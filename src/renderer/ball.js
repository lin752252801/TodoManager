const el = document.getElementById('ball');
const pctEl = document.getElementById('pct');
const capEl = document.getElementById('cap');

let lastPct = null;
let holdTimer = null;

function paintPct(pct) {
  lastPct = pct;
  pctEl.classList.remove('done');
  capEl.textContent = '';
  pctEl.textContent = pct + '%';
}

function showResult(mb) {
  clearTimeout(holdTimer);
  pctEl.classList.add('done');
  if (mb > 0) {
    capEl.textContent = '已释放';
    pctEl.textContent = mb >= 1024 ? (mb / 1024).toFixed(1) + 'G' : mb + 'M';
  } else {
    capEl.textContent = '';
    pctEl.textContent = '已整理';
  }
  holdTimer = setTimeout(() => {
    if (lastPct != null) paintPct(lastPct);
  }, 2600);
}

function apply(u) {
  if (!u || !Number.isFinite(u.pct)) return;
  // 清理结果要在球上停一会儿，别让 2 秒一次的占用轮询把它冲掉
  if (holdTimer) {
    lastPct = u.pct;
    return;
  }
  paintPct(u.pct);
}

ball.onUsage(apply);
ball.usage().then(apply);

let start = null;
let last = null;
let dragging = false;

el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  start = { x: e.screenX, y: e.screenY };
  last = start;
  dragging = false;
  el.setPointerCapture(e.pointerId);
});

el.addEventListener('pointermove', (e) => {
  if (!start) return;
  if (!dragging && Math.abs(e.screenX - start.x) + Math.abs(e.screenY - start.y) > 5) dragging = true;
  if (!dragging) return;
  const dx = e.screenX - last.x;
  const dy = e.screenY - last.y;
  last = { x: e.screenX, y: e.screenY };
  if (dx || dy) ball.move(dx, dy);
});

let busy = false;

async function clean() {
  if (busy) return;
  busy = true;
  el.classList.add('busy');
  try {
    const r = await ball.trim();
    showResult(r && r.mb > 0 ? r.mb : 0);
  } finally {
    el.classList.remove('busy');
    busy = false;
  }
}

function up() {
  if (!start) return;
  const wasDrag = dragging;
  start = null;
  dragging = false;
  if (!wasDrag) clean();
}

el.addEventListener('pointerup', up);
el.addEventListener('pointercancel', () => {
  start = null;
  dragging = false;
});
