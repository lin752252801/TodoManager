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

// 渲染层在拖动里只负责说三件事：按下了、还按着、松手了。球去哪儿由主进程按全局光标算。
// 之前这里报的是页面里的位移，非 100% 缩放下那些坐标带小数、还会随窗口移动重算，
// 手停住不动时照样能挤出零点几像素，球就顺着它自己爬。
let down = false;
let hb = 0;

el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  down = true;
  el.setPointerCapture(e.pointerId);
  ball.dragStart();
  // 心跳只说明「这一下还没松」，一个坐标都不带。
  // 必须按时钟发，不能挂在 pointermove 上：按住不动的时候系统根本不发鼠标事件，
  // 只靠 move 当心跳，停手 2.5 秒就会被主进程当成已经松手而放开这次拖动。
  clearInterval(hb);
  hb = setInterval(() => { if (down) ball.dragAlive(); }, 120);
});

async function up(allowClean) {
  if (!down) return;
  down = false;
  clearInterval(hb);
  hb = 0;
  if (!(await ball.dragEnd()) && allowClean) clean();
}

window.addEventListener('pointerup', () => up(true));
window.addEventListener('pointercancel', () => up(false));
