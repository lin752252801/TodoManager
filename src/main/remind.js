const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const store = require('./store');

const DAY = 86400000;
// 提前几天开始提醒：默认高 3 天、中 2 天、低 1 天，用户可以在设置里改（见 leadOf）
const DEFAULT_LEAD = { high: 3, mid: 2, low: 1 };
const LEAD_MIN = 0;
const LEAD_MAX = 30;
// 到点提醒：每 20 秒扫一次；「稍后」10 分钟后再响
const DUE_TICK_MS = 20000;
const DUE_SNOOZE_MS = 10 * 60000;
// 开机前就已经到期的那些交给逾期通道，这里只接到点时刻前后才入队的
const bootAt = Date.now();
const PRIO_LABEL = { high: '高', mid: '中', low: '低' };

// 每次数队列时现读设置，改完不用重启也不用等下一轮。
// 0 是合法值（只在到期当天和逾期后提醒），所以不能用 || 兜默认。
function leadOf(priority) {
  const cfg = (store.getSettings() || {}).remindLead || DEFAULT_LEAD;
  const raw = cfg[priority] != null ? cfg[priority] : DEFAULT_LEAD.mid;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_LEAD.mid;
  return Math.min(LEAD_MAX, Math.max(LEAD_MIN, n));
}
const CARD_W = 348;
const CARD_H = 184;
const MARGIN = 8; // 卡片外的透明留白，留给投影
const MERGE_AT = 4; // 攒到这么多条就合成一张清单，逐条点确定太累
const LIST_BASE_H = 146; // 清单卡片的标题 + 统计 + 按钮 + 内边距（比单条卡片少一行「任务名称」）
const LIST_ROW_H = 52; // 一行任务（名称 + 时间/状态）
const LIST_GAP = 8;
const LIST_MAX_H = 470; // 超过就内部滚动，别顶满屏幕

// 详细内容最多摊开 3 行，再多就省略号：弹窗是来打断你的，不是来让你读文档的
const DETAIL_MAX_LINES = 3;
const DETAIL_LINE_H = 18;
const DETAIL_GAP = 7;
// 一行按 18 个汉字估：标签「详细内容：」自己占掉一截宽度，实测一行只装得下 19 个左右。
// 宁可估多（卡片偏高一点），也不能估少 —— 估少了第三行会被窗口直接裁掉，连省略号都出不来
const DETAIL_CHARS = 18;

let getMain = () => null;
let queue = [];
let current = null;
let popup = null;
const payloads = new Map();

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

function inDueWindow(t, now) {
  if ((store.getSettings() || {}).remindDue === false) return false;
  if (!t.dueRemind || t.dueFired) return false;
  if (t.due <= bootAt && !(t.dueSnooze > bootAt)) return false;
  if (t.dueSnooze && now < t.dueSnooze) return false;
  return now >= t.due - dueLeadMs();
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
    // 启动时已经进入「到点弹窗提醒」触发窗的任务交给 dueTick 走更精确的到点弹窗，避免连弹两次
    if (inDueWindow(t, now)) continue;
    const days = Math.round((startOfDay(t.due) - startOfDay(now)) / DAY);
    const lead = leadOf(t.priority);
    if (days > lead) continue;
    out.push({ task: t, overdue: false, days });
  }
  out.sort((a, b) => (b.overdue - a.overdue) || a.task.due - b.task.due);
  return out;
}

function noteOf(item) {
  if (item.atDue) {
    // 到点那条：提前弹的时候才需要「还有 N 分钟」，正点弹标题已经说明了
    const m = Math.round((item.lead || 0) / 60000);
    return m > 0 ? `还有 ${m} 分钟到期` : '';
  }
  return item.overdue
    ? `已逾期 ${Math.max(1, Math.ceil((Date.now() - item.task.due) / DAY))} 天`
    : remaining(item.days);
}

// 详情开头往往就是标题本身（新建时是从同一句话里截出来的），原样贴上去会把同一句念两遍，
// 所以先折成一行、剥掉重复的标题前缀——和主列表 previewText 的差集规则保持一致
function detailOf(t) {
  let s = String(t.detail || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const title = String(t.title || '').trim();
  if (title) {
    if (s === title) return '';
    if (s.startsWith(title)) s = s.slice(title.length).replace(/^[\s，,。.、；;：:！!？?]+/, '');
  }
  return s.trim();
}

function payloadOf(item, more) {
  const t = item.task;
  return {
    id: t.id,
    overdue: item.overdue,
    atDue: !!item.atDue,
    leadM: item.atDue ? Math.round((item.lead || 0) / 60000) : 0,
    sample: !!item.sample,
    title: t.title,
    detail: detailOf(t),
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
      return {
        id: t.id,
        title: t.title,
        dueText: fmtDue(t),
        note: noteOf(i) || (i.atDue ? '已到时间' : ''),
        overdue: i.overdue,
        prio: PRIO_LABEL[t.priority] || '中'
      };
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
  if (!payload.list) {
    const lines = payload.detail ? Math.min(DETAIL_MAX_LINES, Math.max(1, Math.ceil([...payload.detail].length / DETAIL_CHARS))) : 0;
    return { w: CARD_W, h: CARD_H + (lines ? DETAIL_GAP + lines * DETAIL_LINE_H : 0) };
  }
  const n = payload.items.length;
  return { w: CARD_W, h: Math.min(LIST_MAX_H, LIST_BASE_H + n * LIST_ROW_H + (n - 1) * LIST_GAP) };
}

function openWindow(payload, item) {
  // 先清空全局句柄再销毁旧窗口：防止旧窗体的 closed 事件同步或异步覆盖新弹窗的 popup/current
  const old = popup;
  popup = null;
  if (old && !old.isDestroyed()) old.destroy();
  current = item || null;
  const wa = area();
  const raw = sizeOf(payload);
  const w = Math.min(raw.w, Math.max(240, wa.width - MARGIN * 2));
  const h = Math.min(raw.h, Math.max(180, wa.height - MARGIN * 2));
  const box = { w: w + MARGIN * 2, h: h + MARGIN * 2 };
  const win = new BrowserWindow({
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
      additionalArguments: [
        '--remind-th=' + (store.getSettings().theme === 'dark' ? 'dark' : 'light')
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !app.isPackaged
    }
  });
  popup = win;
  const wcId = win.webContents.id;
  payloads.set(wcId, payload);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'remind.html'));
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  // 用户直接关掉窗口（Alt+F4）也算「稍后」，队列要继续走（含预览期间新排入的真实提醒）
  win.on('closed', () => {
    payloads.delete(wcId);
    if (popup !== win) return;
    popup = null;
    current = null;
    next();
  });
}

