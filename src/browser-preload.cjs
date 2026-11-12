'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The bar of the Nexus browser (ui/browser.html): one channel, checked in main/browser.cjs.
contextBridge.exposeInMainWorld('nexusBrowser', {
  command: async msg => {
    const r = await ipcRenderer.invoke('nexus-browser', msg);
    if (!r.ok) throw Error(r.error);
    return r.data;
  },
  onState: callback => ipcRenderer.on('browser-state', (_e, value) => callback(value)),
  onFocusAddress: callback => ipcRenderer.on('browser-focus-address', () => callback()),
});
