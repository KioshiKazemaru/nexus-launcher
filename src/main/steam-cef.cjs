'use strict';
// Sending Steam messages through the running Steam client, without its windows.
//
// Steam has no Web API for sending, and a second sign-in to Steam's chat
// servers shows the account offline in a running client (see chat.cjs). The
// client's own UI runs in Chromium (steamwebhelper); with the file
// ".cef-enable-remote-debugging" in the Steam folder it opens the DevTools
// protocol on 127.0.0.1:8080. Nexus calls there what the client's "Send"
// button calls: g_FriendsUIApp.ChatStore.GetFriendChat(id).SendChatMessageInternal.
// The port is local only, but any program on this PC can use it while it is on.

const fs = require('node:fs');
const path = require('node:path');

const PORT = 8080;
const FLAG = '.cef-enable-remote-debugging';
const STEAM_ID_BASE = 76561197960265728n;

function flagPath(steamDir) {
  return path.join(steamDir, FLAG);
}
function enabled(steamDir) {
  try {
    return !!steamDir && fs.existsSync(flagPath(steamDir));
  } catch {
    return false;
  }
}
function enable(steamDir) {
  if (!steamDir) throw Error('Папка Steam не найдена');
  fs.writeFileSync(flagPath(steamDir), '');
}

// The Steam client's shared JS context, if the port is open.
async function target(fetchImpl = fetch) {
  const r = await fetchImpl(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(1500) }).catch(
    () => null
  );
  if (!r?.ok) return null;
  const list = await r.json().catch(() => []);
  const t = (Array.isArray(list) ? list : []).find(x => x?.title === 'SharedJSContext');
  const url = String(t?.webSocketDebuggerUrl || '');
  // Only the local Steam client.
  if (!/^ws:\/\/(127\.0\.0\.1|localhost):8080\/devtools\/page\/[\w-]+$/.test(url)) return null;
  if (!/^https:\/\/steamloopback\.host\//.test(String(t.url || ''))) return null;
  return url;
}

function evaluate(url, expression, { WebSocketImpl = globalThis.WebSocket, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    const timer = setTimeout(() => (ws.close(), reject(Error('клиент Steam не ответил'))), timeout);
    ws.onerror = () => (clearTimeout(timer), reject(Error('клиент Steam не ответил')));
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );
    ws.onmessage = m => {
      let r;
      try {
        r = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (r.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (r.result?.exceptionDetails)
        reject(
          Error(
            'клиент Steam: ' + (r.result.exceptionDetails.exception?.description || 'ошибка').split('\n')[0]
          )
        );
      else resolve(r.result?.result?.value);
    };
  });
}

