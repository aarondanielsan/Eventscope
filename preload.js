const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ipcRenderer', {
  invoke(channel, data) {
    if (channel === 'lighthouse:getactions') {
      return ipcRenderer.invoke(channel, data);
    }
    throw new Error(`Unsupported IPC channel: ${channel}`);
  },
});
