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

const icon = path.join(
  __dirname,
  '../../ui/assets/' + (process.platform === 'win32' ? 'nexus.ico' : 'nexus.png')
);
const SETTLE_MS = 4000; // after logon Steam sends every friend's status: that is not news
const ACHIEVEMENT_POLL_MS = 90000;
const POLL_MS = 60000; // friends' statuses from the Web API while the Steam client is open

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
    this.polled = new Set(); // Steam account ids with a first Web API poll done
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
    this.pollTimer = setInterval(
      () => this.poll().catch(e => this.ctx.log.debug?.('presence', e.message)),
      POLL_MS
    );
    this.pollTimer.unref?.();
    this.firstPoll = setTimeout(
      () => this.poll().catch(e => this.ctx.log.debug?.('presence', e.message)),
      15000
    );
    this.firstPoll.unref?.();
  }
  stop() {
    clearInterval(this.pollTimer);
    clearTimeout(this.firstPoll);
    for (const w of this.achievementTimers.values()) clearTimeout(w.timer);
    this.file.flushSync();
  }
  // Steam and Epic chat connections carry the status (not with "Не подключаться").
  // Steam's is skipped while the Steam client runs (see chat.cjs STEAM_CLIENT_OPEN).
  connect() {
    if (this.status() === 'off' || !this.ctx.chat) return;
    for (const account of this.ctx.accounts.connected('steam'))
      this.ctx.chat
        .steam(account)
        .connect()
        .catch(e => e.code !== 'STEAM_CLIENT_OPEN' && this.ctx.log.warn('presence', `steam: ${e.message}`));
    this.ctx.chat.connectEpic();
  }
  // Without the chat connection (the Steam client is open) the friends' statuses
  // come from the Web API once a minute; changes between two polls are the news.
  async poll() {
    if (this.status() === 'off') return;
    this.connect(); // the Steam client may have been closed meanwhile
    for (const account of this.ctx.accounts.connected('steam')) {
      if (this.ctx.chat?.steamCm?.get(account.id)?.state === 'online') continue; // live already
      const list = await this.ctx.friends?.steamFriends(account);
      if (Array.isArray(list)) this.webFriends(account, list);
    }
  }
  webFriends(account, list) {
    const first = !this.polled.has(account.id);
    this.polled.add(account.id);
    for (const x of list) {
      if (!/^7656119\d{10}$/.test(String(x?.id))) continue;
      const now = {
        status: x.status,
        game: x.status === 'ingame' ? String(x.game || '') : '',
        appId: Number(x.gameId) || 0,
        name: String(x.name || ''),
        avatar: String(x.avatar || ''),
      };
      const old = this.steamFriends.get(x.id);
      this.steamFriends.set(x.id, now);
      if (old && old.status === now.status && old.game === now.game && old.appId === now.appId) continue;
      this.ctx.social?.broadcast({
        type: 'presence',
        provider: 'steam',
        friendId: x.id,
        status: now.status,
        game: now.game,
      });
      if (first) continue; // the first poll is the current state, not news
      for (const ev of p.changes(old, now))
        this.event({
          ...ev,
          provider: 'steam',
          accountId: account.id,
          friendId: x.id,
          name: now.name,
          avatar: now.avatar,
        });
    }
  }
  async setStatus(status) {
    this.settings().myStatus = p.checkStatus(status);
    this.ctx.storage.saveSettings();
    this.applyAll();
    this.connect();
    this.ctx.social?.broadcast({ type: 'my-status', status: this.status() });
    this.ctx.tray?.update();
    this.applyClientStatus(this.status());
    return this.status();
  }
  // With the Steam client open Nexus is not on Steam's chat servers (see chat.cjs),
  // so setPersona above does not reach Steam: the status is set in the client itself,
  // the way its own status menu does it.
  applyClientStatus(status) {
    if (process.env.NEXUS_TEST === '1' || !this.ctx.accounts?.connected?.('steam').length) return;
    const cef = this.steamCef || require('./steam-cef.cjs');
    Promise.resolve()
      .then(() => this.ctx.actions?.processRunning?.('steam.exe'))
      .then(async open => {
        if (!open) return;
        try {
          await cef.setPersonaState(status);
          this.ctx.log.info('presence', `steam client status: ${status}`);
        } catch (e) {
          if (e.code !== 'NO_PORT') throw e;
          this.ctx.chat?.prepareSteamClient?.();
          // After the window's own «Ваш статус: …», not under it.
          setTimeout(
            () =>
              this.ctx.toast?.(
                'Клиент Steam запущен, и статус в нём Nexus сменит после следующего запуска Steam. Пока статус можно сменить в самом Steam.'
              ),
            2500
          ).unref?.();
        }
      })
      .catch(e => this.ctx.log.warn('presence', `steam client status: ${e.message}`));
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
  // The Steam status belongs to the whole account. Nexus signs in to Steam's chat
  // only while the Steam client is closed (its sign-in greys out a running client,
  // see chat.cjs). If the client starts later, "В сети" is left to it; Nexus sets
  // only a status the user chose in Nexus, and never "offline".
  async applyPersona(client, status) {
    if (status === 'off') return;
    if (status === 'online' && !client.nexusPersonaSet) {
      const steamOpen = await Promise.resolve()
        .then(() => this.ctx.actions?.processRunning?.('steam.exe'))
        .catch(() => false);
      // The status may have changed while we checked: the newer call sets it.
      if (steamOpen || this.status() !== status) return;
    }
    client.setPersona(p.STEAM_PERSONA[status]);
    // Back to "В сети" with the Steam client open: Nexus no longer needs to own the status.
    client.nexusPersonaSet = status !== 'online';
  }
  applySteam(accountId, client) {
    const status = this.status();
    this.applyPersona(client, status).catch(e => this.ctx.log.debug?.('presence', e.message));
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
  // The name of a Steam game a friend plays: Steam sends only its app id.
  // From the library, the Steam store (any game, playtests too) or Steam's chat
  // servers (not signed in while the Steam client runs). A miss is retried later.
  async appName(client, appId) {
    if (!appId) return '';
    await this.appNamesFor(client, [appId]);
    return this.appNames.get(Number(appId)) || '';
  }
  async appNamesFor(client, ids) {
    const fresh = id => this.appNames.has(id) || Date.now() - (this.appNameMiss?.get(id) || 0) < 600000;
    const want = [
      ...new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0 && id < 2 ** 32)),
    ].filter(id => !fresh(id));
    if (!want.length) return;
    const found = new Map();
    for (const g of this.ctx.library?.games || [])
      for (const o of g.offers || [])
        if (o.provider === 'steam' && want.includes(Number(o.appId))) found.set(Number(o.appId), g.name);
    let left = want.filter(id => !found.has(id));
    if (left.length)
      try {
        const items = await require('../steam-library.cjs').dlcItems(
          (url, o) => this.ctx.publicFetch(url, o),
          left.map(String),
          this.ctx.settings?.storeCountry || 'US'
        );
        for (const x of items) found.set(Number(x.appId), x.name);
      } catch (e) {
        this.ctx.log.debug?.('presence', `app names: ${e.message}`);
      }
    left = left.filter(id => !found.has(id));
    for (const id of left)
      try {
        const r = await client?.getProductInfo?.([id], [], false);
        const name = r?.apps?.[id]?.appinfo?.common?.name;
        if (name) found.set(id, name);
      } catch {}
    this.appNameMiss ||= new Map();
    for (const id of want) {
      const name = String(found.get(id) || '').slice(0, 120);
      if (name) this.appNames.set(id, name);
      else this.appNameMiss.set(id, Date.now());
    }
  }
  async steamUser(account, client, sid, user) {
    const id = sid?.getSteamID64?.() || String(sid || '');
    if (!/^7656119\d{10}$/.test(id) || id === String(account.id)) return;
    if (client.myFriends && client.myFriends[id] !== 3) return; // only friends
    const merged = { ...(client.users?.[id] || {}), ...user };
    // No persona_state = Steam did not send the status (not "offline"): keep what we know.
    if (merged.persona_state === null || merged.persona_state === undefined) return;
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
    const s = this.settings();
    // «Активность друзей» → settings: what is recorded and for how long. Notifications
    // and the overlay do not depend on it.
    if (p.activityWanted(s, ev.type)) {
      const before = this.activity;
      const keep = p.activityKeep(s);
      this.activity = p.addActivity(before, entry, Date.now(), keep > p.WEEK ? 1000 : 300, keep);
      if (this.activity === before || this.activity[0] !== entry) return; // a repeat
      this.file.schedule(() => JSON.stringify(this.activity));
      this.ctx.social?.broadcast({ type: 'activity', entry });
    }
    this.ctx.overlay?.event({ kind: 'friend', entry });
    if (ev.type === 'online' && s.notifyFriendOnline === true)
      this.notify(entry.name, 'Теперь в сети', () => this.ctx.social?.openChat(entry.conv));
    if (ev.type === 'game' && s.notifyFriendGame !== false)
      this.notify(entry.name, `Играет в ${entry.game || 'игру'}`, () =>
        this.ctx.social?.openChat(entry.conv)
      );
  }
  feed() {
    const s = this.settings();
    const keep = p.activityKeep(s);
    return this.activity.filter(x => Date.now() - x.at < keep && p.activityWanted(s, x.type));
  }
  clearActivity() {
    this.activity = [];
    this.file.schedule(() => JSON.stringify(this.activity));
    return [];
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
