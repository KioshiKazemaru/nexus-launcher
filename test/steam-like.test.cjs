// Like the Steam client: status and friends' activity, launch options, news,
// Workshop, profile statistics, FPS counter, tray, overlay and "Недавние".
// Run via `npm test` (the Electron stub is preloaded).
const test = require('node:test'),
  assert = require('node:assert/strict'),
  EventEmitter = require('node:events'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const electron = require('electron');
const p = require('../src/presence.cjs');
const lo = require('../src/launch-options.cjs');
const news = require('../src/news.cjs');
const ws = require('../src/workshop.cjs');
const pr = require('../src/profile.cjs');
const fps = require('../src/fps.cjs');
const { PresenceService } = require('../src/main/presence.cjs');
const { RunningGames } = require('../src/main/running.cjs');
const { NexusTray } = require('../src/main/tray.cjs');
const { Overlay } = require('../src/main/overlay.cjs');
const { WorkshopService } = require('../src/main/workshop.cjs');
const { Storage } = require('../src/main/storage.cjs');

const STEAM_ME = '76561198000000001',
  FRIEND = '76561198000000002';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-steamlike-'));

function context(extra = {}) {
  const storage = new Storage(tmp(), electron.safeStorage);
  const ctx = {
    storage,
    settings: storage.loadSettings(),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    gameEvents: new EventEmitter(),
    hub: { publish() {} },
    library: { games: [], achievements: async () => ({ available: false }) },
    accounts: { connected: () => [] },
    social: { broadcast: ev => (ctx.events ||= []).push(ev), openChat() {}, chatFocused: () => false },
    ...extra,
  };
  return ctx;
}

test('Steam persona: status, game name, non-Steam games; changes become activity', () => {
  assert.deepEqual(
    p.steamPersona({ persona_state: 1, gameid: '730', player_name: 'Друг' }, 'Counter-Strike 2'),
    {
      status: 'ingame',
      game: 'Counter-Strike 2',
      appId: 730,
      name: 'Друг',
      avatar: '',
    }
  );
  assert.equal(p.steamPersona({ persona_state: 3 }).status, 'away');
  assert.equal(
    p.steamPersona({ persona_state: 0, gameid: '730' }).status,
    'offline',
    'offline friends play nothing'
  );
  // A non-Steam game: a 64-bit game id and the name the friend's client sent.
  const shortcut = p.steamPersona({
    persona_state: 1,
    gameid: '15190414816125648896',
    game_name: 'Control · Nexus',
  });
  assert.deepEqual([shortcut.status, shortcut.game, shortcut.appId], ['ingame', 'Control · Nexus', 0]);
  const off = { status: 'offline', game: '' },
    on = { status: 'online', game: '' },
    cs = { status: 'ingame', game: 'CS2', appId: 730 };
  assert.deepEqual(p.changes(undefined, on), [], 'the first status is not news');
  assert.deepEqual(p.changes(off, on), [{ type: 'online' }]);
  assert.deepEqual(p.changes(on, cs), [{ type: 'game', game: 'CS2', appId: 730 }]);
  assert.deepEqual(p.changes(cs, on), [{ type: 'stop', game: 'CS2', appId: 730 }]);
  assert.deepEqual(
    p.changes(off, cs).map(x => x.type),
    ['online', 'game']
  );
  assert.throws(() => p.checkStatus('busy'), /Неизвестный статус/);
});

test('activity feed: newest first, repeats within a minute are one entry, a week at most', () => {
  const now = Date.now();
  let list = p.addActivity(
    [],
    { at: now - 8 * 24 * 3600 * 1000, friendId: 'x', type: 'online', game: '' },
    now
  );
  list = p.addActivity(list, { at: now - 1000, friendId: 'a', type: 'game', game: 'CS2' }, now);
  assert.equal(list.length, 1, 'old entries are dropped');
  const again = p.addActivity(list, { at: now, friendId: 'a', type: 'game', game: 'CS2' }, now);
  assert.equal(again.length, 1);
  list = p.addActivity(list, { at: now, friendId: 'b', type: 'online', game: '' }, now);
  assert.deepEqual(
    list.map(x => x.friendId),
    ['b', 'a']
  );
});

test('presence service: my status, "… · Nexus" for non-Steam games, friends\' events and notifications', async () => {
  const shown = [];
  const Real = electron.Notification;
  electron.Notification = class extends EventEmitter {
    static isSupported() {
      return true;
    }
    constructor(o) {
      super();
      this.o = o;
    }
    show() {
      shown.push(this.o);
    }
  };
  try {
    const ctx = context();
    ctx.friends = { cache: { steam: [{ friends: [{ id: FRIEND, name: 'Друг' }] }] } };
    const service = new PresenceService(ctx);
    ctx.presence = service;
    service.start();
    const client = new EventEmitter();
    client.persona = [];
    client.played = [];
    client.myFriends = { [FRIEND]: 3 };
    client.users = {};
    client.setPersona = s => client.persona.push(s);
    client.gamesPlayed = g => client.played.push(g);
    client.getProductInfo = async () => ({
      apps: { 730: { appinfo: { common: { name: 'Counter-Strike 2' } } } },
    });
    const account = { id: STEAM_ME, key: 'steam:0' };
    service.attach(account, client);
    await new Promise(r => setImmediate(r));
    assert.deepEqual(client.persona, [1], 'online by default (no Steam client running)');
    const sid = id => ({ getSteamID64: () => id });
    // The first wave after logon is the current state.
    await service.steamUser(account, client, sid(FRIEND), { persona_state: 0, player_name: 'Друг' });
    service.ready.add(STEAM_ME);
    await service.steamUser(account, client, sid(FRIEND), {
      persona_state: 1,
      gameid: '730',
      player_name: 'Друг',
    });
    assert.deepEqual(
      service.feed().map(x => [x.type, x.game]),
      [
        ['game', 'Counter-Strike 2'],
        ['online', ''],
      ]
    );
    assert.equal(shown.length, 1, '"играет в" is notified; "в сети" is off by default');
    assert.match(shown[0].body, /Играет в Counter-Strike 2/);
    assert.deepEqual(service.steamStatus(FRIEND), { status: 'ingame', game: 'Counter-Strike 2' });
    // Steam sends personas without a status (persona_state null) right after logon:
    // that is "unknown", not "offline" — nothing changes, nothing is announced.
    await service.steamUser(account, client, sid(FRIEND), { persona_state: null, player_name: 'Друг' });
    assert.deepEqual(service.steamStatus(FRIEND), { status: 'ingame', game: 'Counter-Strike 2' });
    assert.equal(shown.length, 1);
    const OTHER = '76561198000000003';
    client.myFriends[OTHER] = 3;
    await service.steamUser(account, client, sid(OTHER), { persona_state: null, player_name: 'Новый' });
    assert.equal(service.steamStatus(OTHER), null, 'the status from the Web API stays');
    // Not a friend: ignored.
    await service.steamUser(account, client, sid('76561198000000099'), { persona_state: 1 });
    assert.equal(service.steamStatus('76561198000000099'), null);
    // An Epic game runs: Steam friends see it as a non-Steam game.
    ctx.gameEvents.emit('start', { id: 'epic:x', name: 'Control', provider: 'epic', since: Date.now() });
    assert.deepEqual(client.played.at(-1), ['Control · Nexus']);
    ctx.gameEvents.emit('stop', { id: 'epic:x', name: 'Control', provider: 'epic' });
    assert.deepEqual(client.played.at(-1), []);
    // A Steam game: Steam itself shows it; Nexus reports nothing.
    const before = client.played.length;
    ctx.gameEvents.emit('start', { id: 'steam:1', name: 'Dota 2', provider: 'steam', since: Date.now() });
    assert.equal(client.played.length, before);
    // Another session plays: nothing is reported over it.
    ctx.gameEvents.emit('stop', { id: 'steam:1' });
    client.emit('playingState', { blocked: true, playingApp: 570 });
    ctx.gameEvents.emit('start', { id: 'custom:y', name: 'Мод', provider: 'custom', since: Date.now() });
    assert.equal(client.played.length, before);
    // Status.
    await service.setStatus('invisible');
    await new Promise(r => setImmediate(r));
    assert.equal(client.persona.at(-1), 7);
    assert.equal(ctx.settings.myStatus, 'invisible');
    await assert.rejects(service.setStatus('nope'), /Неизвестный статус/);
    // "Не подключаться" never sets the account offline (that greys out the Steam client).
    const sent = client.persona.length;
    await service.setStatus('off');
    await new Promise(r => setImmediate(r));
    assert.equal(client.persona.length, sent);
    await service.setStatus('online');
    service.stop();
  } finally {
    electron.Notification = Real;
  }
});

test('Steam status: with the Steam client open, "В сети" is left to Steam; other statuses are set and undone', async () => {
  const ctx = context();
  ctx.actions = { processRunning: async name => name === 'steam.exe' };
  const service = new PresenceService(ctx);
  ctx.presence = service;
  const client = new EventEmitter();
  client.persona = [];
  client.myFriends = {};
  client.setPersona = s => client.persona.push(s);
  client.gamesPlayed = () => {};
  const tick = () => new Promise(r => setImmediate(r));
  try {
    service.attach({ id: STEAM_ME, key: 'steam:0' }, client);
    await tick();
    assert.deepEqual(client.persona, [], 'the Steam client owns "В сети"');
    await service.setStatus('away');
    await tick();
    assert.deepEqual(client.persona, [3]);
    await service.setStatus('online');
    await tick();
    assert.deepEqual(client.persona, [3, 1], '"Нет на месте" is undone');
    await service.setStatus('online');
    await tick();
    assert.deepEqual(client.persona, [3, 1], 'and then left to Steam again');
  } finally {
    service.stop();
  }
});

test('new achievements while a Steam game runs are announced once', async () => {
  const ctx = context();
  let unlocked = ['A'];
  ctx.library = {
    games: [{ id: 'steam:10', name: 'Игра', offers: [{ provider: 'steam', appId: '10' }] }],
    achievements: async (_id, opts) => {
      assert.equal(opts.force, true, 'the cache is skipped while playing');
      return {
        available: true,
        list: ['A', 'B', 'C'].map(n => ({ name: n, description: '', unlocked: unlocked.includes(n) })),
      };
    },
  };
  const events = [];
  ctx.overlay = { event: e => events.push(e) };
  const service = new PresenceService(ctx);
  const w = { known: null };
  await service.checkAchievements('steam:10', w);
  assert.equal(events.length, 0, 'what was unlocked before the game is not news');
  unlocked = ['A', 'B'];
  await service.checkAchievements('steam:10', w);
  await service.checkAchievements('steam:10', w);
  assert.deepEqual(
    events.map(e => [e.kind, e.name, e.game]),
    [['achievement', 'B', 'Игра']]
  );
});

test('launch options: cleaned, split with quotes, Steam link', () => {
  assert.equal(lo.cleanOptions('  -novid\n-high\t'), '-novid -high');
  assert.throws(() => lo.cleanOptions('x'.repeat(501)), /длиннее/);
  assert.deepEqual(lo.splitArgs('-novid -w 1920 "C:\\My Mods" +exec "a b"'), [
    '-novid',
    '-w',
    '1920',
    'C:\\My Mods',
    '+exec',
    'a b',
  ]);
  assert.deepEqual(lo.splitArgs('  '), []);
  assert.deepEqual(lo.splitArgs('""'), ['']);
  assert.equal(lo.steamRunUri('570', '-novid -console'), 'steam://run/570//-novid%20-console/');
  assert.equal(lo.optionsFor({ launchOptions: { a: '-x' } }, 'a'), '-x');
  assert.equal(lo.optionsFor({}, 'a'), '');
});

test('news: plain text, the first picture, patch notes, merged feeds', () => {
  const json = {
    appnews: {
      newsitems: [
        {
          gid: '1',
          title: 'Patch 1.2',
          url: 'https://steamstore-a.akamaihd.net/news/externalpost/x/1',
          feedlabel: 'Community Announcements',
          date: 1700000000,
          contents:
            '{STEAM_CLAN_IMAGE}/123/abc.png [h1]Изменения[/h1][list][*]Быстрее[*]Меньше ошибок[/list]<script>x</script> &amp; ещё',
          tags: ['patchnotes'],
        },
        {
          gid: '2',
          title: 'Скидка',
          url: 'javascript:alert(1)',
          date: 1700001000,
          contents: '[img]https://evil.test/a.png[/img]Текст',
        },
        { title: 'без даты' },
      ],
    },
  };
  const items = news.parseNews(json, 570);
  assert.equal(items.length, 2);
  assert.equal(items[0].image, news.CLAN_IMAGES + '123/abc.png');
  assert.equal(items[0].patch, true);
  assert.match(items[0].text, /Изменения\n+• Быстрее\n• Меньше ошибок/);
  assert.doesNotMatch(items[0].text, /<|\[/);
  assert.match(items[0].text, /& ещё/);
  assert.equal(items[1].url, '', 'only https links');
  assert.equal(items[1].image, '', 'pictures only from Steam');
  assert.equal(news.plainText('слово '.repeat(200), 50).length <= 51, true);
  assert.deepEqual(
    news.mergeFeeds([items, [items[1]]]).map(x => x.id),
    ['2', '1']
  );
  assert.throws(() => news.parseNews({}), /не отдал/);
});

test('Workshop: installed items of a Steam game with titles and pictures', async () => {
  const lib = tmp();
  const game = path.join(lib, 'steamapps', 'common', 'Game');
  fs.mkdirSync(game, { recursive: true });
  fs.mkdirSync(path.join(lib, 'steamapps', 'workshop'), { recursive: true });
  fs.writeFileSync(
    path.join(lib, 'steamapps', 'workshop', 'appworkshop_570.acf'),
    `"AppWorkshop"\n{\n\t"appid"\t\t"570"\n\t"SizeOnDisk"\t\t"3000"\n\t"NeedsUpdate"\t\t"0"\n\t"WorkshopItemsInstalled"\n\t{\n\t\t"111"\n\t\t{\n\t\t\t"size"\t\t"1000"\n\t\t\t"timeupdated"\t\t"1600000000"\n\t\t}\n\t\t"222"\n\t\t{\n\t\t\t"size"\t\t"2000"\n\t\t\t"timeupdated"\t\t"1700000000"\n\t\t}\n\t\t"bad"\n\t\t{\n\t\t}\n\t}\n}\n`
  );
  const bodies = [];
  const ctx = context({
    library: {
      games: [
        {
          id: 'steam:570',
          name: 'Dota 2',
          offers: [{ provider: 'steam', appId: '570', installed: true, installDir: game }],
        },
        { id: 'epic:a', name: 'Epic', offers: [{ provider: 'epic', appId: 'a', installed: true }] },
      ],
    },
    publicFetch: async (url, o) => {
      bodies.push(String(o.body));
      return {
        ok: true,
        json: async () => ({
          response: {
            publishedfiledetails: [
              {
                publishedfileid: '222',
                result: 1,
                title: 'Новый мод',
                preview_url: 'https://images.steamusercontent.com/ugc/1/x/',
                subscriptions: 5,
                tags: [{ tag: 'Map' }],
              },
              { publishedfileid: '111', result: 1, title: 'Старый', preview_url: 'https://evil.test/x.png' },
            ],
          },
        }),
      };
    },
  });
  const w = new WorkshopService(ctx);
  const r = await w.items('steam:570');
  assert.equal(r.total, 2);
  assert.equal(r.size, 3000);
  assert.deepEqual(
    r.items.map(x => [x.id, x.title, !!x.preview]),
    [
      ['222', 'Новый мод', true],
      ['111', 'Старый', false],
    ]
  );
  assert.match(bodies[0], /itemcount=2/);
  await w.items('steam:570');
  assert.equal(bodies.length, 1, 'item details are cached');
  const epic = await w.items('epic:a');
  assert.equal(epic.available, false);
  assert.match(epic.reason, /нет общей Мастерской/);
});

test('profile: library statistics, latest achievements, Steam badges', () => {
  const now = Date.now();
  const games = [
    {
      id: 'a',
      name: 'A',
      playtime: 600,
      lastPlayed: Math.floor(now / 1000) - 3600,
      offers: [{ provider: 'steam', owned: true, playtime: 600 }],
    },
    {
      id: 'b',
      name: 'B',
      playtime: 60,
      offers: [{ provider: 'epic', owned: true, installed: true, playtime: 60 }],
    },
    { id: 'c', name: 'C', playtime: 0, offers: [{ provider: 'steam', owned: true }] },
  ];
  const s = pr.libraryStats(games, now);
  assert.equal(s.games, 3);
  assert.equal(s.installed, 1);
  assert.equal(s.minutes, 660);
  assert.equal(s.neverPlayed, 1);
  assert.equal(s.playedThisMonth, 1);
  assert.deepEqual(
    s.top.map(g => g.id),
    ['a', 'b']
  );
  assert.deepEqual(s.byProvider.steam, { games: 2, family: 0, minutes: 600 });
  const ach = pr.latestAchievements(
    [
      [
        '1:10',
        {
          value: {
            available: true,
            list: [
              { name: 'X', unlocked: true, unlockedAt: 100 },
              { name: 'Y', unlocked: false },
            ],
          },
        },
      ],
      ['1:20', { value: { available: true, list: [{ name: 'Z', unlocked: true, unlockedAt: 200 }] } }],
    ],
    appId => ({ 10: 'Десять', 20: 'Двадцать' })[appId]
  );
  assert.deepEqual(
    ach.map(a => [a.name, a.game]),
    [
      ['Z', 'Двадцать'],
      ['X', 'Десять'],
    ]
  );
  assert.deepEqual(pr.parseBadges({ response: { player_level: 12, player_xp: 1500, badges: [{}, {}] } }), {
    level: 12,
    xp: 1500,
    badges: 2,
    xpNeeded: 0,
    xpCurrent: 0,
  });
});

test('FPS: PresentMon columns of both versions, frames of the game only, frames per second', () => {
  const v1 = fps.columns(
    'Application,ProcessID,SwapChainAddress,Runtime,SyncInterval,PresentFlags,MsBetweenPresents'
  );
  assert.deepEqual(v1, { pid: 1, frame: 6 });
  const v2 = fps.columns(
    'Application,ProcessID,SwapChainAddress,PresentRuntime,CPUStartTime,FrameTime,CPUBusy'
  );
  assert.deepEqual(v2, { pid: 1, frame: 5 });
  assert.equal(fps.columns('a,b,c'), null);
  assert.deepEqual(fps.frameOf('game.exe,42,0x1,DXGI,100,16.6,1', v2), { pid: 42, ms: 16.6 });
  assert.equal(fps.frameOf('game.exe,x,0x1,DXGI,100,abc,1', v2), null);
  const m = new fps.FpsMeter(1000);
  const now = 10000;
  for (let i = 0; i < 60; i++) m.add(1000 / 60, now - 500 + i);
  assert.equal(m.fps(now), 60);
  assert.equal(m.fps(now + 5000), 0, 'no frames — no FPS');
  assert.ok(fps.presentMonCandidates({ ProgramFiles: 'C:\\PF' }).some(f => f.includes('AMD')));
});

test('"Недавние": every start counts, whoever started the game; start and stop are announced', async () => {
  const ctx = context();
  ctx.library.games = [
    {
      id: 'steam:1',
      name: 'Один',
      offers: [{ provider: 'steam', installed: true, installDir: path.join(os.tmpdir(), 'One') }],
    },
    {
      id: 'steam:2',
      name: 'Два',
      offers: [{ provider: 'steam', installed: true, installDir: path.join(os.tmpdir(), 'Two') }],
    },
  ];
  ctx.settings.recent = [{ id: 'steam:2', time: 1 }];
  const events = [];
  ctx.gameEvents.on('start', e => events.push(['start', e.id]));
  ctx.gameEvents.on('stop', e => events.push(['stop', e.id]));
  const running = new RunningGames(ctx);
  // A game started by Steam itself (not by Nexus).
  let procs = [{ pid: 7, path: path.join(os.tmpdir(), 'One', 'one.exe') }];
  running.listProcesses = async () => procs;
  await running.refresh();
  await running.refresh();
  assert.deepEqual(
    ctx.settings.recent.map(r => r.id),
    ['steam:1', 'steam:2'],
    'newest first, each game once'
  );
  procs = [];
  await running.refresh();
  assert.deepEqual(events, [
    ['start', 'steam:1'],
    ['stop', 'steam:1'],
  ]);
});

test('tray: recent installed games, status menu, playing game in the tooltip', async () => {
  const ctx = context();
  ctx.library.games = [
    { id: 'a', name: 'Установлена', offers: [{ provider: 'steam', installed: true }] },
    { id: 'b', name: 'Не установлена', offers: [{ provider: 'epic', owned: true }] },
  ];
  ctx.settings.recent = [
    { id: 'b', time: 2 },
    { id: 'a', time: 1 },
  ];
  const played = [];
  ctx.actions = { play: async x => played.push(x) };
  ctx.presence = {
    status: () => 'away',
    playing: { name: 'Установлена' },
    setStatus: async s => (ctx.status = s),
  };
  ctx.running = { isRunning: () => false };
  ctx.focusMain = () => {};
  ctx.showPage = page => (ctx.page = page);
  const tray = new NexusTray(ctx, { icon: 'x.ico' });
  tray.create();
  const items = tray.tray.menu.template;
  const recent = items.find(i => i.label === 'Недавние игры');
  assert.deepEqual(
    recent.submenu.map(i => i.label),
    ['Установлена'],
    'only installed games can be started from the tray'
  );
  recent.submenu[0].click();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(played, [{ id: 'a', provider: 'steam' }]);
  const status = items.find(i => /^Статус/.test(i.label));
  assert.equal(status.label, 'Статус: Нет на месте');
  status.submenu.find(i => i.label === 'Невидимка').click();
  assert.equal(ctx.status, 'invisible');
  assert.match(tray.tray.tooltip, /в игре: Установлена/);
  items.find(i => i.label === 'Активность друзей').click();
  assert.equal(ctx.page, 'activity');
  tray.hidden();
  assert.match(tray.tray.balloon.title, /в трее/);
});

test('overlay: the hotkey exists only while a game runs; notices reach the corner window', () => {
  const T = electron.__test;
  const ctx = context();
  let running = {};
  ctx.running = { snapshot: () => running, running: {} };
  const overlay = new Overlay(ctx);
  overlay.start();
  assert.equal(T.shortcuts.size, 0);
  running = { 'steam:1': { name: 'Игра', provider: 'steam', since: Date.now() } };
  ctx.gameEvents.emit('start', { id: 'steam:1' });
  assert.ok(T.shortcuts.has('Shift+Tab'));
  T.shortcuts.get('Shift+Tab')();
  const win = overlay.win('overlay');
  assert.ok(win?.isVisible(), 'the hotkey opens the overlay');
  assert.equal(win.webContents.sent.at(-1)[1].info.game.name, 'Игра');
  overlay.event({ kind: 'achievement', name: 'Первая кровь' });
  const hud = overlay.win('hud');
  assert.equal(hud.clickThrough, true, 'the corner window lets clicks through to the game');
  assert.deepEqual(
    [
      hud.webContents.sent.at(-1)[1].kind,
      hud.webContents.sent.at(-1)[1].type,
      hud.webContents.sent.at(-1)[1].name,
    ],
    ['notice', 'achievement', 'Первая кровь']
  );
  ctx.settings.overlayHotkey = 'Shift+F1';
  overlay.reconfigure();
  assert.ok(T.shortcuts.has('Shift+F1') && !T.shortcuts.has('Shift+Tab'));
  running = {};
  ctx.gameEvents.emit('stop', { id: 'steam:1' });
  assert.equal(T.shortcuts.size, 0, 'Shift+Tab is given back to other programs');
  assert.equal(win.isVisible(), false);
  overlay.stop();
});

test('Workshop helpers: installed items, request body, details from Steam hosts only', () => {
  const acf = `"AppWorkshop"
{
  "appid" "1145360"
  "SizeOnDisk" "4096"
  "NeedsUpdate" "1"
  "WorkshopItemsInstalled"
  {
    "42" { "size" "2048" "timeupdated" "1700000000" }
    "bad" { "size" "1" }
  }
}`;
  const w = ws.parseAppWorkshop(acf);
  assert.deepEqual(w.items, [{ id: '42', size: 2048, updated: 1700000000000 }]);
  assert.equal(w.size, 4096);
  assert.equal(w.needsUpdate, true);
  assert.deepEqual(ws.parseAppWorkshop('').items, []);
  assert.equal(
    String(ws.detailsBody(['1', '2'])),
    'itemcount=2&publishedfileids%5B0%5D=1&publishedfileids%5B1%5D=2'
  );
  const d = ws.parseDetails({
    response: {
      publishedfiledetails: [
        {
          result: 1,
          publishedfileid: '42',
          title: 'Мод',
          preview_url: 'https://images.steamusercontent.com/ugc/1/',
          tags: [{ tag: 'Maps' }],
        },
        { result: 1, publishedfileid: '43', title: 'Чужой', preview_url: 'https://evil.example/x.png' },
        { result: 9, publishedfileid: '44' },
      ],
    },
  });
  assert.equal(d.get('42').preview, 'https://images.steamusercontent.com/ugc/1/');
  assert.deepEqual(d.get('42').tags, ['Maps']);
  assert.equal(d.get('43').preview, '');
  assert.equal(d.has('44'), false);
  assert.equal(ws.parseDetails(null).size, 0);
});

test('news text drops BBCode with attributes; profile counts games launched before sign-in', () => {
  assert.equal(
    news.plainText(
      '[img src="{STEAM_CLAN_IMAGE}/1/a.png" align="justify"]Robert [url="https://x"]Lusser[/url]'
    ),
    'Robert Lusser'
  );
  const now = Date.now();
  const s = pr.libraryStats(
    [
      {
        id: 'a',
        name: 'A',
        offers: [{ provider: 'steam', installed: true }],
        playtime: 0,
        lastPlayed: now / 1000 - 3600,
      },
      { id: 'b', name: 'B', offers: [{ provider: 'steam', installed: true }], playtime: 0, lastPlayed: 0 },
    ],
    now
  );
  assert.equal(s.played, 1);
  assert.equal(s.neverPlayed, 1);
  assert.equal(s.playedThisMonth, 1);
  assert.deepEqual(s.top, []);
});

test('friends from the Web API once a minute: the first poll is the state, later changes are news', async () => {
  const ctx = context();
  const service = new PresenceService(ctx);
  ctx.presence = service;
  const account = { id: STEAM_ME, key: 'steam:0' };
  let list = [
    { id: FRIEND, name: 'Друг', avatar: '', status: 'offline', game: '', gameId: '' },
    { id: 'x', name: 'Bad', status: 'online' },
  ];
  ctx.accounts = { ...ctx.accounts, connected: p => (p === 'steam' ? [account] : []) };
  ctx.friends = { steamFriends: async () => list };
  ctx.chat = { steamCm: new Map(), steam: () => ({ connect: async () => {} }), connectEpic() {} };
  try {
    await service.poll();
    assert.deepEqual(service.steamStatus(FRIEND), { status: 'offline', game: '' });
    assert.equal(service.feed().length, 0, 'the first poll is not news');
    list = [{ id: FRIEND, name: 'Друг', avatar: '', status: 'ingame', game: 'Dota 2', gameId: '570' }];
    await service.poll();
    assert.deepEqual(service.steamStatus(FRIEND), { status: 'ingame', game: 'Dota 2' });
    assert.deepEqual(
      service.feed().map(x => [x.type, x.name, x.game]),
      [
        ['game', 'Друг', 'Dota 2'],
        ['online', 'Друг', ''],
      ]
    );
    // With the chat connection online, its live statuses are used instead.
    ctx.chat.steamCm.set(STEAM_ME, { state: 'online' });
    list = [];
    await service.poll();
    assert.deepEqual(service.steamStatus(FRIEND), { status: 'ingame', game: 'Dota 2' });
  } finally {
    service.stop();
  }
});

test('Epic profile tab: only Epic games, hours, most played and games launched through Nexus', () => {
  const games = [
    {
      id: 'a',
      name: 'A',
      offers: [{ provider: 'epic', owned: true, playtime: 300, lastPlayed: 1700000000 }],
    },
    { id: 'b', name: 'B', offers: [{ provider: 'epic', installed: true, playtime: 600 }] },
    { id: 'c', name: 'C', offers: [{ provider: 'epic', owned: true }] },
    { id: 'd', name: 'D', offers: [{ provider: 'steam', owned: true, playtime: 9999 }] },
    {
      id: 'e',
      name: 'E',
      offers: [
        { provider: 'steam', owned: true, playtime: 50 },
        { provider: 'epic', owned: true, playtime: 20, lastPlayed: 1800000000 },
      ],
    },
  ];
  const s = pr.epicStats(games);
  assert.equal(s.games, 4);
  assert.equal(s.installed, 1);
  assert.equal(s.minutes, 920);
  assert.equal(s.played, 3);
  assert.deepEqual(
    s.top.map(x => x.id),
    ['b', 'a', 'e']
  );
  // Newest launch first, in milliseconds.
  assert.deepEqual(
    s.recent.map(x => [x.id, x.lastPlayed]),
    [
      ['e', 1800000000000],
      ['a', 1700000000000],
    ]
  );
  assert.deepEqual(pr.epicStats(null), {
    games: 0,
    installed: 0,
    minutes: 0,
    played: 0,
    top: [],
    recent: [],
  });
});
