const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getTasks: () => ipcRenderer.invoke('tasks:get'),
  setTasks: (tasks) => ipcRenderer.invoke('tasks:set', tasks),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),
  snapState: () => ipcRenderer.invoke('snap:state'),
  hide: () => ipcRenderer.invoke('win:hide'),
  getBounds: () => ipcRenderer.invoke('win:bounds'),
  // dir 必须跟着一起传：主进程要靠它决定夹哪条边（夹错边会把对面那条边拖走）
  resizeTo: (b, dir) => ipcRenderer.send('win:resize-to', b, dir),
  resizeState: (on) => ipcRenderer.send('win:resize-state', on),
  setOpacity: (v) => ipcRenderer.invoke('win:opacity', v),
  setEditing: (on, ttl) => ipcRenderer.invoke('win:editing', on, ttl),
  testRemind: (mode) => ipcRenderer.invoke('remind:test', mode),
  onSnap: (cb) => ipcRenderer.on('snap:state', (_e, state) => cb(state)),
  // 主进程独立改过任务数据（例如给逾期任务打「已确认」）时用它把本地副本对齐
  onTasksChanged: (cb) => ipcRenderer.on('tasks:changed', (_e, tasks) => cb(tasks)),
  onTray: (cb) => {
    ipcRenderer.on('tray:new', () => cb('new'));
    ipcRenderer.on('tray:settings', () => cb('settings'));
  }
});
