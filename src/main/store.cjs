'use strict';
// Store front: search, collections, prices, price watches, Epic giveaways,
// wishlist import and "where is it cheaper".

const { Notification } = require('electron');
const path = require('node:path');
const { catalog } = require('../catalog.cjs');
const { CatalogPrices, steamOffer } = require('../catalog-prices.cjs');
const { ownedOffers, ownsOffer } = require('../ownership.cjs');
const { fetchHome, browseSteamSafe } = require('../storefront.cjs');
const { PriceWatcher, fetchPrice, usablePrice } = require('../prices.cjs');
const {
  responseJSON,
  searchEpic,
  searchSteamByTags,
  browseEpic,
  combineOffers,
  searchStores,
  normalize,
  imageUrl,
  regionCurrency,
} = require('../providers.cjs');
const { storeUrl } = require('../core.cjs');
const { fetchFreeGames, newGiveaways, giveawayKey } = require('../free-games.cjs');
const wishlist = require('../wishlist.cjs');
const steamLib = require('../steam-library.cjs');
const { LruMap } = require('./hub.cjs');
const { bestOffer } = require('../compare.cjs');
const recommend = require('../recommend.cjs');
const { JsonFile } = require('./storage.cjs');
const { canonicalTitle } = require('../matching.cjs');

const REC_TTL = 6 * 3600 * 1000; // recommendations are recomputed at most every 6 hours
const TAGS_TTL = 30 * 86400000; // tags of an owned game change rarely
const CACHE_LIMIT = 5000;
// Runs jobs with a small concurrency (store APIs are rate limited).
async function eachLimited(list, limit, job) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (index < list.length) await job(list[index++]);
    })
  );
}

const COUNTRIES = Object.keys(regionCurrency);
const providerNames = { steam: 'Steam', epic: 'Epic Games' };
const icon = path.join(__dirname, '../../ui/assets/nexus.ico');

