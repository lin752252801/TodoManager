const { screen } = require('electron');
const store = require('./store');

const SLIVER = 6; // 吸附后露出的像素
const TRIGGER = 24; // 鼠标距屏幕边缘多少像素算进入触发区
const SNAP_DIST = 30; // 拖动结束时距边缘多少像素内触发吸附
const ANIM_MS = 160;
const POLL_MS = 24;
const DRAG_SETTLE_MS = 180;
const RESIZE_SETTLE_MS = 260; // 松手/停止变化后仍视作「缩放中」的余量
const MIN_VIS = 60; // 自由状态下至少留在屏幕内的像素，兜住任何越界
const EDIT_LEASE_MS = 5000; // 编辑态最长占用时间，之后必须靠按键/输入续期
const EDIT_LEASE_MAX = 15000; // 渲染层可自报的租约上限

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

class SnapController {
  constructor(win) {
    this.win = win;
    this.mode = 'free'; // free | hidden | expanded
    this.side = null; // right | left | top
    this.normal = null;
    this.animTimer = null;
    this.animating = false;
    this.pending = null;
    this.lastUserMove = 0;
    this.lastBoundsChange = 0;
    this.ignoreUntil = 0;
    this.prevBounds = win.getBounds();
    this.lastResizeSeen = 0;
    this.resizing = false;
    this.resizeStartedAt = 0;
    this.normalDirty = false;
    this.editing = false;
    this.editingUntil = 0;
    this.topmost = false;
    const s = store.getSettings();
    this.expandDelay = Number.isFinite(s.expandDelayMs) ? s.expandDelayMs : 120;
    // 收起和展开用同一个延迟：两段时间不对称时，用户会觉得「移出去半天不收回」
    this.collapseDelay = this.expandDelay;

    this.onMove = () => this.handleUserMove();
    this.onResize = () => this.handleUserMove();
    win.on('move', this.onMove);
    win.on('resize', this.onResize);

    // Win+D / 点「显示桌面」会把窗口最小化。吸附态下这等于把那条细边一起抹掉，
    // 而最小化中的窗口 setBounds 无效，鼠标移到边缘也展不开，只能靠点别的窗口唤回来。
    // 本应用没有「最小化」语义（标题栏那个按钮走的是收进托盘），所以直接恢复。
    this.onMinimize = () => this.unminimize();
    win.on('minimize', this.onMinimize);

    this.onMetrics = () => this.reconcileDisplays();
    screen.on('display-metrics-changed', this.onMetrics);

    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  unminimize() {
    if (this.win.isDestroyed() || !this.win.isMinimized()) return;
    this.win.restore();
  }

  // 吸附态常驻置顶：「显示桌面」除了最小化还会把桌面窗口提到普通窗口之上，
  // 只靠事后 restore 抢不回来。floating 层级高于普通窗口但低于真正的置顶窗，
  // 细边因此不会被壁纸盖住；脱离吸附（拖回桌面中间）就交还普通层级。
  setTopmost(on) {
    if (this.win.isDestroyed()) return;
    if (this.topmost === on) return;
    this.topmost = on;
    this.win.setAlwaysOnTop(on, 'floating');
  }

  dispose() {
    clearInterval(this.timer);
    this.stopAnim();
    this.win.removeListener('move', this.onMove);
    this.win.removeListener('resize', this.onResize);
    this.win.removeListener('minimize', this.onMinimize);
    screen.removeListener('display-metrics-changed', this.onMetrics);
  }

  workArea() {
    return screen.getDisplayMatching(this.win.getBounds()).workArea;
  }

  // 区分「拖动窗口」和「拖动边框」：尺寸变了就是缩放。
  // 缩放期间以及松手后的一小段余量里绝不挪窗口——按住左键停在最小尺寸时鼠标早已离开窗口，
  // 此时收起/吸附会在用户手里把窗口缩回去，而且鼠标不在屏幕边缘再也展不开。
  handleUserMove() {
    const b = this.win.getBounds();
    const prev = this.prevBounds;
    this.prevBounds = b;
    const now = Date.now();
    // 每一次位置/尺寸变化都记下来，哪怕这次因为冷却被忽略：release() 之后有 220ms 冷却，
    // 只看 lastUserMove 的话拖动中途就会触发吸附判定，窗口在用户手里弹回边缘
    this.lastBoundsChange = now;
    if (this.animating || now < this.ignoreUntil) return;
    // 一次 setBounds 会连着发 move 和 resize 两个事件，第二个事件看不到任何变化，直接丢掉。
    // 用「有没有真的变化」判断，不能用时间窗：拖手柄时缩放心跳会一直刷新时间戳。
    if (prev && prev.x === b.x && prev.y === b.y && prev.width === b.width && prev.height === b.height) return;
    const resized = !!prev && (prev.width !== b.width || prev.height !== b.height);
    if (resized) {
      this.lastResizeSeen = now;
      // 吸附态被缩放：保持吸附只换展开尺寸。解除吸附会让窗口停在边缘却不再收起，
      // 于是鼠标移出界面也收不回去，只能重新拖一次标题栏。
      if (this.mode !== 'free') {
        this.syncNormalAfterResize(b);
        return;
      }
    }
    this.lastUserMove = now;
    this.pending = null;
    if (this.mode !== 'free') this.release();
  }

  // 吸附态被缩放：贴边那一侧重新对齐，展开位记成新尺寸，松手后仍会正常收起
  syncNormalAfterResize(b) {
    const wa = this.workArea();
    const n = this.clamp(b, wa);
    if (this.side === 'right') n.x = wa.x + wa.width - n.width;
    else if (this.side === 'left') n.x = wa.x;
    else n.y = wa.y;
    this.normal = n;
    this.pending = null;
    this.normalDirty = true;
    if (this.mode === 'hidden') this.applyBounds(this.hiddenBounds(n, this.side, wa), true);
  }

  // 渲染层自绘手柄会显式告诉我们按下/松开；系统边框缩放没有这个信号，靠 RESIZE_SETTLE_MS 兜
  setResizing(on) {
    const now = Date.now();
    this.resizing = !!on;
    if (on) this.resizeStartedAt = now;
    this.lastResizeSeen = now;
  }

  inResize(now) {
    if (now - this.lastResizeSeen < RESIZE_SETTLE_MS) return true;
    // 页面刷新/崩溃时可能再也收不到「松开」，不能永久冻住吸附
    return this.resizing && now - this.resizeStartedAt < 10000;
  }

  // quiet=true 时不拉长 ignoreUntil：动画结束时若还压着 220ms 冷却，用户紧接着拖动会被吞掉
  applyBounds(b, quiet) {
    if (!quiet) this.ignoreUntil = Date.now() + 220;
    this.win.setBounds({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height)
    });
  }

