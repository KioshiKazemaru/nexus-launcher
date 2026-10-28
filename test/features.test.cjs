const test = require('node:test'),
  assert = require('node:assert/strict');
const { remapGameIds } = require('../src/game-ids.cjs');
const collections = require('../src/collections.cjs');
const ach = require('../src/achievements.cjs');
const backup = require('../src/backup.cjs');
const { redact } = require('../src/main/log.cjs');
const { Sections } = require('../src/main/hub.cjs');
const { steamProgress } = require('../src/core.cjs');
const { suggestions } = require('../src/matching.cjs');
const steamPlatform = require('../src/platforms/steam.cjs');
const epicPlatform = require('../src/platforms/epic.cjs');
const platforms = require('../src/platforms/index.cjs');

const settings = () => ({
  favorites: [],
  recent: [],
  preferred: {},
  hidden: [],
  collections: [],
  customPlaytime: {},
});

test('ids of merged games: favorites, recent, platform choice, hidden and collections move to the new id', () => {
  const s = settings();
  s.favorites = ['epic:Hades', 'gone:1'];
  s.recent = [
    { id: 'epic:Hades', time: 5 },
    { id: 'steam:1145360', time: 9 },
  ];
  s.preferred = { 'epic:Hades': 'epic' };
  s.hidden = ['epic:Hades'];
  s.collections = [{ id: 'c', name: 'C', games: ['epic:Hades'] }];
  const games = [
    {
      id: 'steam:1145360',
      aliases: ['epic:Hades'],
      offers: [
        { provider: 'steam', appId: '1145360' },
        { provider: 'epic', appId: 'Hades' },
      ],
    },
  ];
  assert.equal(remapGameIds(s, games), true);
  assert.deepEqual(s.favorites, ['steam:1145360', 'gone:1']);
  assert.deepEqual(s.recent, [{ id: 'steam:1145360', time: 9 }]);
  assert.deepEqual(s.preferred, { 'steam:1145360': 'epic' });
  assert.deepEqual(s.hidden, ['steam:1145360']);
  assert.deepEqual(s.collections[0].games, ['steam:1145360']);
  assert.equal(remapGameIds(s, games), false);
});

test('Steam collections: static ones, hidden and favorites are imported; dynamic and deleted are skipped', () => {
  const entry = (id, value, extra = {}) => [
    `user-collections.${id}`,
    { key: `user-collections.${id}`, value: JSON.stringify(value), ...extra },
  ];
  const parsed = collections.parseSteamCollections([
    entry('uc-1', { id: 'uc-1', name: 'Кооп', added: [10, 20, 30], removed: [30] }),
    entry('uc-2', { id: 'uc-2', name: 'Динамическая', filterSpec: { x: 1 } }),
    entry('uc-3', { id: 'uc-3', name: 'Удалённая', added: [10] }, { is_deleted: true }),
    entry('hidden', { id: 'hidden', added: [20] }),
    entry('favorite', { id: 'favorite', added: [10] }),
    ['other.key', {}],
  ]);
  assert.deepEqual(
    parsed.map(c => c.id),
    ['uc-1', 'hidden', 'favorite']
  );
  const s = settings();
  const report = collections.importSteamCollections(
    s,
    parsed,
    a => ({ 10: 'steam:10', 20: 'steam:20' })[a] || null
  );
  assert.deepEqual(report, { collections: 1, games: 2, hidden: 1, favorites: 1 });
  assert.deepEqual(s.collections[0], {
    id: 'steam-uc-1',
    name: 'Кооп',
    games: ['steam:10', 'steam:20'],
    source: 'steam',
  });
  collections.importSteamCollections(s, parsed, a => `steam:${a}`);
  assert.equal(s.collections.length, 1, 're-import updates instead of duplicating');
  assert.throws(() => collections.parseSteamCollections({}));
  assert.throws(() => collections.createCollection(s, '   ', 'x'));
});

