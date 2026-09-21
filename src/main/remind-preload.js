const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remind', {
  payload: () => JSON.parse(new URLSearchParams(window.location.search).get('p') || 'null'),
  answer: (action) => ipcRenderer.send('remind:answer', action)
});
