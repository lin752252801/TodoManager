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

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
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
