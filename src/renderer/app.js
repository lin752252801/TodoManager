const bridge = window.api;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const DAY = 86400000;
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

// 截止时间的三态：普通 / 临近(≤2天) / 逾期
function dueInfo(t) {
  const ms = t.due;
  const now = Date.now();
  const narrow = state.tier === 'narrow';
  const d = new Date(ms);
  const hm = t.dueAllDay ? '' : ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ms < now) {
    const over = Math.max(1, Math.ceil((now - ms) / DAY));
    return { cls: 'due-over', text: `已逾期：${over}天` };
  }
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const dateStr = narrow
    ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    : sameYear
      ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}${hm}`
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const rel = days === 0 ? `今天${hm}` : days === 1 ? `明天${hm}` : days === 2 ? `后天${hm}` : dateStr;
  return { cls: days <= 2 ? 'due-soon' : '', text: `截止 ${rel}` };
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
  <article class="card p-${t.priority} ${open ? 'is-open' : ''} ${t.done ? 'is-done' : ''}" data-id="${t.id}" data-act="open">
    <div class="row">
      <button class="check" data-act="done" title="${t.done ? '移回待办' : '标记完成'}">${TICK}</button>
      <div class="t-title">${esc(t.title)}</div>
      <span class="pill" title="点击展开后可修改优先级"><i class="pdot"></i>${PRIO_LABEL[t.priority]}</span>
      <span class="chev">${CHEV}</span>
    </div>
    ${preview ? `<div class="pline">${esc(preview)}</div>` : ''}
    <div class="meta">
      <span class="created">${CAL}${esc(fmtCreated(t.createdAt))}</span>
      ${due ? `<span class="due ${due.cls}">${CLOCK}${esc(due.text)}</span>` : ''}
    </div>
    ${open ? detailHtml(t) : ''}
  </article>`;
}

function detailHtml(t) {
  const d = draftOf(t) || t;
  return `
  <div class="detail" data-act="noop">
    <label class="field"><span>标题（建议 ${TITLE_MAX} 字以内）</span><input type="text" maxlength="60" data-f="title" value="${esc(d.title)}" placeholder="一句话说明" /></label>
    <label class="field"><span>详细内容</span><textarea data-f="detail" placeholder="补充说明…">${esc(d.detail == null ? '' : d.detail)}</textarea></label>
    <div class="detail-grid">
      <div class="field">
        <span>截止日期（时间可留空）</span>
        <div class="due-row">
          <button type="button" class="date-btn" data-act="pick-date" title="选择截止日期">
            <span class="dv${d.due ? '' : ' ph'}">${d.due ? toDateInput(d.due) : '选择日期'}</span>${CAL}
          </button>
          <button type="button" class="time-btn" data-act="pick-time" title="选择截止时间" aria-haspopup="dialog" aria-expanded="false"${d.due ? '' : ' disabled'}>
            <span class="tv${toTimeInput(d.due, d.dueAllDay) ? '' : ' ph'}">${toTimeInput(d.due, d.dueAllDay) || '选择时间'}</span>${CLOCK}
          </button>
        </div>
      </div>
      <div class="field"><span>优先级</span>
        <div class="acts">
          ${['high', 'mid', 'low']
            .map((p) => `<button class="btn ${d.priority === p ? 'is-on' : ''}" data-act="set-prio" data-p="${p}">${PRIO_LABEL[p]}</button>`)
            .join('')}
        </div>
      </div>
    </div>
    <div class="acts">
      <span class="stamp">创建时间：${fmtStamp(t.createdAt)}</span>
      ${t.done ? `<span class="stamp">完成时间：${fmtStamp(t.completedAt)}</span>` : ''}
    </div>
    <div class="acts confirm">
      <span class="dirty-tip">有未确认的修改</span>
      <span class="confirm-btns">
        <button class="btn btn-primary" data-act="save" disabled>确定</button>
        <button class="btn btn-ghost" data-act="cancel">取消</button>
        <button class="btn btn-danger" data-act="del">删除</button>
      </span>
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

function render() {
  // 卡片整段重绘，锚点已经没了，面板留着会飘在原地
  closeCal();
  closeTp();
  const scroll = listEl.scrollTop;
  const items = visibleTasks();
  listEl.innerHTML = items.map(cardHtml).join('');
  const none = items.length === 0;
  emptyEl.hidden = !none;
  if (none) emptyEl.textContent = state.tab === 'done' ? '还没有已完成的任务' : '暂无待办，先添加一条';
  growAll();
  $$('.card', listEl).forEach((card) => {
    const t = find(card.dataset.id);
    if (t) syncDirty(card, t);
  });
  listEl.scrollTop = scroll;
}

function persist() {
  bridge.setTasks(state.tasks);
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
  $$('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  patchSetting({ tab });
  render();
}

function showView(view) {
  state.view = view;
  closeCal();
  closeTp();
  $$('.rail-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  $('#view-tasks').hidden = view !== 'tasks';
  $('#view-settings').hidden = view !== 'settings';
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

$$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
$$('.rail-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

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
function applyTheme(theme) {
  const dark = theme === 'dark';
  if (dark !== document.body.classList.contains('dark')) document.body.classList.toggle('dark', dark);
  $$('#set-theme .btn').forEach((b) => b.classList.toggle('is-on', (b.dataset.theme === 'dark') === dark));
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
let rzFrame = 0;
let rzDelta = null;

function rzFlush() {
  rzFrame = 0;
  if (!rz || !rzDelta) return;
  // 顺手续租：万一 pointerup 丢在窗口外，主进程也只按「最后一次动静」计时，不会长期冻住收起
  bridge.resizeState(true);
  bridge.resizeTo(resizeBounds(rz.b, rz.dir, rzDelta.dx, rzDelta.dy));
  rzDelta = null;
}

$$('.rsz').forEach((el) => {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || rz) return;
    e.preventDefault();
    // 先告诉主进程「我在缩放」，吸附状态期间不要碰窗口
    bridge.resizeState(true);
    // 捕获只是锦上添花：move/up 一律挂在 window 上，丢捕获也不会漏
    if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
    el.addEventListener('lostpointercapture', endResize);
    el.classList.add('is-active');
    const x0 = e.clientX;
    const y0 = e.clientY;
    bridge.getBounds().then((b) => {
      rz = { el, dir: el.dataset.dir, b, x0, y0 };
      document.body.classList.add('resizing');
    });
  });
});

function endResize() {
  bridge.resizeState(false);
  if (!rz) return;
  cancelAnimationFrame(rzFrame);
  rzFrame = 0;
  rzDelta = null;
  rz.el.classList.remove('is-active');
  rz = null;
  document.body.classList.remove('resizing');
}

window.addEventListener('pointermove', (e) => {
  if (!rz) return;
  rzDelta = { dx: e.clientX - rz.x0, dy: e.clientY - rz.y0 };
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
  $$('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === state.tab));
  $('#set-autostart').checked = !!s.autoStart;
  $('#set-ball').checked = !!s.ball;
  applyTheme(s.theme === 'dark' ? 'dark' : 'light');
  $('#set-data').textContent = s.dataDir;
  $('#set-config').textContent = s.configDir;
  $('#set-version').textContent = 'V' + s.version;
  const pct = Math.round(Math.max(0.5, Math.min(1, Number(s.opacity) || 1)) * 100);
  opacityRange.value = String(pct);
  paintSlider(pct);
  bridge.onSnap(applySnap);
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
}

boot();
