const bridge = window.api;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const DAY = 86400000;
const HOUR = 3600000;
const PRIO = { high: 0, mid: 1, low: 2 };
const PRIO_LABEL = { high: '高', mid: '中', low: '低' };
const TITLE_MAX = 20;

const state = {
  tasks: [],
  tab: 'active',
  expandedId: null,
  draft: null,
  view: 'tasks',
  tier: 'mid'
};

const listEl = $('#list');
const emptyEl = $('#empty');
const addInput = $('#add-input');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtStamp(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 列表里的创建时间按宽度分档，窄档只留月日
function fmtCreated(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date =
    sameYear && state.tier !== 'wide'
      ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${hm}`;
}

function toDateInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toTimeInput(ms, allDay) {
  if (!ms || allDay) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 只填了日期就算有效，时间留空表示「当天结束前」，按 23:59 记，避免被当成 00:00 立刻逾期
function dueFrom(dateStr, timeStr) {
  if (!dateStr) return { due: null, allDay: false };
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!timeStr) {
    return { due: new Date(y, m - 1, d, 23, 59, 0, 0).getTime(), allDay: true };
  }
  const [hh, mm] = timeStr.split(':').map(Number);
  return { due: new Date(y, m - 1, d, hh, mm, 0, 0).getTime(), allDay: false };
}

// 倒计时文案：不足 1 小时到 8 天之间才值得占一个胶囊的位置
function remainText(ms, now) {
  const left = ms - now;
  if (left < 0) return `逾期 ${Math.max(1, Math.ceil(-left / DAY))} 天`;
  if (left < HOUR) return '不足 1 小时';
  if (left < 2 * DAY) return `剩 ${Math.ceil(left / HOUR)} 小时`;
  if (left < 8 * DAY) return `剩 ${Math.ceil(left / DAY)} 天`;
  return '';
}

// 截止时间的三态：普通 / 临近(≤2天) / 逾期。
// 逾期那档只写到期的时刻：「逾期」几个字右边胶囊已经写了，重复一遍会挤掉时间。
function dueInfo(t) {
  const ms = t.due;
  const now = Date.now();
  const d = new Date(ms);
  const hm = t.dueAllDay ? '' : ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const dateStr = state.tier === 'narrow' || sameYear ? md : `${d.getFullYear()}-${md}`;
  if (ms < now) return { cls: 'over', text: `${dateStr}${hm}`, chip: remainText(ms, now) };
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  const rel = days <= 2 ? ['今天', '明天', '后天'][days] + hm : `${dateStr}${hm}`;
  return { cls: days <= 2 ? 'soon' : 'ok', text: `截止 ${rel}`, chip: days <= 7 ? remainText(ms, now) : '' };
}

function visibleTasks() {
  const list = state.tasks.filter((t) => (state.tab === 'done' ? t.done : !t.done));
  if (state.tab === 'done') return list.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  return list.sort((a, b) => {
    if (PRIO[a.priority] !== PRIO[b.priority]) return PRIO[a.priority] - PRIO[b.priority];
    const ad = a.due == null ? Infinity : a.due;
    const bd = b.due == null ? Infinity : b.due;
    if (ad !== bd) return ad - bd;
    return a.createdAt - b.createdAt;
  });
}

const CLOCK =
  '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.6V8l2.4 1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const TICK = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="m3.6 8.3 3 3 5.8-6.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const CHEV = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="m6 3.5 5 4.5-5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const CAL =
  '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="2.4" y="3.4" width="11.2" height="10.2" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.4 6.4h11.2M5.4 1.9v3M10.6 1.9v3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
const PEN =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/></svg>';

// 预览与标题重复时只保留差集，避免同一句话显示两遍
function previewText(t) {
  let s = (t.detail || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const title = (t.title || '').trim();
  if (!title) return s;
  if (s === title) return '';
  if (s.startsWith(title)) s = s.slice(title.length).replace(/^[\s，,。.、；;：:！!？?]+/, '');
  return s.trim();
}

function cardHtml(t) {
  const open = state.expandedId === t.id;
  const preview = previewText(t);
  const due = t.due ? dueInfo(t) : null;
  return `
  <article class="card glass p-${t.priority} ${open ? 'is-open' : ''} ${t.done ? 'is-done' : ''}" data-id="${t.id}" data-act="open">
    <span class="spine"></span>
    <div class="head">
      <button class="ring" data-act="done" title="${t.done ? '移回待办' : '标记完成'}">${TICK}</button>
      <div class="m">
        <div class="row1">
          <div class="n1">${esc(t.title)}</div>
          <span class="chip prio" title="点击展开后可修改优先级">${PRIO_LABEL[t.priority]}</span>
        </div>
        ${preview ? `<div class="pv">${esc(preview)}</div>` : ''}
        <div class="meta">
          <span class="tm crt">${CAL}${esc(fmtCreated(t.createdAt))}</span>
          ${due ? `<span class="tm d-${due.cls}">${CLOCK}${esc(due.text)}</span>` : ''}
          ${due && due.chip ? `<span class="chip ${due.cls === 'over' ? 'over' : 'soon'}">${esc(due.chip)}</span>` : ''}
        </div>
      </div>
      <span class="chev">${CHEV}</span>
    </div>
    ${open ? detailHtml(t) : ''}
  </article>`;
}

function detailHtml(t) {
  const d = draftOf(t) || t;
  return `
  <div class="detail" data-act="noop">
    <label class="fld"><span>标题（建议 ${TITLE_MAX} 字以内）</span><input type="text" maxlength="60" data-f="title" value="${esc(d.title)}" placeholder="一句话说明" /></label>
    <label class="fld"><span>详细内容</span><textarea data-f="detail" placeholder="补充说明…">${esc(d.detail == null ? '' : d.detail)}</textarea></label>
    <div class="row2">
      <div class="fld">
        <span>截止日期（时间可留空）</span>
        <button type="button" class="date-btn" data-act="pick-date" title="选择截止日期">
          <span class="dv${d.due ? '' : ' ph'}">${d.due ? toDateInput(d.due) : '选择日期'}</span>${CAL}
        </button>
      </div>
      <div class="fld">
        <span>时间</span>
        <button type="button" class="time-btn" data-act="pick-time" title="选择截止时间" aria-haspopup="dialog" aria-expanded="false"${d.due ? '' : ' disabled'}>
          <span class="tv${toTimeInput(d.due, d.dueAllDay) ? '' : ' ph'}">${toTimeInput(d.due, d.dueAllDay) || '选择时间'}</span>${CLOCK}
        </button>
      </div>
    </div>
    <div class="fld"><span>优先级</span>
      <div class="seg">
        ${['high', 'mid', 'low']
          .map((p) => `<button class="btn ${d.priority === p ? 'is-on' : ''}" data-act="set-prio" data-p="${p}">${PRIO_LABEL[p]}</button>`)
          .join('')}
      </div>
    </div>
    <div class="dstamp">
      ${CAL}<span>创建时间 ${fmtStamp(t.createdAt)}</span>${t.done ? `<span>· 完成时间 ${fmtStamp(t.completedAt)}</span>` : ''}
    </div>
    <div class="dfoot">
      <button class="btn del" data-act="del">删除</button>
      <span class="dirty-tip">有未确认的修改</span>
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn pri" data-act="save" disabled>保存</button>
    </div>
  </div>`;
}

function draftOf(t) {
  const d = state.draft;
  return d && d.id === t.id ? d : null;
}

function beginDraft(t) {
  state.draft = {
    id: t.id,
    title: t.title,
    detail: t.detail || '',
    due: t.due,
    dueAllDay: !!t.dueAllDay,
    priority: t.priority
  };
}

function isDirty(t) {
  const d = draftOf(t);
  if (!d) return false;
  return (
    d.title !== t.title ||
    d.detail !== (t.detail || '') ||
    d.due !== t.due ||
    !!d.dueAllDay !== !!t.dueAllDay ||
    d.priority !== t.priority
  );
}

// 只改 DOM 上的脏标记，不重绘，否则输入焦点会丢
function syncDirty(card, t) {
  const dirty = isDirty(t);
  card.classList.toggle('is-dirty', dirty);
  const save = card.querySelector('[data-act="save"]');
  if (save) save.disabled = !dirty;
}

function commitDraft() {
  const d = state.draft;
  if (!d) return;
  const t = find(d.id);
  if (t) {
    t.title = d.title.trim().slice(0, 200) || '（未命名）';
    t.detail = d.detail;
    t.due = d.due;
    t.dueAllDay = !!d.dueAllDay;
    t.priority = d.priority;
    persist();
  }
  state.draft = null;
  // 点「确定」即视为编辑结束：卡片收起，下次要改再点开，基准自然是任务上的新值
  closeEditor();
}

function closeEditor() {
  state.expandedId = null;
  state.draft = null;
  // 面板挂在 body 上，不跟着卡片一起消失；不关掉就会飘在半空，还占着「编辑中」的锁
  closeCal();
  closeTp();
  patchSetting({ expandedId: null });
  render();
}

// ---- 自绘日历面板 ----
// 原生日历改不了样式（上下月的日期和本月混在一起），所以自己画：格子里只放当月，
// 月初的空位留白，换月用 ‹ ›，下面一排快捷选择。
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const cal = { el: null, anchor: null, y: 0, m: 0, view: 'days' };

function calOpen() {
  return !!cal.el && !cal.el.hidden;
}

function mondayIndex(d) {
  return (d.getDay() + 6) % 7;
}

function atNoon(y, m, day) {
  // 取当天中午：避免时区/夏令时把日期甩到前一天或后一天
  return new Date(y, m, day, 12, 0, 0, 0).getTime();
}

function quickDay(kind) {
  const n = new Date();
  const t = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12);
  if (kind === 'tomorrow') t.setDate(t.getDate() + 1);
  else if (kind === 'weekend') t.setDate(t.getDate() + ((5 - mondayIndex(t) + 7) % 7));
  else if (kind === 'nextweek') t.setDate(t.getDate() + 7);
  else if (kind === 'monthend') t.setDate(new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate());
  return t.getTime();
}

function calHead(title, clickable) {
  return `
    <div class="cal-head">
      <button type="button" class="cal-nav" data-cal="prev" title="上一个">‹</button>
      ${clickable ? `<button type="button" class="cal-m" data-cal="${clickable}" title="快速切换">${title}</button>` : `<span class="cal-m">${title}</span>`}
      <button type="button" class="cal-nav" data-cal="next" title="下一个">›</button>
    </div>`;
}

function daysHtml() {
  const draft = state.draft;
  const sel = draft && draft.due ? startOfDay(draft.due) : 0;
  const today = startOfDay(Date.now());
  const y = cal.y;
  const m = cal.m;
  const lead = mondayIndex(new Date(y, m, 1));
  const total = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<i class="d blank"></i>');
  for (let day = 1; day <= total; day++) {
    const ms = atNoon(y, m, day);
    const key = startOfDay(ms);
    const cls = ['d'];
    if (key === today) cls.push('is-today');
    if (sel && key === sel) cls.push('is-sel');
    cells.push(`<i class="${cls.join(' ')}" data-day="${ms}">${day}</i>`);
  }
  return `${calHead(`${y} 年 ${m + 1} 月`, 'to-months')}
    <div class="cal-grid wd">${WEEK.map((w) => `<b>${w}</b>`).join('')}</div>
    <div class="cal-grid">${cells.join('')}</div>
    <div class="cal-quick">
      <button type="button" data-cal="q" data-q="today">今天</button>
      <button type="button" data-cal="q" data-q="tomorrow">明天</button>
      <button type="button" data-cal="q" data-q="weekend">本周末</button>
      <button type="button" data-cal="q" data-q="nextweek">下周</button>
      <button type="button" data-cal="q" data-q="monthend">月底</button>
      <button type="button" class="cal-clear" data-cal="clear">清除</button>
    </div>`;
}

function monthsHtml() {
  const now = new Date();
  const cells = [];
  for (let i = 0; i < 12; i++) {
    const cls = ['d'];
    if (now.getFullYear() === cal.y && now.getMonth() === i) cls.push('is-today');
    if (i === cal.m) cls.push('is-sel');
    cells.push(`<i class="${cls.join(' ')}" data-mon="${i}">${i + 1} 月</i>`);
  }
  return `${calHead(`${cal.y} 年`, 'to-years')}
    <div class="cal-grid mo">${cells.join('')}</div>`;
}

function yearsHtml() {
  const base = Math.floor(cal.y / 12) * 12;
  const now = new Date();
  const cells = [];
  for (let i = 0; i < 12; i++) {
    const y = base + i;
    const cls = ['d'];
    if (y === now.getFullYear()) cls.push('is-today');
    if (y === cal.y) cls.push('is-sel');
    cells.push(`<i class="${cls.join(' ')}" data-year="${y}">${y}</i>`);
  }
  return `${calHead(`${base} — ${base + 11}`, '')}
    <div class="cal-grid mo">${cells.join('')}</div>`;
}

function calHtml() {
  return cal.view === 'months' ? monthsHtml() : cal.view === 'years' ? yearsHtml() : daysHtml();
}

function placeCal() {
  const r = cal.anchor.getBoundingClientRect();
  // 296 = 五个快捷按钮一排放得下，窄窗口再让 flex-wrap 自己换行
  const w = Math.min(296, window.innerWidth - 16);
  cal.el.style.width = w + 'px';
  // 先量高再定位：下方放不下就朝上开，别把面板甩出窗口
  const h = cal.el.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  cal.el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  cal.el.style.top = top + 'px';
}

function showCal(view) {
  cal.view = view;
  cal.el.innerHTML = calHtml();
  placeCal();
}

function openCal(btn) {
  if (!state.draft) return;
  const base = state.draft.due ? new Date(state.draft.due) : new Date();
  cal.y = base.getFullYear();
  cal.m = base.getMonth();
  cal.view = 'days';
  cal.anchor = btn;
  if (!cal.el) {
    cal.el = document.createElement('div');
    cal.el.className = 'cal';
    cal.el.addEventListener('click', onCalClick);
    document.body.appendChild(cal.el);
  }
  cal.el.hidden = false;
  showCal('days');
}

function closeCal() {
  if (cal.el) cal.el.hidden = true;
  cal.anchor = null;
  cal.view = 'days';
}

function onCalClick(e) {
  const cell = e.target.closest('[data-day],[data-mon],[data-year]');
  if (cell) {
    if (cell.hasAttribute('data-day')) return pickDay(Number(cell.dataset.day));
    if (cell.hasAttribute('data-mon')) {
      cal.m = Number(cell.dataset.mon);
      return showCal('days');
    }
    cal.y = Number(cell.dataset.year);
    return showCal('months');
  }
  const btn = e.target.closest('[data-cal]');
  if (!btn) return;
  const kind = btn.dataset.cal;
  if (kind === 'to-months') return showCal('months');
  if (kind === 'to-years') return showCal('years');
  if (kind === 'prev' || kind === 'next') {
    const step = kind === 'next' ? 1 : -1;
    if (cal.view === 'days') {
      cal.m += step;
      if (cal.m < 0) {
        cal.m = 11;
        cal.y--;
      } else if (cal.m > 11) {
        cal.m = 0;
        cal.y++;
      }
    } else if (cal.view === 'months') {
      cal.y += step;
    } else {
      cal.y += step * 12;
    }
    return showCal(cal.view);
  }
  if (kind === 'q') return pickDay(quickDay(btn.dataset.q));
  if (kind === 'clear') return pickDay(null);
}

function pickDay(ms) {
  const d = state.draft;
  const btn = cal.anchor;
  closeCal();
  if (!d || !btn) return;
  if (!ms) {
    d.due = null;
    d.dueAllDay = false;
  } else {
    // 已经填过具体时刻就只换日期，把时分保留下来；否则记成「当天结束前」
    const keep = d.due && !d.dueAllDay ? new Date(d.due) : null;
    const base = new Date(ms);
    d.due = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      keep ? keep.getHours() : 23,
      keep ? keep.getMinutes() : 59,
      0,
      0
    ).getTime();
    d.dueAllDay = !keep;
  }
  const card = btn.closest('.card');
  const dv = btn.querySelector('.dv');
  if (dv) {
    dv.textContent = d.due ? toDateInput(d.due) : '选择日期';
    dv.classList.toggle('ph', !d.due);
  }
  paintTimeBtn(card, d);
  if (!d.due) closeTp();
  if (card) {
    const t = find(card.dataset.id);
    if (t) syncDirty(card, t);
  }
}

// ---- 自绘时间面板 ----
// 原生时间框的下拉是系统控件：小时分钟无限循环滚动，样式也动不了。
// 自己画两列固定列表：时刻 00—23 共 24 格，分钟 00—59 共 60 格，滚到头就停。
const tp = { el: null, anchor: null, hh: 0, mm: 0, dim: false };

function tpOpen() {
  return !!tp.el && !tp.el.hidden;
}

function tpCol(kind, cap, count, sel) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push(
      `<button type="button" class="tp-i${i === sel ? ' is-on' : ''}" data-tp="${kind}" data-v="${i}" aria-pressed="${i === sel}">${pad(i)}</button>`
    );
  }
  return `<div class="tp-col"><span class="tp-cap">${cap}</span><div class="tp-list">${items.join('')}</div></div>`;
}

function tpHtml() {
  // 只填了日期时不预设时刻，表头显示 --:--，免得把默认的 23:59 当成用户选的
  const h = tp.dim ? '--' : pad(tp.hh);
  const m = tp.dim ? '--' : pad(tp.mm);
  return `
    <div class="tp-cur"><span class="tp-h">${h}</span><b>:</b><span class="tp-m">${m}</span></div>
    <div class="tp-cols">${tpCol('h', '时', 24, tp.dim ? -1 : tp.hh)}${tpCol('m', '分', 60, tp.dim ? -1 : tp.mm)}</div>
    <div class="cal-quick">
      <button type="button" data-tp="now">现在</button>
      <button type="button" class="cal-clear" data-tp="clear">清除</button>
    </div>`;
}

function placeTp() {
  const r = tp.anchor.getBoundingClientRect();
  const w = Math.min(168, window.innerWidth - 16);
  tp.el.style.width = w + 'px';
  const h = tp.el.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  tp.el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  tp.el.style.top = top + 'px';
}

function centerTpList(list, i) {
  const it = list.children[i];
  if (!it) return;
  list.scrollTop = Math.max(0, it.offsetTop - list.clientHeight / 2 + it.offsetHeight / 2);
}

function paintTimeBtn(card, d) {
  const btn = card && card.querySelector('.time-btn');
  if (!btn) return;
  const v = toTimeInput(d.due, d.dueAllDay);
  const tv = btn.querySelector('.tv');
  tv.textContent = v || '选择时间';
  tv.classList.toggle('ph', !v);
  btn.disabled = !d.due;
}

function paintTp() {
  const cur = tp.el.querySelector('.tp-cur');
  cur.querySelector('.tp-h').textContent = tp.dim ? '--' : pad(tp.hh);
  cur.querySelector('.tp-m').textContent = tp.dim ? '--' : pad(tp.mm);
  // 只换高亮不重绘列表，否则滚动位置会被甩回顶部
  tp.el.querySelectorAll('.tp-i').forEach((b) => {
    const v = Number(b.dataset.v);
    const on = !tp.dim && v === (b.dataset.tp === 'h' ? tp.hh : tp.mm);
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on);
  });
}

function openTp(btn) {
  const card = btn.closest('.card');
  const t = card && find(card.dataset.id);
  const d = t && draftOf(t);
  if (!d || !d.due) return;
  const x = new Date(d.due);
  tp.hh = x.getHours();
  tp.mm = x.getMinutes();
  // 只填了日期没填时刻：默认那串 23:59 不算用户选的，列表先不高亮
  tp.dim = !!d.dueAllDay;
  tp.anchor = btn;
  if (!tp.el) {
    tp.el = document.createElement('div');
    tp.el.className = 'tp';
    tp.el.setAttribute('role', 'dialog');
    tp.el.setAttribute('aria-label', '选择截止时间');
    tp.el.addEventListener('click', onTpClick);
    document.body.appendChild(tp.el);
  }
  tp.el.hidden = false;
  tp.el.innerHTML = tpHtml();
  btn.setAttribute('aria-expanded', 'true');
  const lists = tp.el.querySelectorAll('.tp-list');
  centerTpList(lists[0], tp.hh);
  centerTpList(lists[1], tp.mm);
  placeTp();
}

function closeTp() {
  if (tp.el) tp.el.hidden = true;
  const a = tp.anchor;
  tp.anchor = null;
  if (!a) return;
  a.removeAttribute('aria-expanded');
  // 面板隐藏后焦点会掉回 body，键盘操作的人就丢了位置
  if (a.isConnected) {
    a.setAttribute('aria-expanded', 'false');
    a.focus();
  }
}

function onTpClick(e) {
  const b = e.target.closest('[data-tp]');
  if (!b) return;
  const kind = b.dataset.tp;
  const btn = tp.anchor;
  const card = btn && btn.closest('.card');
  const t = card && find(card.dataset.id);
  const d = t && draftOf(t);
  if (!d || !d.due) return closeTp();
  const dateStr = toDateInput(d.due);
  if (kind === 'clear') {
    tp.dim = true;
    const r = dueFrom(dateStr, '');
    d.due = r.due;
    d.dueAllDay = r.allDay;
  } else {
    if (kind === 'now') {
      const n = new Date();
      tp.hh = n.getHours();
      tp.mm = n.getMinutes();
    } else if (kind === 'h') {
      tp.hh = Number(b.dataset.v);
    } else {
      tp.mm = Number(b.dataset.v);
    }
    tp.dim = false;
    const r = dueFrom(dateStr, `${pad(tp.hh)}:${pad(tp.mm)}`);
    d.due = r.due;
    d.dueAllDay = r.allDay;
    // 「现在」可能把高亮甩到看不见的地方（23 点、58 分），列表要跟着滚过去
    if (kind === 'now') {
      const lists = tp.el.querySelectorAll('.tp-list');
      centerTpList(lists[0], tp.hh);
      centerTpList(lists[1], tp.mm);
    }
  }
  paintTp();
  paintTimeBtn(card, d);
  syncDirty(card, t);
}

// 面板开着的时候点外面就收起；点日期框本身交给 toggle，别在这里抢着关
document.addEventListener('pointerdown', (e) => {
  if (tpOpen() && !tp.el.contains(e.target) && !(tp.anchor && tp.anchor.contains(e.target))) closeTp();
  if (!calOpen()) return;
  if (cal.el.contains(e.target) || (cal.anchor && cal.anchor.contains(e.target))) return;
  closeCal();
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (tpOpen()) closeTp();
  else if (calOpen()) closeCal();
});

// 列表滚动、窗口改尺寸都会让锚点走位，面板跟着挪；锚点没了就收起，别飘着
function syncPanels() {
  if (tpOpen()) (tp.anchor && tp.anchor.isConnected ? placeTp() : closeTp());
  if (calOpen()) (cal.anchor && cal.anchor.isConnected ? placeCal() : closeCal());
}

listEl.addEventListener('scroll', syncPanels, { passive: true });
window.addEventListener('resize', syncPanels);

function autoGrow(el, max) {
  // 设置页显示时任务页是 display:none，量不到盒子（scrollHeight 为 0），
  // 这时候写高度会把输入框压成 20px，切回来文字就被裁掉了
  if (!el.offsetParent) return;
  el.style.height = 'auto';
  // scrollHeight 不含边框，直接赋值会差出 2px 而冒出滚动条
  const border = el.offsetHeight - el.clientHeight;
  el.style.height = Math.min(max, Math.max(el.scrollHeight + border, 20)) + 'px';
}

function growAll() {
  autoGrow(addInput, 120);
  $$('.detail textarea', listEl).forEach((el) => autoGrow(el, 260));
}

// ---- 焦点卡：列表顶部那张「最紧急」 ----
// 只挑最近一条要到期（或已逾期）的，7 天以外的不值得占这一屏最大的位置。
function focusTask(items) {
  if (state.tab !== 'active' || state.expandedId) return null;
  const now = Date.now();
  let best = null;
  items.forEach((t) => {
    if (t.due == null || t.due - now >= 7 * DAY) return;
    if (!best || t.due < best.due) best = t;
  });
  return best;
}

function focusHtml(t) {
  const now = Date.now();
  const left = t.due - now;
  const due = dueInfo(t);
  // 进度条画的是「从创建到截止走完了多少」，没有创建时间就按一小时窗口兜底，别除零
  const from = t.createdAt && t.createdAt < t.due ? t.createdAt : t.due - HOUR;
  const pct = Math.max(3, Math.min(100, Math.round(((now - from) / (t.due - from)) * 100)));
  const preview = previewText(t);
  return `
  <div class="card focus glass p-${t.priority}" data-id="${t.id}" data-act="open">
    <div class="f-k${left > 2 * DAY ? ' calm' : ''}">${CLOCK}最紧急 · ${esc(remainText(t.due, now))}</div>
    <div class="f-h">${esc(t.title)}</div>
    ${preview ? `<div class="f-d">${esc(preview)}</div>` : ''}
    <div class="f-cd">
      <span class="c">${CAL}${esc(fmtCreated(t.createdAt))} 创建</span>
      <span class="bar${left > 2 * DAY ? ' safe' : ''}"><i style="width:${pct}%"></i></span>
      <span class="t${left < 0 ? ' over' : ''}">${esc(due.text.replace(/^截止 /, ''))} 到期</span>
    </div>
    <div class="f-acts">
      <button class="btn-teal" data-act="done">标记完成</button>
      <button class="btn-o" data-act="open" title="展开编辑">${PEN}</button>
    </div>
  </div>`;
}

// ---- 时间轴分组 ----
// 规则按顺序命中即止，所以「已逾期」必须排在「今天」前面：
// 昨天下午到期的一条按自然日差算是 0 天，会被误判成今天要做的。
function dayGap(ms, now) {
  return Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
}

const GROUPS_ACTIVE = [
  ['已逾期', 'var(--danger)', (t, now) => t.due != null && t.due < now],
  ['今天', 'var(--blue)', (t, now) => t.due != null && dayGap(t.due, now) === 0],
  ['明天', 'var(--blue)', (t, now) => t.due != null && dayGap(t.due, now) === 1],
  ['本周稍后', 'var(--violet)', (t, now) => t.due != null && dayGap(t.due, now) <= 7],
  ['30 天内', 'var(--teal)', (t, now) => t.due != null && dayGap(t.due, now) <= 30],
  ['更晚', 'var(--txt4)', (t) => t.due != null],
  ['未设截止', 'var(--txt4)', () => true]
];

const GROUPS_DONE = [
  ['今天完成', 'var(--teal)', (t, now) => dayGap(t.completedAt || t.createdAt, now) === 0],
  ['昨天完成', 'var(--teal)', (t, now) => dayGap(t.completedAt || t.createdAt, now) === 1],
  ['本周更早', 'var(--blue)', (t, now) => dayGap(t.completedAt || t.createdAt, now) <= 6],
  ['更早', 'var(--txt4)', () => true]
];

function groupsHtml(list) {
  const now = Date.now();
  const rules = state.tab === 'done' ? GROUPS_DONE : GROUPS_ACTIVE;
  const out = [];
  let rest = list;
  rules.forEach(([name, color, hit]) => {
    if (!rest.length) return;
    const bucket = [];
    const keep = [];
    rest.forEach((t) => (hit(t, now) ? bucket : keep).push(t));
    rest = keep;
    if (!bucket.length) return;
    out.push(
      `<div class="grp"><span class="dot" style="background:${color};box-shadow:0 0 8px ${color}"></span><span class="name">${name}</span><span class="cnt">${bucket.length}</span><span class="line"></span></div>`
    );
    out.push(bucket.map(cardHtml).join(''));
  });
  return out.join('');
}

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function updateHeader() {
  const now = new Date();
  $('#hdr-date').innerHTML = `${now.getMonth() + 1} 月 ${now.getDate()} 日<em>${WEEK_CN[now.getDay()]}</em>`;
  const act = state.tasks.filter((t) => !t.done);
  const ms = Date.now();
  const over = act.filter((t) => t.due != null && t.due < ms).length;
  const high = act.filter((t) => t.priority === 'high').length;
  const bits = [`${act.length} 项待办`];
  if (over) bits.push(`<b>${over} 项已逾期</b>`);
  if (high) bits.push(`高优先级 ${high} 项`);
  $('#hdr-sub').innerHTML = bits.join(' · ');
  const done = state.tasks.length - act.length;
  $('#hdr-fill').style.width = (state.tasks.length ? Math.round((done / state.tasks.length) * 100) : 0) + '%';
  $('#hdr-num').textContent = `已完成 ${done} / ${state.tasks.length}`;
}

function syncDock() {
  const act = state.tasks.filter((t) => !t.done).length;
  const done = state.tasks.length - act;
  $('#dock-active').textContent = `待办 ${act}`;
  $('#dock-done').textContent = `已完成 ${done}`;
  $$('.d-i').forEach((b) => {
    const on =
      b.dataset.view === 'settings' ? state.view === 'settings' : state.view === 'tasks' && b.dataset.tab === state.tab;
    b.classList.toggle('is-on', on);
  });
}

function render() {
  // 卡片整段重绘，锚点已经没了，面板留着会飘在原地
  closeCal();
  closeTp();
  const scroll = listEl.scrollTop;
  const items = visibleTasks();
  const fc = focusTask(items);
  const rest = fc ? items.filter((t) => t !== fc) : items;
  listEl.innerHTML = (fc ? focusHtml(fc) : '') + groupsHtml(rest);
  const none = items.length === 0;
  emptyEl.hidden = !none;
  if (none) emptyEl.textContent = state.tab === 'done' ? '还没有已完成的任务' : '暂无待办，先添加一条';
  // 已完成只用来查看，新任务从「待办」加，所以这一栏不需要输入框，把高度让给列表
  document.body.classList.toggle('tab-done', state.tab === 'done');
  growAll();
  $$('.card', listEl).forEach((card) => {
    const t = find(card.dataset.id);
    if (t) syncDirty(card, t);
  });
  updateHeader();
  syncDock();
  listEl.scrollTop = scroll;
}

let persistSeq = 0;

// 主进程可能在这次往返期间给任务打了 overdueAcked（逾期提醒点过「确定」），
// 所以拿它的返回值把本地副本对齐一次，不然本地那份永远缺这个字段。
// 只有最后一次请求的结果才算数：连点两下时先发的响应回来得更早，
// 无条件覆盖会把后发（更新）的状态顶掉。
async function persist() {
  const seq = ++persistSeq;
  const saved = await bridge.setTasks(state.tasks);
  if (seq === persistSeq && Array.isArray(saved)) state.tasks = saved;
}

function patchSetting(partial) {
  bridge.patchSettings(partial);
}

function toggleOpen(id) {
  if (state.expandedId === id) {
    state.expandedId = null;
    state.draft = null;
  } else {
    state.expandedId = id;
    const t = find(id);
    if (t) beginDraft(t);
  }
  patchSetting({ expandedId: state.expandedId });
  render();
}

function find(id) {
  return state.tasks.find((t) => t.id === id);
}

// 离线取标题：首行 → 截到第一个句末标点 → 再按字数上限截断
function deriveTitle(raw) {
  const first = (raw.split('\n').find((l) => l.trim()) || '').trim();
  const seg = (first.split(/[。！？!?；;]/)[0] || '').trim();
  const base = (seg || first).replace(/^[-•*、\s]+/, '');
  const chars = [...base];
  return (chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join('') : base).trim();
}

function addTask() {
  const raw = addInput.value.trim();
  if (!raw) return;
  state.tasks.push({
    id: uid(),
    title: deriveTitle(raw) || '未命名待办',
    detail: raw,
    priority: 'mid',
    due: null,
    dueAllDay: false,
    createdAt: Date.now(),
    done: false,
    completedAt: null
  });
  addInput.value = '';
  autoGrow(addInput, 120);
  persist();
  render();
}

function setTab(tab) {
  state.tab = tab;
  patchSetting({ tab });
  render();
}

function showView(view) {
  state.view = view;
  closeCal();
  closeTp();
  document.body.classList.toggle('showing-settings', view === 'settings');
  $('#view-tasks').hidden = view !== 'tasks';
  $('#view-settings').hidden = view !== 'settings';
  syncDock();
  // 隐藏期间改过窗口尺寸的话，输入框高度是按旧宽度算的，回来重算一次
  if (view === 'tasks') growAll();
}

function applySnap(st) {
  const hidden = st.mode === 'hidden';
  document.body.classList.toggle('snap-right', hidden && st.side === 'right');
  document.body.classList.toggle('snap-left', hidden && st.side === 'left');
  document.body.classList.toggle('snap-top', hidden && st.side === 'top');
  const sideName = { left: '屏幕左侧', right: '屏幕右侧', top: '屏幕顶部' };
  const label = st.mode === 'free' ? '未吸附' : '已吸附：' + (sideName[st.side] || '屏幕边缘');
  const el = $('#set-snap');
  if (el) el.textContent = label;
}

// 数据文件读不出来时主进程已经自动把原件备份走了，但界面如果一声不吭，
// 用户只会看到「待办全没了」，多半以为是自己误删。所以顶部留一条说明。
function paintDataWarn(list) {
  const el = $('#data-warn');
  if (!el) return;
  if (!Array.isArray(list) || !list.length) {
    el.hidden = true;
    return;
  }
  const base = (p) => String(p).split(/[\\/]/).pop();
  const parts = list.map((w) =>
    w.backup
      ? `${base(w.file)} 读不出来，原件已备份为 ${base(w.backup)}`
      : `${base(w.file)} 读不出来，且备份失败，请先手动复制一份再继续`
  );
  el.textContent = `数据文件有问题：${parts.join('；')}。本次以默认内容启动，请核对后再继续使用。`;
  el.hidden = false;
}

function tierOf() {
  const w = window.innerWidth;
  return w < 420 ? 'narrow' : w < 640 ? 'mid' : 'wide';
}

function applyTier() {
  const tier = tierOf();
  if (tier === state.tier) return false;
  document.body.classList.remove('w-narrow', 'w-mid', 'w-wide');
  document.body.classList.add('w-' + tier);
  state.tier = tier;
  return true;
}

listEl.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const t = find(card.dataset.id);
  if (!t) return;
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const kind = act.dataset.act;
  if (kind === 'done') {
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
    persist();
    render();
  } else if (kind === 'set-prio') {
    const d = draftOf(t);
    if (!d) return;
    d.priority = act.dataset.p;
    $$('.btn[data-act="set-prio"]', card).forEach((b) => b.classList.toggle('is-on', b.dataset.p === d.priority));
    syncDirty(card, t);
  } else if (kind === 'save') {
    commitDraft();
  } else if (kind === 'cancel') {
    closeEditor();
  } else if (kind === 'del') {
    state.tasks = state.tasks.filter((x) => x.id !== t.id);
    if (state.expandedId === t.id) {
      state.expandedId = null;
      state.draft = null;
      patchSetting({ expandedId: null });
    }
    persist();
    render();
  } else if (kind === 'open') {
    toggleOpen(t.id);
  } else if (kind === 'pick-date') {
    if (calOpen() && cal.anchor === act) closeCal();
    else {
      closeTp();
      openCal(act);
    }
  } else if (kind === 'pick-time') {
    if (tpOpen() && tp.anchor === act) closeTp();
    else {
      closeCal();
      openTp(act);
    }
  }
});

listEl.addEventListener('input', (e) => {
  const card = e.target.closest('.card');
  const t = card && find(card.dataset.id);
  const d = t && draftOf(t);
  if (!d) return;
  const f = e.target.dataset.f;
  if (f === 'title') d.title = e.target.value.slice(0, 200);
  else if (f === 'detail') {
    d.detail = e.target.value;
    autoGrow(e.target, 260);
  } else return;
  syncDirty(card, t);
});

addInput.addEventListener('input', () => autoGrow(addInput, 120));
addInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    addTask();
  }
});

$('#add-btn').addEventListener('click', addTask);
$('#btn-close').addEventListener('click', () => bridge.hide());
$('#btn-close-2').addEventListener('click', () => bridge.hide());

$$('.d-i').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.view === 'settings') return showView('settings');
    showView('tasks');
    setTab(b.dataset.tab);
  })
);

// 手风琴：整行都能点，但行里的开关 / 主题按钮 / 弹窗预览要留给控件自己
$$('.acc-h').forEach((h) =>
  h.addEventListener('click', (e) => {
    if (e.target.closest('button, input, .seg')) return;
    h.parentElement.classList.toggle('is-open');
  })
);

// 勾选状态以主进程回读到的结果为准：写不进启动项时把勾退回未开启，别让用户看到假的「已开启」
$('#set-autostart').addEventListener('change', async (e) => {
  const want = e.target.checked;
  const s = await bridge.patchSettings({ autoStart: want });
  const ok = !!s.autoStart;
  e.target.checked = ok;
  $('#autostart-warn').hidden = ok || !want;
});

$('#set-test-remind').addEventListener('click', () => bridge.testRemind());

// ---------- 主题 ----------
// 分组标题下那行摘要：收起来也要看得见当前主题和透明度
function paintAppearanceSum() {
  const el = $('#set-appearance-sum');
  if (el) {
    el.textContent =
      (document.body.classList.contains('dark') ? '深色' : '浅色') + ' · 透明度 ' + $('#set-opacity').textContent;
  }
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  if (dark !== document.body.classList.contains('dark')) document.body.classList.toggle('dark', dark);
  $$('#set-theme .btn').forEach((b) => b.classList.toggle('is-on', (b.dataset.theme === 'dark') === dark));
  paintAppearanceSum();
}

$$('#set-theme .btn').forEach((b) =>
  b.addEventListener('click', () => {
    applyTheme(b.dataset.theme);
    bridge.patchSettings({ theme: b.dataset.theme });
  })
);

// ---------- 内存清理悬浮球 ----------
$('#set-ball').addEventListener('change', async (e) => {
  const s = await bridge.patchSettings({ ball: e.target.checked });
  e.target.checked = !!s.ball;
});

// ---------- 窗口透明度 ----------
const opacityRange = $('#set-opacity-range');
const opacityValue = $('#set-opacity');

function paintSlider(pct) {
  opacityRange.style.setProperty('--fill', pct + '%');
  opacityValue.textContent = pct + '%';
  paintAppearanceSum();
}

opacityRange.addEventListener('input', () => {
  const pct = Number(opacityRange.value);
  paintSlider(pct);
  bridge.setOpacity(pct / 100);
});

// ---------- 自绘缩放手柄 ----------
const MIN_W = 300;
const MIN_H = 340;

function resizeBounds(b, dir, dx, dy) {
  let left = b.x;
  let top = b.y;
  let right = b.x + b.width;
  let bottom = b.y + b.height;
  if (dir.includes('w')) left = b.x + dx;
  if (dir.includes('e')) right = b.x + b.width + dx;
  if (dir.includes('n')) top = b.y + dy;
  if (dir.includes('s')) bottom = b.y + b.height + dy;
  if (right - left < MIN_W) {
    if (dir.includes('w')) left = right - MIN_W;
    else right = left + MIN_W;
  }
  if (bottom - top < MIN_H) {
    if (dir.includes('n')) top = bottom - MIN_H;
    else bottom = top + MIN_H;
  }
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

let rz = null;
// 「按下已经发出、getBounds() 还没回来」这段窗口期里，正被按住的那个手柄。
// 它同时充当两个角色：这一趟是否还有效的令牌，以及松手时要清掉高亮的那个元素。
let rzPendingEl = null;
let rzFrame = 0;
let rzDelta = null;

function rzFlush() {
  rzFrame = 0;
  if (!rz || !rzDelta) return;
  // 顺手续租：万一 pointerup 丢在窗口外，主进程也只按「最后一次动静」计时，不会长期冻住收起
  bridge.resizeState(true);
  // dir 一并交给主进程：贴边夹取时它必须知道用户拖的是哪条边，
  // 否则只能按原点整体夹，拖左/上边缘拉到贴边会把对面那条边一起拖走。
  bridge.resizeTo(resizeBounds(rz.b, rz.dir, rzDelta.dx, rzDelta.dy), rz.dir);
  rzDelta = null;
}

// 收尾必须能处理「rz 还没赋值」的情况：原来这里第一句就是 if (!rz) return，
// 于是松手早于 getBounds 兑现时，is-active 高亮和 body.resizing 全都没被清掉。
function endResize() {
  bridge.resizeState(false);
  cancelAnimationFrame(rzFrame);
  rzFrame = 0;
  rzDelta = null;
  if (rzPendingEl) {
    rzPendingEl.classList.remove('is-active');
    rzPendingEl = null;
  }
  if (rz) {
    rz.el.classList.remove('is-active');
    rz = null;
  }
  document.body.classList.remove('resizing');
}

// 缩放的起点和增量一律用屏幕坐标（screenX/screenY），不能用 clientX/clientY。
// clientX 是相对客户区的：拖右/下边缘时窗口原点不动，鼠标走 1px 增量也是 1px，看着没问题；
// 但拖左/上边缘时窗口自己也在朝鼠标方向移动，客户区坐标系跟着平移，增量只剩
// 「鼠标位移 − 窗口位移」，成了负反馈，永远追不上（实测跟随率：右边 100%、下边 100%、
// 左边 80%、上边 60%、左上角只剩 40%；手感就是「从左边/上边拉窗口黏手、拉不快」）。
// 起点和增量必须用同一套坐标系，只改一处会比现在更糟。
$$('.rsz').forEach((el) => {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || rz) return;
    e.preventDefault();
    // 先告诉主进程「我在缩放」，吸附状态期间不要碰窗口
    bridge.resizeState(true);
    // 捕获只是锦上添花：move/up 一律挂在 window 上，丢捕获也不会漏。
    // 必须 once —— 这个监听原来是在每次 pointerdown 里新加的、从不移除，
    // 而 endResize 每次都会发一条 resizeState(false) 的 IPC，拖过 N 次之后
    // 每次松手就会发 N 条。长驻软件里会一直涨。
    if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
    el.addEventListener('lostpointercapture', endResize, { once: true });
    el.classList.add('is-active');
    rzPendingEl = el;
    const x0 = e.screenX;
    const y0 = e.screenY;
    // getBounds() 是一次 IPC 往返（实测 p50 0.3ms、p99 1.4ms）。这期间用户要是已经松手，
    // pointerup 会先跑 endResize 把这一趟作废；晚到的 promise 再把 rz 和 body.resizing 补上，
    // 就成了「不按鼠标移动指针也在改窗口大小」。所以兑现时先核对令牌，作废的直接丢弃。
    bridge.getBounds().then((b) => {
      if (rzPendingEl !== el) return;
      rzPendingEl = null;
      if (!b) return bridge.resizeState(false);
      rz = { el, dir: el.dataset.dir, b, x0, y0 };
      document.body.classList.add('resizing');
    });
  });
});

window.addEventListener('pointermove', (e) => {
  if (!rz) return;
  // 兜底：只看 rz 的话，一旦 pointerup 整个丢了（丢在窗口外、被别的程序吃掉），
  // 之后单纯移动指针就会一直改窗口大小。按键已经松开就直接收尾。
  if (e.buttons === 0) return endResize();
  rzDelta = { dx: e.screenX - rz.x0, dy: e.screenY - rz.y0 };
  if (!rzFrame) rzFrame = requestAnimationFrame(rzFlush);
});
window.addEventListener('pointerup', endResize);
window.addEventListener('pointercancel', endResize);
window.addEventListener('blur', endResize);

// 只有真正的文字输入才算「编辑中」。滑块拿到焦点后不会失焦，把它算进来会让窗口永远不收。
function isTextField(el) {
  // 只放行文字框：滑块拿到焦点后不会失焦，那些框要能直接敲键盘改，
  // 这些一律不算「编辑中」，否则鼠标移出界面窗口收不起来。
  return !!el && el.matches('textarea, input[type="text"]');
}

// 日历 / 时间面板是我们自己画的浮层，鼠标移过去选日期就等于离开了卡片的范围，
// 按「移出界面」收起会把面板晾在半空。面板开着时锁住窗口：
// 心跳每秒续一次租约，面板收起后靠租约到期自然收起。
const DATE_LEASE_MS = 8000;

function holdsWindow(el) {
  return isTextField(el) || calOpen() || tpOpen();
}

setInterval(() => {
  if (calOpen() || tpOpen()) bridge.setEditing(true, DATE_LEASE_MS);
}, 1000);

document.addEventListener('focusin', (e) => {
  if (isTextField(e.target)) bridge.setEditing(true);
});
document.addEventListener('keydown', (e) => {
  if (isTextField(e.target)) bridge.setEditing(true);
});
document.addEventListener('input', (e) => {
  if (isTextField(e.target)) bridge.setEditing(true);
});
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!holdsWindow(document.activeElement)) bridge.setEditing(false);
  }, 80);
});

// 原生拖拽边框缩放走系统模态循环，期间页面收不到 pointer 事件。
// 因此「尺寸停止变化 + 鼠标重新移动」才等价于松开左键，此时才换档重排，按住不动时版面不跳。
let lastResizeAt = 0;
let lastPointerAt = 0;
let reflowTimer = null;
let reflowWaiting = false;

function applyReflow() {
  reflowWaiting = false;
  if (applyTier() && !state.expandedId) render();
}

function scheduleReflow() {
  clearTimeout(reflowTimer);
  reflowTimer = setTimeout(() => {
    if (lastPointerAt > lastResizeAt) applyReflow();
    else {
      reflowWaiting = true;
      reflowTimer = setTimeout(applyReflow, 1200);
    }
  }, 140);
}

window.addEventListener('resize', () => {
  lastResizeAt = Date.now();
  growAll();
  scheduleReflow();
});
window.addEventListener(
  'pointermove',
  () => {
    lastPointerAt = Date.now();
    if (reflowWaiting) {
      clearTimeout(reflowTimer);
      applyReflow();
    }
  },
  true
);

async function boot() {
  state.tasks = await bridge.getTasks();
  const s = await bridge.getSettings();
  state.tab = s.tab === 'done' ? 'done' : 'active';
  state.expandedId = s.expandedId || null;
  $('#set-autostart').checked = !!s.autoStart;
  $('#set-ball').checked = !!s.ball;
  applyTheme(s.theme === 'dark' ? 'dark' : 'light');
  $('#set-data').textContent = s.dataDir;
  $('#set-config').textContent = s.configDir;
  $('#set-version').textContent = 'V' + s.version;
  paintDataWarn(s.loadWarnings);
  const pct = Math.round(Math.max(0.5, Math.min(1, Number(s.opacity) || 1)) * 100);
  opacityRange.value = String(pct);
  paintSlider(pct);
  bridge.onSnap(applySnap);
  // 主进程独立改过任务数据（提醒弹窗点「确定」给逾期任务打了标记）时，把本地副本整个换掉。
  // 正在编辑就不重绘，免得输入焦点和草稿被冲掉 —— 草稿是按 id 找任务的，换掉数组也不影响它。
  bridge.onTasksChanged((tasks) => {
    if (!Array.isArray(tasks)) return;
    state.tasks = tasks;
    if (!state.expandedId) render();
  });
  bridge.onTray((kind) => {
    showView('tasks');
    if (kind === 'new') addInput.focus();
    else showView('settings');
  });
  applySnap(await bridge.snapState());
  applyTier();
  const opened = state.expandedId && find(state.expandedId);
  if (opened) beginDraft(opened);
  render();
  // 「剩 4 小时」「今天到期」这些都是按当下算出来的，放着不动会越看越旧。
  // 编辑中 / 面板开着时不重绘，否则输入焦点和锚点都没了。
  setInterval(() => {
    if (!state.expandedId && !calOpen() && !tpOpen()) render();
  }, 60000);
}

boot();