// The expression run in the client. The text goes in as a JSON string; brackets
// are escaped, so Steam shows the text as typed and not as BBCode.
function sendExpression(accountId, text) {
  const body = JSON.stringify(String(text).replace(/\[/g, '\\['));
  return `(async () => {
  const app = window.g_FriendsUIApp;
  if (!app?.ChatStore?.GetFriendChat || !app.FriendStore?.self?.accountid) return { error: 'notready' };
  const chat = app.ChatStore.GetFriendChat(${Number(accountId)}, true);
  if (!chat?.SendChatMessageInternal) return { error: 'nochat' };
  const r = await chat.SendChatMessageInternal(${body});
  const last = chat.chat_messages?.[chat.chat_messages.length - 1];
  return { result: Number(r) || 0, at: Number(last?.rtTimestamp) || 0 };
})()`;
}

// → server time (ms) of the sent message; throws with a reason.
async function sendFriendMessage(friendId64, text, deps = {}) {
  const url = await target(deps.fetch);
  if (!url) throw Object.assign(Error('порт клиента Steam закрыт'), { code: 'NO_PORT' });
  const accountId = Number(BigInt(String(friendId64)) - STEAM_ID_BASE);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw Error('Друг не найден');
  const r = await evaluate(url, sendExpression(accountId, text), deps);
  if (r?.error === 'notready')
    throw Object.assign(Error('клиент Steam ещё входит в аккаунт'), { code: 'NOT_READY' });
  if (!r || r.error) throw Error('клиент Steam не открыл чат с другом');
  // The client's send error: 0 none, 1 generic, 2 not friends, 3 no permission in a group, 4 rate limit.
  if (r.result === 2)
    throw Object.assign(Error('Steam не разрешил отправку: вы не друзья или игрок ограничил сообщения'), {
      eresult: 15,
    });
  if (r.result === 4)
    throw Object.assign(Error('Steam: слишком много сообщений, подождите немного'), { eresult: 84 });
  if (r.result) throw Error(`клиент Steam не отправил сообщение (${r.result})`);
  return r.at ? r.at * 1000 : Date.now();
}

// ---- new messages, the moment the client has them ----
// The client calls the binding from its own message handlers: the friend's
// messages (OnReceivedNewMessage) and the user's (OnUserChatEcho: sent from
// Nexus or written in Steam). Installed once per client start; a Nexus that
// reconnects defines the binding again.
const BINDING = 'nexusSteamMsg';
const HOOK = `(() => {
  const store = window.g_FriendsUIApp?.ChatStore?.FriendChatStore;
  const self = window.g_FriendsUIApp?.FriendStore?.self?.accountid;
  if (!store?.GetFriendChat || !self) return 'notready';
  const friend = [...(window.g_FriendsUIApp.FriendStore.all_friends_accountids || [])][0];
  const chat = store.m_rgFriendChats?.[0] || (friend ? store.GetFriendChat(friend, true) : null);
  if (!chat) return 'notready';
  const P = Object.getPrototypeOf(chat);
  if (P.__nexusHooked) return 'ok';
  const tell = (c, from, text, at) => {
    try {
      if (typeof window.${BINDING} === 'function' && typeof text === 'string')
        window.${BINDING}(JSON.stringify({ self: c.self?.accountid || self, friend: c.accountid_partner, from, text, at: Number(at) || 0 }));
    } catch {}
  };
  const recv = P.OnReceivedNewMessage;
  P.OnReceivedNewMessage = function (m, ...rest) {
    const r = recv.call(this, m, ...rest);
    if (m && !m.BIsLocalEcho?.() && m.unAccountID != this.self?.accountid) tell(this, 'them', m.strMessage, m.rtTimestamp);
    return r;
  };
  const echo = P.OnUserChatEcho;
  P.OnUserChatEcho = function (at, ordinal, text, ...rest) {
    const r = echo.call(this, at, ordinal, text, ...rest);
    tell(this, 'me', text, at);
    return r;
  };
  P.__nexusHooked = true;
  return 'ok';
})()`;

const STEAM_ID_BASE_N = STEAM_ID_BASE;
function parseEvent(payload) {
  let e;
  try {
    e = JSON.parse(String(payload));
  } catch {
    return null;
  }
  const self = Number(e?.self),
    friend = Number(e?.friend);
  if (!Number.isSafeInteger(self) || self <= 0 || !Number.isSafeInteger(friend) || friend <= 0) return null;
  if (typeof e.text !== 'string' || !e.text || e.text.length > 10000) return null;
  return {
    accountId: String(STEAM_ID_BASE_N + BigInt(self)),
    friendId: String(STEAM_ID_BASE_N + BigInt(friend)),
    from: e.from === 'me' ? 'me' : 'them',
    text: e.text,
    at: Number(e.at) > 0 ? Number(e.at) * 1000 : Date.now(),
  };
}

// One DevTools connection that stays open while the client runs.
class SteamClientEvents {
  constructor({ onMessage, log, fetch: fetchImpl, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.onMessage = onMessage;
    this.log = log;
    this.fetch = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.connecting = false;
  }
  get connected() {
    return !!this.ws;
  }
  // Called often (every poll): connects when the port is there and nothing is open.
  async ensure() {
    if (this.ws || this.connecting) return this.connected;
    this.connecting = true;
    try {
      const url = await target(this.fetch);
      if (!url) return false;
      await this.open(url);
      return true;
    } catch (e) {
      this.log?.debug?.('chat', `steam client events: ${e.message}`);
      this.close();
      return false;
    } finally {
      this.connecting = false;
    }
  }
  open(url) {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(url);
      let id = 0;
      const pending = new Map();
      const call = (method, params) =>
        new Promise((res, rej) => {
          const n = ++id;
          pending.set(n, { res, rej });
          ws.send(JSON.stringify({ id: n, method, params }));
        });
      const timer = setTimeout(() => (ws.close(), reject(Error('клиент Steam не ответил'))), 15000);
      ws.onerror = () => (clearTimeout(timer), reject(Error('клиент Steam не ответил')));
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
      };
      ws.onmessage = m => {
        let r;
        try {
          r = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (r.id && pending.has(r.id)) {
          const x = pending.get(r.id);
          pending.delete(r.id);
          if (r.error) x.rej(Error(r.error.message || 'ошибка'));
          else x.res(r.result);
        } else if (r.method === 'Runtime.bindingCalled' && r.params?.name === BINDING) {
          const e = parseEvent(r.params.payload);
          if (e) this.onMessage?.(e);
        }
      };
      ws.onopen = async () => {
        try {
          await call('Runtime.addBinding', { name: BINDING });
          const r = await call('Runtime.evaluate', { expression: HOOK, returnByValue: true });
          if (r?.result?.value !== 'ok') throw Error('клиент Steam ещё входит в аккаунт');
          clearTimeout(timer);
          this.ws = ws;
          this.log?.info('chat', 'steam: new messages come from the Steam client');
          resolve();
        } catch (e) {
          clearTimeout(timer);
          ws.close();
          reject(e);
        }
      };
    });
  }
  close() {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
  }
}

module.exports = {
  enabled,
  enable,
  target,
  evaluate,
  sendExpression,
  sendFriendMessage,
  parseEvent,
  SteamClientEvents,
  HOOK,
  BINDING,
  FLAG,
  PORT,
};
