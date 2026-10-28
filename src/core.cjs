const path = require('node:path');
const fsp = require('node:fs/promises');
const { catalog } = require('./catalog.cjs');
const { plainTitle, offerKey, groupOffers } = require('./matching.cjs');
const { parseLauncherInstalled } = require('./epic-oauth.cjs');
function parseVdf(text) {
  const tokens = (text.match(/"(?:\\.|[^"\\])*"|\/\/[^\n\r]*|[{}]/g) || []).filter(x => !x.startsWith('//'));
  let i = 0;
  const decode = s => s.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  function object(nested = false) {
    const out = {};
    while (i < tokens.length) {
      if (tokens[i] === '}') {
        i++;
        if (!nested) throw Error('Unexpected VDF brace');
        return out;
      }
      const key = tokens[i++];
      if (!key?.startsWith('"')) throw Error('Invalid VDF key');
      const value = tokens[i++];
      if (value === '{') out[decode(key)] = object(true);
      else if (value?.startsWith('"')) out[decode(key)] = decode(value);
      else throw Error('Invalid VDF value');
    }
    if (nested) throw Error('Unclosed VDF object');
    return out;
  }
  return object();
}
const normalize = s => plainTitle(s);
function catalogEntry(offer) {
  if (offer.provider === 'steam') return catalog.find(c => c.steam === offer.appId);
  if (offer.provider === 'epic')
    return catalog.find(c => !c.noAutoMerge && normalize(c.name) === normalize(offer.name));
  return undefined;
}
// Same offer seen by several sources (local manifest, account library,
// a second account): keep install state and every account that owns it.
function combineOffer(old, o) {
  const accountIds = [
    ...new Set([...(old.accountIds || [old.accountId]), ...(o.accountIds || [o.accountId])].filter(Boolean)),
  ];
  const name =
    (/^Steam #/.test(o.name || '') || o.nameFromFolder) && old.name ? old.name : o.name || old.name;
  // The same app may come in two languages (local manifest vs account list).
  const altName =
    [old.altName, o.altName, old.name, o.name].find(
      n => n && n !== name && !/^Steam #/.test(n) && n !== o.appId
    ) || '';
  return Object.assign(old, o, {
    name,
    altName,
    nameFromFolder: old.nameFromFolder && o.nameFromFolder,
    source: old.owned === true && o.owned !== true ? old.source : o.source || old.source,
    namespace: old.namespace || o.namespace,
    itemId: old.itemId || o.itemId,
    installed: old.installed || o.installed,
    owned: old.owned === true || o.owned === true,
    licenseUnknown: old.licenseUnknown !== false && o.licenseUnknown !== false,
    accountId: old.accountId || o.accountId,
    accountIds,
    playtime: Math.max(Number(old.playtime) || 0, Number(o.playtime) || 0),
    lastPlayed: Math.max(Number(old.lastPlayed) || 0, Number(o.lastPlayed) || 0),
    image: old.image || o.image,
    portrait: old.portrait || o.portrait,
  });
}
// options: { links, splits, externalId } — see matching.cjs.
function mergeGames(offers, options = {}) {
  const unique = new Map();
  for (const o of offers) {
    const k = offerKey(o);
    if (unique.has(k)) combineOffer(unique.get(k), { ...o });
    else unique.set(k, { ...o, accountIds: o.accountIds || (o.accountId ? [o.accountId] : []) });
  }
  const groups = groupOffers([...unique.values()], {
    catalogId: o => catalogEntry(o)?.id,
    noTitleMerge: o => o.provider === 'steam' && catalogEntry(o)?.noAutoMerge === true,
    externalId: options.externalId,
    links: options.links || [],
    splits: options.splits || new Set(),
  });
  const games = groups.map(group => {
    const list = group.keys.map(k => unique.get(k));
    const known = list.map(catalogEntry).find(Boolean);
    const steam = list.find(o => o.provider === 'steam');
    const main = steam || list.find(o => o.provider === 'epic') || list[0];
    const id = known?.id || `${main.provider}:${main.appId}`;
    return {
      ...(known || { name: main.name, color: '#77a5d6', tags: ['Моя библиотека'], art: 'architecture' }),
      id,
      aliases: [...new Set(list.map(o => `${o.provider}:${o.appId}`))].filter(x => x !== id),
      mergedBy: group.reason,
      offers: list,
    };
  });
  // Leading quotes, spaces or symbols in a store title must not move it to the top.
  const key = name => String(name || '').replace(/^[^\p{L}\p{N}]+/u, '');
  return games.sort((a, b) =>
    key(a.name).localeCompare(key(b.name), 'ru', { sensitivity: 'base', numeric: true })
  );
}
function chooseOffer(game, preferred, installedFirst = true) {
  return (
    game.offers.find(o => o.provider === preferred && (o.installed || !installedFirst)) ||
    game.offers.find(o => o.provider === 'steam' && (o.installed || !installedFirst)) ||
    game.offers.find(o => o.installed) ||
    game.offers.find(o => o.provider === preferred) ||
    game.offers.find(o => o.provider === 'steam') ||
    game.offers[0]
  );
}
function launchUri(o) {
  if (o.provider === 'steam' && /^\d+$/.test(o.appId))
    return `steam://${o.installed ? 'rungameid' : 'install'}/${o.appId}`;
  if (o.provider === 'epic' && o.appId && (o.installed || o.owned)) {
    const target = encodeURIComponent(
      o.namespace && o.itemId ? `${o.namespace}:${o.itemId}:${o.appId}` : o.appId
    );
    // Without namespace/itemId the launcher cannot install by id; open the library instead.
    if (!o.installed && !(o.namespace && o.itemId)) return 'com.epicgames.launcher://library';
    return `com.epicgames.launcher://apps/${target}?action=${o.installed ? 'launch' : 'install'}&silent=true`;
  }
  throw Error('Unsupported launch target');
}
const exists = async p => {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
};
// Download/update progress from an appmanifest (EAppState flags + byte counters).
// Steam shows two stages: download (BytesDownloaded) and installation of the
// downloaded data into the game folder (BytesStaged).
function steamProgress(v) {
  const flags = Number(v.StateFlags) || 0;
  const total = Number(v.BytesToDownload) || 0,
    done = Number(v.BytesDownloaded) || 0,
    toStage = Number(v.BytesToStage) || 0,
    staged = Number(v.BytesStaged) || 0;
  const active = flags & (256 | 1024 | 1048576); // UpdateRunning | UpdateStarted | Downloading
  const paused = flags & 512; // UpdatePaused
  if (flags & 2048) return { progress: { state: 'uninstalling' } };
  if (!(active || paused)) return {};
  const percent = (a, b) => Math.min(99, Math.floor((a / b) * 100));
  if (total && done < total)
    return {
      progress: {
        state: paused ? 'paused' : (flags & 4) === 4 ? 'updating' : 'downloading',
        percent: percent(done, total),
        done,
        total,
      },
    };
  if (toStage && staged < toStage)
    return {
      progress: {
        state: paused ? 'paused' : 'installing',
        percent: percent(staged, toStage),
        done: staged,
        total: toStage,
      },
    };
  return {};
}
// Bytes in a folder (the files a running Epic installation has written so far).
async function folderBytes(dir, limit = 200000) {
  let bytes = 0,
    files = 0;
  const walk = async d => {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files > limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        files++;
        try {
          bytes += (await fsp.stat(p)).size;
        } catch {}
      }
    }
  };
  await walk(dir);
  return bytes;
}
// Installations the Epic launcher is running now: Manifests\Pending\*.item.
// A new installation: progress = bytes written in the game folder / InstallSize.
// An update of an installed game: Epic does not say how much will change, so
// only the written amount is known.
// Download size of an Epic build = sum of its compressed chunks (what the Epic
// launcher shows as "N GB" while installing). Read from the build manifest the
// launcher keeps for the running installation; parsed once per file version.
const buildSizes = new Map();
async function epicBuildSizes(manifestPath) {
  if (!manifestPath) return null;
  try {
    const st = await fsp.stat(manifestPath);
    const key = `${manifestPath}|${st.size}|${st.mtimeMs}`;
    if (buildSizes.has(key)) return buildSizes.get(key);
    const { readManifest } = require('./epic-saves.cjs');
    const m = readManifest(await fsp.readFile(manifestPath));
    const sizes = {
      download: m.chunks.reduce((n, c) => n + (c.fileSize || 0), 0),
      install: m.files.reduce((n, f) => n + (f.size || 0), 0),
    };
    if (buildSizes.size > 20) buildSizes.clear();
    buildSizes.set(key, sizes);
    return sizes;
  } catch {
    return null;
  }
}
async function scanEpicPending(manifestDir, installedApps = new Set()) {
  const dir = path.join(manifestDir, 'Pending');
  let files = [];
  try {
    files = (await fsp.readdir(dir)).filter(x => x.endsWith('.item'));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    try {
      const v = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8'));
      if (!v.AppName || !v.InstallLocation || (v.MainGameAppName && v.MainGameAppName !== v.AppName))
        continue;
      const update = installedApps.has(v.AppName);
      const build = await epicBuildSizes(v.PendingManifestPath || v.CompleteManifestPath);
      const installSize = build?.install || Number(v.InstallSize) || 0;
      // Written game data; for a new installation it is shown in download bytes,
      // like the Epic launcher: written / size on disk × download size.
      const written = update
        ? await folderBytes(v.StagingLocation || path.join(v.InstallLocation, '.egstore', 'bps'))
        : await folderBytes(v.InstallLocation);
      const total = build?.download || installSize;
      const done = installSize && !update ? Math.round(Math.min(1, written / installSize) * total) : written;
      out.push({
        provider: 'epic',
        appId: v.AppName,
        namespace: v.CatalogNamespace,
        itemId: v.CatalogItemId,
        name: v.DisplayName || v.AppName,
        installed: update,
        source: 'local',
        licenseUnknown: true,
        installLocation: v.InstallLocation,
        progress:
          update || !total
            ? { state: 'updating', done }
            : {
                state: 'downloading',
                percent: Math.min(99, Math.floor((done / total) * 100)),
                done,
                total,
                ...(installSize && installSize !== total ? { installSize } : {}),
              },
      });
    } catch {}
  }
  return out;
}
// Disk scans are async so the main process (and the window) never blocks.
async function scanSteam(roots) {
  const offers = [],
    errors = [],
    libraries = new Set(roots.filter(Boolean));
  for (const root of [...libraries]) {
    const file = path.join(root, 'steamapps', 'libraryfolders.vdf');
    try {
      const v = parseVdf(await fsp.readFile(file, 'utf8')).libraryfolders || {};
      for (const [k, x] of Object.entries(v))
        if (/^\d+$/.test(k)) {
          const p = typeof x === 'string' ? x : x.path;
          if (p) libraries.add(p);
        }
    } catch (e) {
      if (e.code !== 'ENOENT') errors.push('Не удалось прочитать список библиотек Steam.');
    }
  }
  const seen = new Set();
  for (const root of libraries) {
    let files;
    try {
      files = await fsp.readdir(path.join(root, 'steamapps'));
    } catch {
      continue;
    }
    for (const file of files.filter(x => /^appmanifest_\d+\.acf$/.test(x))) {
      try {
        const v = parseVdf(await fsp.readFile(path.join(root, 'steamapps', file), 'utf8')).AppState;
        if (v && /^\d+$/.test(v.appid) && v.name && !seen.has(v.appid)) {
          seen.add(v.appid);
          offers.push({
            provider: 'steam',
            appId: v.appid,
            name: v.name,
            installed: (Number(v.StateFlags) & 4) === 4,
            source: 'local',
            licenseUnknown: true,
            lastPlayed: Number(v.LastPlayed) || 0,
            // Size on disk as Steam counts it (the "Хранилище" page).
            sizeOnDisk: Number(v.SizeOnDisk) || 0,
            // The manifest Steam keeps for the installed game (removed on uninstall).
            manifestFile: path.join(root, 'steamapps', file),
            // Folder of the game: its processes run from here (see main/running.cjs).
            ...(typeof v.installdir === 'string' && v.installdir && !/[\\/]|\.\./.test(v.installdir)
              ? { installDir: path.join(root, 'steamapps', 'common', v.installdir) }
              : {}),
            ...steamProgress(v),
          });
        }
      } catch {
        errors.push(`Повреждён манифест ${file}`);
      }
    }
  }
  return { offers, errors, libraries: [...libraries] };
}
// manifestDir: ...\EpicGamesLauncher\Data\Manifests
// installedDat: ...\UnrealEngineLauncher\LauncherInstalled.dat (optional)
async function scanEpic(manifestDir, installedDat) {
  const offers = [],
    errors = [],
    found = new Set();
  let files = [];
  try {
    files = await fsp.readdir(manifestDir);
  } catch {}
  for (const file of files.filter(x => x.endsWith('.item'))) {
    try {
      const v = JSON.parse(await fsp.readFile(path.join(manifestDir, file), 'utf8'));
      if (
        v.AppName &&
        v.DisplayName &&
        !v.bIsIncompleteInstall &&
        (!v.MainGameAppName || v.MainGameAppName === v.AppName) &&
        v.InstallLocation &&
        (await exists(v.InstallLocation))
      ) {
        found.add(v.AppName);
        offers.push({
          provider: 'epic',
          appId: v.AppName,
          namespace: v.CatalogNamespace,
          itemId: v.CatalogItemId,
          name: v.DisplayName,
          installed: true,
          source: 'local',
          licenseUnknown: true,
          // What the game needs to start without the Epic launcher (see main/epic-play.cjs).
          installLocation: v.InstallLocation,
          installSize: Number(v.InstallSize) || 0,
          manifestFile: path.join(manifestDir, file),
          executable: typeof v.LaunchExecutable === 'string' ? v.LaunchExecutable : '',
          launchCommand: typeof v.LaunchCommand === 'string' ? v.LaunchCommand : '',
          ownershipToken: String(v.OwnershipToken).toLowerCase() === 'true',
          canRunOffline: v.bCanRunOffline !== false,
          // Installed build (updates are found by comparing with Epic's current one).
          version: typeof v.AppVersionString === 'string' ? v.AppVersionString : '',
        });
      }
    } catch {
      errors.push(`Повреждён манифест Epic ${file}`);
    }
  }
  if (installedDat) {
    try {
      const list = parseLauncherInstalled(JSON.parse(await fsp.readFile(installedDat, 'utf8')));
      for (const x of list) {
        if (found.has(x.appId) || !(await exists(x.installLocation))) continue;
        found.add(x.appId);
        offers.push({
          provider: 'epic',
          appId: x.appId,
          namespace: x.namespace,
          itemId: x.itemId,
          // The .dat file has no title; it is filled from the account library or catalog.
          name: path.basename(x.installLocation) || x.appId,
          installed: true,
          source: 'local',
          licenseUnknown: true,
          nameFromFolder: true,
        });
      }
    } catch (e) {
      if (e.code !== 'ENOENT') errors.push('Не удалось прочитать LauncherInstalled.dat');
    }
  }
  return { offers, errors };
}
function storeUrl(provider, game) {
  if (provider === 'steam' && game.steam && /^\d+$/.test(game.steam))
    return `https://store.steampowered.com/app/${game.steam}/`;
  if (provider === 'steam')
    return `https://store.steampowered.com/search/?term=${encodeURIComponent(game.name)}`;
  if (provider === 'epic')
    return `https://store.epicgames.com/browse?q=${encodeURIComponent(game.name)}&sortBy=relevancy&sortDir=DESC&count=40`;
  throw Error('Unknown store');
}
module.exports = {
  steamProgress,
  scanEpicPending,
  folderBytes,
  parseVdf,
  normalize,
  catalogEntry,
  mergeGames,
  chooseOffer,
  launchUri,
  scanSteam,
  scanEpic,
  storeUrl,
};
