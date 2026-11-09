'use strict';
// News and patch notes (see ../news.cjs): per game and for the library's
// "Что нового" (games played recently and installed games).

const n = require('../news.cjs');

const CACHE_MS = 60 * 60 * 1000;

class NewsService {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = new Map(); // app id → { at, list }
  }
  // Steam app id of a library game (Epic-only games have none).
  appId(gameId) {
    const g = (this.ctx.library.games || []).find(x => x.id === gameId);
    const id = g?.offers?.find(o => o.provider === 'steam')?.appId || g?.steam;
    return /^\d+$/.test(String(id || '')) ? String(id) : '';
  }
  async forApp(appId, count = 10) {
    const hit = this.cache.get(appId);
    if (hit && Date.now() - hit.at < CACHE_MS && hit.list.length >= Math.min(count, hit.count))
      return hit.list;
    const r = await this.ctx.publicFetch(n.newsUrl(appId, count), { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw Error(`Steam: HTTP ${r.status}`);
    const list = n.parseNews(await r.json(), appId);
    this.cache.set(appId, { at: Date.now(), list, count });
    return list;
  }
  async game(gameId) {
    const appId = this.appId(gameId);
    if (!appId)
      return { available: false, reason: 'Новости есть только у игр, которые продаются в Steam.', items: [] };
    return { available: true, items: await this.forApp(appId, 10) };
  }
  // "Что нового": a few posts of each recently played or installed game.
  async feed() {
    const games = this.ctx.library.games || [];
    const recent = (this.ctx.settings.recent || []).map(r => r.id);
    const order = [
      ...recent,
      ...games
        .filter(g => g.offers?.some(o => o.installed))
        .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
        .map(g => g.id),
    ];
    const ids = [...new Set(order.map(id => this.appId(id)).filter(Boolean))].slice(0, 12);
    const lists = await Promise.all(ids.map(id => this.forApp(id, 4).catch(() => [])));
    const name = appId => games.find(g => this.appId(g.id) === String(appId))?.name || '';
    const gameId = appId => games.find(g => this.appId(g.id) === String(appId))?.id || '';
    return n
      .mergeFeeds(lists, 30)
      .filter(x => Date.now() - x.date < 60 * 24 * 3600 * 1000)
      .map(x => ({ ...x, game: name(x.appId), gameId: gameId(x.appId) }));
  }
}

module.exports = { NewsService };
