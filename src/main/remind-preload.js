const { contextBridge, ipcRenderer } = require('electron');

// 载荷和主题都不走 URL query：file:// 带上 query 在非 asar 目录下直接 ERR_FAILED（离屏实测），
// 详情一长也容易顶爆 URL。命令行参数上限 32k，够放长详情。
const pick = (prefix) => {
  const a = process.argv.find((s) => s.startsWith(prefix));
  return a ? a.slice(prefix.length) : '';
};

contextBridge.exposeInMainWorld('remind', {
  payload: () => {
    try {
      return JSON.parse(decodeURIComponent(pick('--remind-payload='))) || null;
    } catch {
      return null;
    }
  },
  theme: () => pick('--remind-th='),
  answer: (action) => ipcRenderer.send('remind:answer', action)
});
