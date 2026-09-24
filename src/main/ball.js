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

// Chromium 给透明窗口额外加了 8px 非客户区（内容 56，系统矩形 64），
// 这圈像素看不见却照样吃鼠标事件，球下方/右方就成了挡桌面右键的死区。
// 渲染层又收不到 forward 转发的 mousemove，所以直接在主进程比对光标和圆心。
const HIT_R = 27.5;
const DRAG_POLL_MS = 16; // 拖动时光标要跟得上看，不能按 60ms 的悬停节奏走
const DRAG_SLOP = 6; // 按下后先移动这么几个像素才算真拖，避免手抖把球挪走

function trackHit() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const p = screen.getCursorScreenPoint();
  if (drag) {
    // 拖动期间不许切回穿透：一穿窗口就收不到「松手」，长按状态会粘住
    if (!inWindow(p, b)) {
      // 拖到屏幕边被夹住时鼠标会跑出窗口，离开一小会儿就当作已经放手
      if (!drag.outSince) drag.outSince = Date.now();
      else if (Date.now() - drag.outSince > 350) {
        const moved = drag.moved;
        endDrag();
        dragFinished = moved;
      }
    } else {
      drag.outSince = 0;
    }
    return;
  }
  const dx = p.x - (b.x + SIZE / 2);
  const dy = p.y - (b.y + SIZE / 2);
  const on = dx * dx + dy * dy <= HIT_R * HIT_R;
  if (on === interactive) return;
  interactive = on;
  win.setIgnoreMouseEvents(!on, { forward: true });
}

function inWindow(p, b) {
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

// 拖动改由主进程驱动：渲染层按 screenX 增量挪窗，鼠标一超出这颗 56px 的球就再也收不到事件，
// 长按状态卡住，之后鼠标一靠近球就跟着跑，像在用鼠标推它。
// 反过来让窗口跟着光标走，抓取点始终留在球内，事件就不会断。
function dragTick() {
  if (!win || win.isDestroyed() || !drag) return;
  const p = screen.getCursorScreenPoint();
  // 按下不等于拖动：没移动开几个像素就别挪窗口，否则手一抖球就跑偏
  if (!drag.moved && Math.abs(p.x - drag.x0) + Math.abs(p.y - drag.y0) <= DRAG_SLOP) return;
  drag.moved = true;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const x = Math.max(wa.x, Math.min(p.x - drag.dx, wa.x + wa.width - SIZE));
  const y = Math.max(wa.y, Math.min(p.y - drag.dy, wa.y + wa.height - SIZE));
  if (x !== b.x || y !== b.y) {
    win.setPosition(x, y);
    persistPos();
  }
}

function startDrag(dx, dy, sx, sy) {
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  // 按下点必须由渲染层随事件一起报上来：事件送达可能滞后上百毫秒，
  // 那时再取当前光标，起点就成了拖动终点，阈值判定永远不成立、窗口纹丝不动
  const x0 = Number.isFinite(sx) ? sx : p.x;
  const y0 = Number.isFinite(sy) ? sy : p.y;
  drag = { dx: Math.round(dx), dy: Math.round(dy), x0, y0, moved: false, outSince: 0 };
  dragFinished = false;
  if (!interactive) {
    interactive = true;
    win.setIgnoreMouseEvents(false, { forward: true });
  }
  clearInterval(dragTimer);
  dragTimer = setInterval(dragTick, DRAG_POLL_MS);
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
  // 默认整窗穿透，trackHit 发现光标进圆了再收回
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
  hitTimer = setInterval(trackHit, 60);
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
  ipcMain.on('ball:drag-start', (_e, dx, dy, sx, sy) => startDrag(dx, dy, sx, sy));
  ipcMain.handle('ball:drag-end', () => endDrag());
}

function sync() {
  if (store.getSettings().ball) create();
  else destroy();
}

module.exports = { register, sync, destroy, usage };
