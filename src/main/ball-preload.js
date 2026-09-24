const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ball', {
  usage: () => ipcRenderer.invoke('ball:usage'),
  trim: () => ipcRenderer.invoke('ball:trim'),
  dragStart: (dx, dy, sx, sy) => ipcRenderer.send('ball:drag-start', dx, dy, sx, sy),
  dragEnd: () => ipcRenderer.invoke('ball:drag-end'),
  onUsage: (cb) => ipcRenderer.on('usage', (_e, v) => cb(v))
});
