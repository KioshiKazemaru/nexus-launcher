const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const s = require('../src/epic-saves.cjs');
const api = require('../src/epic-games-api.cjs');

// Packed by the Legendary launcher's own code (savegame_helper.package_savegame):
// "Slot 1/progress.ini" (with Cyrillic text) and "meta.bin".
const FIXTURE = path.join(__dirname, 'fixtures', 'legendary-save');

test('rolling hash equals the one of Epic / Legendary', () => {
  assert.equal(s.rollingHash(Buffer.from('Nexus Launcher')), 0x3203a8200f47ffb9n);
  assert.equal(s.rollingHash(Buffer.alloc(0)), 0n);
});

test('a save packed by Legendary is read and restored byte for byte', () => {
  const mdir = path.join(FIXTURE, 'manifests');
  const name = fs.readdirSync(mdir)[0];
  const m = s.readManifest(fs.readFileSync(path.join(mdir, name)));
  assert.equal(m.meta.appName, 'LegApp' + 'b'.repeat(32));
  assert.equal(m.meta.buildVersion, '2026.10.15-20.01.02');
  assert.deepEqual(m.custom, { CloudSaveFolder: '{UserDir}/My Games/Leg' });
  assert.equal(m.chunks.length, 1);
  const chunkFile = path.join(FIXTURE, m.chunks[0].path);
  assert.ok(fs.existsSync(chunkFile), 'chunk path computed like Legendary: ' + m.chunks[0].path);
  const chunk = s.readChunk(fs.readFileSync(chunkFile));
  assert.equal(s.rollingHash(chunk.data), m.chunks[0].hash);
  const files = s.unpackSave(m, new Map([[s.guidKey(chunk.guid), chunk.data]]));
  const byPath = Object.fromEntries(files.map(f => [f.path, f.data]));
  assert.equal(byPath['Slot 1/progress.ini'].toString('utf8'), 'level=7\nname=Игрок\n');
  assert.deepEqual([...byPath['meta.bin']], [1, 2, 3, 0, 255]);
  assert.equal(s.manifestDate(name), Date.UTC(2026, 9, 15, 20, 1, 2));
});

