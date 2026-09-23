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
let saveTimer = null;
let interactive = false;

// Chromium 给透明窗口额外加了 8px 非客户区（内容 56，系统矩形 64），
// 这圈像素看不见却照样吃鼠标事件，球下方/右方就成了挡桌面右键的死区。
// 渲染层又收不到 forward 转发的 mousemove，所以直接在主进程比对光标和圆心。
const HIT_R = 27.5;

function trackHit() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const p = screen.getCursorScreenPoint();
  const dx = p.x - (b.x + SIZE / 2);
  const dy = p.y - (b.y + SIZE / 2);
  const on = dx * dx + dy * dy <= HIT_R * HIT_R;
  if (on === interactive) return;
  interactive = on;
  win.setIgnoreMouseEvents(!on, { forward: true });
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
  return { pct: Math.max(0, Math.min(100, Math.round((1 - free / total) * 100))), total, free };
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
  poll = setInterval(pushUsage, 2000);
  clearInterval(hitTimer);
  hitTimer = setInterval(trackHit, 60);
}

function destroy() {
  clearInterval(poll);
  poll = null;
  clearInterval(hitTimer);
  hitTimer = null;
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
  ipcMain.on('ball:move', (_e, dx, dy) => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const x = Math.max(wa.x, Math.min(b.x + Math.round(dx), wa.x + wa.width - SIZE));
    const y = Math.max(wa.y, Math.min(b.y + Math.round(dy), wa.y + wa.height - SIZE));
    win.setPosition(x, y);
    persistPos();
  });
}

function sync() {
  if (store.getSettings().ball) create();
  else destroy();
}

module.exports = { register, sync, destroy, usage };
