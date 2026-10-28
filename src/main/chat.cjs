'use strict';
// Chat with friends right in Nexus (see ../chat.cjs for the protocols).
//   Steam: history through the Web API; sending and live messages through
//          Steam's chat servers (CM), signed in like the web chat of
//          steamcommunity.com (steam-user with the web chat token). New
//          messages are also found by polling the message sessions.
//   Epic:  one XMPP connection per account for the friends' presence. Epic
//          answers private messages through it with "503 service unavailable"
//          (also to oneself), so Nexus does not offer sending to Epic friends.
// Events for the windows: { type: 'message' | 'unread' | 'presence' | 'chat-state', … }.

const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { Notification } = require('electron');
const path = require('node:path');
const steamLib = require('../steam-library.cjs');
const c = require('../chat.cjs');
const { JsonFile } = require('./storage.cjs');

const icon = path.join(__dirname, '../../ui/assets/nexus.ico');
const POLL_OPEN_MS = 4000;
const POLL_IDLE_MS = 20000;
const TOKEN_MS = 5 * 60000;
const EPIC_NO_SEND =
  'Epic Games не даёт писать друзьям из сторонних программ: сервер чата Epic отклоняет личные сообщения. Написать можно в Epic Games Launcher или в игре.';

// Why Steam refused (steam-user errors carry an EResult).
function steamError(e) {
  const r = Number(e?.eresult);
  if (r === 15) return 'Steam не разрешил отправку: вы не друзья или игрок ограничил сообщения';
  if (r === 84) return 'Steam: слишком много сообщений, подождите немного';
  if (r === 5 || r === 8 || r === 21)
    return 'Steam не принял вход в чат — войдите в Steam заново в «Аккаунтах» главного окна';
  if (r === 17) return 'Аккаунт Steam ограничен: отправка сообщений недоступна';
  return `Steam: ${e?.message || 'ошибка'}${r ? ' (' + r + ')' : ''}`;
}

// Steam's chat servers, signed in like steamcommunity.com/chat.
class SteamCm extends EventEmitter {
  constructor({ webLogon, log, SteamUserImpl }) {
    super();
    this.webLogon = webLogon;
    this.log = log;
    this.SteamUserImpl = SteamUserImpl;
    this.client = null;
    this.connecting = null;
    this.state = 'offline';
  }
  setState(state, error = '') {
    this.state = state;
    this.emit('state', { state, error });
  }
  connect() {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = this.logOn()
      .catch(e => {
        this.setState('error', e.message);
        throw e;
      })
      .finally(() => (this.connecting = null));
    return this.connecting;
  }
  async logOn() {
    this.setState('connecting');
    const { accountName, token, steamId } = await this.webLogon();
    const SteamUser = this.SteamUserImpl || require('steam-user');
    const client = new SteamUser({
      protocol: SteamUser.EConnectionProtocol?.WebSocket,
      autoRelogin: false,
      dataDirectory: null,
      enablePicsCache: false,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('чат Steam не ответил')), 30000);
      client.once('loggedOn', () => (clearTimeout(timer), resolve()));
      client.once('error', e => (clearTimeout(timer), reject(Error(steamError(e)))));
      client.logOn({ accountName, webLogonToken: token, steamID: steamId });
    });
    const msg = from => m =>
      this.emit('message', {
        friendId: String(m.steamid_friend),
        text: c.steamText(m.message),
        at: +m.server_timestamp || Date.now(),
        from,
      });
    client.chat.on('friendMessage', msg('them'));
    client.chat.on('friendMessageEcho', msg('me'));
    const lost = () => {
      if (this.client !== client) return;
      this.client = null;
      this.setState('offline');
    };
    client.on('disconnected', lost);
    client.on('error', e => {
      this.log?.warn('chat', `steam cm: ${e.message}`);
      lost();
    });
    this.client = client;
    this.setState('online');
    return client;
  }
  async send(friendId, text) {
    const client = await this.connect();
    try {
      const r = await client.chat.sendFriendMessage(friendId, text);
      return +r?.server_timestamp || Date.now();
    } catch (e) {
      throw Error(steamError(e));
    }
  }
  ack(friendId) {
    try {
      this.client?.chat.ackFriendMessage(friendId, new Date());
    } catch {}
  }
  stop() {
    const client = this.client;
    this.client = null;
    try {
      client?.logOff();
    } catch {}
    this.setState('offline');
  }
}

