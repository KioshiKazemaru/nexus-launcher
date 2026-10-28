// Chat with Steam and Epic friends: message parsing, the Epic XMPP session
// (with a fake WebSocket) and the chat service (with a fake Steam Web API).
// Run via `npm test`.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const c = require('../src/chat.cjs');
const { ChatService, EpicXmpp } = require('../src/main/chat.cjs');

const ME = '76561198000000010',
  FRIEND = '76561198000000020';
const EPIC_ME = 'a'.repeat(32),
  EPIC_FRIEND = 'b'.repeat(32);

test('Steam messages: BBCode becomes text, my messages are told apart, ids convert', () => {
  assert.equal(c.steamText('hi [emoticon]steamhappy[/emoticon]'), 'hi :steamhappy:');
  assert.equal(c.steamText('[url=https://x.test]link[/url] [b]bold[/b]'), 'link (https://x.test) bold');
  assert.equal(c.steamText('a \\[b\\] c'), 'a [b] c');
  assert.equal(c.steamText('[best] [i]x[/i]'), '[best] x');
  assert.equal(c.steamEscape(' [b]not bold[/b] '), '\\[b]not bold\\[/b]');
  assert.equal(c.steamId32(FRIEND), '39734292');
  assert.equal(c.steamId64('39734292'), FRIEND);
  const msgs = c.parseSteamMessages(
    {
      response: {
        messages: [
          { accountid: c.steamId32(FRIEND), timestamp: 200, message: 'second' },
          { accountid: c.steamId32(ME), timestamp: 100, message: 'first' },
          { accountid: 1, timestamp: 0, message: 'broken' },
        ],
      },
    },
    ME
  );
  assert.deepEqual(
    msgs.map(m => [m.from, m.text, m.at]),
    [
      ['me', 'first', 100000],
      ['them', 'second', 200000],
    ]
  );
  assert.deepEqual(
    c.parseSteamSessions({
      response: {
        message_sessions: [{ accountid_friend: 39734292, last_message: 5, unread_message_count: 2 }],
      },
    }),
    [{ friendId: FRIEND, last: 5000, unread: 2 }]
  );
  assert.deepEqual(c.parseSteamMessages({}, ME), []);
});

test('conversation keys only accept real Steam/Epic ids', () => {
  const key = c.convKey('steam', ME, FRIEND);
  assert.deepEqual(c.parseConvKey(key), { provider: 'steam', accountId: ME, friendId: FRIEND });
  assert.ok(c.parseConvKey(c.convKey('epic', EPIC_ME, EPIC_FRIEND)));
  assert.equal(c.parseConvKey('steam|1|2'), null);
  assert.equal(c.parseConvKey(`epic|${EPIC_ME}|../x`), null);
  assert.equal(c.parseConvKey(`custom|${ME}|${FRIEND}`), null);
  assert.equal(c.cleanText('  a\r\nb\u0007 '), 'a\nb');
  assert.equal(c.cleanText('x'.repeat(5000)).length, c.MAX_TEXT);
});

test('XMPP stanzas: messages, presence, pings; text is escaped both ways', () => {
  const m = c.parseStanza(
    `<message from="${EPIC_FRIEND}@prod.ol.epicgames.com/V2:launcher:WIN::X" type="chat" id="1" xmlns="jabber:client"><body>a &lt;b&gt; &amp; &#1087;</body></message>`
  );
  assert.equal(m.name, 'message');
  assert.equal(c.bareId(m.from), EPIC_FRIEND);
  assert.equal(m.body, 'a <b> & п');
  const p = c.parseStanza(
    `<presence from="${EPIC_FRIEND}@prod.ol.epicgames.com/V2:Fortnite:WIN::Y"><status>{"Status":"Battle Royale","bIsPlaying":true}</status></presence>`
  );
  assert.deepEqual(c.epicPresence(p), { status: 'ingame', game: 'Battle Royale' });
  assert.deepEqual(c.epicPresence(c.parseStanza(`<presence from="x" type="unavailable"/>`)), {
    status: 'offline',
    game: '',
  });
  assert.deepEqual(
    c.epicPresence(c.parseStanza('<presence from="x"><show>away</show><status>{}</status></presence>')),
    {
      status: 'away',
      game: '',
    }
  );
  const ping = c.parseStanza(
    '<iq type="get" id="p1" from="prod.ol.epicgames.com"><ping xmlns="urn:xmpp:ping"/></iq>'
  );
  assert.equal(ping.ping, true);
  const out = c.xmpp.message(EPIC_FRIEND, '<script>&"', 'm1');
  assert.match(out, /<body>&lt;script&gt;&amp;&quot;<\/body>/);
  assert.match(out, new RegExp(`to="${EPIC_FRIEND}@prod\\.ol\\.epicgames\\.com"`));
});

