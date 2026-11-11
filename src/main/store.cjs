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
const { saleNotices } = require('./notices.cjs');
const wishlist = require('../wishlist.cjs');
const steamLib = require('../steam-library.cjs');
const dealsApi = require('../deals.cjs');
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
const icon = path.join(
  __dirname,
  '../../ui/assets/' + (process.platform === 'win32' ? 'nexus.ico' : 'nexus.png')
);

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
    // country → { key, at, value }; the last results are kept between runs, so the
    // store shows them at once after start while the library is still syncing.
    this.recResults = new Map(
      Object.entries(saved.results || {}).filter(([, r]) => r && typeof r.key === 'string' && r.value)
    );
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
    // DLC the Steam accounts already have are not offered: the library lists games only,
    // the account's licences list the DLC too.
    const licences = await this.ctx.library.steamLicences?.().catch(() => new Set());
    const bought = id => !!licences?.has(String(id));
    const ids = [];
    for (const g of selected) {
      try {
        const data = await details(String(g.steam));
        if (data?.success)
          ids.push(...(data.data?.dlc || []).filter(x => /^\d+$/.test(String(x)) && !bought(x)).slice(0, 3));
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
    this.recFile.schedule(() =>
      JSON.stringify({ ...this.recCache, results: Object.fromEntries(this.recResults) })
    );
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
    const start = () => {
      if (this.recRunning.has(country)) return this.recRunning.get(country);
      const run = this.computeRecommendations(owned, country)
        .then(value => {
          this.recResults.set(country, { key, at: Date.now(), value });
          this.saveRecCache();
          return value;
        })
        .finally(() => this.recRunning.delete(country));
      this.recRunning.set(country, run);
      return run;
    };
    if (!force && old && Date.now() - old.at < REC_TTL) {
      // The library changed (a sync step, a purchase): the last selection is shown
      // now and a fresh one is prepared for the next request.
      if (old.key === key) return old.value;
      start().catch(e => this.ctx.log?.warn('recommend', e.message));
      return { ...old.value, refreshing: true };
    }
    return start();
  }
  async computeRecommendations(owned, country) {
    const basedOn = {
      steam: owned.filter(g => g.provider !== 'epic').length,
      epic: owned.filter(g => g.provider !== 'steam').length,
      epicMatched: 0,
    };
    if (!owned.length) return { items: [], profile: [], basedOn, checkedAt: Date.now() };
    // Steam's tag names are needed later; they load while the owned games are matched.
    const namesJob = steamLib.steamTagNames(this.ctx.publicFetch).catch(() => new Map());
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
    const names = await namesJob;
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
    const failures = [];
    await eachLimited(queries, 3, async ids => {
      try {
        for (const o of (await searchSteamByTags(this.ctx.publicFetch, ids, country, 30)).offers)
          if (!offers.has(o.appId)) offers.set(o.appId, o);
      } catch (e) {
        failures.push(e.message);
        this.ctx.log?.debug('recommend', `search: ${e.message}`);
      }
    });
    // Every search failed (Steam limits frequent requests with HTTP 429): that is not
    // "nothing to suggest". An error keeps the last selection and is not cached.
    if (queries.length && failures.length === queries.length)
      throw Error(
        failures.some(m => /HTTP 429/.test(m))
          ? 'Steam временно ограничил запросы. Подборка обновится через несколько минут — нажмите ↻.'
          : 'Поиск Steam сейчас недоступен. Попробуйте позже — нажмите ↻.'
      );
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
  // The full store page of a game (about, requirements, languages…), kept 30 minutes:
  // Steam's when the game is on Steam, Epic Games Store's otherwise.
  // All DLC of a Steam game, with what the Steam accounts already have (their licences):
  // the «Дополнения» of the library page, «Свойства» and the store page.
  async gameDlc({ appId }) {
    appId = String(appId || '');
    if (!/^\d{1,10}$/.test(appId)) throw Error('Дополнения есть только у игр Steam');
    const country = this.country() || 'US';
    this.gameDlcCache ||= new LruMap(100);
    const key = appId + ':' + country,
      old = this.gameDlcCache.get(key);
    const licences = await this.ctx.library.steamLicences?.().catch(() => null);
    const mark = v => ({
      ...v,
      items: v.items.map(x => ({ ...x, owned: !!licences?.has(x.appId) })),
      known: !!licences?.size,
    });
    if (old && Date.now() - old.at < 1800000) return mark(old.value);
    const u = new URL('https://store.steampowered.com/api/appdetails');
    u.search = new URLSearchParams({ appids: appId, cc: country, l: 'russian', filters: 'basic' });
    const data = (await responseJSON(this.ctx.publicFetch, u.href))?.[appId];
    const ids = (data?.success ? data.data?.dlc || [] : []).map(String).filter(x => /^\d{1,10}$/.test(x));
    const items = ids.length
      ? await steamLib.dlcItems((url, o) => this.ctx.publicFetch(url, o), ids.slice(0, 300), country)
      : [];
    items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const value = { appId, total: ids.length, items };
    this.gameDlcCache.set(key, { at: Date.now(), value });
    return mark(value);
  }
  async storePage({ id }) {
    const g = typeof id === 'string' ? this.find(id) : null;
    if (!g) throw Error('Игра не найдена');
    const page = require('../store-page.cjs');
    const appId = String(g.steam || g.storeOffers?.find(o => o.provider === 'steam')?.appId || '');
    const epic = g.storeOffers?.find(
      o =>
        o.provider === 'epic' &&
        /^[\w-]{1,64}$/.test(o.appId || '') &&
        /^[\w-]{1,64}$/.test(o.namespace || '')
    );
    if (!/^\d{1,10}$/.test(appId) && !epic) return null;
    const country = this.country(),
      key = (/^\d{1,10}$/.test(appId) ? appId : 'epic:' + epic.appId) + ':' + country;
    this.pageCache ||= new Map();
    const old = this.pageCache.get(key);
    if (old && Date.now() - old.at < 1800000) return old.value;
    let value;
    if (/^\d{1,10}$/.test(appId)) {
      const u = new URL('https://store.steampowered.com/api/appdetails');
      u.search = new URLSearchParams({ appids: appId, cc: country, l: 'russian' });
      value = page.parseAppDetails((await responseJSON(this.ctx.publicFetch, u.href))?.[appId], appId);
    } else {
      const u = new URL('https://store.epicgames.com/graphql');
      u.search = new URLSearchParams({
        query:
          'query NexusOffer($namespace:String!,$id:String!){Catalog{catalogOffer(namespace:$namespace,id:$id,locale:"ru"){title description longDescription developerDisplayName publisherDisplayName releaseDate seller{name} keyImages{type url} tags{id name groupName}}}}',
        variables: JSON.stringify({ namespace: epic.namespace, id: epic.appId }),
      });
      const offer = (await responseJSON(this.ctx.epicFetch || this.ctx.publicFetch, u.href))?.data?.Catalog
        ?.catalogOffer;
      // Requirements and languages are on the older product page; new products have none.
      const slug = String(epic.url || '').match(
        /^https:\/\/store\.epicgames\.com\/p\/([a-z0-9][a-z0-9-]{0,180})$/i
      )?.[1];
      let content = null;
      if (slug)
        content = await responseJSON(
          this.ctx.publicFetch,
          `https://store-content-ipv4.ak.epicgames.com/api/ru/content/products/${slug}`
        ).catch(() => null);
      value = page.parseEpicOffer(offer, content, epic.url || '');
    }
    if (this.pageCache.size > 50) this.pageCache.delete(this.pageCache.keys().next().value);
    this.pageCache.set(key, { at: Date.now(), value });
    return value;
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
    const adding = !s[list].includes(id);
    if (list === 'wishlist') this.toggleWish(id, adding);
    s[list] = adding ? [...s[list], id] : s[list].filter(x => x !== id);
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
      if (!first)
        this.ctx.notices?.add(
          fresh.map(g => ({
            kind: 'giveaway',
            key: 'giveaway:' + giveawayKey(g),
            title: `Бесплатно в Epic Games: ${g.name}`,
            body: 'Заберите игру в магазине Epic Games, пока раздача идёт',
            image: typeof g.image === 'string' ? g.image : '',
          })),
          { system: !!this.ctx.settings.notifyGiveaways }
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
  //
  // "Желаемое" = the wishlists of the connected Steam and Epic accounts + the games
  // added in Nexus. settings.wishlistFrom remembers where each entry came from
  // ('nexus', 'steam:<SteamID>', 'epic:<account id>'):
  //   - a game removed from a store wishlist leaves Nexus too, unless it also came
  //     from elsewhere (another account, or added in Nexus);
  //   - a game the user removes in Nexus is not brought back by the next sync while
  //     it stays in the store wishlist (settings.wishlistDismissed);
  //   - an account that could not be read keeps its games.

  wishOrigins(id) {
    const s = this.ctx.settings;
    return s.wishlistFrom[id] || (s.wishlist.includes(id) ? ['nexus'] : []);
  }
  // In Nexus: the heart of a card. Removing a game that is on a store wishlist hides
  // it from Nexus (the store wishlist itself is not changed).
  toggleWish(id, add) {
    const s = this.ctx.settings;
    if (add) {
      // Back in Nexus: the store lists it was hidden from count again.
      const stores = [...this.wishOrigins(id), ...(s.wishlistDismissed[id] || [])];
      s.wishlistFrom[id] = [...new Set(['nexus', ...stores.filter(o => o !== 'legacy')])];
      delete s.wishlistDismissed[id];
      return;
    }
    const stores = this.wishOrigins(id).filter(o => o !== 'nexus' && o !== 'legacy');
    if (stores.length) s.wishlistDismissed[id] = stores;
    delete s.wishlistFrom[id];
  }
  // The wishlist entry of a store game: the game itself, or an entry of the same
  // title from the other store (one card with both prices instead of two).
  wishTarget(g) {
    const s = this.ctx.settings;
    if (!this.index.has(g.id)) this.index.set(g.id, g);
    if (s.wishlist.includes(g.id) || s.wishlistDismissed[g.id]) {
      // A cover found later (Steam's hashed image path) replaces the one that is missing.
      const old = this.index.get(g.id);
      if (g.image && old && old.image !== g.image && s.wishlist.includes(g.id)) {
        const fixed = { ...old, image: g.image, portrait: old.portrait || g.portrait };
        this.index.set(g.id, fixed);
        this.save(fixed);
      }
      return g.id;
    }
    const key = normalize(g.name);
    const same = s.wishlist
      .map(id => this.index.get(id) || s.savedGames[id])
      .find(x => x && x.id !== g.id && normalize(x.name) === key);
    if (!same) {
      this.save(this.index.get(g.id));
      return g.id;
    }
    // A Steam wishlist entry knows only its app id: its Steam offer is spelled out, or
    // the card would show only the Epic price.
    const offersOf = x =>
      x.storeOffers?.length
        ? x.storeOffers
        : x.steam
          ? [{ provider: 'steam', appId: x.steam, url: `https://store.steampowered.com/app/${x.steam}/` }]
          : [];
    const offers = [...offersOf(same)];
    const incoming = offersOf(g);
    for (const o of incoming) if (!offers.some(x => x.provider === o.provider)) offers.push(o);
    const merged = { ...same, steam: same.steam || g.steam, storeOffers: offers };
    this.index.set(same.id, merged);
    this.save(merged);
    return same.id;
  }
  // One store wishlist read successfully: its games are exactly `ids`.
  applyWishlist(origin, ids) {
    const s = this.ctx.settings;
    // Entries from before origins were kept: 'legacy' until a store list claims them.
    for (const id of s.wishlist) s.wishlistFrom[id] ||= ['legacy'];
    const now = new Set(ids);
    let added = 0,
      removed = 0;
    for (const [id, list] of Object.entries(s.wishlistFrom)) {
      if (!list.includes(origin) || now.has(id)) continue;
      const rest = list.filter(o => o !== origin);
      if (rest.length) s.wishlistFrom[id] = rest;
      else {
        delete s.wishlistFrom[id];
        s.wishlist = s.wishlist.filter(x => x !== id);
        removed++;
      }
    }
    for (const [id, list] of Object.entries(s.wishlistDismissed)) {
      if (!list.includes(origin) || now.has(id)) continue;
      const rest = list.filter(o => o !== origin);
      if (rest.length) s.wishlistDismissed[id] = rest;
      else delete s.wishlistDismissed[id];
    }
    for (const id of ids) {
      if (s.wishlistDismissed[id]) {
        if (!s.wishlistDismissed[id].includes(origin)) s.wishlistDismissed[id].push(origin);
        continue;
      }
      const list = (s.wishlistFrom[id] || []).filter(o => o !== 'legacy');
      if (!list.includes(origin)) list.push(origin);
      s.wishlistFrom[id] = list;
      if (!s.wishlist.includes(id)) {
        s.wishlist.push(id);
        added++;
      }
    }
    if (added || removed) this.catalogVersion++;
    return { added, removed };
  }
  // signedIn: false for a Steam account whose Nexus sign-in expired; its wishlist is
  // read as a public one by its SteamID.
  async steamWishlist(account, signedIn = true) {
    const s = signedIn ? this.ctx.accounts.session(account.key) : null;
    // A private wishlist needs the session token; a public one works without it.
    const token = signedIn
      ? await steamLib
          .cachedSessionToken((url, o) => s.fetch(url, o), account.id)
          .catch(e => {
            this.ctx.log.debug('wishlist', e.message);
            return '';
          })
      : '';
    const appIds = await wishlist.fetchSteamWishlist(this.ctx.publicFetch, account.id, token);
    // Without the token a private wishlist looks empty: that is not "everything was
    // removed", the games stay.
    if (!token && !appIds.length)
      throw Error(
        signedIn
          ? 'Steam не отдал список желаемого'
          : 'нет входа в Steam, а список желаемого закрыт настройками приватности. Войдите в Steam в «Аккаунтах»'
      );
    const names = await steamLib
      .storeItems(this.ctx.publicFetch, appIds, this.country())
      .catch(() => new Map());
    return wishlist.steamWishlistGames(appIds, names).map(g => catalog.find(c => c.steam === g.steam) || g);
  }
  async epicWishlist(account) {
    const result = await this.ctx.epicStorePage(account.key).run(wishlist.EPIC_WISHLIST_PROBE);
    // The account is signed in to Nexus, not to the store site. The store asks for a
    // security check a person passes: the window shows «Войти в магазин Epic».
    if (wishlist.epicNotSignedIn(result)) {
      const e = Error('нужно войти в магазин Epic: нажмите «Войти в магазин Epic»');
      e.storeSignIn = true;
      throw e;
    }
    return wishlist.parseEpicWishlist(result, imageUrl);
  }
  // The Epic store site signed in with a one-time code of the connected account, as
  // Epic Games Launcher opens its store: no password, only Epic's own security check.
  async epicStoreSignInUrl(account) {
    const { gameLoginCode } = require('../epic-games-api.cjs');
    const token = await this.ctx.accounts.tokens.accessToken(account.id);
    const code = await gameLoginCode(this.ctx.publicFetch, token);
    const u = new URL('https://www.epicgames.com/id/exchange');
    u.search = new URLSearchParams({
      exchangeCode: code,
      redirectUrl: 'https://store.epicgames.com/ru/wishlist',
    });
    return u.href;
  }
  // Reads the wishlists of all connected accounts. report: games added and removed
  // per store, and the accounts that could not be read.
  async syncWishlists() {
    if (this.wishRunning) return this.wishRunning;
    this.wishStatus = { ...this.wishStatus, running: true };
    this.ctx.hub.publish();
    this.wishRunning = (async () => {
      const report = { steam: 0, epic: 0, removed: 0, errors: [], storeSignIn: [] };
      const readOk = new Set();
      const steam = this.ctx.accounts.connected('steam');
      // Steam accounts known from an earlier sign-in that is not active now.
      const known = Object.entries(this.ctx.settings.knownAccounts || {})
        .filter(([key, a]) => key.startsWith('steam:') && /^7656119\d{10}$/.test(a?.id || ''))
        .filter(([, a]) => !steam.some(c => c.id === a.id))
        .map(([key, a]) => ({ key, id: a.id, name: a.name || '' }));
      const accounts = [
        ...steam.map(a => ['steam', a, () => this.steamWishlist(a)]),
        ...known.map(a => ['steam', a, () => this.steamWishlist(a, false)]),
        ...this.ctx.accounts.connected('epic').map(a => ['epic', a, () => this.epicWishlist(a)]),
      ];
      for (const [provider, account, read] of accounts) {
        try {
          const games = await read();
          const ids = games.map(g => this.wishTarget(g));
          const r = this.applyWishlist(`${provider}:${account.id}`, ids);
          readOk.add(`${provider}:${account.id}`);
          report[provider] += r.added;
          report.removed += r.removed;
        } catch (e) {
          report.errors.push(`${providerNames[provider]} (${account.name}): ${e.message}`);
          if (e.storeSignIn) report.storeSignIn.push({ key: account.key, name: account.name });
        }
      }
      // Every account read: what no store claimed was added in Nexus.
      if (!report.errors.length)
        for (const [id, list] of Object.entries(this.ctx.settings.wishlistFrom))
          if (list.includes('legacy'))
            this.ctx.settings.wishlistFrom[id] = [...new Set(list.map(o => (o === 'legacy' ? 'nexus' : o)))];
      this.ctx.storage.saveSettings();
      this.wishRead = readOk;
      this.wishStatus = {
        running: false,
        at: Date.now(),
        errors: report.errors,
        storeSignIn: report.storeSignIn,
        accounts: accounts.length,
      };
      this.ctx.hub.publish();
      this.initialPrices()
        .then(() => this.checkWishSales())
        .catch(e => this.ctx.log?.warn('prices', e.message));
      return report;
    })().finally(() => {
      this.wishRunning = null;
    });
    return this.wishRunning;
  }
  // The old button «Импортировать желаемое» does the same.
  // Wishlist games that went on sale: to the bell (and a system notification).
  checkWishSales() {
    const s = this.ctx.settings;
    const games = s.wishlist.map(id => this.find(id)).filter(Boolean);
    const date = t => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    return (
      this.ctx.notices?.add(saleNotices(games, this.country(), providerNames, date), {
        system: s.notifyWishSales !== false,
      }) || []
    );
  }
  importWishlists() {
    return this.syncWishlists();
  }
  // After a sign-in or a library refresh: one sync for several accounts, at most
  // every 10 minutes (the button and the 3-hour timer sync at once).
  // origin: the account that just signed in ('steam:<SteamID>'); an account whose list
  // the last sync did not read is synced at once, whatever the 10 minutes.
  wishlistSoon(origin = '') {
    const unread = origin && !this.wishRead?.has(origin);
    if (this.wishTimer || (!unread && Date.now() - (this.wishStatus?.at || 0) < 600000)) return;
    this.wishTimer = setTimeout(async () => {
      this.wishTimer = null;
      // A sync already running did not include the account that just signed in.
      await this.wishRunning?.catch(() => {});
      if (unread && this.wishRead?.has(origin)) return;
      this.syncWishlists().catch(e => this.ctx.log?.warn('wishlist', e.message));
    }, 5000);
    this.wishTimer.unref?.();
  }

  // ---- discounts ------------------------------------------------------------

  // A page of the games on sale. provider 'all' interleaves Steam and Epic; each store
  // has its own position (cursor) in its list, null when it has no more.
  async deals({ provider = 'all', sort = 'popular', steamStart = 0, epicStart = 0 } = {}) {
    if (!['all', 'steam', 'epic'].includes(provider)) throw Error('Неизвестный магазин');
    const country = this.country();
    const key = JSON.stringify([provider, sort, steamStart, epicStart, country]);
    this.dealsCache ||= new LruMap(40);
    const old = this.dealsCache.get(key);
    if (old && Date.now() - old.checkedAt < 600000) return old;
    const want = (p, start) => (provider === 'all' || provider === p) && start !== null;
    const [steam, epic] = await Promise.allSettled([
      want('steam', steamStart) ? dealsApi.steamDeals(this.ctx.publicFetch, country, steamStart, sort) : null,
      want('epic', epicStart) ? dealsApi.epicDeals(this.epicFetch, country, epicStart, sort) : null,
    ]);
    const errors = [];
    const empty = { offers: [], total: 0, next: null };
    const part = (r, name) => {
      if (r.status === 'fulfilled') return r.value || empty;
      errors.push(`${name}: ${/HTTP \d+/.exec(r.reason?.message)?.[0] || r.reason?.message || 'нет ответа'}`);
      return empty;
    };
    const s = part(steam, 'Steam'),
      e = part(epic, 'Epic Games');
    const ordered = [];
    for (let i = 0; i < Math.max(s.offers.length, e.offers.length); i++) {
      if (s.offers[i]) ordered.push(s.offers[i]);
      if (e.offers[i]) ordered.push(e.offers[i]);
    }
    // Each offer is its own card: the same game may be on sale in one store only.
    const items = ordered.map(o => {
      const id = o.provider === 'steam' ? `steam:${o.appId}` : `epic:${o.appId}`;
      const previous = this.index.get(id);
      const g = {
        ...previous,
        id,
        name: o.name,
        ...(o.provider === 'steam' ? { steam: o.appId } : {}),
        image: o.image || previous?.image || '',
        tags: previous?.tags?.length ? previous.tags : o.tags || [],
        desc: previous?.desc || o.desc || '',
        storeOffers: [
          o,
          ...(previous?.storeOffers || []).filter(x => x.provider !== o.provider && x.country === country),
        ],
        pricesUpdatedAt: Date.now(),
      };
      this.index.set(id, g);
      return g;
    });
    const answer = {
      items,
      country,
      totals: { steam: s.total, epic: e.total },
      next: { steamStart: s.next, epicStart: e.next },
      errors,
      checkedAt: Date.now(),
    };
    if (!errors.length) this.dealsCache.set(key, answer);
    return answer;
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