class EpicXmpp extends EventEmitter {
  constructor({ accountId, getToken, log, WebSocketImpl = globalThis.WebSocket }) {
    super();
    this.accountId = accountId;
    this.getToken = getToken;
    this.log = log;
    this.WebSocket = WebSocketImpl;
    this.ws = null;
    this.state = 'offline';
    this.stopped = true;
    this.retry = 0;
    this.seq = 0;
  }
  nextId() {
    return `nx${++this.seq}`;
  }
  setState(s, error = '') {
    if (this.state === s && !error) return;
    this.state = s;
    this.emit('state', { state: s, error });
  }
  start() {
    this.stopped = false;
    if (!this.ws) this.connect().catch(e => this.failed(e));
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.send(c.xmpp.close());
      ws?.close();
    } catch {}
    this.setState('offline');
  }
  failed(e) {
    this.log?.warn('chat', `epic xmpp: ${e.message}`);
    this.setState('error', e.message);
    this.ws = null;
    this.scheduleReconnect();
  }
  scheduleReconnect() {
    clearInterval(this.pingTimer);
    if (this.stopped) return;
    const delay = [3000, 10000, 30000, 60000][Math.min(this.retry++, 3)];
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(
      () => !this.stopped && !this.ws && this.connect().catch(e => this.failed(e)),
      delay
    );
  }
  async connect() {
    this.setState('connecting');
    const token = await this.getToken();
    const ws = new this.WebSocket('wss://xmpp-service-prod.ol.epicgames.com', 'xmpp');
    this.ws = ws;
    let authed = false;
    const send = x => ws.readyState === 1 && ws.send(x);
    ws.onopen = () => send(c.xmpp.open());
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      this.setState(this.stopped ? 'offline' : 'connecting');
      this.scheduleReconnect();
    };
    ws.onmessage = ({ data }) => {
      const s = c.parseStanza(String(data));
      if (!s) return;
      if (s.name === 'stream:features' && !authed) send(c.xmpp.auth(this.accountId, token));
      else if (s.name === 'success') {
        authed = true;
        send(c.xmpp.open());
      } else if (s.name === 'failure') {
        this.stopped = true; // a bad token does not get better by retrying
        this.setState('error', 'Epic отклонил вход в чат — войдите в аккаунт Epic заново');
        ws.close();
      } else if (s.name === 'stream:features' && authed)
        send(c.xmpp.bind('bind1', `V2:launcher:WIN::${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`));
      else if (s.name === 'iq' && s.id === 'bind1') {
        if (s.type !== 'result') return this.failed(Error('привязка сессии чата не удалась'));
        send(c.xmpp.presence('Nexus'));
        this.retry = 0;
        this.setState('online');
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => send(c.xmpp.ping(this.nextId())), 60000);
      } else if (s.name === 'iq' && s.ping && s.type === 'get') send(c.xmpp.pong(s.id, s.from));
      else if (s.name === 'message') this.onMessage(s);
      else if (s.name === 'presence') this.onPresence(s);
      else if (s.name === 'close') ws.close();
    };
  }
  onMessage(s) {
    const friendId = c.bareId(s.from);
    if (!c.EPIC_ID.test(friendId)) return; // service messages (parties, …)
    if (s.type === 'error') return this.emit('send-error', { friendId, id: s.id });
    if (s.type !== 'chat' || !s.body) return;
    const text = c.cleanText(s.body);
    if (text) this.emit('message', { friendId, text, at: Date.now() });
  }
  onPresence(s) {
    const friendId = c.bareId(s.from);
    if (!c.EPIC_ID.test(friendId) || friendId === this.accountId) return;
    this.emit('presence', { friendId, ...c.epicPresence(s) });
  }
  send(friendId, text) {
    if (this.state !== 'online' || this.ws?.readyState !== 1)
      throw Error('Чат Epic ещё подключается — попробуйте через несколько секунд');
    const id = this.nextId();
    this.ws.send(c.xmpp.message(friendId, text, id));
    return id;
  }
}

