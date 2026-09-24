const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const store = require('./store');
const paths = require('./paths');

// 窗口必须和球体一样大：透明像素也属于这个置顶窗口，会吞掉鼠标事件，
// 留白一多，球旁边那圈看着是空的，却挡住桌面右键
const BALL = 56;
const SIZE = BALL;

let win = null;
let poll = null;
let hitTimer = null;
let drag = null;
let saveTimer = null;
let interactive = false;
// 自动放手过一次就记在这儿：渲染层的「松手」会晚一步到达，得告诉它这一下是拖不是点
let dragFinished = false;
// 渲染层明确报过「松手」：之后在途的心跳不许把拖动接回来
let handEnded = false;

// 透明窗口平时整窗穿透，只有光标靠近时才收回，免得球旁边那块看不见的地方挡住桌面右键。
// 收回的判定不能卡在球面上：按下只有一瞬间，等光标压到球上再翻状态，那一下点击就漏给桌面了，
// 而且漏掉之后桌面（比如桌面的框选）会把鼠标捕获走，球页面连后续的 move 都收不到，只能干看着。
// 所以感应圈要开得比窗口大得多：真正会吞点击的只有那 56px 窗口本身，感应圈开到 400px
// 也不会多吞一下点击（光标在圈内、窗口外时窗口根本收不到事件），换来的只是提前量。
const ARM_R = 400;
const HIT_POLL_MS = 8; // 一次按下只有几十毫秒，轮询慢了就等于漏按；拖动跟手也是这个间隔
const DRAG_SLOP = 6; // 按下后先移动这么几个像素才算真拖，避免手抖把球挪走
const DRAG_STUCK_MS = 2500; // 渲染层这么久没有任何回报才兜底放手，正常拖动一直在报

function setInteractive(on) {
  if (!win || win.isDestroyed() || interactive === on) return;
  interactive = on;
  win.setIgnoreMouseEvents(!on, { forward: true });
}

function inWindow(p, b) {
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

function tick() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const p = screen.getCursorScreenPoint();
  if (drag) return dragTick(b, p);
  const d = Math.hypot(p.x - (b.x + b.width / 2), p.y - (b.y + b.height / 2));
  setInteractive(d <= ARM_R);
}

function clampToWork(x, y) {
  const wa = screen.getDisplayMatching({ x, y, width: SIZE, height: SIZE }).workArea;
  // 必须取整：窗口位置只收整数，喂小数会当场抛异常（非 100% 缩放下位移就是小数）
  // 夹边一律按 56 算，不按 getBounds 的实际宽高：非 100% 缩放下实际宽高会多 1px 边框取整，
  // 拿它当参照每帧都能差出 1，球就顺着这 1px 自己往前爬
  return {
    x: Math.round(Math.max(wa.x, Math.min(x, wa.x + wa.width - SIZE))),
    y: Math.round(Math.max(wa.y, Math.min(y, wa.y + wa.height - SIZE)))
  };
}

// 上一次真正写给窗口的位置。参照必须是「我们要求的位置」而不是 getBounds()：
// 缩放不是 100% 时，窗口实际宽高会比要的多 1px（边框取整），拿实际 bounds 一比就永远「有变化」。
let lastSet = null;

function applyDragPos(x, y) {
  const t = clampToWork(x, y);
  if (lastSet && lastSet.x === t.x && lastSet.y === t.y) return t;
  lastSet = t;
  // 一定要带尺寸：setPosition 只挪位置，非 100% 缩放下每调一次窗口就长大 1 像素（实测 125% 调
  // 100 次从 56 变 156）。球画在窗口正中，窗口一长球就自己往前挪 —— 用户报的
  // 「100 不会动，125 以上全部都会动」就是这个。setContentBounds 把视口钉死在 56，怎么拖都不涨。
  win.setContentBounds({ x: t.x, y: t.y, width: SIZE, height: SIZE });
  persistPos();
  return t;
}

// 拖动现场：每 30ms 记一行「光标读数 / 球的位置」，只留最近一次拖动，写在 data 里几 KB 而已。
// 「手不动球自己走」在开发机上一直复现不出来，用户那边再报第二次的话，这段现场能一眼看出
// 到底是系统给的光标读数自己在动，还是另有别人在挪窗口。
const DRAG_LOG_MS = 30;
const DRAG_LOG_MAX = 400;

function logDrag(p, t) {
  const d = drag;
  const now = Date.now();
  if (!d.moved || now - d.last < DRAG_LOG_MS || d.log.length >= DRAG_LOG_MAX) return;
  d.last = now;
  d.log.push(`+${now - d.t0}ms  光标=${p.x},${p.y}  位移=${p.x - d.cx},${p.y - d.cy}  球=${t.x},${t.y}`);
}

