'use strict';
// Friends list like Steam's "Друзья и чат": the friends of every connected
// Steam and Epic account. Steam: list + status through the Web API with the
// session token Nexus already uses (the Steam Community friends page as a
// fallback). Epic: list and names only.

const steamLib = require('../steam-library.cjs');
const f = require('../friends.cjs');
const { convKey } = require('../chat.cjs');

const CACHE_MS = 60000;

class FriendsService {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = null;
    this.pending = null;
  }
  async list({ force = false } = {}) {
    if (force || !this.cache || Date.now() - this.cache.checkedAt >= CACHE_MS) {
      if (!this.pending)
        this.pending = this.load()
          .then(r => (this.cache = r))
          .finally(() => (this.pending = null));
      await this.pending;
    }
    return this.decorate(this.cache);
  }
  // Live parts on top of the cached list: Epic presence from the chat
  // connection, conversation keys and unread messages.
  decorate(data) {
    const chat = this.ctx.chat;
    const unread = chat?.unreadMap() || {};
    const group = provider => g => ({
      ...g,
      friends: f.sortFriends(
        g.friends.map(x => {
          const conv = convKey(provider, g.account.id, x.id);
          const live = provider === 'epic' ? chat?.epicStatus(x.id) : null;
          return { ...x, ...(live || {}), conv, unread: unread[conv] || 0 };
        })
      ),
    });
    return {
      ...data,
      steam: data.steam.map(group('steam')),
      epic: data.epic.map(group('epic')),
      epicLive: [...(chat?.epic?.values() || [])].some(x => x.state === 'online'),
      ...this.me(),
    };
  }
  // My accounts with "В игре: …" (for the top of the friends window) and unread counts.
  me() {
    const running = Object.values(this.ctx.running?.snapshot() || {});
    const playing = p =>
      running.find(r => r.provider === p) ||
      (p === 'steam' ? running.find(r => r.provider === 'custom') : null);
    return {
      me: ['steam', 'epic'].flatMap(p =>
        this.ctx.accounts.connected(p).map(a => ({
          provider: p,
          name: a.name || '',
          avatar: a.avatar || '',
          playing: playing(p)?.name || '',
        }))
      ),
      unread: this.ctx.chat?.unreadMap() || {},
      chatState: this.ctx.chat?.chatState() || {},
    };
  }
  async load() {
    const out = { steam: [], epic: [], errors: [], checkedAt: Date.now() };
    for (const account of this.ctx.accounts.connected('steam')) {
      try {
        out.steam.push({
          account: { key: account.key, id: account.id, name: account.name },
          friends: f.sortFriends(await this.steamFriends(account)),
        });
      } catch (e) {
        out.errors.push(`Steam (${account.name}): ${e.message}`);
      }
    }
    for (const account of this.ctx.accounts.connected('epic')) {
      try {
        out.epic.push({
          account: { key: account.key, id: account.id, name: account.name },
          friends: f.sortFriends(await this.epicFriends(account)),
        });
      } catch (e) {
        out.errors.push(`Epic Games (${account.name}): ${e.message}`);
      }
    }
    return out;
  }
  async steamFriends(account) {
    const s = this.ctx.accounts.session(account.key);
    const sessionFetch = (url, o) => s.fetch(url, o);
    try {
      const token = await steamLib.sessionToken(sessionFetch, account.id);
      const api = async (method, params) => {
        const u = new URL(`https://api.steampowered.com/${method}`);
        u.search = new URLSearchParams({ access_token: token, ...params });
        const r = await this.ctx.publicFetch(u.href, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw Error(`Steam: HTTP ${r.status}`);
        return r.json();
      };
      const ids = f.parseSteamFriendIds(await api('IFriendsListService/GetFriendsList/v1/', {}));
      const friends = [];
      for (let i = 0; i < ids.length; i += 100)
        friends.push(
          ...f.parseSteamSummaries(
            await api('ISteamUser/GetPlayerSummaries/v2/', { steamids: ids.slice(i, i + 100).join(',') })
          )
        );
      return friends;
    } catch (e) {
      this.ctx.log.debug?.('friends', `steam api: ${e.message}`);
      // The friends page of Steam Community, signed in as the user.
      const r = await s.fetch(`https://steamcommunity.com/profiles/${account.id}/friends/`, {
        credentials: 'include',
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw Error(`страница друзей: HTTP ${r.status}`);
      return f.parseSteamFriendsPage(await r.text());
    }
  }
  async epicFriends(account) {
    const token = await this.ctx.accounts.tokens.accessToken(account.id);
    const headers = { Authorization: `bearer ${token}` };
    const r = await this.ctx.publicFetch(
      `https://friends-public-service-prod.ol.epicgames.com/friends/api/v1/${account.id}/summary`,
      { headers, signal: AbortSignal.timeout(15000) }
    );
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const ids = f.parseEpicFriendIds(await r.json());
    const names = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const u = new URL('https://account-public-service-prod03.ol.epicgames.com/account/api/public/account');
      ids.slice(i, i + 100).forEach(id => u.searchParams.append('accountId', id));
      const a = await this.ctx.publicFetch(u.href, { headers, signal: AbortSignal.timeout(15000) });
      if (a.ok) for (const [id, name] of f.parseEpicAccounts(await a.json())) names.set(id, name);
    }
    return ids.map(id => ({
      id,
      name: names.get(id) || 'Игрок Epic',
      avatar: '',
      status: 'unknown',
      game: '',
    }));
  }
}

module.exports = { FriendsService };
