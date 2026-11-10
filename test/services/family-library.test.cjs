// Steam Families in the main process (Electron stub, offline): installed games
// that are not on the user's account must not become the user's library.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  fsp = require('node:fs/promises'),
  path = require('node:path'),
  { pathToFileURL } = require('node:url');
const electron = require('electron');
const T = electron.__test;

const ME = '76561198000000001',
  MOM = '76561198000000009',
  STRANGER = '76561198000000077';
const ME32 = String(BigInt(ME) - 76561197960265728n);
const STRANGER32 = String(BigInt(STRANGER) - 76561197960265728n);
const jwt = sub => ['x', Buffer.from(JSON.stringify({ sub })).toString('base64url'), 'signature'].join('.');
const APPS = Array.from({ length: 30 }, (_, i) => String(2000 + i));

// --- a Steam folder: 30 manifests and localconfig.vdf of two people ---
const root = path.join(T.dir, 'Steam');
const now = Math.floor(Date.now() / 1000);
fs.mkdirSync(path.join(root, 'steamapps'), { recursive: true });
APPS.forEach((id, i) => {
  // 26 launched on this PC, 16 of them in the last 30 days.
  const last = i < 16 ? now - 3600 : i < 26 ? now - 90 * 86400 : 0;
  fs.writeFileSync(
    path.join(root, 'steamapps', `appmanifest_${id}.acf`),
    `"AppState" { "appid" "${id}" "name" "Family Game ${i}" "StateFlags" "4" "LastPlayed" "${last}" "installdir" "fg${i}" }`
  );
});
const localconfig = minutes =>
  `"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "${APPS[0]}" { "LastPlayed" "${now}" "Playtime" "${minutes}" } } } } } }`;
for (const [id, minutes] of [
  [ME32, 90],
  [STRANGER32, 5000],
]) {
  fs.mkdirSync(path.join(root, 'userdata', id, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'userdata', id, 'config', 'localconfig.vdf'), localconfig(minutes));
}

// Every localconfig.vdf read is recorded.
const configReads = [];
const readFile = fsp.readFile;
fsp.readFile = function (file, ...rest) {
  if (/localconfig\.vdf$/i.test(String(file))) configReads.push(String(file));
  return readFile.call(this, file, ...rest);
};

// --- Steam answers ---
const signedIn = {};
globalThis.__stubCookies = partition =>
  signedIn[partition]
    ? [{ name: 'steamLoginSecure', domain: 'store.steampowered.com', value: `${signedIn[partition]}%7C%7Cx` }]
    : [];
let familyDown = false;
const familyCalls = [];
T.setRoutes([
  [
    'store.steampowered.com/account/',
    (_u, o) => ({
      status: 200,
      body: signedIn[o.partition]
        ? `<div data-userinfo='{"steamid":"${signedIn[o.partition]}","logged_in":true}'></div><div id="account_pulldown">Kid</div>`
        : '<div>Войти</div>',
      type: 'text/html',
    }),
  ],
  ['ajaxgetasyncconfig', (_u, o) => ({ success: 1, data: { webapi_token: jwt(signedIn[o.partition]) } })],
  // The account itself owns nothing.
  ['IPlayerService/GetOwnedGames', () => ({ response: { game_count: 0 } })],
  [
    `steamcommunity.com/profiles/${ME}/games`,
    () => ({
      status: 200,
      body: `<template data-profile-gameslist="{&quot;strSteamId&quot;:&quot;${ME}&quot;,&quot;rgGames&quot;:[]}"></template>`,
      type: 'text/html',
    }),
  ],
  [
    'IFamilyGroupsService/GetFamilyGroupForUser',
    u => {
      familyCalls.push(u);
      if (familyDown) return { status: 503, body: 'Service Unavailable', type: 'text/plain' };
      return {
        response: {
          family_groupid: '9001',
          family_group: { name: 'Дом', members: [{ steamid: ME }, { steamid: MOM }] },
        },
      };
    },
  ],
  [
    'IFamilyGroupsService/GetSharedLibraryApps',
    u => {
      familyCalls.push(u);
      return { response: { apps: APPS.map(appid => ({ appid: Number(appid), owner_steamids: [MOM] })) } };
    },
  ],
  [
    'IPlayerService/GetPlayerLinkDetails',
    () => ({ response: { accounts: [{ public_data: { steamid: MOM, persona_name: 'Мама' } }] } }),
  ],
]);

const wait = ms => new Promise(r => setTimeout(r, ms));
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
let call;
// What the window shows in «Имеющиеся» and «Скачанные» (ui/app-store.js).
const inAccountLibrary = o => o.owned === true || (o.installed === true && o.librarySource !== 'local');
const ownedView = s => s.games.filter(g => g.offers.some(inAccountLibrary));
const installedView = s => s.games.filter(g => g.offers.some(o => o.installed));

test.before(async () => {
  process.argv.push('--dev-linux');
  process.env.NEXUS_TEST = '1';
  process.env.NEXUS_NO_SYSTEM_SCAN = '1';
  process.env.ProgramData = path.join(T.dir, 'ProgramData');
  require('../../src/main.cjs');
  for (let i = 0; i < 100 && !T.handlers.size; i++) await wait(20);
  const mainWindow = T.windows.find(w => w.options?.webPreferences?.preload);
  const uiUrl = pathToFileURL(path.join(__dirname, '../../ui/index.html')).href;
  call = async (name, payload) => {
    const r = await T.handlers.get(name)(
      { sender: mainWindow.webContents, senderFrame: { url: uiUrl } },
      payload
    );
    if (!r.ok) throw Error(r.error);
    return r.data;
  };
  await idle();
  T.dialogs.open = root;
  await call('steamRoot');
  T.dialogs.open = null;
  await idle();
});