test('achievements from the API and the community XML, icons merged, unsafe icons dropped', () => {
  const api = ach.parseApiAchievements({
    playerstats: {
      success: true,
      achievements: [
        { apiname: 'A', achieved: 1, unlocktime: 100, name: 'Альфа' },
        { apiname: 'B', achieved: 0 },
      ],
    },
  });
  const xml = ach.parseXmlAchievements(
    '<playerstats><achievements><achievement closed="1"><iconClosed><![CDATA[https://cdn.akamai.steamstatic.com/a.jpg]]></iconClosed><name><![CDATA[Альфа]]></name><apiname>A</apiname><unlockTimestamp>100</unlockTimestamp></achievement><achievement closed="0"><iconOpen>https://evil.test/b.jpg</iconOpen><name>B</name><apiname>B</apiname></achievement></achievements></playerstats>'
  );
  const list = ach.mergeAchievements(api, xml);
  assert.equal(list[0].icon, 'https://cdn.akamai.steamstatic.com/a.jpg');
  assert.equal(list[1].icon, '');
  assert.deepEqual(ach.summarize(list), { total: 2, unlocked: 1, percent: 50 });
  assert.throws(
    () => ach.parseApiAchievements({ playerstats: { success: false, error: 'Requested app has no stats' } }),
    /no stats/
  );
  assert.throws(() => ach.parseXmlAchievements('<html>'));
});

test('backup keeps lists and never restores secrets or machine-specific accounts', () => {
  const s = {
    ...settings(),
    wishlist: [],
    links: [],
    splits: [],
    seenGiveaways: [],
    priceWatches: [],
    custom: [],
    savedGames: {},
    storeCountry: 'US',
    libraryView: 'installed',
    steamSlots: [0, 3],
    epicPartitions: { x: 'p' },
    remember: { steam: true },
  };
  const data = backup.createBackup({ ...s, favorites: ['a'] }, { 'steam:1': { offers: [] } }, '1.0');
  assert.equal(data.settings.steamSlots, undefined);
  assert.equal(data.settings.epicPartitions, undefined);
  data.settings.custom = [
    { id: '1', name: 'x', exe: 'C:/a.exe' },
    { id: '2', name: 'y', exe: 'C:/evil.bat' },
    { id: '3', name: 'z', exe: '\\\\server\\share\\z.exe' },
    { id: '4', name: 'w', exe: 'relative\\w.exe' },
  ];
  data.settings.storeCountry = 'not a country';
  const lib = backup.restoreBackup(s, data);
  assert.deepEqual(s.favorites, ['a']);
  // Programs named by a backup are never added silently: the user is asked first.
  assert.deepEqual(s.custom, []);
  assert.deepEqual(
    backup.backupCustomGames(s, data).map(c => c.id),
    ['1']
  );
  s.custom.push({ id: '1', name: 'x', exe: 'c:/A.exe' });
  assert.deepEqual(backup.backupCustomGames(s, data), [], 'already added games are not offered again');
  assert.equal(s.storeCountry, 'US');
  assert.deepEqual(s.steamSlots, [0, 3]);
  assert.deepEqual(Object.keys(lib), ['steam:1']);
  assert.throws(() => backup.restoreBackup(s, { format: 'x' }), /не резервная копия/);
});

test('log redaction masks tokens, keys, codes and bearer headers', () => {
  const line = redact(
    'url?access_token=abc123&key=K&steamid=7 {"refresh_token":"r1"} Authorization: bearer t.t.t authorizationCode: 0123456789abcdef0123456789abcdef kill /sessions/kill/xyz eyJhbGciOiJIUzI1NiJ9xx.eyJzdWIiOiIxMjM0NTY3ODkwIn0x.signature123'
  );
  for (const s of ['abc123', '=K&', 'r1', 't.t.t', '0123456789abcdef', 'xyz', 'eyJ'])
    assert.equal(line.includes(s), false, s);
  assert.ok(line.includes('steamid=7'));
});

