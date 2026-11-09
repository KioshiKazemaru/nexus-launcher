'use strict';
// "Профиль" page (see ../profile.cjs).

const steamLib = require('../steam-library.cjs');
const pr = require('../profile.cjs');

const CACHE_MS = 15 * 60 * 1000;

class ProfileService {
  constructor(ctx) {
    this.ctx = ctx;
    this.badges = new Map(); // steam account id → { at, value }
  }
  async steamBadges(account) {
    const hit = this.badges.get(account.id);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const s = this.ctx.accounts.session(account.key);
    const token = await steamLib.sessionToken((u, o) => s.fetch(u, o), account.id);
    const u = new URL('https://api.steampowered.com/IPlayerService/GetBadges/v1/');
    u.search = new URLSearchParams({ access_token: token, steamid: account.id });
    const r = await this.ctx.publicFetch(u.href, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw Error(`Steam: HTTP ${r.status}`);
    const value = pr.parseBadges(await r.json());
    this.badges.set(account.id, { at: Date.now(), value });
    return value;
  }
  async info() {
    const games = this.ctx.library.games || [];
    const accounts = [];
    for (const provider of ['steam', 'epic'])
      for (const a of this.ctx.accounts.connected(provider)) {
        const x = {
          provider,
          name: a.name || '',
          avatar: a.avatar || '',
          id: provider === 'steam' ? a.id : '',
        };
        if (provider === 'steam')
          try {
            Object.assign(x, (await this.steamBadges(a)) || {});
          } catch (e) {
            this.ctx.log.debug?.('profile', e.message);
          }
        accounts.push(x);
      }
    const nameOf = appId =>
      games.find(g => g.offers.some(o => o.provider === 'steam' && String(o.appId) === String(appId)))
        ?.name || '';
    return {
      accounts,
      stats: pr.libraryStats(games),
      achievements: pr.latestAchievements([...(this.ctx.library.achievementCache || new Map())], nameOf),
      status: this.ctx.presence?.status() || 'online',
    };
  }
}

module.exports = { ProfileService };
