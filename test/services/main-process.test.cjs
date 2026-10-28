// Main-process scenarios with the Electron stub (run via `npm test`, which
// preloads test/helpers/register-electron.cjs). Everything happens offline.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { pathToFileURL } = require('node:url');
const electron = require('electron');
const T = electron.__test;
const epic = require('../../src/epic-oauth.cjs');

const STEAM_A = '76561198000000001',
  STEAM_B = '76561198000000002';
const EPIC_A = 'a'.repeat(32),
  EPIC_B = 'b'.repeat(32);
const jwt = sub => ['x', Buffer.from(JSON.stringify({ sub })).toString('base64url'), 'signature'].join('.');
const signedIn = { 'nexus-steam': STEAM_A };
const steamIdFor = partition => signedIn[partition] || null;
globalThis.__stubCookies = partition =>
  steamIdFor(partition)
    ? [{ name: 'steamLoginSecure', domain: 'store.steampowered.com', value: `${steamIdFor(partition)}%7C%7Cx` }]
    : [];
let partitionB = '';
const accountHtml = id =>
  `<div data-userinfo='{"steamid":"${id}","logged_in":true}'></div><div id="account_pulldown">${id === STEAM_A ? 'Alpha' : 'Beta'}</div>`;
const steamGames = {
  [STEAM_A]: [
    { appid: 1091500, name: 'Cyberpunk 2077', playtime_forever: 600, rtime_last_played: 1700000000 },
    { appid: 570, name: 'Dota 2', playtime_forever: 50 },
  ],
  [STEAM_B]: [{ appid: 1091500, name: 'Cyberpunk 2077', playtime_forever: 10 }],
};
const epicGames = {
  [EPIC_A]: [
    {
      appName: 'Obscure',
      namespace: 'ob',
      catalogItemId: 'oi',
      metadata: { title: 'Obscure Indie', categories: [{ path: 'games' }] },
    },
    {
      appName: 'Hades',
      namespace: 'h',
      catalogItemId: 'hi',
      metadata: { title: 'Hades™', categories: [{ path: 'games' }] },
    },
    {
      appName: 'CP',
      namespace: 'cp',
      catalogItemId: 'ci',
      metadata: { title: 'Cyberpunk 2077: Ultimate Edition', categories: [{ path: 'games' }] },
    },
  ],
  [EPIC_B]: [
    {
      appName: 'Alan',
      namespace: 'aw',
      catalogItemId: 'ai',
      metadata: { title: 'Alan Wake 2', categories: [{ path: 'games' }] },
    },
  ],
};

const graphqlTitles = [];
T.setRoutes([
  [
    'store.epicgames.com/graphql',
    u => {
      const keywords = JSON.parse(new URL(u).searchParams.get('variables')).keywords;
      graphqlTitles.push(keywords);
      const elements = /alan/i.test(keywords)
        ? [
            {
              id: 'alan-offer',
              namespace: 'aw',
              title: 'Alan Wake 2',
              categories: [{ path: 'games' }],
              items: [{ id: 'ai', namespace: 'aw' }],
              keyImages: [{ type: 'OfferImageWide', url: 'https://cdn1.epicgames.com/alan.jpg' }],
            },
          ]
        : [];
      return { data: { Catalog: { searchStore: { elements, paging: { total: elements.length } } } } };
    },
  ],
  [
    'api/appdetails',
    u => {
      const id = new URL(u).searchParams.get('appids');
      return {
        [id]: {
          success: true,
          data: {
            name: 'Game ' + id,
            type: 'game',
            price_overview: { final: 99900, currency: 'RUB', final_formatted: '999 ₽', discount_percent: 0 },
          },
        },
      };
    },
  ],
  [
    'store.steampowered.com/account/',
    (_u, o) => ({
      status: 200,
      body: steamIdFor(o.partition) ? accountHtml(steamIdFor(o.partition)) : '<div>Войти</div>',
      type: 'text/html',
    }),
  ],
  ['ajaxgetasyncconfig', (_u, o) => ({ success: 1, data: { webapi_token: jwt(steamIdFor(o.partition)) } })],
  [
    'IPlayerService/GetOwnedGames',
    u => {
      const sub = JSON.parse(
        Buffer.from(new URL(u).searchParams.get('access_token').split('.')[1], 'base64url')
      ).sub;
      return { response: { game_count: steamGames[sub].length, games: steamGames[sub] } };
    },
  ],
  [
    'ISteamUserStats/GetPlayerAchievements',
    () => ({
      playerstats: {
        success: true,
        achievements: [
          { apiname: 'A1', achieved: 1, unlocktime: 1700000000, name: 'Первый шаг' },
          { apiname: 'A2', achieved: 0, unlocktime: 0, name: 'Второй шаг' },
        ],
      },
    }),
  ],
  [
    'oauth/token',
    (_u, o) => {
      const p = new URLSearchParams(o.body);
      const id = p.get('code') === 'b'.repeat(32) ? EPIC_B : EPIC_A;
      return {
        access_token: 'acc-' + id,
        expires_in: 7200,
        refresh_token: 'ref-' + id,
        refresh_expires: 86400,
        account_id: id,
        displayName: id === EPIC_A ? 'EpicA' : 'EpicB',
      };
    },
  ],
  [
    'library/api/public/items',
    (_u, o) => ({ records: epicGames[o.headers.Authorization.split('acc-')[1]], responseMetadata: {} }),
  ],
  ['playtime/account', u => (u.includes(EPIC_A) ? [{ artifactId: 'Hades', totalTime: 7200 }] : [])],
  ['freeGamesPromotions', () => ({ data: { Catalog: { searchStore: { elements: [] } } } })],
]);

