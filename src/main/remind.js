const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const store = require('./store');

const DAY = 86400000;
// 提前几天开始提醒：高 3 天、中 2 天、低 1 天
const LEAD = { high: 3, mid: 2, low: 1 };
const PRIO_LABEL = { high: '高', mid: '中', low: '低' };
const CARD_W = 348;
const CARD_H = 184;
const MARGIN = 8; // 卡片外的透明留白，留给投影
const MERGE_AT = 4; // 攒到这么多条就合成一张清单，逐条点确定太累
const LIST_BASE_H = 146; // 清单卡片的标题 + 统计 + 按钮 + 内边距（比单条卡片少一行「任务名称」）
const LIST_ROW_H = 52; // 一行任务（名称 + 时间/状态）
const LIST_GAP = 8;
const LIST_MAX_H = 470; // 超过就内部滚动，别顶满屏幕

let getMain = () => null;
let queue = [];
let current = null;
let popup = null;

function pad(n) {
  return String(n).padStart(2, '0');
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtDue(t) {
  const d = new Date(t.due);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return t.dueAllDay ? date : `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function remaining(days) {
  if (days === 0) return '今天到期';
  if (days === 1) return '明天到期';
  if (days === 2) return '后天到期';
  return `还有 ${days} 天`;
}

// 逾期且没确认过的排最前，其余按截止时间就近
function pending(now) {
  const out = [];
  for (const t of store.getTasks()) {
    if (t.done || !t.due) continue;
    const overdue = t.due < now;
    if (overdue) {
      if (t.overdueAcked) continue;
      out.push({ task: t, overdue: true, days: 0 });
      continue;
    }
    const days = Math.round((startOfDay(t.due) - startOfDay(now)) / DAY);
    const lead = LEAD[t.priority] != null ? LEAD[t.priority] : LEAD.mid;
    if (days > lead) continue;
    out.push({ task: t, overdue: false, days });
  }
  out.sort((a, b) => (b.overdue - a.overdue) || a.task.due - b.task.due);
  return out;
}

function noteOf(item) {
  return item.overdue
    ? `已逾期 ${Math.max(1, Math.ceil((Date.now() - item.task.due) / DAY))} 天`
    : remaining(item.days);
}

function payloadOf(item, more) {
  const t = item.task;
  return {
    id: t.id,
    overdue: item.overdue,
    sample: !!item.sample,
    title: t.title,
    dueText: fmtDue(t),
    prio: PRIO_LABEL[t.priority] || '中',
    note: noteOf(item),
    more
  };
}

function listPayload(items) {
  const od = items.filter((i) => i.overdue).length;
  return {
    list: true,
    items: items.map((i) => {
      const t = i.task;
      return { id: t.id, title: t.title, dueText: fmtDue(t), note: noteOf(i), overdue: i.overdue, prio: PRIO_LABEL[t.priority] || '中' };
    }),
    od,
    soon: items.length - od
  };
}

function area() {
  const win = getMain();
  const anchor = win && !win.isDestroyed() ? win.getBounds() : null;
  const disp = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
  return disp.workArea;
}

function sizeOf(payload) {
  if (!payload.list) return { w: CARD_W, h: CARD_H };
  const n = payload.items.length;
  return { w: CARD_W, h: Math.min(LIST_MAX_H, LIST_BASE_H + n * LIST_ROW_H + (n - 1) * LIST_GAP) };
}

function openWindow(payload) {
  if (popup && !popup.isDestroyed()) popup.destroy();
  const wa = area();
  const { w, h } = sizeOf(payload);
  const box = { w: w + MARGIN * 2, h: h + MARGIN * 2 };
  popup = new BrowserWindow({
    x: Math.round(wa.x + (wa.width - box.w) / 2),
    y: Math.round(wa.y + (wa.height - box.h) / 2),
    width: box.w,
    height: box.h,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'remind-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !app.isPackaged
    }
  });
  popup.setAlwaysOnTop(true, 'screen-saver');
  popup.loadFile(path.join(__dirname, '..', 'renderer', 'remind.html'), {
    query: { p: JSON.stringify(payload), th: store.getSettings().theme === 'dark' ? 'dark' : 'light' }
  });
  popup.once('ready-to-show', () => popup.show());
  // 用户直接关掉窗口（Alt+F4）也算「稍后」，队列要继续走
  popup.on('closed', () => {
    popup = null;
    const item = current;
    current = null;
    if (item && !item.sample) next();
  });
}

function next() {
  if (!queue.length) return;
  // 攒得多就一次列清楚，逐条点确定会让人直接关掉程序
  if (queue.length >= MERGE_AT) {
    const items = queue.splice(0, queue.length);
    current = { list: true, items, sample: false };
    openWindow(listPayload(items));
    return;
  }
  const item = queue.shift();
  current = item;
  openWindow(payloadOf(item, queue.length));
}

// 主进程把「已确认」写进内存，并立刻广播给渲染层。
// 不广播的话渲染层手里那份副本永远不含 overdueAcked，它之后随便一次 persist()
// （新增 / 完成 / 删除任意一条）都会把整份旧数组发回来，标记当场被抹掉，
// 用户下次开机又会被同一条逾期任务打扰一次。
function broadcastTasks() {
  const win = getMain();
  if (win && !win.isDestroyed()) win.webContents.send('tasks:changed', store.getTasks());
}

function ack(item) {
  const t = store.getTasks().find((x) => x.id === item.task.id);
  if (!t) return;
  t.overdueAcked = true;
  store.setTasks(store.getTasks());
  broadcastTasks();
}

function answer(action) {
  const item = current;
  if (!popup || popup.isDestroyed()) return;
  popup.close(); // closed 事件里继续队列
  if (!item || item.sample || action !== 'ok') return;
  // 逾期项只提醒这一次：点「确定」才算确认收到，「稍后」下次开机还会弹
  if (item.list) {
    for (const one of item.items) if (one.overdue) ack(one);
  } else if (item.overdue) {
    ack(item);
  }
}

function run() {
  queue = pending(Date.now());
  current = null;
  next();
}

// 设置页的「看看弹窗长什么样」：不进队列、不落任何状态
function test(mode) {
  const now = Date.now();
  queue = [];
  if (mode === 'list') {
    const mk = (i, title, due, priority, overdue) => ({
      task: { id: '__sample' + i + '__', title, due, dueAllDay: false, priority },
      overdue,
      days: Math.round((startOfDay(due) - startOfDay(now)) / DAY)
    });
    const items = [
      mk(1, '整理月度工作报表', now - 2 * DAY, 'high', true),
      mk(2, '给妈妈打电话', now - 1 * DAY, 'mid', true),
      mk(3, '提交报销单', now + 1 * DAY, 'high', false),
      mk(4, '预约牙科检查', now + 3 * DAY, 'low', false)
    ];
    current = { list: true, items, sample: true };
    openWindow(listPayload(items));
    return;
  }
  current = { task: { id: '__sample__', title: '整理月度工作报表', due: now - 2 * DAY, dueAllDay: false, priority: 'high' }, overdue: true, days: 0, sample: true };
  openWindow(payloadOf(current, 0));
}

function init(mainGetter) {
  getMain = mainGetter;
  ipcMain.on('remind:answer', (_e, action) => answer(action === 'ok' ? 'ok' : 'later'));
}

module.exports = { init, run, test };
