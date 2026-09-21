const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const store = require('./store');
const paths = require('./paths');
const { SnapController } = require('./snap');
const { createTray } = require('./tray');
const autostart = require('./autostart');
const remind = require('./remind');
const ball = require('./ball');

let win = null;
let snap = null;
let quitting = false;

const MIN_OPACITY = 0.5;
const MIN_W = 300;
const MIN_H = 340;

// Windows 的登录项名取自 AppUserModelID。不设的话 Electron 写成默认的 electron.app.Electron，
// 任务管理器和管家类软件里看不出是谁，容易被当成可疑启动项直接禁掉，用户也无从排查。
if (process.platform === 'win32') app.setAppUserModelId('com.lagongrenren.todomanager');

function opacityValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(MIN_OPACITY, Math.min(1, n));
}

// 存的值是用户看到的百分比，落到 win.setOpacity 前开一次方。
// 深色窗口叠在亮桌面上，alpha 0.9 透出的那 10% 白光就足以让文字发灰，肉眼会觉得只有 0.7；
// 不校正的话滑块上半段几乎全是「一拉就糊」。
function opacityAlpha(v) {
  const o = opacityValue(v);
  if (o >= 1) return 1;
  const t = (o - MIN_OPACITY) / (1 - MIN_OPACITY);
  return MIN_OPACITY + (1 - MIN_OPACITY) * Math.sqrt(t);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function savedBounds() {
  const w = store.getSettings().window;
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(Math.max(w.width || 366, 300), wa.width);
  const height = Math.min(Math.max(w.height || 710, 340), wa.height);
  const hasPos = Number.isFinite(w.x) && Number.isFinite(w.y);
  // 越界保护：显示器拔掉 / 分辨率变化时回到可见区域
  const visible = hasPos && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return w.x < a.x + a.width - 60 && w.x + width > a.x + 60 && w.y < a.y + a.height - 60 && w.y + height > a.y;
  });
  return {
    x: visible ? w.x : wa.x + Math.round((wa.width - width) / 2),
    y: visible ? w.y : wa.y + 40,
    width,
    height
  };
}

function createWindow() {
  const bounds = savedBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_W,
    minHeight: MIN_H,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: store.getSettings().theme === 'dark' ? '#131c2c' : '#f5f7fb',
    resizable: true,
    maximizable: false,
    // 不给 WS_MINIMIZEBOX：「显示桌面」/ Win+D 的枚举会跳过不可最小化的窗口，
    // 从根上不让它把吸附细边收掉（事后再 restore 有竞态，慢一拍就只剩桌面）。
    minimizable: false,
    fullscreenable: false,
    hasShadow: true,
    autoHideMenuBar: true,
    // 贴边常驻的小窗，占一个任务栏按钮只会碍事；找回窗口走托盘
    skipTaskbar: true,
    icon: paths.iconPng,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  snap = new SnapController(win);

  win.once('ready-to-show', () => {
    const restored = snap.restore();
    if (!restored) {
      const b = savedBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      win.setBounds(snap.clamp(b, wa));
    }
    win.setOpacity(opacityAlpha(store.getSettings().opacity));
    if (store.getSettings().visible !== false) win.show();
    persistBoundsSoon();
  });

  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideToTray();
  });
  win.on('show', () => store.patchSettings({ visible: true }));
  win.on('move', persistBoundsSoon);
  win.on('resize', persistBoundsSoon);
  win.on('closed', () => {
    win = null;
  });

  createTray(() => win, () => app.quit());
}

let boundsTimer = null;
function persistBoundsSoon() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || snap.mode !== 'free') return;
    const b = win.getBounds();
    store.patchSettings({ window: { x: b.x, y: b.y, width: b.width, height: b.height } });
  }, 500);
}

// skipTaskbar 之后没有任务栏按钮可点回来，最小化只会把窗口丢在桌面上找不着，
// 所以最小化和关闭走同一条路：收进托盘，由托盘菜单或再次启动 exe 唤回。
function hideToTray() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  store.patchSettings({ visible: false });
}

function showWindow() {
  if (!win) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  store.patchSettings({ visible: true });
  win.focus();
}

// 渲染层自绘手柄驱动的缩放
function resizeTo(b) {
  if (!win || win.isDestroyed() || !b) return;
  // 注意：这里不能调 win.getMinWidth()/getMinHeight()，在 IPC 回调里会卡死主线程
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const width = Math.max(MIN_W, Math.min(Math.round(b.width || 0), wa.width));
  const height = Math.max(MIN_H, Math.min(Math.round(b.height || 0), wa.height));
  win.setBounds(snap.clamp({ x: Math.round(b.x || 0), y: Math.round(b.y || 0), width, height }, wa));
}

function applyOpacity(v) {
  const o = opacityValue(v);
  store.patchSettings({ opacity: o });
  const alpha = opacityAlpha(o);
  if (win && !win.isDestroyed()) win.setOpacity(alpha);
  return alpha;
}

function registerIpc() {
  ipcMain.handle('tasks:get', () => store.getTasks());
  ipcMain.handle('tasks:set', (_e, tasks) => {
    store.setTasks(Array.isArray(tasks) ? tasks : []);
    return store.getTasks();
  });
  ipcMain.handle('settings:get', () => ({
    ...store.getSettings(),
    autoStart: autostart.isEnabled(),
    dataDir: paths.dataDir,
    configDir: paths.configDir,
    version: app.getVersion()
  }));
  ipcMain.handle('settings:patch', (_e, patch) => {
    if (typeof patch.autoStart === 'boolean') autostart.setEnabled(patch.autoStart);
    store.patchSettings(patch);
    if ('ball' in patch) ball.sync();
    return { ...store.getSettings(), autoStart: autostart.isEnabled() };
  });
  ipcMain.handle('snap:state', () => snap.state());
  ipcMain.handle('win:bounds', () => win.getBounds());
  ipcMain.on('win:resize-to', (_e, b) => resizeTo(b));
  ipcMain.on('win:resize-state', (_e, on) => {
    if (snap) snap.setResizing(on);
  });
  ipcMain.handle('win:opacity', (_e, v) => applyOpacity(v));
  ipcMain.handle('win:hide', () => hideToTray());
  ipcMain.handle('win:editing', (_e, on, ttl) => snap.setEditing(on, ttl));
  ipcMain.handle('remind:test', (_e, mode) => remind.test(mode));
}

app.whenReady().then(() => {
  registerIpc();
  ball.register();
  createWindow();
  remind.init(() => win);
  ball.sync();
  // 等主窗口贴位再弹，不然提醒窗会先出现在旧位置上
  setTimeout(() => remind.run(), 1500);
});

app.on('before-quit', () => {
  quitting = true;
  if (snap) snap.dispose();
  store.flush();
});
