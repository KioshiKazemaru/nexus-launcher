// Installing games without the launchers' windows: Epic games are downloaded
// by Nexus (manifest + chunks, as Legendary), Steam games by Steam in the tray.
// A small "game" is packed in Epic's format and served by a fake CDN.
// Run via `npm test`.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const electron = require('electron');
const d = require('../src/epic-download.cjs');
const { packSave } = require('../src/epic-saves.cjs');
const { EpicInstaller } = require('../src/main/epic-install.cjs');
const {
  SteamInstaller,
  appManifest,
  steamLibraries,
  parseAppInfo,
  installDirName,
} = require('../src/main/steam-install.cjs');
const { parseVdf } = require('../src/core.cjs');

const ACCOUNT = 'a'.repeat(32);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-install-'));
const rnd = n => crypto.randomBytes(n);

test('assets: only Epic CDNs, signed manifest URLs, chunk folders', () => {
  assert.equal(
    d.assetsUrl({ namespace: 'ns', itemId: 'item1', appId: 'Fennec' }),
    'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/v2/platform/Windows/namespace/ns/catalogItem/item1/app/Fennec/label/Live'
  );
  assert.throws(() => d.assetsUrl({ namespace: '../x', itemId: 'i', appId: 'a' }), /Некорректный/);
  const a = d.parseAssets({
    elements: [
      {
        appName: 'Fennec',
        buildVersion: '1.0',
        hash: 'h',
        manifests: [
          { uri: 'https://evil.example/Builds/x.manifest', queryParams: [] },
          {
            uri: 'https://egdownload.fastly-edge.com/Builds/Org/x.manifest',
            queryParams: [{ name: 'f_token', value: 'abc' }],
          },
        ],
      },
    ],
  });
  assert.equal(a.manifests.length, 1);
  assert.equal(a.manifests[0].url, 'https://egdownload.fastly-edge.com/Builds/Org/x.manifest?f_token=abc');
  assert.equal(a.manifests[0].base, 'https://egdownload.fastly-edge.com/Builds/Org');
  assert.throws(() => d.parseAssets({ elements: [] }), /не выдал/);
});

test('JSON manifests (older games): blobs, GUIDs, chunk paths and file parts', () => {
  assert.equal(d.blobNum('001000'), 1n);
  assert.equal(d.blobNum('000001'), 256n);
  assert.deepEqual([...d.blobBytes('255000016')], [255, 0, 16]);
  const guid = '0123456789ABCDEF0123456789ABCDEF';
  const m = d.parseManifest(
    Buffer.from(
      JSON.stringify({
        ManifestFileVersion: '013000000000',
        AppNameString: 'Old',
        BuildVersionString: '1.2',
        LaunchExeString: 'Game.exe',
        LaunchCommand: '-x',
        FileManifestList: [
          {
            Filename: 'Game.exe',
            FileHash: '001'.repeat(20),
            FileChunkParts: [{ Guid: guid, Offset: '000000000000', Size: '000004000000' }],
          },
        ],
        ChunkHashList: { [guid]: '001000000000000000000000' },
        ChunkShaList: { [guid]: 'aa'.repeat(20) },
        DataGroupList: { [guid]: '007' },
        ChunkFilesizeList: { [guid]: '100000000000000000000000' },
      })
    )
  );
  assert.equal(m.featureLevel, 13);
  assert.equal(m.meta.launchExe, 'Game.exe');
  assert.equal(m.files[0].size, 1024);
  assert.equal(m.chunks[0].fileSize, 100);
  assert.equal(m.chunks[0].path, `ChunksV3/07/0000000000000001_${guid}.chunk`);
  const p = d.plan(m);
  assert.equal(p.chunks.length, 1);
  assert.deepEqual(p.chunks[0].targets, [{ file: 'Game.exe', fileOffset: 0, chunkOffset: 0, size: 1024 }]);
});

test('paths from a manifest never leave the install folder; folder names are safe', () => {
  const root = path.resolve('C:\\Games\\X');
  assert.equal(d.safeTarget(root, 'Bin/Game.exe'), path.join(root, 'Bin', 'Game.exe'));
  for (const bad of ['../evil.dll', 'a/../../b', '/abs', 'C:/Windows/x', 'a//b', ''])
    assert.throws(() => d.safeTarget(root, bad), /Небезопасный/);
  assert.equal(d.folderName('Fortnite: Battle Royale?'), 'Fortnite Battle Royale');
  assert.equal(d.folderName('Any', 'HorizonZeroDawn'), 'HorizonZeroDawn');
  assert.equal(d.folderName('CON'), 'Game');
});