const wait = ms => new Promise(r => setTimeout(r, ms));
// Waits until the main process has no background work left (account checks,
// library syncs, covers, external lookups, pending window updates), instead of
// sleeping for a fixed time. Fails after `timeout` ms.
async function idle(timeout = 15000) {
  const ctx = globalThis.__nexusTest;
  const busy = () =>
    Object.keys(ctx.accounts.monitor.inFlight).length > 0 ||
    Object.keys(ctx.library.checks).length > 0 ||
    ctx.library.artRunning ||
    !!ctx.integrations.queue ||
    !!ctx.hub.timer;
  const end = Date.now() + timeout;
  let calm = 0;
  while (calm < 3) {
    if (Date.now() > end) throw Error('main process did not become idle');
    calm = busy() ? 0 : calm + 1;
    await wait(20);
  }
}
// Retries an assertion block until it passes (for work that has no idle signal, e.g. disk polling).
async function eventually(check, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > end) throw e;
      await wait(100);
    }
  }
}
let mainWindow, call, uiUrl;

test.before(async () => {
  process.argv.push('--dev-linux');
  process.env.NEXUS_TEST = '1';
  require('../../src/main.cjs');
  for (let i = 0; i < 100 && !T.handlers.size; i++) await wait(20);
  mainWindow = T.windows.find(w => w.options?.webPreferences?.preload);
  uiUrl = pathToFileURL(path.join(__dirname, '../../ui/index.html')).href;
  call = async (name, payload) => {
    const r = await T.handlers.get(name)(
      { sender: mainWindow.webContents, senderFrame: { url: uiUrl } },
      payload
    );
    if (!r.ok) throw Error(r.error);
    return r.data;
  };
  await idle();
});

test('IPC from any other page is refused', async () => {
  await assert.rejects(
    T.handlers.get('state')({ sender: {}, senderFrame: { url: 'https://evil.test' } }),
    /Untrusted/
  );
});

test('Steam account is verified and its library loaded with playtime', async () => {
  await call('refreshAccounts');
  await idle();
  const s = await call('state');
  assert.equal(s.accounts.steam.name, 'Alpha');
  assert.equal(s.libraryState.steam.status, 'ready');
  const cp = s.games.find(g => g.steam === '1091500');
  assert.equal(cp.playtime, 600);
});

test('Epic account via pasted code; libraries merge across stores; tokens are not in the state', async () => {
  await call('epicCode', JSON.stringify({ authorizationCode: 'a'.repeat(32) }));
  await idle();
  const s = await call('state');
  assert.equal(s.accounts.epic.name, 'EpicA');
  const cp = s.games.find(g => g.steam === '1091500');
  assert.deepEqual(cp.offers.map(o => o.provider).sort(), ['epic', 'steam']);
  assert.equal(s.games.find(g => g.name === 'Hades™' || g.name === 'Hades').playtime, 120);
  assert.equal(JSON.stringify(s).includes('ref-' + EPIC_A), false);
  assert.equal(JSON.stringify(s).includes('acc-' + EPIC_A), false);
});

