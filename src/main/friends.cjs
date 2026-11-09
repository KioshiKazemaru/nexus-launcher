'use strict';
// Friends list like Steam's "Друзья и чат": the friends of every connected
// Steam and Epic account. Steam: list + status through the Web API with the
// session token Nexus already uses (the Steam Community friends page as a
// fallback). Epic: list and names only.

const steamLib = require('../steam-library.cjs');
const f = require('../friends.cjs');
const { convKey } = require('../chat.cjs');

const CACHE_MS = 60000;
const PROFILE_MS = 5 * 60 * 1000;

class FriendsService {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = null;
    this.pending = null;
    this.profiles = new Map(); // steam id → { at, value }
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
          const live = provider === 'epic' ? chat?.epicStatus(x.id) : this.ctx.presence?.steamStatus(x.id);
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
      myStatus: this.ctx.presence?.status() || 'online',
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
  // Steam Web API with the account's session token (IPlayerService etc. take it).
  async steamApi(account) {
    const s = this.ctx.accounts.session(account.key);
    const token = await steamLib.sessionToken((url, o) => s.fetch(url, o), account.id);
    return async (method, params) => {
      const u = new URL(`https://api.steampowered.com/${method}`);
      u.search = new URLSearchParams({ access_token: token, ...params });
      const r = await this.ctx.publicFetch(u.href, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        const why = text
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        throw Error(`Steam ${method.split('/')[1]}: HTTP ${r.status}${why ? ' — ' + why : ''}`);
      }
      return r.json();
    };
  }
  // A Steam profile page inside Nexus: who, status, level, games, games in common.
  async profile(id) {
    id = String(id || '');
    if (!/^7656119\d{10}$/.test(id)) throw Error('Профиль недоступен');
    const hit = this.profiles.get(id);
    if (hit && Date.now() - hit.at < PROFILE_MS) return this.decorateProfile(hit.value);
    const accounts = this.ctx.accounts.connected('steam');
    if (!accounts.length) throw Error('Подключите Steam в «Аккаунтах»');
    // The account this person is a friend of (their friends-only details are visible to it).
    await this.list().catch(() => {});
    const isFriend = a =>
      !!this.cache?.steam.some(g => g.account.id === a.id && g.friends.some(x => x.id === id));
    const account = accounts.find(isFriend) || accounts[0];
    const api = await this.steamApi(account);
    const soft = (promise, what) =>
      promise.catch(e => {
        this.ctx.log.debug?.('friends', `profile ${what}: ${e.message}`);
        return null;
      });
    // The profile page's own data (real name, "О себе"), signed in: friends-only parts are visible.
    const session = this.ctx.accounts.session(account.key);
    const xml = async () => {
      const r = await session.fetch(`https://steamcommunity.com/profiles/${id}/?xml=1`, {
        credentials: 'include',
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw Error(`HTTP ${r.status}`);
      return f.parseSteamProfileXml(await r.text());
    };
    const [details, badges, owned, recent, items, page] = await Promise.all([
      api('IPlayerService/GetPlayerLinkDetails/v1/', { 'steamids[0]': id }),
      soft(api('IPlayerService/GetBadges/v1/', { steamid: id }), 'badges'),
      soft(
        api('IPlayerService/GetOwnedGames/v1/', {
          steamid: id,
          include_appinfo: 'true',
          include_played_free_games: 'true',
        }),
        'games'
      ),
      soft(api('IPlayerService/GetRecentlyPlayedGames/v1/', { steamid: id, count: '10' }), 'recent'),
      soft(api('IPlayerService/GetProfileItemsEquipped/v1/', { steamid: id }), 'items'),
      soft(xml(), 'page'),
    ]);
    const person = f.parseSteamLinkDetails(details)[0];
    if (!person) throw Error('Steam не отдал этот профиль');
    if (person.gameId && !person.game) {
      const client = this.ctx.presence?.clients?.get(String(account.id));
      person.game = (await this.ctx.presence?.appName(client, Number(person.gameId)).catch(() => '')) || '';
    }
    let games = null;
    try {
      games = owned ? f.parseOwnedGames(owned) : null;
    } catch {
      games = null;
    }
    const lvl = badges?.response;
    const value = {
      ...person,
      avatar: person.avatar.replace(/_medium\.jpg$/, '_full.jpg'),
      accountId: account.id,
      friend: isFriend(account),
      level: lvl && lvl.player_level !== undefined ? Number(lvl.player_level) || 0 : null,
      badges: Array.isArray(lvl?.badges) ? lvl.badges.length : null,
      games,
      recent: recent ? f.parseRecentGames(recent) : [],
      ...f.parseProfileItems(items),
      realName: page?.realName || '',
      location: page?.location || '',
      summary: page?.summary || '',
      memberSince: page?.memberSince || '',
    };
    // Images and names of the games the page shows: one store request.
    const lib = this.libraryApps();
    const ownedGames = value.games?.games || [];
    const shown = [
      ...new Set([
        ...(person.gameId ? [String(person.gameId)] : []),
        ...value.recent.map(g => g.appId),
        ...[...ownedGames]
          .sort((a, b) => b.minutes - a.minutes)
          .slice(0, 10)
          .map(g => g.appId),
        ...ownedGames.filter(g => lib.has(g.appId)).map(g => g.appId),
      ]),
    ].slice(0, 100);
    const storeHits = shown.length
      ? await soft(steamLib.storeItems(this.ctx.publicFetch, shown, this.ctx.settings?.storeCountry), 'store')
      : null;
    value.store = Object.fromEntries(
      [...(storeHits || new Map())].map(([k, x]) => [String(k), { name: x.name || '', image: x.image || '' }])
    );
    this.profiles.set(id, { at: Date.now(), value });
    return this.decorateProfile(value);
  }
  // Steam games of the library: app id → { id, minutes }.
  libraryApps() {
    const lib = new Map();
    for (const g of this.ctx.library?.games || [])
      for (const o of g.offers || [])
        if (o.provider === 'steam' && (o.owned || o.installed))
          lib.set(String(o.appId), { id: g.id, minutes: Number(o.playtime) || 0 });
    return lib;
  }
  // Live status, chat key and games in common with the library.
  decorateProfile(v) {
    const live = this.ctx.presence?.steamStatus(v.id);
    const lib = this.libraryApps();
    // Store images and names (new games keep their images under hashed paths).
    const store = v.store || {};
    const withArt = g => ({
      ...g,
      image: store[g.appId]?.image || '',
      name: g.name || store[g.appId]?.name || '',
    });
    const common = (v.games?.games || [])
      .filter(g => lib.has(g.appId))
      .map(g => ({ ...g, gameId: lib.get(g.appId).id, mine: lib.get(g.appId).minutes }))
      .sort((a, b) => b.minutes + b.mine - (a.minutes + a.mine));
    const top = [...(v.games?.games || [])].filter(g => g.minutes > 0).sort((a, b) => b.minutes - a.minutes);
    const inLib = appId => lib.get(appId)?.id || '';
    const lastPlayed = new Map((v.games?.games || []).map(g => [g.appId, g.lastPlayed]));
    const status = live?.status || v.status;
    const gameId = status === 'ingame' ? v.gameId : '';
    return {
      ...v,
      status,
      // The status poll may have no game name: the profile's own, then the store's.
      game: (status === 'ingame' && (live?.game || v.game || store[gameId]?.name)) || '',
      gameId,
      gameImage: store[gameId]?.image || '',
      conv: v.friend ? convKey('steam', v.accountId, v.id) : '',
      games: v.games && {
        hidden: v.games.hidden,
        count: v.games.count,
        minutes: v.games.minutes,
        played: v.games.games.filter(g => g.minutes > 0).length,
      },
      top: top.slice(0, 10).map(g => withArt({ ...g, gameId: inLib(g.appId) })),
      recent: v.recent.map(g =>
        withArt({
          ...g,
          gameId: inLib(g.appId),
          lastPlayed: lastPlayed.get(g.appId) || null,
        })
      ),
      common: common.slice(0, 60).map(withArt),
      commonCount: common.length,
    };
  }
  async steamFriends(account) {
    const s = this.ctx.accounts.session(account.key);
    try {
      const api = await this.steamApi(account);
      const ids = f.parseSteamFriendIds(await api('IFriendsListService/GetFriendsList/v1/', {}));
      // GetPlayerLinkDetails takes the session token (GetPlayerSummaries needs a developer key).
      const friends = [];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const params = Object.fromEntries(chunk.map((id, n) => [`steamids[${n}]`, id]));
        friends.push(
          ...f.parseSteamLinkDetails(await api('IPlayerService/GetPlayerLinkDetails/v1/', params))
        );
      }
      // Only an app id comes for a friend in game: the name from the library or the Steam client.
      const client = this.ctx.presence?.clients?.get(String(account.id));
      for (const x of friends)
        if (x.gameId && !x.game)
          x.game = (await this.ctx.presence?.appName(client, Number(x.gameId)).catch(() => '')) || '';
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
