'use strict';
// Export / import of Nexus settings. The backup never contains secrets:
// cookies, Epic tokens and API keys stay in the encrypted vault of this PC.
// Account slots and web partitions belong to this PC and are not restored.

const FORMAT = 'nexus-backup';
const LIST_FIELDS = ['favorites', 'wishlist', 'hidden', 'seenGiveaways', 'splits'];
const MAX_BYTES = 32 * 1024 * 1024;

function createBackup(settings, ownedCache, version) {
  const copy = JSON.parse(JSON.stringify(settings));
  for (const k of ['steamSlots', 'epicPartitions', 'remember', 'purchaseAccount', 'knownAccounts'])
    delete copy[k];
  return {
    format: FORMAT,
    version: 1,
    app: version,
    createdAt: new Date().toISOString(),
    settings: copy,
    library: ownedCache,
  };
}

const isStr = (v, max = 300) => typeof v === 'string' && v.length <= max;
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v, max = 1e12) => (Number.isFinite(v) && v >= 0 && v <= max ? v : null);
const currency = v => (typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : null);
const httpsUrl = v => (isStr(v, 1000) && /^https:\/\//.test(v) ? v : null);

// A backup file can come from anywhere: every restored record is rebuilt from
// known fields with checked types, unknown fields are dropped.
function cleanPrice(p) {
  if (!isObject(p) || num(p.amount) === null || !currency(p.currency)) return null;
  return {
    amount: p.amount,
    currency: p.currency,
    price: isStr(p.price, 60) ? p.price : null,
    discount: num(p.discount, 100) || 0,
    at: num(p.at) || 0,
  };
}
function cleanWatch(w) {
  if (
    !isObject(w) ||
    !isStr(w.key, 300) ||
    !['steam', 'epic'].includes(w.provider) ||
    !isStr(w.appId, 200) ||
    !isStr(w.name, 200)
  )
    return null;
  if (!/^[A-Z]{2}$/.test(w.country || '')) return null;
  return {
    key: w.key,
    id: isStr(w.id, 200) ? w.id : w.key,
    name: w.name,
    image: httpsUrl(w.image) || '',
    provider: w.provider,
    appId: w.appId,
    namespace: isStr(w.namespace, 200) ? w.namespace : '',
    country: w.country,
    target: num(w.target, 1e8),
    targetCurrency: currency(w.targetCurrency),
    current: cleanPrice(w.current),
    history: (Array.isArray(w.history) ? w.history : []).map(cleanPrice).filter(Boolean).slice(-180),
  };
}
function cleanPlaytime(map) {
  const out = {};
  for (const [id, v] of Object.entries(map).slice(0, 5000))
    if (isStr(id, 100) && isObject(v) && num(v.minutes, 1e8) !== null)
      out[id] = { minutes: Math.round(v.minutes), lastPlayed: num(v.lastPlayed) || 0 };
  return out;
}
function cleanSavedGames(map) {
  const out = {};
  for (const [id, g] of Object.entries(map).slice(0, 5000)) {
    if (!isStr(id, 200) || !isObject(g) || g.id !== id || !isStr(g.name, 200)) continue;
    out[id] = {
      id,
      name: g.name,
      steam: /^\d{1,10}$/.test(g.steam || '') ? g.steam : undefined,
      epic: /^[a-z0-9][a-z0-9-]{0,180}$/i.test(g.epic || '') ? g.epic : undefined,
      image: httpsUrl(g.image) || '',
      portrait: httpsUrl(g.portrait) || '',
      tags: (Array.isArray(g.tags) ? g.tags : []).filter(t => isStr(t, 50)).slice(0, 10),
      desc: isStr(g.desc, 2000) ? g.desc.slice(0, 500) : '',
      storeOffers: (Array.isArray(g.storeOffers) ? g.storeOffers : [])
        .filter(o => isObject(o) && ['steam', 'epic'].includes(o.provider) && isStr(o.appId, 200))
        .slice(0, 4)
        .map(o => ({
          provider: o.provider,
          appId: o.appId,
          namespace: isStr(o.namespace, 200) ? o.namespace : '',
          name: isStr(o.name, 200) ? o.name : g.name,
          url: httpsUrl(o.url),
          items: (Array.isArray(o.items) ? o.items : [])
            .filter(i => isObject(i) && isStr(i.id, 200) && isStr(i.namespace, 200))
            .slice(0, 20),
        })),
    };
  }
  return out;
}

// Manually added games of a backup that are not in settings yet. Nexus asks
// the user before adding them, because "Play" starts the named program.
function backupCustomGames(settings, data) {
  const list = data?.settings?.custom;
  if (!Array.isArray(list)) return [];
  const known = new Set((settings.custom || []).map(c => c.exe.toLowerCase()));
  const ids = new Set((settings.custom || []).map(c => c.id));
  const out = [];
  for (const c of list.slice(0, 500)) {
    if (!(isStr(c?.id, 100) && isStr(c?.name, 200) && isStr(c?.exe, 1000) && /\.exe$/i.test(c.exe))) continue;
    // Only absolute local paths (C:\…); network shares and relative paths are refused.
    if (!/^[A-Za-z]:[\\/]/.test(c.exe) || known.has(c.exe.toLowerCase()) || ids.has(c.id)) continue;
    known.add(c.exe.toLowerCase());
    ids.add(c.id);
    out.push({
      id: c.id,
      name: c.name,
      exe: c.exe,
      ...(/^[\w .()+-]{1,100}\.exe$/i.test(c.trackProcess || '') ? { trackProcess: c.trackProcess } : {}),
    });
  }
  return out;
}

// Validates and merges a backup into settings. Returns the library cache to restore.
function restoreBackup(settings, data, size = 0) {
  if (size > MAX_BYTES) throw Error('Файл резервной копии слишком большой');
  if (data?.format !== FORMAT || data.version !== 1 || typeof data.settings !== 'object')
    throw Error('Это не резервная копия Nexus');
  const s = data.settings;
  for (const k of LIST_FIELDS)
    if (Array.isArray(s[k])) settings[k] = [...new Set(s[k].filter(x => isStr(x)))].slice(0, 5000);
  if (Array.isArray(s.recent))
    settings.recent = s.recent.filter(r => isStr(r?.id) && Number.isFinite(r.time)).slice(0, 20);
  if (s.preferred && typeof s.preferred === 'object')
    settings.preferred = Object.fromEntries(
      Object.entries(s.preferred).filter(([k, v]) => isStr(k) && ['steam', 'epic', 'custom'].includes(v))
    );
  if (Array.isArray(s.links)) settings.links = s.links.filter(l => isStr(l?.a) && isStr(l?.b)).slice(0, 5000);
  if (Array.isArray(s.collections))
    settings.collections = s.collections
      .filter(c => isStr(c?.id, 100) && isStr(c?.name, 80) && Array.isArray(c.games))
      .map(c => ({
        id: c.id,
        name: c.name,
        source: c.source === 'steam' ? 'steam' : 'nexus',
        games: c.games.filter(x => isStr(x)),
      }))
      .slice(0, 200);
  // Manually added games (.exe paths) are not restored here: "Play" would
  // start whatever program a backup file names. See backupCustomGames().
  if (Array.isArray(s.priceWatches))
    settings.priceWatches.splice(
      0,
      settings.priceWatches.length,
      ...s.priceWatches.map(cleanWatch).filter(Boolean).slice(0, 100)
    );
  if (isObject(s.customPlaytime)) settings.customPlaytime = cleanPlaytime(s.customPlaytime);
  if (isObject(s.savedGames)) settings.savedGames = cleanSavedGames(s.savedGames);
  if (/^[A-Z]{2}$/.test(s.storeCountry || '')) settings.storeCountry = s.storeCountry;
  if (['installed', 'owned'].includes(s.libraryView)) settings.libraryView = s.libraryView;
  if (isStr(s.steamRoot, 1000)) settings.steamRoot = s.steamRoot;
  for (const k of [
    'notifyGiveaways',
    'autoUpdate',
    'autoStart',
    'diagnostics',
    'epicDirectLaunch',
    'epicCloudSaves',
    'steamSilent',
    'steamCloseAfter',
  ])
    if (typeof s[k] === 'boolean') settings[k] = s[k];
  const library = data.library && typeof data.library === 'object' ? data.library : {};
  return Object.fromEntries(
    Object.entries(library).filter(
      ([k, v]) => /^(steam|epic):[A-Za-z0-9]+$/.test(k) && Array.isArray(v?.offers)
    )
  );
}

module.exports = {
  FORMAT,
  MAX_BYTES,
  createBackup,
  restoreBackup,
  backupCustomGames,
  cleanWatch,
  cleanSavedGames,
};