test('favorites follow a game when it is split and merged again', async () => {
  let s = await call('state');
  const cp = s.games.find(g => g.steam === '1091500');
  await call('toggle', { list: 'favorites', id: cp.id });
  s = await call('splitGame', cp.id);
  assert.ok(s.games.filter(g => g.name.startsWith('Cyberpunk')).length === 2);
  const steamPart = s.games.find(g => g.steam === '1091500');
  assert.ok(s.settings.favorites.includes(steamPart.id));
  const [a, b] = s.settings.splits[0].split('|');
  s = await call('linkGames', { a, b });
  const merged = s.games.find(g => g.steam === '1091500');
  assert.equal(merged.offers.length, 2);
  assert.ok(s.settings.favorites.includes(merged.id));
});

test('a second Epic account gets its own web session; the first stays signed in', async () => {
  const before = await call('login', { provider: 'epic', add: true });
  assert.equal(before.key, 'epic-login');
  const loginWindow = T.windows.filter(w => !w.destroyed).at(-1);
  const partition = loginWindow.options.webPreferences.session.name;
  partitionB = partition;
  assert.match(partition, /^nexus-epic-[a-f0-9]{8}$/);
  assert.equal(T.sessions.get('nexus-epic').cleared, 0);
  loginWindow.webContents.scriptResult = JSON.stringify({ authorizationCode: 'b'.repeat(32) });
  await loginWindow.loadURL(epic.REDIRECT_URL);
  await idle();
  const s = await call('state');
  assert.deepEqual(
    s.accountList
      .filter(a => a.provider === 'epic')
      .map(a => a.name)
      .sort(),
    ['EpicA', 'EpicB']
  );
  assert.ok(loginWindow.destroyed, 'login window closes after the code is captured');
  assert.ok(s.games.some(g => g.name === 'Alan Wake 2'));
});

test('purchase opens the chosen account; a copy owned by another account does not block it', async () => {
  // Alan Wake 2 is owned by EpicB only.
  const s = await call('state');
  const alan = s.games.find(g => g.name === 'Alan Wake 2');
  await assert.rejects(call('buy', { id: alan.id, provider: 'epic', account: 'epic:' + EPIC_B }), /уже есть/);
  // No store link for a library-only entry: the error is about the link, not ownership.
  await assert.rejects(
    call('buy', { id: alan.id, provider: 'epic', account: 'epic:' + EPIC_A }),
    /ссылки покупки/
  );
});

test('"add Steam account" closed without signing in leaves no empty slot', async () => {
  const r = await call('login', { provider: 'steam', add: true });
  assert.equal(r.key, 'steam:1');
  let s = await call('state');
  assert.deepEqual(s.settings.steamSlots, [0, 1]);
  const w = T.windows.filter(x => !x.destroyed).at(-1);
  w.close();
  await idle();
  s = await call('state');
  assert.deepEqual(s.settings.steamSlots, [0]);
  assert.equal(
    s.accountList.some(a => a.key === 'steam:1'),
    false
  );
});

test('a second Steam account adds its games; the same game on both accounts is one game', async () => {
  signedIn['nexus-steam-1'] = STEAM_B;
  await call('login', { provider: 'steam', add: true });
  await call('refreshAccounts');
  await idle();
  const s = await call('state');
  assert.deepEqual(
    s.accountList
      .filter(a => a.provider === 'steam' && a.status === 'connected')
      .map(a => a.name)
      .sort(),
    ['Alpha', 'Beta']
  );
  const cp = s.games.filter(g => g.steam === '1091500');
  assert.equal(cp.length, 1);
  assert.deepEqual(cp[0].offers.find(o => o.provider === 'steam').accountIds.sort(), [STEAM_A, STEAM_B]);
  await call('forget', 'steam:1');
});

