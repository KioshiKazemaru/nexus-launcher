'use strict';
// "Профиль" page (see ../profile.cjs).

const steamLib = require('../steam-library.cjs');
const pr = require('../profile.cjs');

const CACHE_MS = 15 * 60 * 1000;

class ProfileService {
  constructor(ctx) {
    this.ctx = ctx;
    this.badges = new Map(); // steam account id → { at, value }
    this.epic = new Map(); // epic account id → { at, name, avatar, country }
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
  // An Epic account for the "Epic Games" tab: name, avatar, country, friends and its games.
  async epicProfile(a, games, force) {
    const out = {
      id: a.id,
      name: a.name || '',
      avatar: a.avatar || '',
      country: '',
      friends: this.ctx.friends?.cache?.epic.find(g => g.account.id === a.id)?.friends.length ?? null,
      ...pr.epicStats(games),
    };
    // Epic gives other programs no avatars (the avatar service answers 403): a letter, as in Epic.
    let hit = this.epic.get(a.id);
    if (force || !hit || Date.now() - hit.at > CACHE_MS) {
      hit = { at: Date.now(), country: '', name: '' };
      try {
        const token = await this.ctx.accounts.tokens.accessToken(a.id);
        const r = await this.ctx.publicFetch(
          'https://account-public-service-prod03.ol.epicgames.com/account/api/public/account/' +
            encodeURIComponent(a.id),
          { headers: { Authorization: 'bearer ' + token }, signal: AbortSignal.timeout(15000) }
        );
        if (!r.ok) throw Error('HTTP ' + r.status);
        const account = await r.json();
        // Only the display name and the country: the account also holds e-mail and real name.
        hit.name = String(account?.displayName || '').slice(0, 100);
        hit.country = /^[A-Z]{2}$/.test(account?.country || '') ? account.country : '';
      } catch (e) {
        this.ctx.log.debug?.('profile', 'epic account: ' + e.message);
      }
      this.epic.set(a.id, hit);
    }
    return {
      ...out,
      name: hit.name || out.name,
      country: hit.country,
    };
  }
  async info({ force = false } = {}) {
    const mine = this.ctx.accounts.connected('steam')[0];
    // ↻ on the page: fresh level, badges and Steam page.
    if (mine && force) {
      this.badges.delete(mine.id);
      this.ctx.friends?.profiles?.delete(mine.id);
    }
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
    // The Steam page of my first Steam account: background, frame, «О себе», recent games.
    let steamProfile = null;
    if (mine && this.ctx.friends)
      try {
        steamProfile = await this.ctx.friends.profile(mine.id);
      } catch (e) {
        this.ctx.log.debug?.('profile', 'steam page: ' + e.message);
      }
    const epic = [];
    for (const a of this.ctx.accounts.connected('epic')) epic.push(await this.epicProfile(a, games, force));
    return {
      steamProfile,
      epic,
      accounts,
      stats: pr.libraryStats(games),
      achievements: pr.latestAchievements([...(this.ctx.library.achievementCache || new Map())], nameOf),
      status: this.ctx.presence?.status() || 'online',
    };
  }
}

module.exports = { ProfileService };
