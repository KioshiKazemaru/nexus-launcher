'use strict';
// A game's id changes when offers are merged or split (for example "epic:Hades"
// becomes "steam:1145360" after it is joined with the Steam copy). Settings that
// refer to library games by id are moved to the current id so favorites,
// recent launches and the preferred platform survive merges and splits.
// Ids that match no game (signed-out account, uninstalled) are kept unchanged.

function aliasMap(games) {
  const map = new Map();
  for (const g of games) {
    for (const a of g.aliases || []) if (!map.has(a)) map.set(a, g.id);
    for (const o of g.offers || []) {
      const k = `${o.provider}:${o.appId}`;
      if (!map.has(k)) map.set(k, g.id);
    }
  }
  for (const g of games) map.set(g.id, g.id);
  return map;
}

// Returns true when something changed.
function remapGameIds(settings, games) {
  const map = aliasMap(games);
  const to = id => map.get(id) || id;
  let changed = false;
  const favorites = [...new Set(settings.favorites.map(to))];
  if (favorites.join('\n') !== settings.favorites.join('\n')) {
    settings.favorites = favorites;
    changed = true;
  }
  const recent = new Map();
  for (const r of settings.recent) {
    const id = to(r.id);
    if (!recent.has(id) || recent.get(id).time < r.time) recent.set(id, { ...r, id });
  }
  const nextRecent = [...recent.values()].sort((a, b) => b.time - a.time);
  if (nextRecent.map(r => r.id + r.time).join() !== settings.recent.map(r => r.id + r.time).join()) {
    settings.recent = nextRecent;
    changed = true;
  }
  for (const [id, provider] of Object.entries(settings.preferred)) {
    const target = to(id);
    if (target === id) continue;
    if (!(target in settings.preferred)) settings.preferred[target] = provider;
    delete settings.preferred[id];
    changed = true;
  }
  for (const key of ['hidden']) {
    if (!Array.isArray(settings[key])) continue;
    const next = [...new Set(settings[key].map(to))];
    if (next.join('\n') !== settings[key].join('\n')) {
      settings[key] = next;
      changed = true;
    }
  }
  for (const c of settings.collections || []) {
    const next = [...new Set(c.games.map(to))];
    if (next.join('\n') !== c.games.join('\n')) {
      c.games = next;
      changed = true;
    }
  }
  if (settings.customPlaytime) {
    for (const [id, v] of Object.entries(settings.customPlaytime)) {
      const target = to(id);
      if (target === id) continue;
      settings.customPlaytime[target] = v;
      delete settings.customPlaytime[id];
      changed = true;
    }
  }
  return changed;
}

module.exports = { aliasMap, remapGameIds };
