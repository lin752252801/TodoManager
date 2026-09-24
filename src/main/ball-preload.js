const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ball', {
  usage: () => ipcRenderer.invoke('ball:usage'),
  trim: () => ipcRenderer.invoke('ball:trim'),
  dragStart: () => ipcRenderer.send('ball:drag-start'),
  // 只报位移：球该去哪儿由主进程用「按下当刻的窗口位置 + 位移」算，绝不掺进别的坐标系
  dragMove: (dx, dy) => ipcRenderer.send('ball:drag-move', dx, dy),
  dragEnd: () => ipcRenderer.invoke('ball:drag-end'),
  onUsage: (cb) => ipcRenderer.on('usage', (_e, v) => cb(v))
});
