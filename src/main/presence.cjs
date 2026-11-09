'use strict';
// Status and activity like the Steam client (helpers: ../presence.cjs).
//   My status: "В сети", "Нет на месте", "Невидимка" for Steam (Steam's chat
//     servers, the connection of the chat) and Epic (its XMPP connection).
//     "Не подключаться" leaves both alone until the chat window is opened.
//   "Играет в … · Nexus": while an Epic or manually added game runs, Steam
//     friends see it as a non-Steam game, Epic friends as a game.
//   Friends: status in real time, Windows notifications ("в сети", "играет
//     в …") and the activity feed of the last week.
//   Achievements: while a Steam game runs, new achievements are announced.

const path = require('node:path');
const electron = require('electron');
const p = require('../presence.cjs');
const { convKey } = require('../chat.cjs');
const { JsonFile } = require('./storage.cjs');

const icon = path.join(__dirname, '../../ui/assets/nexus.ico');
const SETTLE_MS = 4000; // after logon Steam sends every friend's status: that is not news
const ACHIEVEMENT_POLL_MS = 90000;

class PresenceService {
  constructor(ctx) {
    this.ctx = ctx;
    this.file = new JsonFile(ctx.storage.file('activity.json'), 2000);
    const saved = this.file.readSync([]);
    this.activity = Array.isArray(saved) ? saved.filter(x => x && Number.isFinite(x.at)) : [];
    this.steamFriends = new Map(); // friend id → persona (see presence.cjs steamPersona)
    this.clients = new Map(); // Steam account id → steam-user client
    this.ready = new Set(); // Steam account ids past the first wave of statuses
    this.epicSince = new Map(); // Epic account id → when its chat connected
    this.appNames = new Map();
    this.reported = new Map(); // Steam account id → the name reported as played
    this.playing = null; // { id, name, provider } of the game running now
    this.notifications = new Set();
    this.achievementTimers = new Map(); // game id → { timer, known: Set }
  }
  settings() {
    return this.ctx.settings;
  }
  status() {
    const s = this.settings().myStatus;
    return p.STATUSES.includes(s) ? s : 'online';
  }
  start() {
    this.ctx.gameEvents?.on('start', g => this.gameStarted(g));
    this.ctx.gameEvents?.on('stop', g => this.gameStopped(g));
    this.connect();
  }
  stop() {
    for (const w of this.achievementTimers.values()) clearTimeout(w.timer);
    this.file.flushSync();
  }
  // Steam and Epic chat connections carry the status (not with "Не подключаться").
  connect() {
    if (this.status() === 'off' || !this.ctx.chat) return;
    for (const account of this.ctx.accounts.connected('steam'))
      this.ctx.chat
        .steam(account)
        .connect()
        .catch(e => this.ctx.log.warn('presence', `steam: ${e.message}`));
    this.ctx.chat.connectEpic();
  }
  async setStatus(status) {
    this.settings().myStatus = p.checkStatus(status);
    this.ctx.storage.saveSettings();
    this.applyAll();
    this.connect();
    this.ctx.social?.broadcast({ type: 'my-status', status: this.status() });
    this.ctx.tray?.update();
    return this.status();
  }
  // ---- my status ---------------------------------------------------------------
  attach(account, client) {
    if (this.clients.get(account.id) === client) return;
    this.clients.set(account.id, client);
    this.ready.delete(account.id);
    this.reported.delete(account.id);
    const settle = () => setTimeout(() => this.ready.add(account.id), SETTLE_MS).unref?.();
    client.once('friendPersonasLoaded', settle);
    setTimeout(() => this.ready.add(account.id), 30000).unref?.();
    client.on('user', (sid, user) =>
      this.steamUser(account, client, sid, user).catch(e => this.ctx.log.debug?.('presence', e.message))
    );
    client.on('playingState', st => {
      // Another session (the Steam client) plays a game: Nexus does not report one.
      client.nexusBlocked = !!st?.blocked;
      if (client.nexusBlocked) this.reported.delete(account.id);
    });
    this.applySteam(account.id, client);
  }
  applyAll() {
    for (const [id, client] of this.clients) this.applySteam(id, client);
    for (const x of this.ctx.chat?.epic?.values() || []) x.setPresence(this.epicPresence());
  }
  applySteam(accountId, client) {
    const status = this.status();
    try {
      client.setPersona(status === 'off' ? 0 : p.STEAM_PERSONA[status]);
    } catch (e) {
      this.ctx.log.debug?.('presence', e.message);
    }
    // Only games Steam does not know about; never over a game of the Steam client.
    const g = this.playing;
    const want =
      g && g.provider !== 'steam' && status !== 'off' && this.settings().showPlaying !== false
        ? p.playingName(g.name)
        : '';
    const had = this.reported.get(accountId) || '';
    if (want === had || client.nexusBlocked) return;
    try {
      client.gamesPlayed(want ? [want] : []);
      if (want) this.reported.set(accountId, want);
      else this.reported.delete(accountId);
    } catch (e) {
      this.ctx.log.debug?.('presence', e.message);
    }
  }
  epicPresence() {
    const status = this.status();
    const g = this.playing;
    return {
      status: status === 'off' ? 'online' : status,
      game: g && this.settings().showPlaying !== false ? g.name : '',
    };
  }
  gameStarted(g) {
    this.playing = { id: g.id, name: g.name, provider: g.provider };
    this.applyAll();
    this.watchAchievements(g.id);
    this.ctx.tray?.update();
  }
  gameStopped(g) {
    if (this.playing?.id === g.id) this.playing = null;
    this.applyAll();
    this.stopAchievements(g.id);
    this.ctx.tray?.update();
  }
  // ---- friends -----------------------------------------------------------------
  async appName(client, appId) {
    if (!appId) return '';
    if (this.appNames.has(appId)) return this.appNames.get(appId);
    const known = (this.ctx.library?.games || []).find(g =>
      g.offers?.some(o => o.provider === 'steam' && String(o.appId) === String(appId))
    );
    let name = known?.name || '';
    if (!name)
      try {
        const r = await client.getProductInfo([appId], [], false);
        name = r?.apps?.[appId]?.appinfo?.common?.name || '';
      } catch {}
    this.appNames.set(appId, String(name).slice(0, 120));
    return this.appNames.get(appId);
  }
  async steamUser(account, client, sid, user) {
    const id = sid?.getSteamID64?.() || String(sid || '');
    if (!/^7656119\d{10}$/.test(id) || id === String(account.id)) return;
    if (client.myFriends && client.myFriends[id] !== 3) return; // only friends
    const merged = { ...(client.users?.[id] || {}), ...user };
    const appId = Number(merged.gameid || merged.game_played_app_id || 0);
    const now = p.steamPersona(merged, merged.game_name ? '' : await this.appName(client, appId));
    const old = this.steamFriends.get(id);
    const name = now.name || old?.name || this.friendName('steam', id);
    this.steamFriends.set(id, { ...now, name, avatar: now.avatar || old?.avatar || '' });
    this.ctx.social?.broadcast({
      type: 'presence',
      provider: 'steam',
      friendId: id,
      status: now.status,
      game: now.game,
    });
    if (!this.ready.has(account.id)) return;
    for (const ev of p.changes(old, now))
      this.event({
        ...ev,
        provider: 'steam',
        accountId: account.id,
        friendId: id,
        name,
        avatar: now.avatar || old?.avatar || '',
      });
  }
  epicOnline(account) {
    this.epicSince.set(account.id, Date.now());
  }
  epicFriend(account, friendId, old, now) {
    const since = this.epicSince.get(account.id) || Date.now();
    if (!this.epicSince.has(account.id)) this.epicSince.set(account.id, since);
    // The first wave after connecting is the current state, not news.
    if (!old && Date.now() - since < 15000) return;
    for (const ev of p.changes(old || { status: 'offline', game: '' }, now))
      this.event({
        ...ev,
        provider: 'epic',
        accountId: account.id,
        friendId,
        name: this.friendName('epic', friendId),
        avatar: '',
      });
  }
  friendName(provider, id) {
    for (const group of this.ctx.friends?.cache?.[provider] || []) {
      const f = group.friends.find(x => x.id === id);
      if (f) return f.name;
    }
    return provider === 'steam' ? 'Друг в Steam' : 'Друг в Epic Games';
  }
  // Live status for the friends list: { status, game } or null.
  steamStatus(friendId) {
    const x = this.steamFriends.get(friendId);
    return x ? { status: x.status, game: x.game } : null;
  }
  event(ev) {
    const entry = {
      at: Date.now(),
      type: ev.type,
      provider: ev.provider,
      friendId: ev.friendId,
      name: ev.name,
      avatar: ev.avatar,
      game: ev.game || '',
      appId: ev.appId || 0,
      conv: convKey(ev.provider, ev.accountId, ev.friendId),
    };
    const before = this.activity;
    this.activity = p.addActivity(before, entry);
    if (this.activity === before || this.activity[0] !== entry) return; // a repeat
    this.file.schedule(() => JSON.stringify(this.activity));
    this.ctx.social?.broadcast({ type: 'activity', entry });
    this.ctx.overlay?.event({ kind: 'friend', entry });
    const s = this.settings();
    if (ev.type === 'online' && s.notifyFriendOnline === true)
      this.notify(entry.name, 'Теперь в сети', () => this.ctx.social?.openChat(entry.conv));
    if (ev.type === 'game' && s.notifyFriendGame !== false)
      this.notify(entry.name, `Играет в ${entry.game || 'игру'}`, () =>
        this.ctx.social?.openChat(entry.conv)
      );
  }
  feed() {
    return this.activity.filter(x => Date.now() - x.at < p.WEEK);
  }
  notify(title, body, onClick) {
    if (this.ctx.social?.chatFocused?.()) return;
    const { Notification } = electron;
    if (!Notification.isSupported?.()) return;
    const n = new Notification({
      title: String(title).slice(0, 100),
      body: String(body).slice(0, 200),
      icon,
      silent: true,
    });
    this.notifications.add(n);
    const done = () => this.notifications.delete(n);
    n.on('click', () => {
      done();
      onClick?.();
    });
    n.on('close', done);
    n.on('failed', done);
    n.show();
  }
  // ---- achievements while playing ---------------------------------------------------
  watchAchievements(gameId) {
    const g = (this.ctx.library?.games || []).find(x => x.id === gameId);
    if (!g?.offers?.some(o => o.provider === 'steam') || this.achievementTimers.has(gameId)) return;
    const w = { timer: null, known: null };
    this.achievementTimers.set(gameId, w);
    const tick = async () => {
      await this.checkAchievements(gameId, w).catch(e => this.ctx.log.debug?.('achievements', e.message));
      if (this.achievementTimers.get(gameId) !== w) return;
      w.timer = setTimeout(tick, ACHIEVEMENT_POLL_MS);
      w.timer.unref?.();
    };
    tick();
  }
  stopAchievements(gameId) {
    const w = this.achievementTimers.get(gameId);
    if (!w) return;
    clearTimeout(w.timer);
    this.achievementTimers.delete(gameId);
    // Steam reports the last ones with a delay: one more look after the game.
    setTimeout(() => this.checkAchievements(gameId, w).catch(() => {}), 45000).unref?.();
  }
  async checkAchievements(gameId, w) {
    const a = await this.ctx.library.achievements(gameId, { force: true });
    if (!a?.available) return;
    const unlocked = a.list.filter(x => x.unlocked);
    if (!w.known) {
      w.known = new Set(unlocked.map(x => x.name));
      return;
    }
    const fresh = unlocked.filter(x => !w.known.has(x.name));
    for (const x of fresh) {
      w.known.add(x.name);
      const game = (this.ctx.library.games || []).find(g => g.id === gameId)?.name || '';
      this.ctx.overlay?.event({
        kind: 'achievement',
        name: x.name,
        description: x.description,
        icon: x.icon,
        game,
      });
      if (this.settings().notifyAchievements !== false)
        this.notify(
          `Достижение получено · ${game}`,
          `${x.name}${x.description ? ' — ' + x.description : ''}`,
          () => this.ctx.showGame?.(gameId)
        );
    }
  }
}

module.exports = { PresenceService };