test('history keeps one copy of a message seen twice and stays limited', () => {
  let h = [];
  h = c.addToHistory(h, { from: 'me', text: 'hi', at: 1000 });
  h = c.addToHistory(h, { from: 'me', text: 'hi', at: 3000 }); // sent here and polled back
  h = c.addToHistory(h, { from: 'them', text: 'hi', at: 2000 });
  assert.deepEqual(
    h.map(m => m.from),
    ['me', 'them']
  );
  let big = [];
  for (let i = 0; i < 20; i++) big = c.addToHistory(big, { from: 'them', text: 't' + i, at: i * 100000 }, 5);
  assert.deepEqual(
    big.map(m => m.text),
    ['t15', 't16', 't17', 't18', 't19']
  );
});

// A fake Epic XMPP server behind the WebSocket.
class FakeSocket {
  static last = null;
  constructor(url, protocol) {
    this.url = url;
    this.protocol = protocol;
    this.readyState = 1;
    this.sent = [];
    FakeSocket.last = this;
    setImmediate(() => this.onopen?.());
  }
  send(x) {
    this.sent.push(x);
    const reply = r => setImmediate(() => this.onmessage?.({ data: r }));
    if (x.startsWith('<open') && !this.authed)
      reply(
        '<stream:features xmlns:stream="http://etherx.jabber.org/streams"><mechanisms><mechanism>PLAIN</mechanism></mechanisms></stream:features>'
      );
    else if (x.startsWith('<auth')) {
      this.auth = Buffer.from(x.replace(/<[^>]+>/g, ''), 'base64').toString();
      this.authed = this.auth.endsWith('\0good-token');
      reply(
        this.authed
          ? '<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>'
          : '<failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><not-authorized/></failure>'
      );
    } else if (x.startsWith('<open'))
      reply('<stream:features><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/></stream:features>');
    else if (x.includes('<bind')) reply('<iq type="result" id="bind1"><bind><jid>me</jid></bind></iq>');
  }
  close() {
    this.readyState = 3;
    setImmediate(() => this.onclose?.({ code: 1000 }));
  }
  push(x) {
    this.onmessage({ data: x });
  }
}
const until = async (fn, ms = 2000) => {
  for (let t = 0; !fn(); t += 5) {
    if (t > ms) throw Error('timeout');
    await new Promise(r => setTimeout(r, 5));
  }
};