class ChatService {
  constructor(ctx, { WebSocketImpl, SteamUserImpl } = {}) {
    this.ctx = ctx;
    this.WebSocketImpl = WebSocketImpl;
    this.SteamUserImpl = SteamUserImpl;
    this.file = new JsonFile(ctx.storage.file('chat-history.json'), 1500);
    this.history = this.loadHistory();
    this.unread = new Map(); // conv → count
    this.viewing = new Set(); // conversations open in the chat window
    this.steamSeen = new Map(); // account id → Map(friend id → last message ms); null until the first poll
    this.tokens = new Map();
    this.epic = new Map(); // account id → EpicXmpp
    this.steamCm = new Map(); // account id → SteamCm
    this.presence = new Map(); // epic friend id → { status, game }
    this.notifications = new Set();
    this.timer = null;
    this.emit = event => ctx.social?.broadcast(event);
  }
  start() {
    this.schedule(1500);
  }
  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const x of this.epic.values()) x.stop();
    for (const x of this.steamCm.values()) x.stop();
    this.file.flushSync();
  }
  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        this.pollSteam()
          .catch(e => this.ctx.log.debug?.('chat', `steam poll: ${e.message}`))
          .finally(() => this.schedule(this.ctx.social?.anyOpen() ? POLL_OPEN_MS : POLL_IDLE_MS)),
      ms
    );
    this.timer.unref?.();
  }
  // ---- accounts ------------------------------------------------------------
  account(provider, accountId) {
    const a = this.ctx.accounts.connected(provider).find(x => String(x.id) === String(accountId));
    if (!a) throw Error(`Аккаунт ${provider === 'steam' ? 'Steam' : 'Epic Games'} не подключён`);
    return a;
  }
  async steamToken(account, force = false) {
    const t = this.tokens.get(account.id);
    if (!force && t && Date.now() - t.at < TOKEN_MS) return t.token;
    const s = this.ctx.accounts.session(account.key);
    const token = await steamLib.sessionToken((u, o) => s.fetch(u, o), account.id);
    this.tokens.set(account.id, { token, at: Date.now() });
    return token;
  }
  async steamApi(account, method, params, post = false) {
    const call = async token => {
      const body = new URLSearchParams({ access_token: token, ...params });
      const url = `https://api.steampowered.com/IFriendMessagesService/${method}/v1/`;
      return this.ctx.publicFetch(post ? url : `${url}?${body}`, {
        method: post ? 'POST' : 'GET',
        ...(post ? { body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}),
        signal: AbortSignal.timeout(15000),
      });
    };
    let r = await call(await this.steamToken(account));
    if (r.status === 401 || r.status === 403) r = await call(await this.steamToken(account, true));
    const eresult = Number(r.headers?.get?.('x-eresult') || 1);
    if (!r.ok || eresult !== 1)
      throw Error(
        eresult === 15 || r.status === 403
          ? 'Steam не разрешил действие (нет доступа)'
          : eresult === 84
            ? 'Steam: слишком много сообщений, подождите немного'
            : `Steam: ${r.ok ? 'ошибка ' + eresult : 'HTTP ' + r.status}`
      );
    return r.json().catch(() => ({}));
  }
  // The web chat token of the Steam sign-in (the community login is renewed
  // through login.steampowered.com when it has expired).
  async steamWebLogon(account) {
    const s = this.ctx.accounts.session(account.key);
    const get = async () => {
      const r = await s.fetch('https://steamcommunity.com/chat/clientjstoken', {
        credentials: 'include',
        signal: AbortSignal.timeout(15000),
      });
      return r.ok ? r.json() : null;
    };
    let j = await get().catch(() => null);
    if (!j?.logged_in) {
      await s
        .fetch(
          'https://login.steampowered.com/jwt/refresh?redir=' +
            encodeURIComponent('https://steamcommunity.com/chat/'),
          { credentials: 'include', signal: AbortSignal.timeout(20000) }
        )
        .catch(() => {});
      j = await get().catch(() => null);
    }
    if (!j?.logged_in || !j.token || String(j.steamid) !== String(account.id))
      throw Error('Steam не пустил в чат — войдите в Steam заново в «Аккаунтах» главного окна');
    return { accountName: j.account_name, token: j.token, steamId: String(j.steamid) };
  }
  steam(account) {
    let x = this.steamCm.get(account.id);
    if (!x) {
      x = new SteamCm({
        webLogon: () => this.steamWebLogon(account),
        log: this.ctx.log,
        SteamUserImpl: this.SteamUserImpl,
      });
      x.on('message', m => this.received('steam', account.id, m.friendId, m.text, m.at, m.from));
      x.on('state', st => this.emit({ type: 'chat-state', provider: 'steam', accountId: account.id, ...st }));
      this.steamCm.set(account.id, x);
    }
    return x;
  }
  // Both chats are connected once a social window is opened, then kept for the session.
  connectChats() {
    for (const account of this.ctx.accounts.connected('steam'))
      this.steam(account)
        .connect()
        .catch(e => this.ctx.log.warn('chat', `steam: ${e.message}`));
    this.connectEpic();
  }
  connectEpic() {
    for (const account of this.ctx.accounts.connected('epic')) {
      if (this.epic.has(account.id)) {
        this.epic.get(account.id).start();
        continue;
      }
      const x = new EpicXmpp({
        accountId: account.id,
        getToken: () => this.ctx.accounts.tokens.accessToken(account.id),
        log: this.ctx.log,
        WebSocketImpl: this.WebSocketImpl,
      });
      x.on('message', m => this.received('epic', account.id, m.friendId, m.text, m.at));
      x.on('presence', p => {
        this.presence.set(p.friendId, { status: p.status, game: p.game });
        this.emit({
          type: 'presence',
          provider: 'epic',
          friendId: p.friendId,
          status: p.status,
          game: p.game,
        });
      });
      x.on('state', s => this.emit({ type: 'chat-state', provider: 'epic', accountId: account.id, ...s }));
      x.on('send-error', () =>
        this.emit({
          type: 'chat-state',
          provider: 'epic',
          accountId: account.id,
          state: 'online',
          error: 'Epic не доставил сообщение',
        })
      );
      this.epic.set(account.id, x);
      x.start();
    }
  }
  epicStatus(friendId) {
    return this.presence.get(friendId) || null;
  }
  chatState() {
    return Object.fromEntries([...this.epic, ...this.steamCm].map(([id, x]) => [id, x.state]));
  }
  // ---- history, sending, unread -------------------------------------------------
  conv(key) {
    const k = c.parseConvKey(key);
    if (!k) throw Error('Некорректный собеседник');
    return { ...k, key: c.convKey(k.provider, k.accountId, k.friendId) };
  }
  store(key, msgs) {
    this.history[key] = msgs;
    this.saveHistory();
  }
  // The history is encrypted with Windows' protection of the user account
  // (safeStorage, like the saved sign-ins). Without it nothing is written:
  // the conversation then lives only until Nexus is closed.
  canEncrypt() {
    return !!this.ctx.storage.encryptionAvailable?.() && !!this.ctx.storage.safeStorage;
  }
  loadHistory() {
    const raw = this.file.readSync({});
    const ok = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    if (typeof raw?.encrypted === 'string') {
      try {
        return ok(
          JSON.parse(this.ctx.storage.safeStorage.decryptString(Buffer.from(raw.encrypted, 'base64')))
        );
      } catch {
        this.ctx.log.warn('chat', 'history could not be decrypted');
        return {};
      }
    }
    // An older plain-text file is encrypted right away (or removed without encryption).
    const legacy = ok(raw);
    if (Object.keys(legacy).length) queueMicrotask(() => this.saveHistory(true));
    return legacy;
  }
  saveHistory(force = false) {
    if (!this.canEncrypt()) {
      if (force) this.file.schedule(() => '{}');
      return;
    }
    this.file.schedule(() =>
      JSON.stringify({
        encrypted: this.ctx.storage.safeStorage
          .encryptString(JSON.stringify(this.history))
          .toString('base64'),
      })
    );
  }
  async messages(key) {
    const k = this.conv(key);
    let warning = '';
    if (k.provider === 'steam') {
      try {
        const account = this.account('steam', k.accountId);
        const json = await this.steamApi(account, 'GetRecentMessages', {
          steamid1: k.accountId,
          steamid2: k.friendId,
          count: 60,
          rtime32_start_time: 0,
          bbcode_format: true,
        });
        this.store(k.key, c.mergeHistory(this.history[k.key], c.parseSteamMessages(json, k.accountId)));
      } catch (e) {
        warning = `История Steam не загрузилась: ${e.message}`;
      }
    } else {
      this.connectEpic();
      warning = EPIC_NO_SEND;
    }
    return {
      messages: this.history[k.key] || [],
      warning,
      readonly: k.provider === 'epic',
      state: k.provider === 'epic' ? this.epic.get(k.accountId)?.state : this.steamCm.get(k.accountId)?.state,
    };
  }
  async send(key, text) {
    const k = this.conv(key);
    const clean = c.cleanText(text);
    if (!clean) throw Error('Пустое сообщение');
    let at = Date.now();
    if (k.provider === 'steam') {
      const account = this.account('steam', k.accountId);
      // steam-user escapes the brackets itself (the text is not BBCode).
      at = await this.steam(account).send(k.friendId, clean);
      const seen = this.steamSeen.get(k.accountId);
      if (seen) seen.set(k.friendId, Math.max(seen.get(k.friendId) || 0, at));
    } else throw Error(EPIC_NO_SEND);
    const msg = { from: 'me', text: clean, at };
    this.store(k.key, c.addToHistory(this.history[k.key], msg));
    this.emit({ type: 'message', conv: k.key, message: msg });
    return msg;
  }
  received(provider, accountId, friendId, text, at, from = 'them') {
    const key = c.convKey(provider, accountId, friendId);
    const msg = { from, text, at };
    const before = (this.history[key] || []).length;
    const next = c.addToHistory(this.history[key], msg);
    if (next.length === before) return; // already known
    this.store(key, next);
    this.emit({ type: 'message', conv: key, message: msg });
    if (from === 'them' && !this.viewing.has(key)) {
      this.unread.set(key, (this.unread.get(key) || 0) + 1);
      this.emitUnread();
      this.notify(provider, friendId, key, text);
    } else if (from === 'them' && provider === 'steam') this.markRead(key).catch(() => {});
  }
  setViewing(keys) {
    this.viewing = new Set(
      (Array.isArray(keys) ? keys : []).map(k => c.parseConvKey(k) && k).filter(Boolean)
    );
    for (const k of this.viewing) if (this.unread.has(k)) this.markRead(k).catch(() => {});
  }
  async markRead(key) {
    const k = this.conv(key);
    this.unread.delete(k.key);
    this.emitUnread();
    if (k.provider === 'steam') this.steamCm.get(k.accountId)?.ack(k.friendId);
  }
  unreadMap() {
    return Object.fromEntries(this.unread);
  }
  emitUnread() {
    this.emit({ type: 'unread', unread: this.unreadMap() });
  }
  friendName(provider, friendId) {
    const data = this.ctx.friends?.cache;
    for (const group of data?.[provider] || []) {
      const f = group.friends.find(x => x.id === friendId);
      if (f) return f.name;
    }
    return provider === 'steam' ? 'Друг в Steam' : 'Друг в Epic Games';
  }
  notify(provider, friendId, key, text) {
    const name = this.friendName(provider, friendId);
    if (this.ctx.social?.chatFocused()) return;
    this.ctx.toast?.(`${name}: ${text.slice(0, 120)}`);
    if (!Notification.isSupported?.()) return;
    const n = new Notification({ title: name, body: text.slice(0, 200), icon, silent: false });
    this.notifications.add(n);
    const done = () => this.notifications.delete(n);
    n.on('click', () => {
      done();
      this.ctx.social?.openChat(key);
    });
    n.on('close', done);
    n.on('failed', done);
    n.show();
  }
  // New Steam messages (also ones written in Steam itself) are found through
  // the sessions that changed since the last look.
  async pollSteam() {
    for (const account of this.ctx.accounts.connected('steam')) {
      const json = await this.steamApi(account, 'GetActiveMessageSessions', {
        only_sessions_with_messages: true,
      });
      const sessions = c.parseSteamSessions(json);
      let seen = this.steamSeen.get(account.id);
      if (!seen) {
        // First look: what is already there is history, not news; Steam's unread counts are kept.
        this.steamSeen.set(account.id, new Map(sessions.map(s => [s.friendId, s.last])));
        for (const s of sessions)
          if (s.unread) this.unread.set(c.convKey('steam', account.id, s.friendId), s.unread);
        if (sessions.some(s => s.unread)) this.emitUnread();
        continue;
      }
      for (const s of sessions) {
        const last = seen.get(s.friendId) || 0;
        if (s.last <= last) continue;
        seen.set(s.friendId, s.last);
        const recent = await this.steamApi(account, 'GetRecentMessages', {
          steamid1: account.id,
          steamid2: s.friendId,
          count: 20,
          rtime32_start_time: Math.floor(last / 1000),
          bbcode_format: true,
        });
        for (const m of c.parseSteamMessages(recent, account.id))
          if (m.at > last) this.received('steam', account.id, s.friendId, m.text, m.at, m.from);
      }
    }
  }
}

module.exports = { ChatService, EpicXmpp, SteamCm, steamError };
