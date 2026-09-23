if (new URLSearchParams(location.search).get('th') === 'dark') document.body.classList.add('dark');

const p = (window.remind && window.remind.payload()) || null;

function setText(id, v) {
  const el = document.getElementById(id);
  if (v) el.textContent = v;
  else el.style.display = 'none';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

if (p && p.list) {
  document.getElementById('h').textContent = '待办任务截止提醒';
  const body = document.getElementById('body');
  body.style.alignContent = 'stretch';
  const stat = `共 ${p.items.length} 项需要关注${p.od ? `，其中 ${p.od} 项已逾期` : ''}`;
  const rows = p.items
    .map(
      (i) => `
      <div class="row${i.overdue ? ' od' : ''}">
        <div class="n" title="${esc(i.title)}">${esc(i.title)}</div>
        <div class="m"><span class="t">${esc(i.dueText)}</span><span class="s">${esc(i.note)}</span></div>
      </div>`
    )
    .join('');
  body.innerHTML = `<div class="stat">${esc(stat)}</div><div class="list">${rows}</div>`;
} else if (p) {
  document.getElementById('h').textContent = p.overdue ? '待办任务已截止' : '待办任务即将截止';
  if (p.overdue) document.getElementById('card').classList.add('is-over');
  setText('due', p.dueText);
  setText('note', p.note ? `（${p.note}）` : '');
  setText('name', p.title);
  setText('more', p.more ? `还有 ${p.more} 项待提醒` : '');
}

const later = () => window.remind.answer('later');
document.getElementById('later').addEventListener('click', later);
document.getElementById('x').addEventListener('click', later);
document.getElementById('ok').addEventListener('click', () => window.remind.answer('ok'));
