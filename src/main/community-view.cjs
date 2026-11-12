'use strict';
// СООБЩЕСТВО inside the Nexus window: Обсуждения, Мастерская, Торговая площадка of
// Steam Community in a <webview> on the page, signed in with the connected Steam
// account. The window allows a webview only on these terms:
//   - only https pages of Steam (steamcommunity.com, store.steampowered.com, …);
//   - the guest never gets the Nexus preload, Node or the main window's session —
//     its session is the Steam account's own partition, set here, not by the page;
//   - other sites and new windows open in the browser.

const COMMUNITY = {
  discussions: 'https://steamcommunity.com/discussions/',
  workshop: 'https://steamcommunity.com/workshop/',
  market: 'https://steamcommunity.com/market/',
};
const STEAM_HOST = /(^|\.)(steamcommunity\.com|steampowered\.com|steamstatic\.com|steamusercontent\.com)$/;

function steamUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'https:' && !u.username && !u.password && STEAM_HOST.test(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

// mainContents: the Nexus window's webContents. partition(): the Steam account's partition.
// openUrl(url): other sites, in the Nexus browser.
function guardCommunityViews(mainContents, { partition, log, openUrl = () => {} } = {}) {
  const openOutside = url => {
    try {
      openUrl(url);
    } catch {}
  };
  mainContents.on('will-attach-webview', (event, prefs, params) => {
    if (!steamUrl(params.src)) {
      event.preventDefault();
      log?.warn('community', 'webview refused');
      return;
    }
    delete prefs.preload;
    delete prefs.preloadURL;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    prefs.allowRunningInsecureContent = false;
    prefs.partition = partition();
  });
  mainContents.on('did-attach-webview', (_event, guest) => {
    // Steam links stay on the page; other sites and new windows go to the browser.
    guest.setWindowOpenHandler(({ url }) => {
      if (steamUrl(url)) guest.loadURL(url).catch(() => {});
      else openOutside(url);
      return { action: 'deny' };
    });
    const keep = (event, url) => {
      if (steamUrl(url)) return;
      event.preventDefault();
      openOutside(url);
    };
    guest.on('will-navigate', keep);
    guest.on('will-redirect', keep);
    guest.on('will-frame-navigate', details => {
      // Frames inside a Steam page (videos, payment widgets) only over https.
      if (!/^https:/.test(details.url) && !/^about:/.test(details.url)) details.preventDefault();
    });
  });
}

module.exports = { COMMUNITY, guardCommunityViews, steamUrl };
