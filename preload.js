const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  lighthouse: {
    getActions(asOf) {
      console.log('[Preload] Forwarding Lighthouse getActions request', asOf);
      return ipcRenderer.invoke('lighthouse:getactions', { asOf });
    },
  },
});
