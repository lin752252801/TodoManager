const { contextBridge, ipcRenderer } = require('electron');

// 载荷改走同步 IPC，避开 Windows 32KB 命令行上限与 file:// query ERR_FAILED；
// 主题仅几十字节，仍经命令行参数传入以便首帧即定色。
const pick = (prefix) => {
  const a = process.argv.find((s) => s.startsWith(prefix));
  return a ? a.slice(prefix.length) : '';
};

contextBridge.exposeInMainWorld('remind', {
  payload: () => ipcRenderer.sendSync('remind:payload'),
  theme: () => pick('--remind-th='),
  answer: (action) => ipcRenderer.send('remind:answer', action)
});
