'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The friends and chat windows: only the social channels (main.cjs registers
// them with `social: true`). Results are unwrapped like in preload.cjs.
const channels = [
  'friends',
  'openProfile',
  'openChat',
  'socialInfo',
  'chatTabs',
  'friendInfo',
  'chatMessages',
  'chatSend',
  'chatViewing',
  'focusMain',
];

contextBridge.exposeInMainWorld('nexus', {
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
