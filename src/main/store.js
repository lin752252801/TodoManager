const fs = require('fs');
const paths = require('./paths');

const DEFAULT_TODOS = { version: 1, tasks: [] };
const DEFAULT_SETTINGS = {
  version: 1,
  window: { x: null, y: null, width: 366, height: 710 },
  snapped: false,
  snapSide: null,
  normalBounds: null,
  tab: 'active',
  expandedId: null,
  visible: true,
  autoStart: false,
  opacity: 1,
  theme: 'light',
  ball: false,
  ballPos: null,
  expandDelayMs: 120
};

// 本次启动时发现的数据文件问题（读不出来、已备份到哪），供界面提示用。
// 不提示的话用户只会看到「待办全没了」，第一反应是自己误删。
const loadWarnings = [];

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (err) {
    // 解析失败一律当「没有数据」启动，但绝不能把原件就这么留在原地：
    // 随后任意一次 setTasks（新增一条就够了）都会把空列表写回同一个文件，
    // 用户的任务就彻底没了，而且全程无感知。先把原件挪成 *.corrupt-<时间戳> 再退回默认值。
    // 用 rename 而不是 copy：原件挪走后构造函数会建一份干净的，下次启动不再重复备份、也不再重复报警。
    if (fs.existsSync(file)) {
      const bak = `${file}.corrupt-${Date.now()}`;
      let backup = null;
      try {
        fs.renameSync(file, bak);
        backup = bak;
      } catch (renameErr) {
        // 文件被同步盘 / 杀软锁住时改名会失败，退回复制，至少把内容留下来
        try {
          fs.copyFileSync(file, bak);
          backup = bak;
        } catch (copyErr) {
          console.error('[store] 数据文件读不出来，且备份失败', file, err, renameErr, copyErr);
        }
      }
      loadWarnings.push({ file, backup, reason: String((err && err.message) || err) });
    }
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const timers = new Map();
function saveDebounced(key, file, get, delay = 400) {
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      try {
        writeJson(file, get());
      } catch (err) {
        console.error('save failed', file, err);
      }
    }, delay)
  );
}

class Store {
  constructor() {
    const todos = readJson(paths.todosFile, DEFAULT_TODOS);
    this.tasks = Array.isArray(todos.tasks) ? todos.tasks : [];
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(paths.settingsFile, {}) };
    this.settings.window = { ...DEFAULT_SETTINGS.window, ...this.settings.window };
    // 首启即落盘，保证 data/todos.json 与 config/settings.json 一定存在
    if (!fs.existsSync(paths.todosFile)) writeJson(paths.todosFile, { version: 1, tasks: this.tasks });
    if (!fs.existsSync(paths.settingsFile)) writeJson(paths.settingsFile, this.settings);
  }

  getTasks() {
    return this.tasks;
  }

  // 启动时数据文件读不出来（已自动备份）的记录，界面拿它提示用户
  getLoadWarnings() {
    return loadWarnings;
  }

  setTasks(tasks) {
    this.tasks = tasks;
    saveDebounced('todos', paths.todosFile, () => ({ version: 1, tasks: this.tasks }));
  }

  flush() {
    for (const [key, timer] of timers) {
      clearTimeout(timer);
      timers.delete(key);
    }
    try {
      writeJson(paths.todosFile, { version: 1, tasks: this.tasks });
      writeJson(paths.settingsFile, this.settings);
    } catch (err) {
      console.error('flush failed', err);
    }
  }

  getSettings() {
    return this.settings;
  }

  patchSettings(patch) {
    Object.assign(this.settings, patch);
    saveDebounced('settings', paths.settingsFile, () => this.settings, 250);
  }
}

module.exports = new Store();
