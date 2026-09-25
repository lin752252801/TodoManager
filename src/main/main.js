const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const store = require('./store');
const paths = require('./paths');
const { SnapController } = require('./snap');
const { createTray, destroyTray } = require('./tray');
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

// 渲染层自绘手柄驱动的缩放。
//
// dir 必须一起传进来（'n'/'s'/'w'/'e' 或其组合，取自手柄的 data-dir）。
// 只给一个矩形的话，一旦窗口原点被工作区顶回去，就分不清「用户正把这条边往外推」
// 和「对面那条边该不该跟着动」，只能按原点整体夹取 —— 于是拖左/上边缘一直推到贴边时，
// 对面那条边会被一起拖走：顶边钉在 0、高度却按「原始 y + 原始高度」继续长，下边缘就往下滑；
// 鼠标在边界上小幅来回时，对面那条边跟着来回动（实测：自由态窗口 y=40 往上拖，
// 顶边到 0 之后下边缘继续从 750 涨到 758；顶边吸附的窗口拖上边缘，高度 620→628）。
// 拖右/下边缘不会这样，因为那条路径不夹原点。
//
// 正确做法：只夹用户正拖的那条边，对面那条边原地不动 —— 手感和拖右边缘一致。
function resizeTo(b, dir) {
  if (!win || win.isDestroyed() || !b) return;
  // 注意：这里不能调 win.getMinWidth()/getMinHeight()，在 IPC 回调里会卡死主线程
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const d = typeof dir === 'string' ? dir : '';
  let x = Math.round(b.x || 0);
  let y = Math.round(b.y || 0);
  let width = Math.round(b.width || 0);
  let height = Math.round(b.height || 0);

  if (!d) {
    // 拿不到方向（老渲染层 / 异常路径）时退回整体夹取，保证窗口一定落在工作区里
    const c = snap.clamp({ x, y, width, height }, wa);
    win.setBounds({ x: c.x, y: c.y, width: Math.max(MIN_W, c.width), height: Math.max(MIN_H, c.height) });
    return;
  }

  if (d.includes('w')) {
    // 右边缘是锚点：先记下来再夹 x，宽度由「右边缘 − 夹过的 x」反推，
    // 而不是先夹 x 再原样保留宽度（那样右边缘会被一起拖走）
    const right = x + width;
    x = Math.max(wa.x, x);
    width = Math.min(Math.max(right - x, MIN_W), wa.width);
  } else if (d.includes('e')) {
    width = Math.min(Math.max(width, MIN_W), wa.x + wa.width - x);
  }
  if (d.includes('n')) {
    const bottom = y + height;
    y = Math.max(wa.y, y);
    height = Math.min(Math.max(bottom - y, MIN_H), wa.height);
  } else if (d.includes('s')) {
    height = Math.min(Math.max(height, MIN_H), wa.y + wa.height - y);
  }
  // 没被拖的那一维整份照抄：它来自渲染层按下时冻结的窗口矩形，本来就在工作区内，
  // 再夹一次只会把对面那条边推走 —— 这正是这个 bug 的成因。
  win.setBounds({ x, y, width, height });
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
    const list = Array.isArray(tasks) ? tasks : [];
    // 渲染层手里那份是启动时结构化克隆出来的副本，不含主进程打过的 overdueAcked。
    // 整份替换会把「逾期只提醒一次」的标记抹掉，所以按 id 把主进程已有的标记并回来，
    // 堵住「ack 刚广播出去、渲染层上一笔整份写回还在路上」这个在途窗口。
    const acked = new Set(store.getTasks().filter((t) => t && t.overdueAcked).map((t) => t.id));
    if (acked.size) for (const t of list) if (t && acked.has(t.id)) t.overdueAcked = true;
    store.setTasks(list);
    return store.getTasks();
  });
  ipcMain.handle('settings:get', () => ({
    ...store.getSettings(),
    autoStart: autostart.isEnabled(),
    dataDir: paths.dataDir,
    configDir: paths.configDir,
    // 启动时发现数据文件损坏（已自动备份）时，界面要能提示一句
    loadWarnings: store.getLoadWarnings(),
    version: app.getVersion()
  }));
  ipcMain.handle('settings:patch', (_e, patch) => {
    if (typeof patch.autoStart === 'boolean') autostart.setEnabled(patch.autoStart);
    store.patchSettings(patch);
    if ('ball' in patch) ball.sync();
    return { ...store.getSettings(), autoStart: autostart.isEnabled() };
  });
  ipcMain.handle('snap:state', () => snap.state());
  // win 在 closed 之后是 null，退出流程里渲染层若正好取一次 bounds 会抛未捕获异常
  ipcMain.handle('win:bounds', () => (win && !win.isDestroyed() ? win.getBounds() : null));
  ipcMain.on('win:resize-to', (_e, b, dir) => resizeTo(b, dir));
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
  // 托盘图标不会随窗口一起消失：不显式销毁，通知区域会留一个点不动的僵尸图标
  destroyTray();
  store.flush();
});