test('Epic chat: signs in with the account token, goes online, receives and sends messages', async () => {
  const x = new EpicXmpp({
    accountId: EPIC_ME,
    getToken: async () => 'good-token',
    WebSocketImpl: FakeSocket,
  });
  const got = [],
    presence = [];
  x.on('message', m => got.push(m));
  x.on('presence', p => presence.push(p));
  x.start();
  await until(() => x.state === 'online');
  const ws = FakeSocket.last;
  assert.equal(ws.url, 'wss://xmpp-service-prod.ol.epicgames.com');
  assert.equal(ws.protocol, 'xmpp');
  assert.equal(ws.auth, `\0${EPIC_ME}\0good-token`);
  assert.ok(
    ws.sent.some(s => s.startsWith('<presence')),
    'initial presence'
  );
  ws.push(`<message from="${EPIC_FRIEND}@prod.ol.epicgames.com/r" type="chat"><body>привет</body></message>`);
  ws.push(
    '<message from="xmpp-admin@prod.ol.epicgames.com" type="normal"><body>{"type":"party"}</body></message>'
  );
  ws.push(
    `<presence from="${EPIC_FRIEND}@prod.ol.epicgames.com/r"><status>{"Status":"Rocket League","bIsPlaying":true}</status></presence>`
  );
  ws.push('<iq type="get" id="srv1" from="prod.ol.epicgames.com"><ping xmlns="urn:xmpp:ping"/></iq>');
  assert.deepEqual(
    got.map(m => [m.friendId, m.text]),
    [[EPIC_FRIEND, 'привет']]
  );
  assert.deepEqual(presence, [{ friendId: EPIC_FRIEND, status: 'ingame', game: 'Rocket League' }]);
  assert.ok(
    ws.sent.some(s => /<iq[^>]*type="result"[^>]*id="srv1"/.test(s)),
    'answers the server ping'
  );
  x.send(EPIC_FRIEND, 'как дела?');
  assert.match(ws.sent.at(-1), /<message[^>]*type="chat"[^>]*><body>как дела\?<\/body><\/message>/);
  x.stop();
  assert.equal(x.state, 'offline');
  assert.throws(() => x.send(EPIC_FRIEND, 'x'), /подключается/);
});

test('Epic chat: a rejected token stops with a clear message instead of retrying', async () => {
  const x = new EpicXmpp({ accountId: EPIC_ME, getToken: async () => 'bad', WebSocketImpl: FakeSocket });
  const states = [];
  x.on('state', s => states.push(s));
  x.start();
  await until(() => states.some(s => s.state === 'error'));
  assert.match(states.find(s => s.state === 'error').error, /войдите в аккаунт Epic заново/);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(x.stopped, true);
  clearTimeout(x.reconnectTimer);
});

// A fake steam-user: records the logon and the sent messages.
const EventEmitter = require('node:events');
class FakeSteamUser extends EventEmitter {
  static EConnectionProtocol = { WebSocket: 2 };
  static last = null;
  static fail = null; // EResult for the next send
  constructor(options) {
    super();
    this.options = options;
    this.sent = [];
    this.acked = [];
    FakeSteamUser.last = this;
    const chat = new EventEmitter();
    chat.sendFriendMessage = async (id, text) => {
      if (FakeSteamUser.fail) throw Object.assign(Error('Fail'), { eresult: FakeSteamUser.fail });
      this.sent.push([String(id), text]);
      return { server_timestamp: new Date(1700000000000) };
    };
    chat.ackFriendMessage = id => this.acked.push(String(id));
    this.chat = chat;
  }
  logOn(details) {
    this.details = details;
    setImmediate(() =>
      details.webLogonToken === 'web-token'
        ? this.emit('loggedOn', {})
        : this.emit('error', Object.assign(Error('InvalidPassword'), { eresult: 5 }))
    );
  }
  logOff() {
    this.loggedOff = true;
  }
}

