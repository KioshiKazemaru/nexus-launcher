'use strict';
// Orchestrates optional services (IsThereAnyDeal, IGDB, SteamGridDB).
// Keys live in the encrypted vault (vault.keys); results are cached on disk so
// lookups happen once per game, in the background, with a small rate limit.

const api = require('../integrations.cjs');
const { canonicalTitle } = require('../matching.cjs');

const KEY_RULES = {
  itad: /^[A-Za-z0-9_-]{16,128}$/,
  igdbId: /^[a-z0-9]{20,64}$/i,
  igdbSecret: /^[a-z0-9]{20,64}$/i,
  sgdb: /^[a-f0-9]{32}$/i,
  steamWebApi: /^[A-Fa-f0-9]{32}$/,
};
const CACHE_LIMIT = 5000;
const SGDB_RETRY = 7 * 86400000;
// Nexus works with Steam and Epic only: other shops from IsThereAnyDeal are
// dropped, the historical low is the lowest of the two stores.
function onlySteamAndEpic(entry) {
  const shops = new Set([api.ITAD_SHOP.steam, api.ITAD_SHOP.epic]);
  const deals = (entry?.deals || []).filter(d => shops.has(d.shopId));
  const lows = deals.map(d => d.storeLow).filter(Boolean);
  const historyLow = lows.length ? lows.reduce((a, b) => (b.amount < a.amount ? b : a)) : null;
  return { deals, historyLow };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

class IntegrationsService {
  constructor(ctx) {
    this.ctx = ctx;
    const c = ctx.storage.loadIntegrations();
    this.cache = {
      itadSteam: c.itadSteam || {},
      itadTitle: c.itadTitle || {},
      igdbSteam: c.igdbSteam || {},
      igdbTitle: c.igdbTitle || {},
      igdbGames: c.igdbGames || {},
      sgdb: c.sgdb || {},
    };
    // name → Map(key → sequence number of first sight), for save().
    this.seq = 0;
    this.seen = {};
    for (const [name, map] of Object.entries(this.cache))
      this.seen[name] = new Map(Object.keys(map).map(k => [k, this.seq++]));
    this.igdbAuth = null;
    this.queue = null;
    this.rebuildTimer = null;
    this.lastError = {};
  }
  keys() {
    return this.ctx.vault.keys || {};
  }
  has(name) {
    if (name === 'igdb') return !!(this.keys().igdbId && this.keys().igdbSecret);
    return !!this.keys()[name];
  }
  status() {
    return {
      itad: { enabled: this.has('itad'), error: this.lastError.itad || '' },
      igdb: { enabled: this.has('igdb'), error: this.lastError.igdb || '' },
      sgdb: { enabled: this.has('sgdb'), error: this.lastError.sgdb || '' },
      steamWebApi: { enabled: this.has('steamWebApi') },
      encryption: this.ctx.storage.encryptionAvailable(),
    };
  }
  setKey(name, value) {
    if (!Object.hasOwn(KEY_RULES, name)) throw Error('Неизвестный ключ');
    const v = typeof value === 'string' ? value.trim() : '';
    if (v && !KEY_RULES[name].test(v)) throw Error('Ключ имеет неверный формат');
    if (v && !this.ctx.storage.encryptionAvailable())
      throw Error('Защищённое хранилище Windows недоступно, ключ не может быть сохранён.');
    const previous = this.ctx.vault.keys;
    const keys = { ...this.keys() };
    if (v) keys[name] = v;
    else delete keys[name];
    if (Object.keys(keys).length) this.ctx.vault.keys = keys;
    else delete this.ctx.vault.keys;
    try {
      this.ctx.storage.saveVault(this.ctx.vault);
    } catch (e) {
      // Not saved: the key must not stay active only until the next start.
      if (previous) this.ctx.vault.keys = previous;
      else delete this.ctx.vault.keys;
      throw e;
    }
    if (name.startsWith('igdb')) this.igdbAuth = null;
    delete this.lastError[name.startsWith('igdb') ? 'igdb' : name];
    if (v) this.enqueue(this.ctx.library.games);
  }
  // Each cache map keeps at most CACHE_LIMIT newest entries. Object key order
  // cannot tell the age: numeric keys (Steam app ids) are always listed in
  // ascending order, so the order in which keys were first seen is tracked.
  save() {
    for (const [name, map] of Object.entries(this.cache)) {
      const seen = this.seen[name];
      for (const k of Object.keys(map)) if (!seen.has(k)) seen.set(k, this.seq++);
      for (const k of seen.keys()) if (!Object.hasOwn(map, k)) seen.delete(k);
      const extra = seen.size - CACHE_LIMIT;
      if (extra > 0) {
        const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, extra);
        for (const [k] of oldest) {
          delete map[k];
          seen.delete(k);
        }
      }
    }
    this.ctx.storage.saveIntegrations(this.cache);
  }
  laterRebuild() {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.ctx.library.rebuild(), 2000);
  }

  // ---- lookups used by the library ----------------------------------------

  externalId(o) {
    const ids = [];
    if (o.provider === 'steam') {
      if (this.cache.itadSteam[o.appId]) ids.push('itad:' + this.cache.itadSteam[o.appId]);
      if (this.cache.igdbSteam[o.appId]) ids.push('igdb:' + this.cache.igdbSteam[o.appId]);
    } else if (o.provider === 'epic') {
      const t = canonicalTitle(o.name);
      if (this.cache.itadTitle[t]) ids.push('itad:' + this.cache.itadTitle[t]);
      if (this.cache.igdbTitle[t]) ids.push('igdb:' + this.cache.igdbTitle[t]);
    }
    return ids;
  }
  metadata(game) {
    const steam = game.offers?.find(o => o.provider === 'steam');
    const id =
      (steam && this.cache.igdbSteam[steam.appId]) || this.cache.igdbTitle[canonicalTitle(game.name)];
    const m = id && this.cache.igdbGames[id];
    return m ? { summary: m.summary, genres: m.genres, cover: m.cover } : null;
  }
  portrait(game) {
    const v = this.cache.sgdb[game.id];
    return typeof v === 'string' ? v : v?.url || '';
  }
  // A cover that was not found is searched again after a week.
  sgdbDue(id, now = Date.now()) {
    const v = this.cache.sgdb[id];
    if (v === undefined) return true;
    if (typeof v === 'string') return !v;
    return !v.url && now - (v.at || 0) > SGDB_RETRY;
  }

  // ---- background queue -----------------------------------------------------

  enqueue(games) {
    if (!this.has('itad') && !this.has('igdb') && !this.has('sgdb')) return;
    this.pendingGames = games;
    if (this.queue) return;
    this.queue = this.run()
      .catch(e => this.ctx.log?.warn('integrations', e.message))
      .finally(() => {
        this.queue = null;
      });
  }
  async run() {
    // Let bursts of rebuilds settle before hitting the network.
    await sleep(1500);
    const games = this.pendingGames || [];
    this.pendingGames = null;
    let changed = false;
    const steamIds = [
      ...new Set(games.flatMap(g => g.offers.filter(o => o.provider === 'steam').map(o => o.appId))),
    ];
    const epicTitles = [
      ...new Set(
        games.flatMap(g => g.offers.filter(o => o.provider === 'epic').map(o => canonicalTitle(o.name)))
      ),
    ].filter(Boolean);

    if (this.has('itad')) {
      try {
        const missing = steamIds.filter(id => !(id in this.cache.itadSteam));
        if (missing.length) {
          const found = await api.itadLookupSteam(this.ctx.publicFetch, this.keys().itad, missing);
          for (const id of missing) this.cache.itadSteam[id] = found[id] || null;
          changed = true;
        }
        for (const t of epicTitles.filter(t => !(t in this.cache.itadTitle)).slice(0, 60)) {
          const g = games.find(x =>
            x.offers.some(o => o.provider === 'epic' && canonicalTitle(o.name) === t)
          );
          const name = g?.offers.find(o => o.provider === 'epic')?.name || t;
          this.cache.itadTitle[t] =
            (await api.itadLookupTitle(this.ctx.publicFetch, this.keys().itad, name))?.id || null;
          changed = true;
          await sleep(250);
        }
        delete this.lastError.itad;
      } catch (e) {
        this.lastError.itad = e.message;
      }
    }
    if (this.has('igdb')) {
      try {
        const auth = await this.igdb();
        const missing = steamIds.filter(id => !(id in this.cache.igdbSteam));
        if (missing.length) {
          const found = await api.igdbBySteam(this.ctx.publicFetch, auth, missing);
          for (const id of missing) this.cache.igdbSteam[id] = found[id] || null;
          changed = true;
        }
        for (const t of epicTitles.filter(t => !(t in this.cache.igdbTitle)).slice(0, 40)) {
          const name =
            games.flatMap(g => g.offers).find(o => o.provider === 'epic' && canonicalTitle(o.name) === t)
              ?.name || t;
          const results = await api.igdbSearch(this.ctx.publicFetch, auth, name);
          const hit = results.find(r => canonicalTitle(r.name) === t);
          this.cache.igdbTitle[t] = hit?.id || null;
          if (hit) this.cache.igdbGames[hit.id] = hit;
          changed = true;
          await sleep(300);
        }
        const ids = [
          ...new Set([...Object.values(this.cache.igdbSteam), ...Object.values(this.cache.igdbTitle)]),
        ].filter(id => Number.isInteger(id) && !this.cache.igdbGames[id]);
        for (let i = 0; i < ids.length; i += 400) {
          for (const g of await api.igdbGames(this.ctx.publicFetch, auth, ids.slice(i, i + 400)))
            this.cache.igdbGames[g.id] = {
              name: g.name,
              summary: g.summary,
              genres: g.genres,
              cover: g.cover,
            };
          changed = true;
          await sleep(300);
        }
        delete this.lastError.igdb;
      } catch (e) {
        this.lastError.igdb = e.message;
        if (e.status === 401) this.igdbAuth = null;
      }
    }
    if (this.has('sgdb')) {
      try {
        const need = games.filter(
          g =>
            this.sgdbDue(g.id) &&
            (g.offers.some(o => o.provider === 'custom') || !g.offers.some(o => o.provider === 'steam'))
        );
        for (const g of need.slice(0, 60)) {
          const steam = g.offers.find(o => o.provider === 'steam');
          const url = await api
            .sgdbPortrait(this.ctx.publicFetch, this.keys().sgdb, { steamAppId: steam?.appId, title: g.name })
            .catch(e => {
              if (e.status) throw e;
              return '';
            });
          delete this.cache.sgdb[g.id];
          this.seen.sgdb.delete(g.id); // a fresh lookup counts as new
          this.cache.sgdb[g.id] = { url, at: Date.now() };
          changed = true;
          await sleep(250);
        }
        delete this.lastError.sgdb;
      } catch (e) {
        this.lastError.sgdb = e.message;
      }
    }
    if (changed) {
      this.save();
      this.laterRebuild();
    }
    this.ctx.hub.publish();
  }
  async igdb() {
    if (this.igdbAuth && this.igdbAuth.expiresAt - Date.now() > 60000) return this.igdbAuth;
    const k = this.keys();
    const t = await api.twitchToken(this.ctx.publicFetch, k.igdbId, k.igdbSecret);
    this.igdbAuth = { clientId: k.igdbId, token: t.token, expiresAt: t.expiresAt };
    return this.igdbAuth;
  }

  // ---- prices in other shops ------------------------------------------------

  async deals(game, country) {
    if (!this.has('itad')) return { enabled: false };
    const steam = game.steam || game.storeOffers?.find(o => o.provider === 'steam')?.appId;
    let id = steam ? this.cache.itadSteam[steam] : null;
    if (!id && steam && !(steam in this.cache.itadSteam)) {
      const found = await api.itadLookupSteam(this.ctx.publicFetch, this.keys().itad, [String(steam)]);
      id = this.cache.itadSteam[steam] = found[steam] || null;
      this.save();
    }
    if (!id) {
      const t = canonicalTitle(game.name);
      if (!(t in this.cache.itadTitle)) {
        this.cache.itadTitle[t] =
          (await api.itadLookupTitle(this.ctx.publicFetch, this.keys().itad, game.name))?.id || null;
        this.save();
      }
      id = this.cache.itadTitle[t];
    }
    if (!id) return { enabled: true, found: false };
    const prices = await api.itadPrices(this.ctx.publicFetch, this.keys().itad, [id], country);
    return {
      enabled: true,
      found: true,
      id,
      ...onlySteamAndEpic(prices[id]),
      checkedAt: Date.now(),
    };
  }
}

module.exports = { IntegrationsService, KEY_RULES, onlySteamAndEpic };