  stopAnim() {
    if (this.animTimer) clearTimeout(this.animTimer);
    this.animTimer = null;
    this.animating = false;
  }

  animate(target, done) {
    this.stopAnim();
    const from = this.win.getBounds();
    const start = Date.now();
    this.animating = true;
    const step = () => {
      const t = Math.min(1, (Date.now() - start) / ANIM_MS);
      const e = easeOutCubic(t);
      this.applyBounds(
        {
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
          width: from.width + (target.width - from.width) * e,
          height: from.height + (target.height - from.height) * e
        },
        true
      );
      if (t < 1) {
        this.animTimer = setTimeout(step, 16);
      } else {
        this.stopAnim();
        if (done) done();
      }
    };
    step();
  }

  clamp(bounds, wa) {
    const width = Math.min(bounds.width, wa.width);
    const height = Math.min(bounds.height, wa.height);
    return {
      width,
      height,
      x: Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - width)),
      y: Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - height))
    };
  }

  // 自由状态下不允许窗口被推到几乎看不见的位置
  ensureVisible(b, wa) {
    const x = Math.max(wa.x - b.width + MIN_VIS, Math.min(b.x, wa.x + wa.width - MIN_VIS));
    const y = Math.max(wa.y - b.height + MIN_VIS, Math.min(b.y, wa.y + wa.height - MIN_VIS));
    if (x === b.x && y === b.y) return false;
    this.applyBounds({ ...b, x, y });
    return true;
  }

  hiddenBounds(normal, side, wa) {
    if (side === 'left') return { ...normal, x: wa.x + SLIVER - normal.width };
    if (side === 'right') return { ...normal, x: wa.x + wa.width - SLIVER };
    return { ...normal, y: wa.y - (normal.height - SLIVER) };
  }

  state() {
    return {
      mode: this.mode,
      side: this.side,
      sliver: SLIVER,
      normal: this.normal,
      editing: this.editing && Date.now() < this.editingUntil
    };
  }

  emitState() {
    if (!this.win.isDestroyed()) this.win.webContents.send('snap:state', this.state());
    store.patchSettings({
      snapped: this.mode !== 'free',
      snapSide: this.side,
      normalBounds: this.normal
    });
  }

  // ---- 状态切换 ----

  snap(side) {
    const wa = this.workArea();
    const normal = this.clamp(this.win.getBounds(), wa);
    // 展开位贴齐屏幕边缘，否则停在边缘的鼠标不在窗口内，会立刻又被收回
    if (side === 'left') normal.x = wa.x;
    else if (side === 'right') normal.x = wa.x + wa.width - normal.width;
    else normal.y = wa.y;
    this.side = side;
    this.normal = normal;
    this.mode = 'hidden';
    this.lastUserMove = 0;
    this.setTopmost(true);
    this.animate(this.hiddenBounds(normal, side, wa), () => this.emitState());
    this.emitState();
  }

  release() {
    if (this.mode === 'free') return;
    const wasHidden = this.mode === 'hidden';
    const target = this.normal;
    this.mode = 'free';
    this.side = null;
    this.normal = null;
    this.pending = null;
    this.setTopmost(false);
    this.emitState();
    // 收起态被用户接管时必须把窗口拉回完整位置，否则只剩一条边、又不再展开
    if (wasHidden && target) this.applyBounds(this.clamp(target, this.workArea()));
  }

  expand() {
    if (this.mode !== 'hidden' || !this.normal) return;
    this.mode = 'expanded';
    this.pending = null;
    this.animate(this.normal, () => {
      if (!this.win.isDestroyed()) this.win.moveTop();
    });
    this.emitState();
  }

  collapse() {
    if (this.mode !== 'expanded' || !this.normal) return;
    this.mode = 'hidden';
    this.pending = null;
    this.animate(this.hiddenBounds(this.normal, this.side, this.workArea()));
    this.emitState();
  }

  // 从持久化状态恢复（开机 / 重启）
  restore() {
    const s = store.getSettings();
    if (!s.snapped || !s.snapSide || !s.normalBounds) return false;
    const wa = screen.getDisplayMatching(s.normalBounds).workArea;
    this.side = s.snapSide;
    this.normal = this.clamp(s.normalBounds, wa);
    this.mode = 'hidden';
    this.setTopmost(true);
    this.applyBounds(this.hiddenBounds(this.normal, this.side, wa));
    this.emitState();
    return true;
  }

  reconcileDisplays() {
    if (this.mode === 'free') return;
    const wa = screen.getDisplayMatching(this.normal || this.win.getBounds()).workArea;
    this.normal = this.clamp(this.normal || this.win.getBounds(), wa);
    this.applyBounds(this.mode === 'hidden' ? this.hiddenBounds(this.normal, this.side, wa) : this.normal);
  }

  // 编辑态只「租」一段时间：输入框拿到焦点后可能永远等不到 focusout（拖完滑块焦点还留在上面、
  // 面板被重绘掉），一旦长期置真，鼠标移出界面就再也不会自动收起。
  // 渲染层每次真正按键/输入时续期，超过租约没动静就当作不在编辑。
  // ttl 由渲染层按场景给：文字框按键即续期用默认值，日期框的原生面板是系统弹窗、
  // 续期消息可能被压在面板里发不出来，要给更长的余量。
  setEditing(on, ttl) {
    this.editing = !!on;
    if (!on) {
      this.editingUntil = 0;
      return;
    }
    const ms = Number(ttl);
    this.editingUntil = Date.now() + (Number.isFinite(ms) ? Math.min(Math.max(ms, 0), EDIT_LEASE_MAX) : EDIT_LEASE_MS);
  }

  // ---- 主循环 ----
  tick() {
    if (this.win.isDestroyed()) return;
    // 兜底：minimize 事件没收到（或被系统吞掉）时，轮询里补一次恢复
    if (this.win.isMinimized()) {
      this.unminimize();
      return;
    }
    if (!this.win.isVisible()) return;
    const now = Date.now();
    const cursor = screen.getCursorScreenPoint();
    const wa = this.workArea();
    const resizing = this.inResize(now);

    if (this.normalDirty && !resizing) {
      this.normalDirty = false;
      this.emitState();
    }

    if (this.mode === 'free') {
      if (resizing) return;
      if (
        this.lastUserMove &&
        now - this.lastUserMove > DRAG_SETTLE_MS &&
        now - this.lastBoundsChange > DRAG_SETTLE_MS
      ) {
        this.lastUserMove = 0;
        const b = this.win.getBounds();
        if (this.evaluateSnap(b, wa)) return;
        this.ensureVisible(b, wa);
      }
      return;
    }

    // 缩放进行中（含松手后的短暂静止）一律不动窗口：按住左键停在最小尺寸时鼠标早已离开
    // 窗口，此时收起会在用户手里把窗口缩回去
    if (resizing) {
      this.pending = null;
      return;
    }

    if (!this.normal) return;
    // 命中判定一律用目标位置而不是当前实时位置，否则动画途中会被误判成「鼠标已离开」而来回抖
    const t = this.mode === 'hidden' ? this.hiddenBounds(this.normal, this.side, wa) : this.normal;

    if (this.mode === 'hidden') {
      // 贴着吸附边、且落在窗口那一维的范围内才算「进入触发区」
      const onBand =
        this.side === 'top'
          ? cursor.x >= t.x && cursor.x <= t.x + t.width
          : cursor.y >= t.y && cursor.y <= t.y + t.height;
      const nearEdge =
        this.side === 'left'
          ? cursor.x <= wa.x + TRIGGER
          : this.side === 'right'
            ? cursor.x >= wa.x + wa.width - TRIGGER
            : cursor.y <= wa.y + TRIGGER;
      if (!(onBand && nearEdge)) {
        this.pending = null;
        return;
      }
      if (!this.pending) this.pending = { kind: 'expand', at: now + this.expandDelay };
      else if (now >= this.pending.at) this.expand();
      return;
    }

    const inside =
      cursor.x >= t.x - 2 && cursor.x <= t.x + t.width + 2 && cursor.y >= t.y - 2 && cursor.y <= t.y + t.height + 2;
    // 租约过期就不再挡住收起，否则焦点留在输入框里会让窗口永远不收
    const editing = this.editing && now < this.editingUntil;
    if (inside || editing) {
      this.pending = null;
      return;
    }
    if (!this.pending) this.pending = { kind: 'collapse', at: now + this.collapseDelay };
    else if (now >= this.pending.at) this.collapse();
  }

  evaluateSnap(b, wa) {
    const rightGap = wa.x + wa.width - (b.x + b.width);
    const leftGap = b.x - wa.x;
    const topGap = b.y - wa.y;
    // 底部不吸附：那一条留给任务栏
    const nearLeft = leftGap <= SNAP_DIST && b.x + b.width > wa.x + SLIVER;
    const nearRight = rightGap <= SNAP_DIST && b.x < wa.x + wa.width - SLIVER;
    const nearTop = topGap <= SNAP_DIST && topGap >= -60;
    if (!nearLeft && !nearRight && !nearTop) return false;
    const cands = [];
    if (nearLeft) cands.push(['left', leftGap]);
    if (nearRight) cands.push(['right', rightGap]);
    if (nearTop) cands.push(['top', topGap]);
    // 同时够到两条边时（比如左上角）贴哪条边，取离得更近的那条
    cands.sort((m, n) => Math.abs(m[1]) - Math.abs(n[1]));
    this.snap(cands[0][0]);
    return true;
  }
}

module.exports = { SnapController, SLIVER, TRIGGER };