function steamChat({ webToken = 'web-token', loggedIn = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-chat-'));
  const events = [],
    toasts = [],
    requests = [],
    sessionRequests = [];
  let sessions = [];
  let recent = [];
  let community = loggedIn;
  const json = (body, status = 200) => ({
    ok: status === 200,
    status,
    headers: { get: () => null },
    json: async () => body,
  });
  const ctx = {
    log: { info() {}, warn() {}, debug() {} },
    storage: {
      file: n => path.join(dir, n),
      encryptionAvailable: () => true,
      // Stand-in for Windows' safeStorage: reversible, but not plain text.
      safeStorage: {
        encryptString: t => Buffer.from(Buffer.from(t).map(b => b ^ 0x5a)),
        decryptString: b => Buffer.from(b.map(x => x ^ 0x5a)).toString(),
      },
    },
    accounts: {
      connected: p => (p === 'steam' ? [{ key: 'steam:0', id: ME, name: 'Me' }] : []),
      session: () => ({
        fetch: async url => {
          sessionRequests.push(url);
          // An expired community login is renewed through login.steampowered.com.
          if (url.startsWith('https://login.steampowered.com/jwt/refresh')) {
            community = true;
            return json({});
          }
          return json(
            community
              ? { logged_in: true, steamid: ME, account_name: 'me_login', token: webToken }
              : { logged_in: false }
          );
        },
      }),
    },
    social: { broadcast: e => events.push(e), anyOpen: () => false, chatFocused: () => false },
    toast: m => toasts.push(m),
    publicFetch: async (url, o = {}) => {
      requests.push({ url, o });
      if (url.includes('GetActiveMessageSessions')) return json({ response: { message_sessions: sessions } });
      if (url.includes('GetRecentMessages')) return json({ response: { messages: recent } });
      return json({}, 404);
    },
  };
  FakeSteamUser.fail = null;
  const chat = new ChatService(ctx, { SteamUserImpl: FakeSteamUser });
  chat.steamToken = async () => 'tok';
  return {
    chat,
    events,
    toasts,
    requests,
    sessionRequests,
    dir,
    set: o => {
      sessions = o.sessions ?? sessions;
      recent = o.recent ?? recent;
    },
  };
}

test('Steam chat: new messages are found by polling; old ones are history, not news', async () => {
  const t = steamChat();
  const f32 = Number(c.steamId32(FRIEND));
  t.set({ sessions: [{ accountid_friend: f32, last_message: 100, unread_message_count: 1 }] });
  await t.chat.pollSteam(); // first look: baseline + Steam's unread count
  assert.equal(t.toasts.length, 0);
  const key = c.convKey('steam', ME, FRIEND);
  assert.deepEqual(t.chat.unreadMap(), { [key]: 1 });
  t.set({
    sessions: [{ accountid_friend: f32, last_message: 200, unread_message_count: 2 }],
    recent: [
      { accountid: f32, timestamp: 100, message: 'old' },
      { accountid: f32, timestamp: 200, message: 'new one' },
    ],
  });
  await t.chat.pollSteam();
  const recentCall = t.requests.find(r => r.url.includes('GetRecentMessages'));
  assert.match(recentCall.url, /rtime32_start_time=100/);
  assert.match(recentCall.url, /access_token=tok/);
  const msgs = t.events.filter(e => e.type === 'message');
  assert.deepEqual(
    msgs.map(e => [e.conv, e.message.from, e.message.text]),
    [[key, 'them', 'new one']]
  );
  assert.deepEqual(t.chat.unreadMap(), { [key]: 2 });
  assert.match(t.toasts[0], /new one/);
  // Nothing new: nothing fetched again.
  const before = t.requests.length;
  await t.chat.pollSteam();
  assert.equal(t.requests.length, before + 1);
  // Opening the conversation clears the unread mark and acks it in Steam.
  await t.chat.steam({ key: 'steam:0', id: ME }).connect();
  t.chat.setViewing([key]);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(t.chat.unreadMap(), {});
  assert.deepEqual(FakeSteamUser.last.acked, [FRIEND]);
});

test('Steam chat: sends through the chat servers with the web chat token; live messages arrive', async () => {
  const t = steamChat({ loggedIn: false });
  const key = c.convKey('steam', ME, FRIEND);
  const msg = await t.chat.send(key, '  привет [b]  ');
  assert.deepEqual(msg, { from: 'me', text: 'привет [b]', at: 1700000000000 });
  const u = FakeSteamUser.last;
  // Signed in like steamcommunity.com/chat; steam-user writes nothing to disk.
  assert.deepEqual(u.details, { accountName: 'me_login', webLogonToken: 'web-token', steamID: ME });
  assert.equal(u.options.dataDirectory, null);
  assert.equal(u.options.protocol, 2);
  assert.ok(
    t.sessionRequests.some(x => x.startsWith('https://login.steampowered.com/jwt/refresh')),
    'renews the community login'
  );
  // steam-user escapes the brackets itself: the plain text is passed.
  assert.deepEqual(u.sent, [[FRIEND, 'привет [b]']]);
  assert.deepEqual(t.events.filter(e => e.type === 'message').at(-1), {
    type: 'message',
    conv: key,
    message: msg,
  });
  assert.deepEqual(t.chat.history[key], [msg]);
  // One connection for the next messages.
  await t.chat.send(key, 'ещё');
  assert.equal(FakeSteamUser.last, u);
  // A live message from the friend, and an echo of one written in Steam itself.
  u.chat.emit('friendMessage', {
    steamid_friend: FRIEND,
    message: 'го [b]в дотку[/b]',
    server_timestamp: new Date(1700000100000),
  });
  u.chat.emit('friendMessageEcho', {
    steamid_friend: FRIEND,
    message: 'щас',
    server_timestamp: new Date(1700000200000),
  });
  assert.deepEqual(
    t.chat.history[key].map(m => [m.from, m.text]),
    [
      ['me', 'привет [b]'],
      ['me', 'ещё'],
      ['them', 'го в дотку'],
      ['me', 'щас'],
    ]
  );
  assert.deepEqual(t.chat.unreadMap(), { [key]: 1 });
  // Errors are explained.
  FakeSteamUser.fail = 84;
  await assert.rejects(t.chat.send(key, 'again'), /слишком много сообщений/);
  FakeSteamUser.fail = 15;
  await assert.rejects(t.chat.send(key, 'again'), /вы не друзья/);
  await assert.rejects(t.chat.send(key, '   '), /Пустое/);
  await assert.rejects(t.chat.send('steam|1|2', 'x'), /Некорректный/);
  // The history is written to disk encrypted, and read back after a restart.
  t.chat.file.flushSync();
  const raw = fs.readFileSync(path.join(t.dir, 'chat-history.json'), 'utf8');
  assert.doesNotMatch(raw, /привет/);
  assert.equal(typeof JSON.parse(raw).encrypted, 'string');
  const again = new ChatService(t.chat.ctx, { SteamUserImpl: FakeSteamUser });
  assert.equal(again.history[key][0].text, 'привет [b]');
  t.chat.stop();
  assert.equal(u.loggedOff, true);
});

test('Steam chat: a rejected sign-in is explained; Epic friends cannot be written to', async () => {
  const t = steamChat({ webToken: 'stale' });
  const key = c.convKey('steam', ME, FRIEND);
  await assert.rejects(t.chat.send(key, 'x'), /войдите в Steam заново/);
  assert.equal(t.chat.history[key], undefined);
  const epicKey = c.convKey('epic', EPIC_ME, EPIC_FRIEND);
  await assert.rejects(t.chat.send(epicKey, 'x'), /не даёт писать друзьям/);
  const r = await t.chat.messages(epicKey);
  assert.equal(r.readonly, true);
  assert.match(r.warning, /Epic Games Launcher или в игре/);
});

test('chat history: an old plain-text file is encrypted; without encryption nothing is kept on disk', async () => {
  const t = steamChat();
  const file = path.join(t.dir, 'chat-history.json');
  const key = c.convKey('steam', ME, FRIEND);
  fs.writeFileSync(file, JSON.stringify({ [key]: [{ from: 'them', text: 'секрет', at: 1 }] }));
  const chat = new ChatService(t.chat.ctx, { SteamUserImpl: FakeSteamUser });
  assert.equal(chat.history[key][0].text, 'секрет');
  await new Promise(r => setImmediate(r));
  chat.file.flushSync();
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /секрет/);
  // No Windows encryption: the old file is emptied, new messages stay in memory only.
  fs.writeFileSync(file, JSON.stringify({ [key]: [{ from: 'them', text: 'секрет', at: 1 }] }));
  const plain = new ChatService(
    { ...t.chat.ctx, storage: { file: n => path.join(t.dir, n) } },
    { SteamUserImpl: FakeSteamUser }
  );
  await new Promise(r => setImmediate(r));
  plain.store(key, [{ from: 'me', text: 'новое', at: 2 }]);
  plain.file.flushSync();
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
});
