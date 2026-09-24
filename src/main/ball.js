const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const store = require('./store');

// 窗口必须和球体一样大：透明像素也属于这个置顶窗口，会吞掉鼠标事件，
// 留白一多，球旁边那圈看着是空的，却挡住桌面右键
const BALL = 56;
const SIZE = BALL;

let win = null;
let poll = null;
let hitTimer = null;
let dragTimer = null;
let drag = null;
let saveTimer = null;
let interactive = false;
// 自动放手过一次就记在这儿：渲染层的「松手」会晚一步到达，得告诉它这一下是拖不是点
let dragFinished = false;

// 透明窗口平时整窗穿透，只有光标靠近时才收回，免得球旁边那块看不见的地方挡住桌面右键。
// 收回的判定不能卡在球面上：按下只有一瞬间，等光标压到球上再翻状态，那一下点击就漏给桌面了，
// 而且漏掉之后桌面（比如桌面的框选）会把鼠标捕获走，球页面连后续的 move 都收不到，只能干看着。
// 所以感应圈要开得比窗口大得多：真正会吞点击的只有那 56px 窗口本身，感应圈开到 400px
// 也不会多吞一下点击（光标在圈内、窗口外时窗口根本收不到事件），换来的只是提前量。
const ARM_R = 400;
const HIT_POLL_MS = 8; // 一次按下只有几十毫秒，轮询慢了就等于漏按
const DRAG_POLL_MS = 50; // 只是看门狗的间隔：正常跟手全靠渲染层报上来的位移
const DRAG_SLOP = 6; // 按下后先移动这么几个像素才算真拖，避免手抖把球挪走
const DRAG_STUCK_MS = 2500; // 渲染层这么久没有任何回报才兜底放手，正常拖动一直在报

function setInteractive(on) {
  if (!win || win.isDestroyed() || interactive === on) return;
  interactive = on;
  win.setIgnoreMouseEvents(!on, { forward: true });
}

function trackHit() {
  if (!win || win.isDestroyed() || drag) return;
  const b = win.getBounds();
  const p = screen.getCursorScreenPoint();
  const d = Math.hypot(p.x - (b.x + b.width / 2), p.y - (b.y + b.height / 2));
  setInteractive(d <= ARM_R);
}

// 拖动改由渲染层报「相对按下点移了多少」，主进程只把这个位移加到按下当刻的窗口位置上。
// 关键是全程只用同一坐标系里的差值：不去比对渲染层的 clientX 和主进程的 bounds，
// 所以缩放比例、透明窗口的非客户区、事件迟到多久，都不会让球跟鼠标对不上。
function inWindow(p, b) {
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

function clampToWork(x, y, b) {
  const wa = screen.getDisplayMatching(b).workArea;
  // 必须取整：setPosition 只收整数，喂小数会当场抛异常（非 100% 缩放下位移就是小数）
  return {
    x: Math.round(Math.max(wa.x, Math.min(x, wa.x + wa.width - b.width))),
    y: Math.round(Math.max(wa.y, Math.min(y, wa.y + wa.height - b.height)))
  };
}

function applyDragPos(x, y) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const t = clampToWork(x, y, b);
  if (t.x !== b.x || t.y !== b.y) {
    win.setPosition(t.x, t.y);
    persistPos();
  }
  if (Math.abs(t.x - drag.ox) + Math.abs(t.y - drag.oy) > DRAG_SLOP) drag.moved = true;
}

// 看门狗：只负责「万一渲染层再也报不上来」时把拖动状态收掉，绝不自己挪窗口。
// 曾经这里有一条兜底跟随——拿渲染层最后一次报的窗内偏移去减主进程的全局光标，
// 算出窗口该在哪儿。问题是这两个数不是同一个东西：窗内偏移是 CSS 像素（缩放不是
// 100% 时带小数），全局光标和窗口位置是整数，一到非 100% 缩放就永远差那半像素，
// 于是每 50ms 拽一下、渲染层再按位移拽回来，球就在鼠标停住时自己爬。
// 现在球的位置只有一个来源：渲染层报上来的位移。鼠标停住就没有位移，球就停住。
function dragTick() {
  if (!win || win.isDestroyed() || !drag) return;
  if (Date.now() - drag.reported <= DRAG_STUCK_MS) return;
  // 光标还在球上就一定收得到松手，别抢着放手：按住不动几秒再拖是正常操作
  if (inWindow(screen.getCursorScreenPoint(), win.getBounds())) return;
  const moved = drag.moved;
  endDrag();
  dragFinished = moved;
}

function beginDrag(ox, oy, moved) {
  drag = { ox, oy, moved, reported: Date.now() };
  setInteractive(true);
  clearInterval(dragTimer);
  dragTimer = setInterval(dragTick, DRAG_POLL_MS);
}

function startDrag() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  dragFinished = false;
  beginDrag(b.x, b.y, false);
}