test('closing a store window of a connected account never removes it, even if the check fails', async () => {
  signedIn['nexus-steam-1'] = STEAM_B;
  await call('login', { provider: 'steam', add: true });
  await call('refreshAccounts');
  await idle();
  const ctx = globalThis.__nexusTest;
  ctx.windows.get('steam:1')?.close(); // login window (closes itself after a verified sign-in)
  await idle();
  T.setOnline(false);
  // A checkout window for steam:1 closed while offline: the check fails, the slot stays.
  const s0 = ctx.accounts.session('steam:1');
  ctx.windows.open({
    key: 'steam:1',
    provider: 'steam',
    session: s0,
    url: 'https://store.steampowered.com/app/570/',
    purpose: 'checkout',
  });
  T.windows
    .filter(w => !w.destroyed)
    .at(-1)
    .close();
  await idle();
  T.setOnline(true);
  const s = await call('state');
  assert.deepEqual(s.settings.steamSlots, [0, 1]);
  await call('forget', 'steam:1');
});

test('backup round trip restores lists but never secrets', async () => {
  const file = path.join(T.dir, 'backup.json');
  T.dialogs.save = file;
  await call('exportBackup');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(/ref-|acc-|cookies|epicTokens/.test(text), false);
  const data = JSON.parse(text);
  data.settings.favorites.push('steam:570');
  fs.writeFileSync(file, JSON.stringify(data));
  T.dialogs.open = file;
  const r = await call('importBackup');
  assert.ok(r.state.settings.favorites.includes('steam:570'));
  T.dialogs.save = T.dialogs.open = null;
});

test('offline: a previously verified Steam account keeps its saved library', async () => {
  T.setOnline(false);
  await call('refreshAccounts');
  await idle();
  let s = await call('state');
  assert.equal(s.online, false);
  assert.equal(s.accountList.find(a => a.key === 'steam:0').status, 'unavailable');
  assert.ok(s.games.some(g => g.name === 'Dota 2' && g.offers.some(o => o.owned)));
  T.setOnline(true);
  await call('refreshAccounts');
  await idle();
  s = await call('state');
  assert.equal(s.accountList.find(a => a.key === 'steam:0').status, 'connected');
});

test('diagnostics report and log files contain no tokens', async () => {
  const file = path.join(T.dir, 'diag.txt');
  T.dialogs.save = file;
  await call('saveDiagnostics');
  T.dialogs.save = null;
  const { Log } = require('../../src/main/log.cjs');
  const log = new Log(path.join(T.dir, 'logs-test'));
  log.warn('x', 'GET https://x/?access_token=SECRET123&steamid=1 Authorization: Bearer abc.def.ghi');
  const text = fs.readFileSync(file, 'utf8') + log.tail(10).join('\n');
  for (const secret of ['SECRET123', 'abc.def.ghi', 'ref-' + EPIC_A, 'acc-' + EPIC_A, STEAM_A])
    assert.equal(text.includes(secret), false, secret);
  assert.match(text, /== Аккаунты ==/);
});

test('Steam achievements for a library game; Epic reports that it has no API', async () => {
  const s = await call('state');
  const cp = s.games.find(g => g.steam === '1091500');
  const a = await call('achievements', cp.id);
  assert.equal(a.available, true);
  assert.equal(a.unlocked, 1);
  assert.equal(a.total, 2);
  const alan = s.games.find(g => g.name === 'Alan Wake 2');
  assert.equal((await call('achievements', alan.id)).available, false);
});

test('hidden games and collections', async () => {
  let s = await call('state');
  const dota = s.games.find(g => g.name === 'Dota 2');
  s = await call('setHidden', { id: dota.id, hidden: true });
  assert.equal(s.games.find(g => g.id === dota.id).hidden, true);
  s = await call('createCollection', 'Кооператив');
  const c = s.settings.collections.find(x => x.name === 'Кооператив');
  s = await call('setInCollection', { collection: c.id, id: dota.id, include: true });
  assert.deepEqual(s.games.find(g => g.id === dota.id).collections, [c.id]);
  await assert.rejects(call('createCollection', 'кооператив'), /уже есть/);
  s = await call('deleteCollection', c.id);
  assert.equal(s.settings.collections.length, 0);
});

test('a price update sends only that game, not the whole library', async () => {
  const s = await call('state');
  const dota = s.games.find(g => g.name === 'Dota 2');
  mainWindow.webContents.sent.length = 0;
  await call('gamePrices', { id: dota.id, force: true });
  await idle();
  const pushes = mainWindow.webContents.sent.filter(([c]) => c === 'state-changed').map(([, v]) => v);
  assert.ok(pushes.length > 0);
  for (const p of pushes) assert.equal(p.games, undefined, 'game list must not be re-sent');
  const delta = Object.assign({}, ...pushes.map(p => p.pricesDelta || {}));
  assert.deepEqual(Object.keys(delta), [dota.id]);
  assert.equal(delta[dota.id].o.find(o => o.provider === 'steam').amount, 999);
});

