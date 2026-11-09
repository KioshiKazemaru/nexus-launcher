'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The overlay and its corner window (HUD): only the overlay channels (main.cjs
// registers them with `overlay: true`). Results are unwrapped like in preload.cjs.
const channels = [
  'overlayInfo',
  'overlayHide',
  'overlayFps',
  'overlayChat',
  'friends',
  'achievements',
  'closeGame',
];

contextBridge.exposeInMainWorld('nexus', {
  onOverlayEvent: callback => ipcRenderer.on('overlay-event', (_e, value) => callback(value)),
  onSocialEvent: callback => ipcRenderer.on('social-event', (_e, value) => callback(value)),
  ...Object.fromEntries(
    channels.map(channel => [
      channel,
      async payload => {
        const r = await ipcRenderer.invoke(channel, payload);
        if (!r.ok) throw Error(r.error);
        return r.data;
      },
    ])
  ),
});