// 位移由渲染层在 pointermove 里算好：事件就算迟到，它带的 screenX 仍是按下那一刻的坐标，
// 差值不会骗人；主进程按这个差值挪窗，甩多远就跟多远。
function moveDrag(dx, dy) {
  if (!win || win.isDestroyed()) return;
  // 渲染层传来的数直接进 IPC，什么都可能是：非有限值一旦当作起点存进 drag，
  // 这之后的每一帧都会算出 NaN 的位置，整次拖动就再也跟不上了，所以先丢掉这一帧。
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  // 非 100% 缩放下 screenX/screenY 带小数，而窗口位置只收整数；
  // 位移本来就是「相对按下点」的总差值，取整最多偏半像素，也不会逐帧累积。
  dx = Math.round(dx);
  dy = Math.round(dy);
  if (!drag) {
    // 兜底放手之后手指还在动：把现在的位置当成新起点接上，别让球从此不跟手
    const b = win.getBounds();
    beginDrag(b.x - dx, b.y - dy, true);
  }
  drag.reported = Date.now();
  if (Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) drag.moved = true;
  applyDragPos(drag.ox + dx, drag.oy + dy);
}

// 回报这一下到底有没有真拖过：渲染层据此决定是挪位置还是清理内存
function endDrag() {
  const moved = drag ? drag.moved : dragFinished;
  dragFinished = false;
  clearInterval(dragTimer);
  dragTimer = null;
  drag = null;
  return moved;
}


const TRIM_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  'Add-Type -Namespace MemTrim -Name Native -MemberDefinition \'[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr OpenProcess(uint a,bool i,uint p);[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr h);[System.Runtime.InteropServices.DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(System.IntPtr h);\'',
  '$list = @(Get-Process)',
  '$before = 0L',
  'foreach ($p in $list) { $before += $p.WorkingSet64 }',
  'foreach ($p in $list) {',
  '  $h = [MemTrim.Native]::OpenProcess(0x1100, $false, [uint32]$p.Id)',
  '  if ($h -ne [System.IntPtr]::Zero) {',
  '    [void][MemTrim.Native]::EmptyWorkingSet($h)',
  '    [void][MemTrim.Native]::CloseHandle($h)',
  '  }',
  '}',
  'Start-Sleep -Milliseconds 250',
  '$after = 0L',
  'foreach ($p in @(Get-Process)) { $after += $p.WorkingSet64 }',
  '[Math]::Max(0, $before - $after)',
  ''
].join('\n');

function usage() {
  const total = os.totalmem();
  const free = os.freemem();
  // 保留一位小数：整数百分比在几分钟内常常纹丝不动，看着像坏了没刷新
  return { pct: Math.max(0, Math.min(100, Math.round((1 - free / total) * 1000) / 10)), total, free };
}

function homePos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - SIZE - 26, y: wa.y + Math.round(wa.height * 0.4) };
}

function savedPos() {
  const p = store.getSettings().ballPos;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return homePos();
  const wa = screen.getDisplayMatching({ x: p.x, y: p.y, width: SIZE, height: SIZE }).workArea;
  return {
    x: Math.max(wa.x, Math.min(p.x, wa.x + wa.width - SIZE)),
    y: Math.max(wa.y, Math.min(p.y, wa.y + wa.height - SIZE))
  };
}

function persistPos() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    store.patchSettings({ ballPos: { x: b.x, y: b.y } });
  }, 400);
}

function pushUsage() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('usage', usage());
}

function create() {
  if (win && !win.isDestroyed()) return;
  const p = savedPos();
  win = new BrowserWindow({
    x: p.x,
    y: p.y,
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'ball-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !app.isPackaged
    }
  });
  // 默认整窗穿透，trackHit 发现光标靠近了再收回
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  interactive = false;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'ball.html'));
  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) win.showInactive();
    pushUsage();
  });
  win.on('closed', () => {
    win = null;
  });
  clearInterval(poll);
  poll = setInterval(pushUsage, 1000);
  clearInterval(hitTimer);
  hitTimer = setInterval(trackHit, HIT_POLL_MS);
}

function destroy() {
  clearInterval(poll);
  poll = null;
  clearInterval(hitTimer);
  hitTimer = null;
  endDrag();
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

// 一次进程级的工作集整理：把所有程序暂时不用的内存页交还给系统。
// 不结束任何进程、不删任何数据，被挤掉的页在程序再次用到时会自动换回来。
function trim() {
  return new Promise((resolve) => {
    const cmd = Buffer.from(TRIM_PS, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', cmd],
      { windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 1 << 20 },
      (_err, out) => {
        const n = Number(String(out || '').trim().split(/\s+/).pop());
        resolve(Number.isFinite(n) && n > 0 ? n : 0);
      }
    );
  });
}

function register() {
  ipcMain.handle('ball:usage', () => usage());
  ipcMain.handle('ball:trim', async () => {
    const bytes = await trim();
    pushUsage();
    return { mb: Math.round(bytes / 1048576), ...usage() };
  });
  ipcMain.on('ball:drag-start', () => startDrag());
  ipcMain.on('ball:drag-move', (_e, dx, dy) => moveDrag(dx, dy));
  ipcMain.handle('ball:drag-end', () => endDrag());
}

function sync() {
  if (store.getSettings().ball) create();
  else destroy();
}

module.exports = { register, sync, destroy, usage };
