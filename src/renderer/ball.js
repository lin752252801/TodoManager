const el = document.getElementById('ball');
const pctEl = document.getElementById('pct');
const capEl = document.getElementById('cap');

let lastPct = null;
let holdTimer = null;

function paintPct(pct) {
  lastPct = pct;
  pctEl.classList.remove('done');
  capEl.textContent = '';
  pctEl.textContent = pct.toFixed(1) + '%';
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
    // 必须把它清空：apply() 拿 holdTimer 当「结果展示中」的开关，
    // 不清空的话清理过一次之后占用就永远不再刷新到球上
    holdTimer = null;
    if (lastPct != null) paintPct(lastPct);
  }, 2600);
}

function apply(u) {
  if (!u || !Number.isFinite(u.pct)) return;
  // 清理结果要在球上停一会儿，别让一秒一次的占用轮询把它冲掉
  if (holdTimer) {
    lastPct = u.pct;
    return;
  }
  paintPct(u.pct);
}

ball.onUsage(apply);
ball.usage().then(apply);

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

// 拖动只报「相对按下点移了多少像素」，主进程把这个位移加到按下当刻的窗口位置上。
// 位移取事件自带的 screenX 差值：事件就算在队列里堵了一百毫秒，它记的仍是手指按下那一刻的坐标，
// 所以甩得多远就跟得多远，不会出现「球落在鼠标后面一大截」；
// 而松手事件在原生鼠标捕获下一定能收到，光标早跑出这颗 56px 的球也一样。
let down = false;
let grab = null;
let pend = null;
let raf = 0;

function flush() {
  raf = 0;
  if (!pend || !down) return;
  const p = pend;
  pend = null;
  ball.dragMove(p.dx, p.dy, p.cx, p.cy);
}

el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  down = true;
  grab = { x: e.screenX, y: e.screenY };
  pend = null;
  el.setPointerCapture(e.pointerId);
  ball.dragStart();
});

window.addEventListener('pointermove', (e) => {
  if (!down || !grab) return;
  pend = { dx: e.screenX - grab.x, dy: e.screenY - grab.y, cx: e.clientX, cy: e.clientY };
  if (!raf) raf = requestAnimationFrame(flush);
});

// 松手一定要把最后一次位移补上：不然球会差着鼠标那一小段停住
async function up(e, allowClean) {
  if (!down) return;
  const last = grab
    ? { dx: e.screenX - grab.x, dy: e.screenY - grab.y, cx: e.clientX, cy: e.clientY }
    : pend;
  down = false;
  grab = null;
  pend = null;
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  if (last) ball.dragMove(last.dx, last.dy, last.cx, last.cy);
  if (!(await ball.dragEnd())) {
    if (allowClean) clean();
  }
}

window.addEventListener('pointerup', (e) => up(e, true));
window.addEventListener('pointercancel', (e) => up(e, false));