test('no accounts + 30 manifests: library 0, «Скачанные» 30, empty profile, localconfig.vdf not read', async () => {
  const s = await call('state');
  assert.equal(
    s.accountList.some(a => a.status === 'connected'),
    false
  );
  assert.equal(installedView(s).length, 30);
  assert.equal(ownedView(s).length, 0);
  assert.ok(s.games.every(g => g.librarySource === 'local'));
  const p = await call('profile');
  assert.deepEqual(p.accounts, []);
  assert.equal(p.steamProfile, null);
  assert.equal(p.stats.games, 0);
  assert.equal(p.stats.family, 0);
  assert.equal(p.stats.installed, 0);
  assert.equal(p.stats.played, 0);
  assert.equal(p.stats.playedThisMonth, 0);
  assert.equal(p.stats.minutes, 0);
  assert.deepEqual(p.stats.byProvider.steam, { games: 0, family: 0, minutes: 0 });
  assert.equal(p.stats.foundOnPc, 30);
  for (const kind of ['owned', 'installed', 'played'])
    assert.deepEqual(await call('profileGames', { kind }), [], kind);
  assert.deepEqual(configReads, [], 'no localconfig.vdf is read without an account');
});

test('account without own games + 30 family manifests: 0 own, 30 family with the owner; only its userdata', async () => {
  signedIn['nexus-steam'] = ME;
  await call('refreshAccounts');
  await idle();
  const s = await call('state');
  assert.equal(s.accounts.steam.status, 'connected');
  const steam = s.games.flatMap(g => g.offers).filter(o => o.provider === 'steam');
  assert.equal(steam.length, 30);
  assert.equal(steam.filter(o => o.owned).length, 0);
  assert.ok(steam.every(o => o.librarySource === 'family'));
  for (const o of steam) assert.deepEqual(o.familyOwners, [{ id: MOM, name: 'Мама' }]);
  assert.equal(ownedView(s).length, 30, 'family games stay in «Имеющиеся»');

  const p = await call('profile');
  assert.equal(p.stats.games, 0);
  assert.equal(p.stats.family, 30);
  assert.deepEqual(p.stats.byProvider.steam, { games: 0, family: 30, minutes: 90 });
  assert.equal((await call('profileGames', { kind: 'family' })).length, 30);
  assert.equal((await call('profileGames', { kind: 'owned' })).length, 0);

  // Both family methods got the session token of the account (as GetOwnedGames).
  assert.ok(familyCalls.length >= 2);
  for (const u of familyCalls) assert.equal(new URL(u).searchParams.get('access_token'), jwt(ME));
  // Several userdata folders: only the connected account's one is read.
  assert.ok(configReads.length > 0);
  assert.ok(configReads.every(f => f.includes(path.join('userdata', ME32, 'config'))));
  assert.equal(
    configReads.some(f => f.includes(STRANGER32)),
    false
  );
  const first = s.games.find(g => g.offers.some(o => o.appId === APPS[0]));
  assert.equal(first.playtime, 90, 'the stranger’s 5000 minutes are not used');
});

test('favorites, collections and launch keep working for family games', async () => {
  let s = await call('state');
  const g = s.games.find(x => x.offers.some(o => o.appId === APPS[1]));
  s = await call('toggle', { list: 'favorites', id: g.id });
  assert.ok(s.settings.favorites.includes(g.id));
  s = await call('createCollection', 'Семейные');
  const c = s.settings.collections.find(x => x.name === 'Семейные');
  s = await call('setInCollection', { collection: c.id, id: g.id, include: true });
  assert.deepEqual(s.games.find(x => x.id === g.id).collections, [c.id]);
  await call('play', { id: g.id, provider: 'steam' });
  assert.ok(T.opened.some(u => u === `steam://rungameid/${APPS[1]}`));
});

test('family endpoint fails: installed games become "unconfirmed", the error is logged, the app keeps working', async () => {
  const ctx = globalThis.__nexusTest;
  familyDown = true;
  delete ctx.library.familyCache[ME];
  await call('syncLibraries');
  await idle();
  const s = await call('state');
  const steam = s.games.flatMap(g => g.offers).filter(o => o.provider === 'steam');
  assert.equal(steam.length, 30, 'no game disappears');
  assert.ok(steam.every(o => o.librarySource === 'unconfirmed' && !o.owned));
  assert.equal(ownedView(s).length, 30);
  assert.ok(ctx.log.tail(200).some(l => /\[family\].*HTTP 503/.test(l)));
  const p = await call('profile');
  assert.equal(p.stats.games, 0);
  assert.equal(p.stats.family, 0);
  assert.equal(p.stats.unconfirmed, 30);
  // The rest of Nexus still answers.
  assert.ok(Array.isArray((await call('state')).games));
  familyDown = false;
});

test('the family list is cached: a second sync within hours does not ask Steam again', async () => {
  const ctx = globalThis.__nexusTest;
  await ctx.library.syncFamily('steam:0', true);
  await idle();
  const before = familyCalls.length;
  await ctx.library.syncFamily('steam:0');
  assert.equal(familyCalls.length, before);
  assert.equal((await call('state')).games[0].librarySource, 'family');
  // The cache survives a restart: it is saved with the account libraries.
  await ctx.storage.ownedFile.flush();
  const saved = ctx.storage.loadOwned();
  assert.deepEqual(Object.keys(saved[`family:${ME}`].apps).sort(), APPS);
});
