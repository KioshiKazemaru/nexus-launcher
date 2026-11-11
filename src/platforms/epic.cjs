'use strict';
const fsp = require('node:fs/promises');
const { scanEpic, scanEpicPending, launchUri, storeUrl } = require('../core.cjs');
const system = require('../os.cjs');

// Games installed by Legendary or Heroic Games Launcher (their installed.json):
// the only Epic installs on Linux, and possible next to the Epic launcher on macOS.
// → offers marked `via: 'legendary'`: they are started and removed through Heroic / Legendary.
async function scanLegendary(files) {
  const offers = [],
    seen = new Set();
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!json || typeof json !== 'object') continue;
    for (const [key, v] of Object.entries(json)) {
      const appId = typeof v?.app_name === 'string' ? v.app_name : key;
      const dir = v?.install_path;
      if (!v || v.is_dlc || seen.has(appId) || typeof dir !== 'string' || !/^[\w.-]{1,100}$/.test(appId))
        continue;
      try {
        if (!(await fsp.stat(dir)).isDirectory()) continue;
      } catch {
        continue;
      }
      seen.add(appId);
      offers.push({
        provider: 'epic',
        appId,
        name: typeof v.title === 'string' && v.title ? v.title.slice(0, 200) : appId,
        installed: true,
        source: 'local',
        licenseUnknown: true,
        via: 'legendary',
        // Heroic keeps its own copy of Legendary: its games are opened in Heroic.
        legendaryFile: file,
        installLocation: dir,
        installSize: Number(v.install_size) || 0,
        version: typeof v.version === 'string' ? v.version : '',
      });
    }
  }
  return offers;
}

// Heroic Games Launcher link (src/backend/protocol.ts of Heroic): an installed
// game starts, for one that is not installed Heroic offers to install it.
// Launch options go as repeated `arg` parameters.
function heroicUri(appId, args = []) {
  if (!/^[\w.-]{1,100}$/.test(String(appId || ''))) throw Error('Некорректная игра Epic');
  const q = new URLSearchParams({ appName: String(appId), runner: 'legendary' });
  for (const a of args) q.append('arg', String(a));
  return `heroic://launch?${q}`;
}

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
  // '' where there is no Epic Games Launcher (Linux).
  manifestDir: () => system.epicFiles()?.manifests || '',
  installedDat: () => system.epicFiles()?.installedDat || '',
  scanLegendary,
  heroicUri,
  // Installed games plus the installations the Epic launcher is running now.
  scanInstalled: async ({ nexusEpicDir } = {}) => {
    const files = system.epicFiles();
    const manifests = files?.manifests || '';
    const result = files ? await scanEpic(manifests, files.installedDat) : { offers: [], errors: [] };
    // Tests set NEXUS_NO_SYSTEM_SCAN: never the PC's real Heroic / Legendary.
    if (!process.env.NEXUS_NO_SYSTEM_SCAN)
      for (const o of await scanLegendary(system.legendaryInstalledFiles()))
        if (!result.offers.some(x => x.appId === o.appId)) result.offers.push(o);
    // Games installed by Nexus when the Epic folder was not writable (main/epic-install.cjs).
    if (nexusEpicDir) {
      const own = await scanEpic(nexusEpicDir, null);
      for (const o of own.offers) if (!result.offers.some(x => x.appId === o.appId)) result.offers.push(o);
    }
    const installed = new Set(result.offers.map(o => o.appId));
    const pending = manifests ? await scanEpicPending(manifests, installed) : [];
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