function next() {
  if (!queue.length) return;
  // 攒得多就一次列清楚，逐条点确定会让人直接关掉程序
  if (queue.length >= MERGE_AT) {
    const items = queue.splice(0, queue.length);
    openWindow(listPayload(items), { list: true, items, sample: false });
    return;
  }
  const item = queue.shift();
  openWindow(payloadOf(item, queue.length), item);
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
  if (!item || item.sample) return;
  const list = item.list ? item.items : [item];
  // 到点提醒：「确定」就是收到（dueFired 已经写过），「稍后」十分钟后再响一次（单条与合并清单通用）
  if (action === 'later') {
    const snoozeAt = Date.now() + DUE_SNOOZE_MS;
    let snoozed = false;
    for (const one of list) {
      if (!one.atDue) continue;
      const t = store.getTasks().find((x) => x.id === one.task.id);
      if (t && !t.done) {
        t.dueFired = false;
        t.dueSnooze = snoozeAt;
        snoozed = true;
      }
    }
    if (snoozed) {
      store.setTasks(store.getTasks());
      broadcastTasks();
    }
    return;
  }
  if (action !== 'ok') return;
  // 逾期项只提醒这一次：点「确定」才算确认收到，「稍后」下次开机还会弹
  for (const one of list) if (one.overdue) ack(one);
}

function run() {
  queue = pending(Date.now());
  current = null;
  next();
}

// 提前几分钟：设置里是 0~60 的整数分钟，非法值一律按 0
function dueLeadMs() {
  const n = Math.round(Number((store.getSettings() || {}).remindDueLead));
  return (Number.isFinite(n) ? Math.min(60, Math.max(0, n)) : 0) * 60000;
}

function isQueuedOrShown(id) {
  if (queue.some((x) => x.task && x.task.id === id)) return true;
  if (!current || current.sample) return false;
  if (current.list) return current.items.some((x) => x.task && x.task.id === id);
  return !!(current.task && current.task.id === id);
}

// 到点通道：只看自己打开了「到点弹窗提醒」的待办。
// 弹过就写 dueFired，改截止时间 / 重新打开开关时由渲染层清掉。
function dueTick() {
  if ((store.getSettings() || {}).remindDue === false) return;
  const lead = dueLeadMs();
  const now = Date.now();
  const fire = [];
  let changed = false;
  for (const t of store.getTasks()) {
    if (t.done || !t.due || !t.dueRemind || t.dueFired) continue;
    if (t.dueSnooze && now < t.dueSnooze) continue;
    // 开机前就到期了且并非处于有效「稍后」期内：逾期通道会管，这里只把标记补上，免得以后重开应用再响一次
    if (t.due <= bootAt && !(t.dueSnooze > bootAt)) {
      t.dueFired = true;
      changed = true;
      continue;
    }
    if (now < t.due - lead) continue;
    t.dueFired = true;
    t.dueSnooze = 0;
    changed = true;
    if (!isQueuedOrShown(t.id)) fire.push({ task: t, overdue: false, days: 0, atDue: true, lead });
  }
  if (changed) {
    store.setTasks(store.getTasks());
    broadcastTasks();
  }
  if (!fire.length) return;
  for (const item of fire) queue.push(item);
  if (!popup) next();
}

// 设置页的「看看弹窗长什么样」：不落任何状态；若正在展示真实提醒，先退回队首等预览关掉再继续
function test(mode) {
  const now = Date.now();
  if (current && !current.sample) {
    if (current.list) queue.unshift(...current.items);
    else queue.unshift(current);
  }
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
    openWindow(listPayload(items), { list: true, items, sample: true });
    return;
  }
  const sampleItem = {
    task: {
      id: '__sample__',
      title: '整理月度工作报表',
      // 开头故意重复一遍标题：预览里正好能看到「差集」生效，不会把同一句话念两遍
      detail: '整理月度工作报表：1、汇总本周销量与回款；2、核对 9 月发票缺口；3、周五下午三点前发给王总。',
      due: now - 2 * DAY,
      dueAllDay: false,
      priority: 'high'
    },
    overdue: true,
    days: 0,
    sample: true
  };
  openWindow(payloadOf(sampleItem, 0), sampleItem);
}

function init(mainGetter) {
  getMain = mainGetter;
  ipcMain.on('remind:payload', (e) => {
    e.returnValue = payloads.get(e.sender.id) || null;
  });
  ipcMain.on('remind:answer', (_e, action) => answer(action === 'ok' ? 'ok' : 'later'));
  setInterval(dueTick, DUE_TICK_MS);
  setTimeout(dueTick, 3000);
}

module.exports = { init, run, test, dueTick };