class StoreService {
  constructor(ctx) {
    this.ctx = ctx;
    this.priceDirty = new Set(); // ids whose store data changed since the last window update
    this.index = new LruMap(3000, id => this.priceDirty.add(id));
    this.catalogVersion = 0; // bumped when saved games / wishlist entries change
    this.searchCache = new LruMap(60);
    this.browseCache = new Map();
    this.homeCache = new Map();
    this.dlcCache = new LruMap(40);
    this.free = null;
    this.notifications = new Set();
    // Tags of owned games and the Steam app of Epic games, kept between runs.
    this.recFile = new JsonFile(ctx.storage.file('recommend-cache.json'), 2000);
    const saved = this.recFile.readSync({}) || {};
    this.recCache = { tags: saved.tags || {}, epicSteam: saved.epicSteam || {} };
    this.recResults = new Map(); // country → { key, at, value }
    this.recRunning = new Map();
    this.prices = new CatalogPrices(ctx.routedFetch);
    // Epic catalog is fetched directly; after HTTP 403 it goes through a hidden store page.
    this.epicFetch = ctx.epicFetch;
    for (const g of [...catalog, ...Object.values(ctx.settings.savedGames)]) this.index.set(g.id, g);
    this.watcher = new PriceWatcher(
      ctx.settings.priceWatches,
      w => fetchPrice(ctx.routedFetch, w),
      () => {
        ctx.storage.saveSettings();
        ctx.hub.publish();
      },
      (w, reason) =>
        this.notify(
          reason,
          `${w.name} · ${providerNames[w.provider]}: ${w.current.price || w.current.amount + ' ' + w.current.currency}`
        )
    );
  }
  notify(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon });
    // Without a reference the notification can be garbage-collected while it
    // is shown, and on Windows its click is then lost.
    this.notifications.add(n);
    const done = () => this.notifications.delete(n);
    n.on('click', () => {
      done();
      this.ctx.focusMain();
      onClick?.();
    });
    n.on('close', done);
    n.on('failed', done);
    n.show();
  }
  fetchers() {
    return { steam: this.ctx.publicFetch, epic: this.epicFetch };
  }
  find(id) {
    return (
      this.index.get(id) || catalog.find(x => x.id === id) || this.ctx.library.games.find(x => x.id === id)
    );
  }
  country() {
    return this.ctx.settings.storeCountry;
  }
  checkCountry(country) {
    if (!COUNTRIES.includes(country)) throw Error('Некорректный регион');
  }

  // ---- catalogue -------------------------------------------------------------

  async search({ query, country, start = 0 }) {
    if (typeof query !== 'string' || query.length > 200 || !query.trim())
      throw Error('Введите название игры');
    this.checkCountry(country);
    if (!Number.isInteger(start) || start < 0 || start > 5000) throw Error('Некорректные параметры поиска');
    const key = JSON.stringify([query.trim(), country, start]),
      cached = this.searchCache.get(key);
    if (cached && Date.now() - cached.checkedAt < 180000) return cached;
    const result = await searchStores(this.fetchers(), query.trim(), country, start);
    for (const g of result.items) {
      g.pricesUpdatedAt = result.checkedAt;
      this.prices.cache.delete(g.id + ':' + country);
      this.index.set(g.id, g);
    }
    if (Object.values(result.providers).every(p => p.ok)) this.searchCache.set(key, result);
    return result;
  }
  async browse({ kind, country, provider = 'steam' }) {
    if (!['new', 'top', 'coming', 'sales', 'free'].includes(kind)) throw Error('Некорректная подборка');
    this.checkCountry(country);
    if (provider === 'epic') return this.browseEpicList(kind, country);
    if (provider !== 'steam') throw Error('Неизвестный магазин');
    const key = kind + ':' + country,
      old = this.browseCache.get(key);
    if (old && Date.now() - old.checkedAt < 180000) return old;
    const result = await browseSteamSafe(this.ctx.publicFetch, kind, country);
    // One pass over the index instead of one per offer.
    const bySteam = new Map();
    for (const x of this.index.values()) if (x.steam && !bySteam.has(x.steam)) bySteam.set(x.steam, x);
    const items = result.offers.map(o => {
      const known = bySteam.get(o.appId);
      const same = known?.storeOffers?.find(x => x.provider === 'steam' && x.country === country);
      const g = {
        ...known,
        id: known?.id || `steam:${o.appId}`,
        name: o.name,
        steam: o.appId,
        image: o.image || known?.image,
        tags: known?.tags || [],
        desc: known?.desc || '',
        storeOffers: [
          { ...same, ...o, country },
          ...(known?.storeOffers || []).filter(
            x => x.provider === 'epic' && (!x.country || x.country === country)
          ),
        ],
      };
      this.index.set(g.id, g);
      return g;
    });
    const answer = { items, country, kind, checkedAt: Date.now() };
    this.browseCache.set(key, answer);
    return answer;
  }
  // The same lists from the Epic Games store. Epic does not publish its top
  // sellers to other programs: "Лидеры" are the Steam top sellers that Epic
  // sells too, with Epic's price (found by exact title).
  async browseEpicList(kind, country) {
    const key = 'epic:' + kind + ':' + country,
      old = this.browseCache.get(key);
    if (old && Date.now() - old.checkedAt < 600000) return old;
    let offers;
    let note = '';
    if (kind === 'top') {
      const top = (await browseSteamSafe(this.ctx.publicFetch, 'top', country)).offers.slice(0, 20);
      const found = new Array(top.length);
      let index = 0;
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (index < top.length) {
            const i = index++;
            try {
              const r = await searchEpic(this.epicFetch, top[i].name, country);
              found[i] = r.offers.find(
                o => o.type === 'game' && normalize(o.name) === normalize(top[i].name)
              );
            } catch (e) {
              this.ctx.log?.debug('epic-top', e.message);
            }
          }
        })
      );
      offers = found.filter(Boolean);
      note =
        'Самые продаваемые в Steam игры, которые есть в Epic Games: свой список лидеров Epic сторонним программам не отдаёт.';
    } else offers = (await browseEpic(this.epicFetch, kind, country)).offers;
    const items = combineOffers(offers.map(o => ({ ...o, country }))).map(g => {
      const previous = this.index.get(g.id);
      const merged = previous
        ? { ...previous, ...g, desc: g.desc || previous.desc, tags: g.tags?.length ? g.tags : previous.tags }
        : g;
      merged.released = offers.find(o => o.appId === g.storeOffers[0]?.appId)?.released || merged.released;
      this.index.set(merged.id, merged);
      return merged;
    });
    const answer = { items, country, kind, provider: 'epic', note, checkedAt: Date.now() };
    this.browseCache.set(key, answer);
    return answer;
  }
  async home({ country, force = false }) {
    this.checkCountry(country);
    if (typeof force !== 'boolean') throw Error('Некорректные параметры витрины');
    const old = this.homeCache.get(country);
    if (!force && old && Date.now() - old.checkedAt < 300000) return old;
    const result = await fetchHome(this.fetchers(), country);
    for (const g of [...result.items, ...result.promotions, ...(result.newReleases || [])]) {
      g.pricesUpdatedAt = result.checkedAt;
      const previous = this.index.get(g.id);
      if (previous) {
        g.desc = previous.desc || g.desc;
        g.tags = previous.tags?.length ? previous.tags : g.tags;
        g.portrait = previous.portrait || g.portrait;
        const combined = new Map([
          ...(previous.storeOffers || [])
            .filter(o => o.country === country)
            .map(o => [o.provider + ':' + o.appId, o]),
          ...(g.storeOffers || []).map(o => [o.provider + ':' + o.appId, o]),
        ]);
        g.storeOffers = [...combined.values()];
      }
      this.index.set(g.id, g);
    }
    // Giveaways are part of the store front.
    result.free = await this.freeGames().catch(() => this.free);
    this.homeCache.set(country, result);
    return result;
  }
  async dlc({ country }) {
    this.checkCountry(country);
    const source = this.ctx.library
      .visible()
      .filter(
        g =>
          g.offers.some(o => o.provider === 'steam' && (o.owned || o.installed)) &&
          /^\d+$/.test(String(g.steam || ''))
      );
    const order = [
      ...this.ctx.settings.recent.map(r => r.id),
      ...source.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)).map(g => g.id),
    ];
    const selected = [...new Set(order)]
      .map(id => source.find(g => g.id === id))
      .filter(Boolean)
      .slice(0, 4);
    const key = country + ':' + selected.map(g => g.steam).join(','),
      old = this.dlcCache.get(key);
    if (old && Date.now() - old.checkedAt < 600000) return old;
    const details = async appId => {
      const u = new URL('https://store.steampowered.com/api/appdetails');
      u.search = new URLSearchParams({ appids: appId, cc: country, l: 'russian' });
      return (await responseJSON(this.ctx.publicFetch, u.href))[appId];
    };
    const ids = [];
    for (const g of selected) {
      try {
        const data = await details(String(g.steam));
        if (data?.success)
          ids.push(...(data.data?.dlc || []).filter(x => /^\d+$/.test(String(x))).slice(0, 3));
      } catch (e) {
        this.ctx.log?.debug('dlc', e.message);
      }
    }
    const owned = ownedOffers(this.ctx.library.visible());
    const unique = [...new Set(ids)].slice(0, 12),
      items = [];
    let index = 0;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (index < unique.length) {
          const appId = String(unique[index++]);
          try {
            const data = await details(appId);
            const offer = steamOffer(
              data,
              { steam: appId, name: data?.data?.name || `Steam ${appId}` },
              country
            );
            if (
              data?.success &&
              offer.type === 'dlc' &&
              offer.image &&
              offer.priceStatus === 'ready' &&
              !ownsOffer(owned, offer)
            ) {
              const g = {
                id: `steam:${appId}`,
                steam: appId,
                name: offer.name,
                image: offer.image,
                desc: offer.description,
                tags: offer.tags,
                storeOffers: [offer],
              };
              items.push(g);
              this.index.set(g.id, g);
            }
          } catch {}
        }
      })
    );
    const result = { items: items.slice(0, 8), checkedAt: Date.now(), country };
    this.dlcCache.set(key, result);
    return result;
  }
  async epicImage(epic, name) {
    const r = await searchEpic(this.epicFetch, name, this.country());
    const offer = r.offers.find(
      o =>
        o.namespace === epic.namespace &&
        (o.items.some(i => i.id === epic.itemId) || normalize(o.name) === normalize(name))
    );
    return offer?.image || '';
  }

  // ---- recommendations ("Рекомендовано вам", like Steam) -------------------

  // Games of every connected account, Steam and Epic together.
  ownedForRecommendations() {
    return this.ctx.library
      .visible()
      .filter(g => g.offers?.some(o => ['steam', 'epic'].includes(o.provider) && (o.owned || o.installed)))
      .map(g => {
        const stores = new Set(g.offers.filter(o => o.provider !== 'custom').map(o => o.provider));
        return {
          id: g.id,
          name: g.name,
          altNames: [...new Set(g.offers.flatMap(o => [o.name, o.altName]).filter(Boolean))],
          provider: stores.size > 1 ? 'both' : [...stores][0],
          minutes: Math.max(0, ...g.offers.map(o => Number(o.playtime) || 0)),
          installed: g.offers.some(o => o.installed),
          steamIds: g.offers.filter(o => o.provider === 'steam').map(o => String(o.appId)),
        };
      });
  }
  saveRecCache() {
    for (const map of Object.values(this.recCache)) {
      const keys = Object.keys(map);
      if (keys.length > CACHE_LIMIT)
        keys
          .sort((a, b) => (map[a]?.at || 0) - (map[b]?.at || 0))
          .slice(0, keys.length - CACHE_LIMIT)
          .forEach(k => delete map[k]);
    }
    this.recFile.schedule(() => JSON.stringify(this.recCache));
  }
  // Epic-only games get the tags of the same game on Steam (found by title).
  async mapEpicToSteam(owned, country) {
    const now = Date.now();
    const pending = owned
      .filter(g => !g.steamIds.length)
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 60)
      .filter(g => {
        const hit = this.recCache.epicSteam[canonicalTitle(g.name)];
        return !hit || (hit.id === null && now - hit.at > TAGS_TTL);
      })
      .slice(0, 40);
    await eachLimited(pending, 3, async g => {
      // Epic may answer in Russian; the Steam search is asked in English.
      const title = [g.name, ...g.altNames].find(n => !/[а-яё]/i.test(n)) || g.name;
      try {
        const id = await steamLib.findSteamApp(this.ctx.publicFetch, title, country);
        this.recCache.epicSteam[canonicalTitle(g.name)] = { id, at: now };
      } catch (e) {
        this.ctx.log?.debug('recommend', `epic → steam: ${e.message}`);
      }
    });
    if (pending.length) this.saveRecCache();
    for (const g of owned)
      if (!g.steamIds.length) {
        const id = this.recCache.epicSteam[canonicalTitle(g.name)]?.id;
        if (id) g.tagSource = id;
      }
  }
  async recommendations({ country, force = false } = {}) {
    this.checkCountry(country);
    if (typeof force !== 'boolean') throw Error('Некорректные параметры рекомендаций');
    const owned = this.ownedForRecommendations();
    const key = owned
      .map(g => g.id)
      .sort()
      .join(',');
    const old = this.recResults.get(country);
    if (!force && old && old.key === key && Date.now() - old.at < REC_TTL) return old.value;
    if (this.recRunning.has(country)) return this.recRunning.get(country);
    const run = this.computeRecommendations(owned, country)
      .then(value => {
        this.recResults.set(country, { key, at: Date.now(), value });
        return value;
      })
      .finally(() => this.recRunning.delete(country));
    this.recRunning.set(country, run);
    return run;
  }
  async computeRecommendations(owned, country) {
    const basedOn = {
      steam: owned.filter(g => g.provider !== 'epic').length,
      epic: owned.filter(g => g.provider !== 'steam').length,
      epicMatched: 0,
    };
    if (!owned.length) return { items: [], profile: [], basedOn, checkedAt: Date.now() };
    await this.mapEpicToSteam(owned, country);
    basedOn.epicMatched = owned.filter(g => g.tagSource).length;
    // Tags of the owned games that tell most about the player (by playtime).
    const now = Date.now();
    const byWeight = [...owned].sort(
      (a, b) => recommend.gameWeight(b.minutes, b.installed) - recommend.gameWeight(a.minutes, a.installed)
    );
    const tagIdOf = g => g.steamIds[0] || g.tagSource;
    const want = [...new Set(byWeight.slice(0, 250).map(tagIdOf).filter(Boolean))];
    const missing = want.filter(id => !this.recCache.tags[id] || now - this.recCache.tags[id].at > TAGS_TTL);
    if (missing.length) {
      try {
        const details = await steamLib.storeDetails(this.ctx.publicFetch, missing, country);
        for (const id of missing) this.recCache.tags[id] = { tags: details.get(id)?.tags || [], at: now };
        this.saveRecCache();
      } catch (e) {
        this.ctx.log?.warn('recommend', `tags: ${e.message}`);
      }
    }
    for (const g of owned) g.tags = this.recCache.tags[tagIdOf(g)]?.tags || [];
    const profile = recommend.buildProfile(owned);
    if (!profile.games) return { items: [], profile: [], basedOn, checkedAt: Date.now() };
    // Candidates: popular games with the player's main tags (single tags and the top pair).
    const names = await steamLib.steamTagNames(this.ctx.publicFetch).catch(() => new Map());
    const idOf = new Map([...names].map(([id, name]) => [name, id]));
    // Specific tags make better queries; broad ones only if nothing else is known.
    const ordered = [
      ...profile.top.filter(t => !recommend.BROAD_TAGS.has(t.tag)),
      ...profile.top.filter(t => recommend.BROAD_TAGS.has(t.tag)),
    ];
    const top = ordered
      .map(t => idOf.get(t.tag))
      .filter(Number.isInteger)
      .slice(0, 6);
    const queries = [...top.map(id => [id]), ...(top.length > 1 ? [[top[0], top[1]]] : [])];
    const offers = new Map();
    await eachLimited(queries, 3, async ids => {
      try {
        for (const o of (await searchSteamByTags(this.ctx.publicFetch, ids, country, 30)).offers)
          if (!offers.has(o.appId)) offers.set(o.appId, o);
      } catch (e) {
        this.ctx.log?.debug('recommend', `search: ${e.message}`);
      }
    });
    const index = recommend.ownedIndex(owned);
    const fresh = [...offers.values()].filter(o => !recommend.isOwned(index, o));
    if (!fresh.length) return { items: [], profile: profile.top, basedOn, checkedAt: Date.now() };
    const details = await steamLib.storeDetails(
      this.ctx.publicFetch,
      fresh.map(o => o.appId),
      country
    );
    const candidates = fresh
      .map(o => ({ offer: o, d: details.get(o.appId) }))
      .filter(x => x.d)
      .map(({ offer, d }) => ({ ...d, appId: offer.appId, name: offer.name, offer }));
    const ranked = recommend.rankCandidates(profile, owned, candidates, {
      hidden: new Set(this.ctx.settings.hidden),
    });
    const items = ranked.map(c => {
      const g = {
        id: catalog.find(x => x.steam === c.appId)?.id || `steam:${c.appId}`,
        name: c.name,
        steam: c.appId,
        image: c.offer.image,
        capsule: c.capsule,
        desc: c.description,
        tags: c.tags,
        reviews: c.reviews,
        released: c.releaseDate,
        reason: c.reason,
        match: Math.round(c.match * 100),
        pricesUpdatedAt: Date.now(),
        storeOffers: [{ ...c.offer, description: c.description, tags: c.tags, screenshots: c.screenshots }],
      };
      this.index.set(g.id, g);
      return g;
    });
    this.ctx.log?.info(
      'recommend',
      `${items.length} of ${candidates.length} candidates; profile of ${profile.games} games (steam ${basedOn.steam}, epic ${basedOn.epic}, epic matched ${basedOn.epicMatched})`
    );
    return { items, profile: profile.top, basedOn, checkedAt: Date.now() };
  }

  // ---- prices ------------------------------------------------------------

  async gamePrices({ id, force = false }) {
    if (typeof id !== 'string' || typeof force !== 'boolean') throw Error('Некорректная игра');
    const g = this.find(id);
    if (!g) throw Error('Игра не найдена');
    const country = this.country();
    const partial = (
      g.storeOffers?.length
        ? g.storeOffers
        : [...(g.steam ? [{ provider: 'steam' }] : []), ...(g.epic ? [{ provider: 'epic' }] : [])]
    ).map(o => (o.country === country ? o : { provider: o.provider, country, priceStatus: 'loading' }));
    const offers = await this.prices.get(g, country, force, offer => {
      if (offer.name && /^Steam #/.test(g.name)) {
        g.name = offer.name;
        const local = this.ctx.library.games.find(x => x.id === id);
        if (local) local.name = offer.name;
      }
      const i = partial.findIndex(o => o.provider === offer.provider);
      if (i < 0) partial.push(offer);
      else partial[i] = offer;
      if (this.country() === country) {
        this.index.set(id, { ...g, storeOffers: [...partial], pricesUpdatedAt: Date.now() });
        this.ctx.hub.publish();
      }
    });
    if (this.country() === country) {
      this.index.set(id, { ...g, storeOffers: offers, pricesUpdatedAt: Date.now() });
      this.ctx.hub.publish();
    }
    return { id, country, storeOffers: offers, best: bestOffer(offers) };
  }
  async initialPrices() {
    const country = this.country();
    const list = [...new Set([...catalog.map(g => g.id), ...this.ctx.settings.wishlist])];
    let index = 0;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (index < list.length && this.country() === country) {
          const id = list[index++];
          try {
            await this.gamePrices({ id });
          } catch {}
        }
      })
    );
  }
  async deals({ id }) {
    const g = this.find(id);
    if (!g) throw Error('Игра не найдена');
    return this.ctx.integrations.deals(g, this.country());
  }
  watch({ id, provider }) {
    const g = this.find(id);
    if (!g || !providerNames[provider]) throw Error('Игра не найдена');
    let offer = g.storeOffers?.find(o => o.provider === provider);
    if (!offer && provider === 'steam' && g.steam) offer = { provider, appId: g.steam };
    if (!offer?.appId) throw Error('Сначала найдите точное предложение этого магазина через поиск');
    const country = this.country(),
      key = [provider, offer.namespace || '', offer.appId, country].join(':');
    const s = this.ctx.settings;
    if (!s.priceWatches.some(w => w.key === key)) {
      if (s.priceWatches.length >= 100) throw Error('Можно отслеживать до 100 предложений');
      const w = {
        key,
        id: g.id,
        name: g.name,
        image: g.image,
        provider,
        appId: offer.appId,
        namespace: offer.namespace || '',
        country,
        history: [],
        target: null,
      };
      if (usablePrice(offer) && offer.country === country) {
        w.current = {
          amount: offer.amount,
          currency: offer.currency,
          price: offer.price,
          discount: offer.discount || 0,
          at: Date.now(),
        };
        w.history.push({ ...w.current });
      }
      s.priceWatches.push(w);
      this.save(g);
    }
    const run = () => this.watcher.check().catch(e => this.ctx.log?.warn('prices', e.message));
    // The running check reports its own errors; only wait for it to end.
    if (this.watcher.inFlight) this.watcher.inFlight.catch(() => {}).finally(run);
    else run();
  }
  unwatch(key) {
    const i = this.ctx.settings.priceWatches.findIndex(w => w.key === key);
    if (i >= 0) this.ctx.settings.priceWatches.splice(i, 1);
    this.ctx.storage.saveSettings();
  }
  target({ key, target }) {
    const w = this.ctx.settings.priceWatches.find(w => w.key === key);
    if (!w) throw Error('Отслеживание не найдено');
    if (target !== null && (!Number.isFinite(target) || target < 0 || target > 100000000))
      throw Error('Введите корректную цену');
    if (target !== null && !w.current?.currency) throw Error('Дождитесь подтверждения валюты магазином');
    w.target = target;
    w.targetCurrency = w.current?.currency;
    this.ctx.storage.saveSettings();
  }
  // Saved games are trimmed so settings.json stays small.
  save(g) {
    this.catalogVersion++;
    const { id, name, steam, epic, image, portrait, tags, desc } = g;
    this.ctx.settings.savedGames[id] = {
      id,
      name,
      steam,
      epic,
      image,
      portrait,
      tags,
      desc: String(desc || '').slice(0, 500),
      storeOffers: (g.storeOffers || []).map(({ provider, appId, namespace, items, url, name: n }) => ({
        provider,
        appId,
        namespace,
        items,
        url,
        name: n,
      })),
    };
    this.ctx.storage.saveSettings();
  }
  toggle({ list, id }) {
    if (!['favorites', 'wishlist'].includes(list) || typeof id !== 'string' || id.length > 160)
      throw Error('Некорректные параметры');
    const g = this.index.get(id) || this.ctx.library.games.find(x => x.id === id);
    if (g) this.save(g);
    const s = this.ctx.settings;
    s[list] = s[list].includes(id) ? s[list].filter(x => x !== id) : [...s[list], id];
    this.ctx.storage.saveSettings();
  }
  // account: optional account key ("steam:1", "epic:<id>"). A copy owned by
  // another connected account does not block buying for this one.
  buyUrl({ id, provider, account }) {
    if (!providerNames[provider]) throw Error('Неизвестный магазин');
    const g = this.find(id);
    if (!g) throw Error('Игра не найдена');
    const offer = g.storeOffers?.find(o => o.provider === provider);
    const target =
      offer ||
      g.offers?.find(o => o.provider === provider) ||
      (provider === 'steam' && g.steam ? { provider, appId: g.steam } : null);
    const buyer = this.ctx.accounts.checkoutTarget(provider, account).account;
    const visible = this.ctx.library.visible();
    const scope = buyer
      ? visible.map(x => ({
          ...x,
          offers: x.offers.filter(o => o.provider !== provider || o.accountIds?.includes(buyer.id)),
        }))
      : visible;
    if (ownsOffer(ownedOffers(scope), target))
      throw Error(
        buyer
          ? `Это предложение уже есть на аккаунте ${buyer.name}.`
          : 'Это предложение уже есть в библиотеке подключённого аккаунта.'
      );
    let url = offer?.url;
    if (!url && !g.storeOffers) {
      if (provider === 'steam' && g.steam) url = storeUrl(provider, g);
      else if (provider === 'epic' && g.epic) url = `https://store.epicgames.com/p/${g.epic}`;
    }
    if (!url) throw Error('Для этого предложения нет ссылки покупки. Найдите игру через поиск Nexus.');
    checkStoreUrl(provider, url);
    this.ctx.settings.preferred[id] = provider;
    this.ctx.storage.saveSettings();
    return url;
  }

  // ---- Epic giveaways --------------------------------------------------------

  async freeGames(force = false) {
    if (!force && this.free && Date.now() - this.free.checkedAt < 30 * 60 * 1000) return this.free;
    const country = this.country();
    this.free = await fetchFreeGames(this.ctx.publicFetch, country);
    const fresh = newGiveaways(this.free.current, this.ctx.settings.seenGiveaways);
    if (fresh.length) {
      const first = !this.ctx.settings.seenGiveaways.length;
      this.ctx.settings.seenGiveaways = [...this.ctx.settings.seenGiveaways, ...fresh.map(giveawayKey)].slice(
        -200
      );
      this.ctx.storage.saveSettings();
      // The very first check only remembers the current giveaways.
      if (!first && this.ctx.settings.notifyGiveaways)
        this.notify('Бесплатно в Epic Games', fresh.map(g => g.name).join(', '), () =>
          this.ctx.showPage('store')
        );
    }
    this.ctx.hub.publish();
    return this.free;
  }
  claimUrl({ appId }) {
    const g =
      this.free?.current.find(x => x.appId === appId) || this.free?.upcoming.find(x => x.appId === appId);
    if (!g?.url) throw Error('Ссылка на раздачу недоступна');
    checkStoreUrl('epic', g.url);
    return g.url;
  }

  // ---- wishlists ---------------------------------------------------------

  async importWishlists() {
    const report = { steam: 0, epic: 0, errors: [] };
    const add = g => {
      if (!this.index.has(g.id)) this.index.set(g.id, g);
      this.save(this.index.get(g.id));
      if (!this.ctx.settings.wishlist.includes(g.id)) {
        this.ctx.settings.wishlist.push(g.id);
        return 1;
      }
      return 0;
    };
    for (const account of this.ctx.accounts.connected('steam')) {
      try {
        const s = this.ctx.accounts.session(account.key);
        // A private wishlist needs the session token; a public one works without it.
        const token = await steamLib
          .sessionToken((url, o) => s.fetch(url, o), account.id)
          .catch(e => {
            this.ctx.log.debug('wishlist', e.message);
            return '';
          });
        const appIds = await wishlist.fetchSteamWishlist(this.ctx.publicFetch, account.id, token);
        const names = await steamLib
          .storeItems(this.ctx.publicFetch, appIds, this.country())
          .catch(() => new Map());
        for (const g of wishlist.steamWishlistGames(appIds, names)) {
          const known = catalog.find(c => c.steam === g.steam);
          report.steam += add(known || g);
        }
      } catch (e) {
        report.errors.push(`Steam (${account.name}): ${e.message}`);
      }
    }
    // Each Epic account has its own web session; its wishlist is read there.
    for (const account of this.ctx.accounts.connected('epic')) {
      try {
        const result = await this.ctx.epicStorePage(account.key).run(wishlist.EPIC_WISHLIST_PROBE);
        for (const g of wishlist.parseEpicWishlist(result, imageUrl)) report.epic += add(g);
      } catch (e) {
        report.errors.push(
          `Epic (${account.name}): ${e.message} — войдите в магазин Epic этим аккаунтом через «Купить»`
        );
      }
    }
    this.ctx.storage.saveSettings();
    this.initialPrices().catch(e => this.ctx.log?.warn('prices', e.message));
    return report;
  }

  // Data for the window: base catalog, saved games and recently priced games.
  // Store data for the window, per game id: offers in the current region, and
  // the store name / cover (used when the library only knows "Steam #id").
  snapshotPrices(libraryIds, only = null) {
    const country = this.country();
    const all = new Set([...libraryIds, ...this.catalogIds()]);
    const ids = only ? [...only].filter(id => all.has(id)) : all;
    const out = {};
    for (const id of ids) {
      const g = this.index.get(id);
      if (!g?.storeOffers) continue;
      out[id] = { o: regionGame(g, country).storeOffers, n: g.name, i: g.image || '' };
    }
    return out;
  }
  catalogIds() {
    return new Set([
      ...catalog.map(g => g.id),
      ...this.ctx.settings.wishlist,
      ...this.ctx.settings.favorites,
      ...Object.keys(this.ctx.settings.savedGames),
    ]);
  }
  snapshotCatalog() {
    const wanted = this.catalogIds();
    const out = [];
    for (const id of wanted) {
      const g = this.index.get(id) || this.ctx.settings.savedGames[id] || catalog.find(c => c.id === id);
      if (g) out.push(regionGame(g, this.country()));
    }
    return out;
  }
}

function checkStoreUrl(provider, url) {
  const target = new URL(url);
  const ok =
    target.protocol === 'https:' &&
    (provider === 'steam'
      ? target.hostname === 'store.steampowered.com' && /^\/app\/\d+\//.test(target.pathname)
      : target.hostname === 'store.epicgames.com' &&
        /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/p\/[a-z0-9-]+$/i.test(target.pathname));
  if (!ok) throw Error('Некорректная ссылка предложения');
}

function regionGame(g, country) {
  return {
    ...g,
    storeOffers: g.storeOffers?.map(o =>
      o.country && o.country !== country
        ? {
            ...o,
            amount: null,
            price: null,
            originalPrice: null,
            discount: 0,
            priceStatus: 'loading',
            priceError: '',
          }
        : o
    ),
  };
}

module.exports = { StoreService, regionGame, checkStoreUrl };