test('state sections: unchanged parts are omitted only in pushed updates', () => {
  const sec = new Sections();
  assert.deepEqual(
    sec.pick('games', 1, () => [1], false),
    [1]
  );
  assert.equal(
    sec.pick('games', 1, () => [1], false),
    undefined
  );
  assert.deepEqual(
    sec.pick('games', 1, () => [1], true),
    [1]
  );
  assert.deepEqual(
    sec.pick('games', 2, () => [2], false),
    [2]
  );
});

test('Steam download progress from appmanifest flags', () => {
  assert.deepEqual(
    steamProgress({ StateFlags: '1026', BytesToDownload: '200', BytesDownloaded: '50' }).progress.percent,
    25
  );
  assert.equal(
    steamProgress({ StateFlags: '516', BytesToDownload: '10', BytesDownloaded: '5' }).progress.state,
    'paused'
  );
  assert.equal(steamProgress({ StateFlags: '4' }).progress, undefined);
  assert.equal(steamProgress({ StateFlags: '2048' }).progress.state, 'uninstalling');
});

test('only Steam and Epic platforms; client actions use official URIs', () => {
  assert.deepEqual(
    platforms.list().map(p => p.id),
    ['steam', 'epic']
  );
  assert.equal(steamPlatform.clientUri('uninstall', { appId: '570' }), 'steam://uninstall/570');
  assert.equal(steamPlatform.clientUri('verify', { appId: '570' }), 'steam://validate/570');
  assert.throws(() => steamPlatform.clientUri('uninstall', { appId: '1&x' }));
  assert.equal(
    epicPlatform.clientUri('uninstall', { appId: 'c', namespace: 'a', itemId: 'b' }),
    'com.epicgames.launcher://apps/a%3Ab%3Ac?action=uninstall'
  );
  assert.equal(epicPlatform.clientUri('verify', { appId: 'c' }), 'com.epicgames.launcher://library');
  assert.throws(() => epicPlatform.clientUri('format', { appId: 'c' }));
});

test('"possibly the same game" stays fast on a large library', () => {
  const words =
    'dark souls hollow knight portal witcher cyber city sky space war star legend quest hero night shadow fire ice blood moon sun empire'.split(
      ' '
    );
  const name = i => [0, 1, 2].map(k => words[(i * 7 + k * 13) % words.length]).join(' ') + ' ' + i;
  const games = [];
  for (let i = 0; i < 3000; i++)
    games.push({ name: name(i), offers: [{ provider: 'steam', appId: String(i) }] });
  for (let i = 0; i < 800; i++)
    games.push({ name: name(i + 9000), offers: [{ provider: 'epic', appId: 'e' + i, namespace: 'n' }] });
  const t = Date.now();
  suggestions(games);
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
});

test('IsThereAnyDeal data is limited to Steam and Epic; historical low is the lower of the two', () => {
  const { onlySteamAndEpic } = require('../src/main/integrations.cjs');
  const r = onlySteamAndEpic({
    deals: [
      {
        shopId: 61,
        shop: 'Steam',
        price: { amount: 20, currency: 'USD' },
        storeLow: { amount: 5, currency: 'USD' },
      },
      {
        shopId: 16,
        shop: 'Epic Game Store',
        price: { amount: 18, currency: 'USD' },
        storeLow: { amount: 7, currency: 'USD' },
      },
      {
        shopId: 35,
        shop: 'GOG',
        price: { amount: 3, currency: 'USD' },
        storeLow: { amount: 1, currency: 'USD' },
      },
    ],
    historyLow: { amount: 1, currency: 'USD' },
  });
  assert.deepEqual(
    r.deals.map(d => d.shop),
    ['Steam', 'Epic Game Store']
  );
  assert.deepEqual(r.historyLow, { amount: 5, currency: 'USD' });
});

