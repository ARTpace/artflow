const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sandboxHost', {
  onMessage: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('artflow-app:plugin-sandbox-message', listener);
  },
  reply: (message) => {
    ipcRenderer.send('artflow-app:plugin-sandbox-reply', message);
  },
});
