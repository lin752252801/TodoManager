const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ball', {
  usage: () => ipcRenderer.invoke('ball:usage'),
  trim: () => ipcRenderer.invoke('ball:trim'),
  move: (dx, dy) => ipcRenderer.send('ball:move', dx, dy),
  onUsage: (cb) => ipcRenderer.on('usage', (_e, v) => cb(v))
});
