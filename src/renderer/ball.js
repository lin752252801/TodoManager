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

// 拖动只报「从哪儿抓的」和「松手了」，挪窗口的事交给主进程按全局光标位置驱动：
// 球只有 56px，靠页面里的 mousemove 增量挪，鼠标一快就脱手，长按状态还会永远卡住。
// 所以按下当场就把主进程挂上，是否真拖过由主进程回答（它才看得到全局光标）。
let down = null;

el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  down = true;
  el.setPointerCapture(e.pointerId);
  ball.dragStart(e.clientX, e.clientY, e.screenX, e.screenY);
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

async function up() {
  if (!down) return;
  down = null;
  if (!(await ball.dragEnd())) clean();
}

el.addEventListener('pointerup', up);
el.addEventListener('pointercancel', () => {
  down = null;
  ball.dragEnd();
});
