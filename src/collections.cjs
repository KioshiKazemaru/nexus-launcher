'use strict';
// Collections and hidden games.
//
// Steam keeps library collections in
//   <Steam>\userdata\<accountId32>\config\cloudstorage\cloud-storage-namespace-1.json
// as [[key, { key, value: "<json>", is_deleted? }], ...] with keys
// "user-collections.<id>". Static collections have "added" app ids; dynamic
// ones ("filterSpec") are rules Nexus cannot evaluate and are skipped.
// "hidden" and "favorite" are Steam's built-in collections.

const MAX_COLLECTIONS = 200;
const MAX_NAME = 80;

function parseSteamCollections(json) {
  if (!Array.isArray(json)) throw Error('Неизвестный формат коллекций Steam');
  const out = [];
  for (const entry of json) {
    const [key, item] = Array.isArray(entry) ? entry : [];
    if (typeof key !== 'string' || !key.startsWith('user-collections.') || !item || item.is_deleted) continue;
    let value;
    try {
      value = typeof item.value === 'string' ? JSON.parse(item.value) : item.value;
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || value.filterSpec) continue;
    const appIds = (Array.isArray(value.added) ? value.added : []).map(String).filter(x => /^\d+$/.test(x));
    const removed = new Set((Array.isArray(value.removed) ? value.removed : []).map(String));
    out.push({
      id: String(value.id || key.slice('user-collections.'.length)).slice(0, 100),
      name: String(value.name || '').slice(0, MAX_NAME),
      appIds: [...new Set(appIds.filter(a => !removed.has(a)))],
    });
  }
  return out;
}

function validName(name) {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!n || n.length > MAX_NAME) throw Error(`Название коллекции: от 1 до ${MAX_NAME} символов`);
  return n;
}

// Applies Steam collections to Nexus settings. steamToGame maps a Steam app id
// to the current Nexus game id. Returns a short report.
function importSteamCollections(settings, parsed, steamToGame) {
  const report = { collections: 0, games: 0, hidden: 0, favorites: 0 };
  const ids = list => [...new Set(list.map(a => steamToGame(a)).filter(Boolean))];
  for (const c of parsed) {
    const games = ids(c.appIds);
    if (c.id === 'hidden') {
      const before = settings.hidden.length;
      settings.hidden = [...new Set([...settings.hidden, ...games])];
      report.hidden += settings.hidden.length - before;
      continue;
    }
    if (c.id === 'favorite') {
      const before = settings.favorites.length;
      settings.favorites = [...new Set([...settings.favorites, ...games])];
      report.favorites += settings.favorites.length - before;
      continue;
    }
    if (!c.name) continue;
    const id = 'steam-' + c.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
    const existing = settings.collections.find(x => x.id === id);
    if (existing) {
      existing.name = c.name;
      existing.games = [...new Set([...existing.games, ...games])];
    } else {
      if (settings.collections.length >= MAX_COLLECTIONS) break;
      settings.collections.push({ id, name: c.name, games, source: 'steam' });
    }
    report.collections++;
    report.games += games.length;
  }
  return report;
}

function createCollection(settings, name, newId) {
  const n = validName(name);
  if (settings.collections.length >= MAX_COLLECTIONS) throw Error('Слишком много коллекций');
  if (settings.collections.some(c => c.name.toLowerCase() === n.toLowerCase()))
    throw Error('Такая коллекция уже есть');
  const c = { id: newId, name: n, games: [], source: 'nexus' };
  settings.collections.push(c);
  return c;
}

function setInCollection(settings, collectionId, gameId, include) {
  const c = settings.collections.find(x => x.id === collectionId);
  if (!c) throw Error('Коллекция не найдена');
  if (typeof gameId !== 'string' || gameId.length > 200) throw Error('Некорректная игра');
  c.games = include ? [...new Set([...c.games, gameId])] : c.games.filter(x => x !== gameId);
}

function setHidden(settings, gameId, hidden) {
  if (typeof gameId !== 'string' || gameId.length > 200) throw Error('Некорректная игра');
  settings.hidden = hidden
    ? [...new Set([...settings.hidden, gameId])]
    : settings.hidden.filter(x => x !== gameId);
}

module.exports = {
  parseSteamCollections,
  importSteamCollections,
  createCollection,
  setInCollection,
  setHidden,
  validName,
};