test('Epic covers: found cover reaches the window; a miss is not searched again on every rebuild', async () => {
  await idle();
  const s = await call('state');
  assert.equal(s.games.find(g => g.name === 'Alan Wake 2').image, 'https://cdn1.epicgames.com/alan.jpg');
  const before = graphqlTitles.filter(t => /Obscure/i.test(t)).length;
  assert.ok(before >= 1);
  for (let i = 0; i < 3; i++) await call('scan');
  await idle();
  assert.equal(graphqlTitles.filter(t => /Obscure/i.test(t)).length, before);
});

test('wishlist import does not change the account used for purchases', async () => {
  const before = (await call('state')).accounts.epic.purchaseAccount;
  await call('importWishlists');
  assert.equal((await call('state')).accounts.epic.purchaseAccount, before);
});

test('download progress updates without rebuilding the library', async () => {
  const root = path.join(T.dir, 'SteamLib');
  fs.mkdirSync(path.join(root, 'steamapps'), { recursive: true });
  T.dialogs.open = root;
  await call('steamRoot');
  T.dialogs.open = null;
  const manifest = done =>
    fs.writeFileSync(
      path.join(root, 'steamapps', 'appmanifest_570.acf'),
      `"AppState" { "appid" "570" "name" "Dota 2" "StateFlags" "1026" "BytesToDownload" "1000" "BytesDownloaded" "${done}" }`
    );
  manifest(100);
  await call('play', {
    id: (await call('state')).games.find(g => g.name === 'Dota 2').id,
    provider: 'steam',
  });
  assert.ok(T.opened.includes('steam://install/570'));
  // First poll (every 5 s): a new manifest appears → library rebuild.
  const dota = await eventually(async () => {
    const s = await call('state');
    const g = s.games.find(x => x.name === 'Dota 2');
    assert.equal(s.progress[g.id]?.percent, 10);
    return g;
  });
  mainWindow.webContents.sent.length = 0;
  manifest(600);
  // Second poll: only progress changed.
  const pushes = await eventually(() => {
    const list = mainWindow.webContents.sent.filter(([c]) => c === 'state-changed').map(([, v]) => v);
    assert.ok(list.some(p => p.progress?.[dota.id]?.percent === 60));
    return list;
  });
  for (const p of pushes) assert.equal(p.games, undefined, 'no library rebuild for progress');
  fs.rmSync(path.join(root, 'steamapps', 'appmanifest_570.acf'));
});

test('pressing "add Epic account" twice reuses the open login window and its session', async () => {
  const sessionsBefore = T.sessions.size;
  await call('login', { provider: 'epic', add: true });
  const windowsAfterFirst = T.windows.filter(w => !w.destroyed).length;
  await call('login', { provider: 'epic', add: true });
  assert.equal(T.sessions.size, sessionsBefore + 1, 'one new session only');
  assert.equal(T.windows.filter(w => !w.destroyed).length, windowsAfterFirst, 'no second window');
  const w = T.windows.filter(x => !x.destroyed).at(-1);
  const partition = w.options.webPreferences.session.name;
  w.close();
  await idle();
  assert.ok(T.sessions.get(partition).cleared > 0, 'the unused login session is removed');
});

test('action replies omit the unchanged game list; the full state is still available', async () => {
  const before = await call('state');
  const dota = before.games.find(g => g.name === 'Dota 2');
  const reply = await call('preferred', { id: dota.id, provider: 'steam' });
  assert.equal(reply.games, undefined);
  assert.equal(reply.settings.preferred[dota.id], 'steam');
  assert.ok(Array.isArray((await call('state')).games));
});

test('forgetting an Epic account removes its games and its web session only', async () => {
  await call('forget', 'epic:' + EPIC_B);
  const s = await call('state');
  assert.equal(
    s.games.some(g => g.name === 'Alan Wake 2'),
    false
  );
  assert.ok(T.sessions.get(partitionB).cleared > 0);
  assert.equal(T.sessions.get('nexus-epic-' + EPIC_A.slice(0, 8)).cleared, 0);
  assert.ok(T.requests.some(r => r.url.includes('/sessions/kill/')));
});