test('crash handler: logs, hides secrets, restarts once and never right after start', () => {
  const { createCrashHandler } = require('../src/main/crash.cjs');
  const run = (uptime, env = {}) => {
    const calls = { errors: [], relaunched: false, exit: null, logged: 0 };
    const handler = createCrashHandler({
      app: { relaunch: () => (calls.relaunched = true), exit: c => (calls.exit = c) },
      dialog: { showErrorBox: (t, m) => calls.errors.push(m) },
      log: { error: () => calls.logged++, flush() {} },
      flush() {},
      env,
      startedAt: 0,
      now: () => uptime,
    });
    handler(new Error('boom access_token=SECRET'));
    handler(new Error('second'));
    return { calls, env };
  };
  const late = run(60000);
  assert.equal(late.calls.relaunched, true);
  assert.equal(late.calls.exit, 1);
  assert.equal(late.calls.errors.length, 1, 'one dialog for repeated errors');
  assert.equal(late.calls.logged, 2);
  assert.equal(late.calls.errors[0].includes('SECRET'), false);
  assert.equal(run(5000).calls.relaunched, false);
  assert.equal(run(60000, { NEXUS_RELAUNCHED: '1' }).calls.relaunched, false);
});

test('backup: malformed watches, playtime and saved games are rebuilt or dropped', () => {
  const { cleanWatch, cleanSavedGames } = require('../src/backup.cjs');
  assert.equal(cleanWatch({ key: 'k', provider: 'gog', appId: '1', name: 'x', country: 'US' }), null);
  const w = cleanWatch({
    key: 'k',
    provider: 'steam',
    appId: '1',
    name: 'x',
    country: 'US',
    evil: 1,
    current: { amount: 5, currency: 'XXXX' },
    history: [
      { amount: 1, currency: 'USD', at: 1 },
      { amount: 'a', currency: 'USD' },
    ],
  });
  assert.equal(w.current, null);
  assert.equal(w.history.length, 1);
  assert.equal(w.evil, undefined);
  const g = cleanSavedGames({
    a: {
      id: 'a',
      name: 'A',
      image: 'javascript:alert(1)',
      storeOffers: [{ provider: 'steam', appId: '1', url: 'http://x' }],
    },
    b: { id: 'other', name: 'B' },
    c: { name: 'C' },
  });
  assert.deepEqual(Object.keys(g), ['a']);
  assert.equal(g.a.image, '');
  assert.equal(g.a.storeOffers[0].url, null);
});

test('custom game started through a launcher: time counts while the game process runs', async () => {
  const { ActionsService } = require('../src/main/actions.cjs');
  const settings = {
    custom: [{ id: 'c', name: 'Game', exe: 'C:/g/launcher.exe', trackProcess: 'game.exe' }],
    customPlaytime: {},
  };
  const toasts = [];
  const ctx = {
    settings,
    storage: { saveSettings() {} },
    library: { scanLocal: async () => {} },
    log: { warn() {}, info() {} },
    toast: m => toasts.push(m),
  };
  const actions = new ActionsService(ctx);
  let clock = 0,
    checks = 0;
  actions.sleep = async ms => (clock += ms);
  actions.processRunning = async () => ++checks < 4; // running for three checks
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await actions.childExited(settings.custom[0], 0);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    assert.equal(settings.customPlaytime.c.minutes, 1); // 5 s + 3 × 15 s ≈ 1 min
    delete settings.custom[0].trackProcess;
    clock = 0;
    await actions.childExited(settings.custom[0], 0);
    assert.match(toasts[0], /лаунчер/);
  } finally {
    Date.now = realNow;
  }
});

test('installing an update saves sign-in sessions before quitting', async () => {
  const { Updater } = require('../src/main/updater.cjs');
  const order = [];
  const u = new Updater({
    accounts: { captureSessions: async () => order.push('sessions') },
    prepareQuit: () => order.push('quit'),
    hub: { publish() {} },
    log: { warn() {} },
  });
  u.updater = { quitAndInstall: () => order.push('install') };
  u.state.status = 'ready';
  await u.install();
  assert.deepEqual(order, ['sessions', 'quit', 'install']);
});
