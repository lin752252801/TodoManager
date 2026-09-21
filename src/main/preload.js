const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getTasks: () => ipcRenderer.invoke('tasks:get'),
  setTasks: (tasks) => ipcRenderer.invoke('tasks:set', tasks),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),
  snapState: () => ipcRenderer.invoke('snap:state'),
  hide: () => ipcRenderer.invoke('win:hide'),
  getBounds: () => ipcRenderer.invoke('win:bounds'),
  resizeTo: (b) => ipcRenderer.send('win:resize-to', b),
  resizeState: (on) => ipcRenderer.send('win:resize-state', on),
  setOpacity: (v) => ipcRenderer.invoke('win:opacity', v),
  setEditing: (on, ttl) => ipcRenderer.invoke('win:editing', on, ttl),
  testRemind: (mode) => ipcRenderer.invoke('remind:test', mode),
  onSnap: (cb) => ipcRenderer.on('snap:state', (_e, state) => cb(state)),
  onTray: (cb) => {
    ipcRenderer.on('tray:new', () => cb('new'));
    ipcRenderer.on('tray:settings', () => cb('settings'));
  }
});