test('pack → unpack round trip: big files span chunks, names keep Unicode, corruption is detected', () => {
  const big = crypto.randomBytes(2.5 * 1024 * 1024);
  const files = [
    { path: 'Профиль/игрок.sav', data: crypto.randomBytes(700 * 1024) },
    { path: 'big.dat', data: big },
    { path: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
  const { manifestPath, uploads } = s.packSave(files, {
    appName: 'App',
    accountId: 'a'.repeat(32),
    cloudFolder: '{AppData}/Game',
    date,
  });
  assert.equal(manifestPath, 'manifests/2026.01.02-03.04.05.manifest');
  const m = s.readManifest(uploads.get(manifestPath));
  assert.equal(m.chunks.length, 4, '3.2 MiB of data → 4 chunks of 1 MiB');
  for (const c of m.chunks) assert.match(c.path, /^ChunksV4\/\d{2}\/[0-9A-F]{16}_[0-9A-F]{32}\.chunk$/);
  const chunks = new Map();
  for (const c of m.chunks) {
    const ch = s.readChunk(uploads.get(c.path));
    chunks.set(s.guidKey(ch.guid), ch.data);
  }
  const out = s.unpackSave(m, chunks);
  assert.deepEqual(
    out.map(f => f.path),
    ['big.dat', 'empty.txt', 'Профиль/игрок.sav']
  );
  assert.ok(out[0].data.equals(big));
  // A damaged chunk never reaches the disk.
  const [first] = chunks.keys();
  chunks.set(first, Buffer.alloc(chunks.get(first).length));
  assert.throws(() => s.unpackSave(m, chunks), /повреждён/);
  chunks.delete(first);
  assert.throws(() => s.unpackSave(m, chunks), /не хватает/);
  assert.throws(() => s.readManifest(Buffer.from('nope')), /не манифест|конец данных/);
});

test('save folder of the game metadata: known variables only', () => {
  const vars = {
    installdir: 'D:/Games/Foo',
    epicid: 'abc',
    appdata: 'C:/Users/U/AppData/Local',
    userdir: 'C:/Users/U/Documents',
    userprofile: 'C:/Users/U',
    usersavedgames: 'C:/Users/U/Saved Games',
  };
  assert.equal(
    s.resolveSaveFolder('{AppData}\\Foo\\Saved\\{EpicId}', vars),
    'C:/Users/U/AppData/Local/Foo/Saved/abc'
  );
  assert.equal(s.resolveSaveFolder('{UserDir}/My Games/Foo', vars), 'C:/Users/U/Documents/My Games/Foo');
  assert.equal(s.resolveSaveFolder('{InstallDir}/Saves', vars), 'D:/Games/Foo/Saves');
  assert.equal(s.resolveSaveFolder('{Unknown}/x', vars), null, 'an unknown variable is not guessed');
  assert.equal(s.resolveSaveFolder('', vars), null);
});

test('include / exclude filters of the game metadata', () => {
  const files = ['Saves/a.sav', 'Saves/b.sav', 'Logs/log.txt', 'Config/Engine.ini', 'shader.cache'];
  assert.deepEqual(s.filterSaveFiles(files, { include: 'Saves/,Config/*.ini' }), [
    'Saves/a.sav',
    'Saves/b.sav',
    'Config/Engine.ini',
  ]);
  assert.deepEqual(s.filterSaveFiles(files, { exclude: 'Logs/,.cache' }), [
    'Saves/a.sav',
    'Saves/b.sav',
    'Config/Engine.ini',
  ]);
  assert.deepEqual(s.filterSaveFiles(files, {}), files);
});

test('sync decisions: newer side wins, both changed is a conflict, first sync compares times', () => {
  const remote = '2026.10.15-20.00.00.manifest';
  const remoteTime = s.manifestDate(remote);
  assert.equal(s.syncDecision({ localTime: 0, remote: null }), 'none');
  assert.equal(s.syncDecision({ localTime: 5, remote: null }), 'upload');
  assert.equal(s.syncDecision({ localTime: 0, remote }), 'download');
  // first sync on this PC
  assert.equal(s.syncDecision({ localTime: remoteTime + 3600000, remote }), 'upload');
  assert.equal(s.syncDecision({ localTime: remoteTime - 3600000, remote }), 'download');
  assert.equal(s.syncDecision({ localTime: remoteTime + 30000, remote }), 'same');
  // after a sync
  const lastSync = { manifest: remote, localTime: 1000 };
  assert.equal(s.syncDecision({ localTime: 1000, remote, lastSync }), 'same');
  assert.equal(s.syncDecision({ localTime: 99999, remote, lastSync }), 'upload');
  assert.equal(
    s.syncDecision({ localTime: 1000, remote: '2026.10.16-08.00.00.manifest', lastSync }),
    'download'
  );
  assert.equal(
    s.syncDecision({ localTime: 99999, remote: '2026.10.16-08.00.00.manifest', lastSync }),
    'conflict',
    'played elsewhere and here since the last sync'
  );
});

test('launch arguments are the ones the Epic launcher passes; commands keep quoted parts', () => {
  assert.deepEqual(api.splitArgs('-nolauncher "-ini:Game:[/Script]:Path=C:\\My Games" -x'), [
    '-nolauncher',
    '-ini:Game:[/Script]:Path=C:\\My Games',
    '-x',
  ]);
  const args = api.launchArgs({
    appName: 'Potoo',
    namespace: 'ns',
    accountId: 'a'.repeat(32),
    displayName: 'Игрок',
    loginCode: 'c0de',
    ovtPath: 'C:/t/x.ovt',
    launchCommand: '-ClientVersion=1',
    extraArgs: '-skipintro',
  });
  assert.deepEqual(args, [
    '-ClientVersion=1',
    '-skipintro',
    '-AUTH_LOGIN=unused',
    '-AUTH_PASSWORD=c0de',
    '-AUTH_TYPE=exchangecode',
    '-epicapp=Potoo',
    '-epicenv=Prod',
    '-epicovt=C:/t/x.ovt',
    '-EpicPortal',
    '-epicusername=Игрок',
    '-epicuserid=' + 'a'.repeat(32),
    '-epiclocale=ru',
    '-epicsandboxid=ns',
  ]);
  assert.deepEqual(
    api.launchInfo({
      customAttributes: {
        CloudSaveFolder: { value: '{AppData}/X' },
        ThirdPartyManagedApp: { value: 'The EA App' },
        CanRunOffline: { value: 'false' },
      },
    }),
    {
      cloudFolder: '{AppData}/X',
      include: '',
      exclude: '',
      extraArgs: '',
      thirdParty: 'The EA App',
      canRunOffline: false,
    }
  );
  const files = {
    'x/u/app/manifests/2026.01.01-00.00.00.manifest': {},
    'x/u/app/manifests/2026.10.15-20.01.02.manifest': {},
    'x/u/app/ChunksV4/01/A_B.chunk': {},
  };
  assert.deepEqual(api.latestManifest(files), {
    path: 'x/u/app/manifests/2026.10.15-20.01.02.manifest',
    name: '2026.10.15-20.01.02.manifest',
  });
  assert.equal(
    api.chunkRemotePath('x/u/app/manifests/2026.10.15-20.01.02.manifest', 'ChunksV4/01/A_B.chunk'),
    'x/u/app/ChunksV4/01/A_B.chunk'
  );
});
