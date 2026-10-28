'use strict';
const path = require('node:path');
const { scanEpic, scanEpicPending, launchUri, storeUrl } = require('../core.cjs');

const programData = () => process.env.ProgramData || 'C:\\ProgramData';

// The Epic launcher accepts install/uninstall/verify actions only with the full
// namespace:itemId:appName id; otherwise its library is opened.
function clientUri(action, offer) {
  if (!['install', 'uninstall', 'verify'].includes(action)) throw Error('Неизвестное действие');
  if (!offer?.appId) throw Error('Некорректная игра Epic');
  if (!(offer.namespace && offer.itemId)) return 'com.epicgames.launcher://library';
  const id = encodeURIComponent(`${offer.namespace}:${offer.itemId}:${offer.appId}`);
  return `com.epicgames.launcher://apps/${id}?action=${action}`;
}

module.exports = {
  id: 'epic',
  name: 'Epic Games',
  manifestDir: () => path.join(programData(), 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
  // Installed games plus the installations the Epic launcher is running now.
  scanInstalled: async ({ nexusEpicDir } = {}) => {
    const manifests = path.join(programData(), 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    const result = await scanEpic(
      manifests,
      path.join(programData(), 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')
    );
    // Games installed by Nexus when the Epic folder was not writable (main/epic-install.cjs).
    if (nexusEpicDir) {
      const own = await scanEpic(nexusEpicDir, null);
      for (const o of own.offers) if (!result.offers.some(x => x.appId === o.appId)) result.offers.push(o);
    }
    const installed = new Set(result.offers.map(o => o.appId));
    const pending = await scanEpicPending(manifests, installed);
    for (const p of pending) {
      const same = result.offers.find(o => o.appId === p.appId);
      if (same) same.progress = p.progress;
      else result.offers.push(p);
    }
    return result;
  },
  launchUri,
  clientUri,
  storeUrl: game => storeUrl('epic', game),
};