// ---- a fake Epic: catalogue, assets, manifests and chunks --------------------------
function build(files, version) {
  const { manifestPath, uploads } = packSave(
    Object.entries(files).map(([p, data]) => ({ path: p, data })),
    { appName: 'Fennec', accountId: '', cloudFolder: '', date: new Date(Date.UTC(2026, 0, version)) }
  );
  return { manifest: uploads.get(manifestPath), uploads };
}
function fakeEpic() {
  const base = 'https://egs-cloudfront-chunks.epicgamescdn.com/Builds/Org/CloudDir';
  const srv = { builds: [], current: null, fetched: [], failChunks: 0 };
  srv.publish = (files, version) => {
    const b = build(files, version);
    srv.current = { ...b, version: `1.${version}` };
    for (const [p, bytes] of b.uploads) srv.builds.push([`${base}/${p}`, bytes]);
    srv.builds.push([`${base}/v${version}.manifest`, b.manifest]);
  };
  const ok = (body, type = 'json') => ({
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    type,
  });
  srv.fetch = async url => {
    srv.fetched.push(url);
    if (url.includes('/launcher/api/public/assets/'))
      return ok({
        elements: [
          {
            appName: 'Fennec',
            buildVersion: srv.current.version,
            hash: 'abc',
            manifests: [
              {
                uri: `${base}/v${srv.current.version.split('.')[1]}.manifest`,
                queryParams: [{ name: 't', value: '1' }],
              },
            ],
          },
        ],
      });
    if (url.includes('/bulk/items'))
      return ok({ item1: { title: 'Fennec', customAttributes: { FolderName: { value: 'Fennec' } } } });
    const clean = url.split('?')[0];
    if (clean.endsWith('.chunk') && srv.failChunks > 0) {
      srv.failChunks--;
      return { ok: false, status: 503 };
    }
    const hit = srv.builds.find(([u]) => u === clean);
    return hit ? ok(hit[1]) : { ok: false, status: 404 };
  };
  return srv;
}
function epicCtx(dir, game) {
  const toasts = [];
  const settings = { epicInstallRoot: path.join(dir, 'Games') };
  const ctx = {
    settings,
    storage: { saveSettings() {}, file: n => path.join(dir, 'userdata', n) },
    library: { games: [game], scanLocal: async () => {}, local: {} },
    accounts: {
      connected: p => (p === 'epic' ? [{ id: ACCOUNT, key: 'epic:' + ACCOUNT }] : []),
      tokens: { accessToken: async () => 'tok' },
    },
    hub: { publish() {} },
    log: { info() {}, warn() {}, debug() {} },
    toast: m => toasts.push(m),
    mainWindow: () => null,
  };
  return { ctx, toasts };
}
const ownedGame = () => ({
  id: 'epic:fennec',
  name: 'Fennec',
  offers: [
    { provider: 'epic', appId: 'Fennec', namespace: 'ns', itemId: 'item1', owned: true, accountId: ACCOUNT },
  ],
});
function withProgramData(dir, fn) {
  const before = process.env.ProgramData;
  process.env.ProgramData = path.join(dir, 'ProgramData');
  return fn().finally(() => {
    if (before === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = before;
  });
}

test('Epic: a game is downloaded, checked and registered like the Epic launcher does', () => {
  const dir = tmp();
  return withProgramData(dir, async () => {
    const files = {
      'Game.exe': rnd(1536 * 1024),
      'Data/pak0.pak': rnd(300 * 1024),
      'Data/readme.txt': Buffer.from('hello'),
    };
    const srv = fakeEpic();
    srv.publish(files, 1);
    srv.failChunks = 1; // one CDN hiccup is retried
    const { ctx, toasts } = epicCtx(dir, ownedGame());
    const e = new EpicInstaller(ctx, { fetcher: srv.fetch });
    const asked = [];
    const original = electron.dialog.showMessageBox;
    electron.dialog.showMessageBox = async (_w, o) => (asked.push(o), { response: 0 });
    try {
      assert.deepEqual(await e.install('epic:fennec'), { how: 'started' });
    } finally {
      electron.dialog.showMessageBox = original;
    }
    assert.match(asked[0].detail, /без Epic Games Launcher/);
    assert.equal(e.progress()['epic:fennec'].nexus, true);
    await e.jobs.get('epic:fennec')?.running;
    const root = path.join(dir, 'Games', 'Fennec');
    for (const [name, data] of Object.entries(files))
      assert.ok(fs.readFileSync(path.join(root, name)).equals(data), name);
    // Registered: .item for the launchers, the manifest in .egstore, LauncherInstalled.dat.
    const items = fs.readdirSync(
      path.join(dir, 'ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
    );
    assert.equal(items.length, 1);
    const item = JSON.parse(
      fs.readFileSync(
        path.join(dir, 'ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests', items[0]),
        'utf8'
      )
    );
    assert.equal(item.AppName, 'Fennec');
    assert.equal(item.InstallLocation, root);
    assert.equal(item.AppVersionString, '1.1');
    assert.equal(item.bIsIncompleteInstall, false);
    assert.equal(item.CatalogNamespace, 'ns');
    assert.ok(fs.existsSync(path.join(root, '.egstore', `${item.InstallationGuid}.manifest`)));
    assert.ok(!fs.existsSync(path.join(root, '.egstore', 'nexus-download.json')), 'progress file removed');
    const dat = JSON.parse(
      fs.readFileSync(
        path.join(dir, 'ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'),
        'utf8'
      )
    );
    assert.deepEqual(
      dat.InstallationList.map(x => [x.AppName, x.InstallLocation, x.AppVersion]),
      [['Fennec', root, '1.1']]
    );
    assert.equal(e.jobs.size, 0);
    assert.deepEqual(ctx.settings.epicJobs, {});
    assert.match(toasts.at(-1), /установлена/);
    // The manifest URL keeps its signature; chunks come from its folder.
    assert.ok(srv.fetched.some(u => u.endsWith('v1.manifest?t=1')));
  });
});

test('Epic: pause and continue (also after a restart) without downloading parts twice', () => {
  const dir = tmp();
  return withProgramData(dir, async () => {
    const files = { 'a.bin': rnd(14 * 1024 * 1024 + 5), 'b.bin': rnd(700 * 1024) };
    const srv = fakeEpic();
    srv.publish(files, 1);
    const { ctx } = epicCtx(dir, ownedGame());
    let e = new EpicInstaller(ctx, { fetcher: srv.fetch });
    // Every chunk download fails: the job stops with an error after the retries…
    srv.failChunks = 1000;
    await e.install('epic:fennec');
    await e.jobs.get('epic:fennec').running;
    assert.equal(e.progress()['epic:fennec'].state, 'error');
    assert.match(e.progress()['epic:fennec'].error, /не скачалась/);
    // …and continues after a restart of Nexus (the job is kept in the settings).
    srv.failChunks = 0;
    e = new EpicInstaller(ctx, { fetcher: srv.fetch });
    e.init();
    assert.equal(e.progress()['epic:fennec'].state, 'paused');
    // Pause right after the first chunk.
    const realFetch = srv.fetch;
    let job;
    e.fetch = async (u, o) => {
      const r = await realFetch(u, o);
      if (u.endsWith('.chunk') && job) job.pause = true;
      return r;
    };
    e.resume('epic:fennec');
    job = e.jobs.get('epic:fennec');
    await job.running;
    assert.equal(e.progress()['epic:fennec'].state, 'paused');
    const firstRound = srv.fetched.filter(u => u.endsWith('.chunk')).length;
    e.fetch = realFetch;
    e.resume('epic:fennec');
    await e.jobs.get('epic:fennec')?.running;
    assert.equal(e.jobs.size, 0);
    for (const [name, data] of Object.entries(files))
      assert.ok(fs.readFileSync(path.join(dir, 'Games', 'Fennec', name)).equals(data), name);
    // Chunks done before the pause were not fetched again.
    const chunks = srv.fetched.filter(u => u.endsWith('.chunk'));
    const unique = new Set(chunks);
    assert.ok(chunks.length - firstRound <= unique.size, 'no chunk twice after the pause');
  });
});

test('Epic: an update downloads only changed files and removes old ones; repair fixes damaged files', () => {
  const dir = tmp();
  return withProgramData(dir, async () => {
    const same = rnd(1100 * 1024);
    const v1 = { 'Game.exe': rnd(200 * 1024), 'Data/same.pak': same, 'Data/old.txt': Buffer.from('old') };
    const srv = fakeEpic();
    srv.publish(v1, 1);
    const game = ownedGame();
    const { ctx, toasts } = epicCtx(dir, game);
    const e = new EpicInstaller(ctx, { fetcher: srv.fetch });
    await e.install('epic:fennec');
    await e.jobs.get('epic:fennec').running;
    const root = path.join(dir, 'Games', 'Fennec');
    const itemDir = path.join(dir, 'ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    const itemFile = path.join(itemDir, fs.readdirSync(itemDir)[0]);
    const guid = JSON.parse(fs.readFileSync(itemFile, 'utf8')).InstallationGuid;
    // The library now sees it installed (as the scan would report it).
    Object.assign(game.offers[0], {
      installed: true,
      installLocation: root,
      manifestFile: itemFile,
      version: '1.1',
    });
    // Build 1.2: Game.exe changed, a new file, old.txt gone, same.pak unchanged.
    const v2 = { 'Game.exe': rnd(210 * 1024), 'Data/same.pak': same, 'Data/new.txt': Buffer.from('new') };
    srv.publish(v2, 2);
    assert.deepEqual(await e.checkUpdates(), { 'epic:fennec': '1.2' });
    srv.fetched.length = 0;
    await e.update('epic:fennec');
    await e.jobs.get('epic:fennec')?.running;
    for (const [name, data] of Object.entries(v2))
      assert.ok(fs.readFileSync(path.join(root, name)).equals(data), name);
    assert.equal(fs.existsSync(path.join(root, 'Data', 'old.txt')), false);
    // same.pak (1.1 MiB = 2 chunks) was not downloaded again.
    assert.ok(srv.fetched.filter(u => u.endsWith('.chunk')).length <= 2);
    const item = JSON.parse(fs.readFileSync(itemFile, 'utf8'));
    assert.equal(item.AppVersionString, '1.2');
    assert.equal(item.InstallationGuid, guid, 'same installation');
    assert.deepEqual(e.updatesMap(), {});
    assert.match(toasts.at(-1), /обновлена/);
    // Repair: a damaged file is found by its SHA-1 and downloaded again.
    fs.writeFileSync(path.join(root, 'Game.exe'), 'broken');
    await e.repair('epic:fennec');
    await e.jobs.get('epic:fennec')?.running;
    assert.ok(fs.readFileSync(path.join(root, 'Game.exe')).equals(v2['Game.exe']));
    assert.match(toasts.at(-1), /проверены/);
    assert.equal(
      fs.readdirSync(root, { recursive: true }).filter(n => String(n).endsWith('.nexus-new')).length,
      0,
      'no temporary files left'
    );
  });
});

test('Epic: no install into Program Files; the launcher can still be chosen; cancel removes files', () => {
  const dir = tmp();
  return withProgramData(dir, async () => {
    const srv = fakeEpic();
    srv.publish({ 'Game.exe': rnd(10) }, 1);
    const { ctx } = epicCtx(dir, ownedGame());
    const e = new EpicInstaller(ctx, { fetcher: srv.fetch });
    assert.match(await e.folderProblem('C:\\Program Files\\Epic Games', 1), /Program Files/);
    assert.match(await e.folderProblem('\\\\server\\share', 1), /Сетевые/);
    const original = electron.dialog.showMessageBox;
    electron.dialog.showMessageBox = async () => ({ response: 2 });
    try {
      assert.deepEqual(await e.install('epic:fennec'), { how: 'client' });
    } finally {
      electron.dialog.showMessageBox = original;
    }
    assert.equal(e.jobs.size, 0);
    // Cancel of a paused install deletes the downloaded files.
    await e.install('epic:fennec');
    const job = e.jobs.get('epic:fennec');
    job.pause = true;
    await job.running;
    electron.dialog.showMessageBox = async () => ({ response: 0 });
    try {
      assert.equal(await e.cancel('epic:fennec'), true);
    } finally {
      electron.dialog.showMessageBox = original;
    }
    assert.equal(fs.existsSync(path.join(dir, 'Games', 'Fennec')), false);
    assert.deepEqual(ctx.settings.epicJobs, {});
  });
});

// ---- Steam ---------------------------------------------------------------------------
test('Steam: the appmanifest Steam picks up, libraries and app info', async () => {
  const acf = appManifest({
    appId: '620',
    name: 'Portal "2"',
    installdir: 'Portal 2',
    owner: '76561198000000010',
  });
  const v = parseVdf(acf).AppState;
  assert.equal(v.appid, '620');
  assert.equal(v.name, 'Portal "2"');
  assert.equal(v.StateFlags, '1026');
  assert.equal(v.installdir, 'Portal 2');
  assert.equal(v.LastOwner, '76561198000000010');
  assert.equal(installDirName('Half-Life: Alyx?'), 'Half-Life Alyx');
  const info = parseAppInfo({
    common: { name: 'Portal 2' },
    config: { installdir: 'Portal 2' },
    depots: {
      621: {
        config: { oslist: 'windows' },
        manifests: { public: { gid: '1', size: '1000', download: '600' } },
      },
      622: { config: { oslist: 'macos' }, manifests: { public: { size: '5000' } } },
      623: { config: { language: 'german' }, manifests: { public: { size: '7000' } } },
      branches: {},
    },
  });
  assert.deepEqual(info, { name: 'Portal 2', installdir: 'Portal 2', size: 1000, download: 600 });
  const root = tmp(),
    second = tmp();
  fs.mkdirSync(path.join(root, 'steamapps'));
  fs.mkdirSync(path.join(second, 'steamapps'));
  fs.writeFileSync(
    path.join(root, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${root.replace(/\\/g, '\\\\')}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${second.replace(/\\/g, '\\\\')}"\n\t}\n}\n`
  );
  const libs = await steamLibraries([root]);
  assert.deepEqual(libs.map(l => l.path).sort(), [path.resolve(root), path.resolve(second)].sort());
  assert.ok(libs.every(l => l.free > 0));
});

test('Steam: install writes the appmanifest and starts Steam hidden (restarting an open Steam)', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'steamapps'));
  const calls = [];
  let steamOpen = true;
  const game = {
    id: 'steam:620',
    name: 'Portal 2',
    offers: [{ provider: 'steam', appId: '620', owned: true, accountId: '76561198000000010' }],
  };
  const ctx = {
    library: { games: [game], local: { steamRoots: [root] }, expectChange: ms => calls.push(['expect', ms]) },
    accounts: { connected: () => [{ id: '76561198000000010' }] },
    actions: {
      steamExe: () => path.join(root, 'steam-missing.exe'),
      processRunning: async () => {
        const was = steamOpen;
        if (calls.some(c => c[0] === 'stop')) steamOpen = false;
        return was;
      },
      runningSteamApp: async () => '0',
    },
    log: { info() {}, warn() {}, debug() {} },
    mainWindow: () => null,
  };
  class FakeSteamUser extends require('node:events') {
    static EConnectionProtocol = { WebSocket: 2 };
    logOn(d) {
      this.d = d;
      setImmediate(() => this.emit('loggedOn'));
    }
    async getProductInfo(apps) {
      return {
        apps: {
          [apps[0]]: {
            appinfo: {
              common: { name: 'Portal 2' },
              config: { installdir: 'Portal 2' },
              depots: { 621: { manifests: { public: { size: '1000' } } } },
            },
          },
        },
      };
    }
    logOff() {}
  }
  const s = new SteamInstaller(ctx, { SteamUserImpl: FakeSteamUser });
  s.stopSteam = async () => calls.push(['stop']);
  s.startSteam = exe => calls.push(['start', exe]);
  const original = electron.dialog.showMessageBox;
  const asked = [];
  electron.dialog.showMessageBox = async (_w, o) => (asked.push(o), { response: 0 });
  try {
    assert.deepEqual(await s.install('steam:620'), { how: 'steam-download' });
  } finally {
    electron.dialog.showMessageBox = original;
    s.stop();
  }
  assert.match(asked[0].detail, /перезапустит его в фоне/);
  assert.match(asked[0].buttons[0], /свободно/);
  const v = parseVdf(fs.readFileSync(path.join(root, 'steamapps', 'appmanifest_620.acf'), 'utf8')).AppState;
  assert.equal(v.installdir, 'Portal 2');
  assert.equal(v.StateFlags, '1026');
  assert.deepEqual(
    calls.map(c => c[0]),
    ['stop', 'start', 'expect']
  );
  // Already known to Steam (started or paused there): Steam continues it, nothing is written.
  game.offers[0].installed = false;
  electron.dialog.showMessageBox = async () => ({ response: 0 });
  try {
    assert.deepEqual(await s.install('steam:620'), { how: 'client' });
  } finally {
    electron.dialog.showMessageBox = original;
  }
});

test('Steam: a running Steam game or a missing Steam hands the install to Steam itself', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'steamapps'));
  const game = { id: 'steam:1', name: 'X', offers: [{ provider: 'steam', appId: '1', owned: true }] };
  const ctx = {
    library: { games: [game], local: { steamRoots: [root] }, expectChange() {} },
    accounts: { connected: () => [] },
    actions: {
      steamExe: () => 'C:\\Steam\\steam.exe',
      processRunning: async () => true,
      runningSteamApp: async () => '730',
    },
    log: { info() {}, warn() {}, debug() {} },
  };
  const s = new SteamInstaller(ctx);
  s.appInfo = async () => ({ name: 'X', installdir: 'X', size: 0, download: 0 });
  assert.deepEqual(await s.install('steam:1'), { how: 'client' });
  ctx.actions.steamExe = () => null;
  assert.deepEqual(await s.install('steam:1'), { how: 'client' });
  assert.equal(fs.readdirSync(path.join(root, 'steamapps')).length, 0);
});
