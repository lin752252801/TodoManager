const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ball', {
  usage: () => ipcRenderer.invoke('ball:usage'),
  trim: () => ipcRenderer.invoke('ball:trim'),
  dragStart: () => ipcRenderer.send('ball:drag-start'),
  // 只报位移和光标在窗内的位置，绝不报「球该去哪儿」：那是主进程拿窗口位置算出来的
  dragMove: (dx, dy, cx, cy) => ipcRenderer.send('ball:drag-move', dx, dy, cx, cy),
  dragEnd: () => ipcRenderer.invoke('ball:drag-end'),
  onUsage: (cb) => ipcRenderer.on('usage', (_e, v) => cb(v))
});
