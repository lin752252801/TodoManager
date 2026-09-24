const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ball', {
  usage: () => ipcRenderer.invoke('ball:usage'),
  trim: () => ipcRenderer.invoke('ball:trim'),
  dragStart: () => ipcRenderer.send('ball:drag-start'),
  // 只报「还按着」，不报坐标：球去哪儿由主进程按全局光标算，页面里的小数坐标掺不进去
  dragAlive: () => ipcRenderer.send('ball:drag-alive'),
  dragEnd: () => ipcRenderer.invoke('ball:drag-end'),
  onUsage: (cb) => ipcRenderer.on('usage', (_e, v) => cb(v))
});