function writeDragLog(d, byHand) {
  const head =
    `拖动现场 ${new Date().toLocaleString()}\n` +
    `缩放=${d.sf}  按下时球=${d.ox},${d.oy}  按下时光标=${d.cx},${d.cy}\n` +
    `结束=${byHand ? '松手' : '兜底放手'}  共 ${d.log.length} 行${d.log.length >= DRAG_LOG_MAX ? '（只记前 12 秒）' : ''}\n`;
  fs.writeFile(path.join(paths.dataDir, 'ball-drag.log'), head + d.log.join('\n') + '\n', () => {});
}

// 球的位置只认一个来源：主进程轮询到的全局光标。渲染层只管说「按下了 / 还按着 / 松手了」，
// 一个坐标都不报。原因是缩放不是 100% 时页面里的坐标全带小数（CSS 像素、screenX 都是），
// 而窗口位置只收整数 DIP，两边对不上；拿页面坐标掺进位移，鼠标停住不动时每一帧都能
// 差出半像素，球就顺着这半像素自己往前爬。现在改成「按下当刻的窗口位置 + 整数 DIP 光标
// 相对按下当刻光标移了多少」，两个数都在同一套整数 DIP 里、每帧从起点重算不逐帧累加，
// 所以光标不动 → 位移不变 → 球一定不动。拖到屏幕边缘被夹住也不会把起点带歪。
function dragTick(b, p) {
  const now = Date.now();
  // 渲染层再也报不上来、光标也不在球上：当作已经松手，别让整个拖动卡死在这儿
  if (now - drag.seen > DRAG_STUCK_MS && !inWindow(p, b)) {
    const moved = drag.moved;
    endDrag();
    dragFinished = moved;
    return;
  }
  const dx = p.x - drag.cx;
  const dy = p.y - drag.cy;
  if (!drag.moved) {
    if (Math.abs(dx) + Math.abs(dy) <= DRAG_SLOP) return;
    drag.moved = true;
  }
  logDrag(p, applyDragPos(drag.ox + dx, drag.oy + dy));
}

function beginDrag(moved) {
  const b = win.getBounds();
  const c = screen.getCursorScreenPoint();
  const sf = screen.getDisplayMatching(b).scaleFactor;
  const now = Date.now();
  drag = { ox: b.x, oy: b.y, cx: c.x, cy: c.y, sf, moved, seen: now, t0: now, last: 0, log: [] };
  lastSet = null; // 这一趟的第一帧一定要真的写一次窗口
  setInteractive(true);
}

function startDrag() {
  if (!win || win.isDestroyed()) return;
  dragFinished = false;
  handEnded = false;
  beginDrag(false);
}

// 心跳：这一下按下还在。位置不从这儿走，所以哪怕报得稀烂也不会把球带偏。
function dragAlive() {
  if (!win || win.isDestroyed()) return;
  if (drag) {
    drag.seen = Date.now();
    return;
  }
  // 已经明确松过手之后迟到的心跳不算新的按下：那是在途的上一趟，接上就成了「没按键球也跟手」
  if (!handEnded) beginDrag(true);
}

// 回报这一下到底有没有真拖过：渲染层据此决定是挪位置还是清理内存
function endDrag(byHand) {
  const d = drag;
  const moved = d ? d.moved : dragFinished;
  dragFinished = false;
  drag = null;
  if (byHand) handEnded = true;
  if (d && d.moved && d.log.length) writeDragLog(d, byHand);
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

function create(at) {
  if (win && !win.isDestroyed()) return;
  const p = clampToWork(at ? at.x : savedPos().x, at ? at.y : savedPos().y);
  lastSet = null;
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
  // 默认整窗穿透，tick 发现光标靠近了再收回
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
  hitTimer = setInterval(tick, HIT_POLL_MS);
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
  ipcMain.on('ball:drag-alive', () => dragAlive());
  ipcMain.handle('ball:drag-end', () => endDrag(true));
  // 改显示缩放时 Windows 只保住窗口的物理尺寸：150% 下 84px 高的球窗，切到 200% 就成了
  // 42px 的 CSS 视口，而球还是 56 CSS 像素，右边和下边直接被裁掉一块（实测）。
  // 光把尺寸写回去也不够：225%→100% 之后 setContentBounds(56) 实测留下 56x63 的视口，
  // 因为 Windows 还攥着旧的物理高度。只有按新缩放重建窗口，才等于「刚开机就是这个缩放」。
  // 位置用系统换算过的当前 DIP，所以球不会跳回原位也不会跑到屏外；拖动中不抢，等松手。
  let remetric = null;
  const rebuild = () => {
    remetric = null;
    if (!win || win.isDestroyed()) return;
    if (drag) {
      remetric = setTimeout(rebuild, 600); // 正拖着，等这趟结束再说
      return;
    }
    const [x, y] = win.getPosition(); // 已经是新缩放下的 DIP
    destroy();
    create({ x, y });
  };
  screen.on('display-metrics-changed', () => {
    clearTimeout(remetric); // 一次缩放变更会连发好几个事件，等它彻底停下再重建
    remetric = setTimeout(rebuild, 600);
  });
}

function sync() {
  if (store.getSettings().ball) create();
  else destroy();
}

module.exports = { register, sync, destroy, usage };
