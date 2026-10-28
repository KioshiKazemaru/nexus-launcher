// Download / install progress of Steam and Epic Games. Run via `npm test`.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { steamProgress, scanEpicPending } = require('../src/core.cjs');

test('Steam: download first, then the installation stage, as the Steam client shows it', () => {
  const downloading = steamProgress({ StateFlags: '1026', BytesToDownload: '1000', BytesDownloaded: '250' });
  assert.deepEqual(downloading.progress, { state: 'downloading', percent: 25, done: 250, total: 1000 });
  const installing = steamProgress({
    StateFlags: '1026',
    BytesToDownload: '1000',
    BytesDownloaded: '1000',
    BytesToStage: '2000',
    BytesStaged: '1500',
  });
  assert.deepEqual(installing.progress, { state: 'installing', percent: 75, done: 1500, total: 2000 });
  assert.equal(
    steamProgress({ StateFlags: '1538', BytesToDownload: '10', BytesDownloaded: '1' }).progress.state,
    'paused'
  );
  assert.deepEqual(steamProgress({ StateFlags: '4', BytesToDownload: '10', BytesDownloaded: '10' }), {});
});

test('Epic: installations of the Epic launcher (Manifests\Pending) with progress from the written bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-epic-pending-'));
  try {
    const manifests = path.join(dir, 'Manifests');
    fs.mkdirSync(path.join(manifests, 'Pending'), { recursive: true });
    // A new installation: 300 of 1000 bytes written.
    const game = path.join(dir, 'Games', 'Citizen');
    fs.mkdirSync(path.join(game, '.egstore', 'bps'), { recursive: true });
    fs.writeFileSync(path.join(game, 'data.pak'), Buffer.alloc(200));
    fs.writeFileSync(path.join(game, '.egstore', 'bps', 'chunk'), Buffer.alloc(100));
    fs.writeFileSync(
      path.join(manifests, 'Pending', 'A.item'),
      JSON.stringify({
        AppName: 'citizen',
        DisplayName: 'Citizen Sleeper',
        InstallLocation: game,
        StagingLocation: path.join(game, '.egstore', 'bps'),
        InstallSize: 1000,
        CatalogNamespace: 'ns',
        CatalogItemId: 'it',
        MainGameAppName: 'citizen',
      })
    );
    // An update of an installed game: only the staged amount is known.
    const other = path.join(dir, 'Games', 'Other');
    fs.mkdirSync(path.join(other, '.egstore', 'bps'), { recursive: true });
    fs.writeFileSync(path.join(other, 'old.pak'), Buffer.alloc(5000));
    fs.writeFileSync(path.join(other, '.egstore', 'bps', 'new'), Buffer.alloc(64));
    fs.writeFileSync(
      path.join(manifests, 'Pending', 'B.item'),
      JSON.stringify({ AppName: 'other', DisplayName: 'Other', InstallLocation: other, InstallSize: 9000 })
    );
    // DLC of another game and broken files are ignored.
    fs.writeFileSync(
      path.join(manifests, 'Pending', 'C.item'),
      JSON.stringify({ AppName: 'dlc', MainGameAppName: 'other', InstallLocation: other })
    );
    fs.writeFileSync(path.join(manifests, 'Pending', 'D.item'), '{broken');
    const list = await scanEpicPending(manifests, new Set(['other']));
    const byApp = Object.fromEntries(list.map(o => [o.appId, o]));
    assert.deepEqual(Object.keys(byApp).sort(), ['citizen', 'other']);
    assert.deepEqual(byApp.citizen.progress, { state: 'downloading', percent: 30, done: 300, total: 1000 });
    assert.equal(byApp.citizen.installed, false);
    assert.equal(byApp.citizen.name, 'Citizen Sleeper');
    assert.deepEqual(byApp.other.progress, { state: 'updating', done: 64 });
    assert.equal(byApp.other.installed, true);
    assert.deepEqual(await scanEpicPending(path.join(dir, 'missing')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('speed and time left come from two scans', () => {
  const { LibraryService } = require('../src/main/library.cjs');
  const offer = (done, state = 'downloading') => ({
    provider: 'epic',
    appId: 'x',
    progress: { state, done, total: 1000 },
  });
  const first = LibraryService.progressMap({ offers: [offer(100)] }, {}, 0);
  assert.equal(first['epic:x'].speed, undefined);
  const second = LibraryService.progressMap({ offers: [offer(300)] }, first, 2000);
  assert.equal(second['epic:x'].speed, 100, '200 bytes in 2 s');
  assert.equal(second['epic:x'].eta, 7, '700 bytes left at 100 B/s');
  assert.equal(second['epic:x'].provider, 'epic');
  const third = LibraryService.progressMap({ offers: [offer(700)] }, second, 4000);
  assert.equal(third['epic:x'].speed, 150, 'smoothed: (100 + 200) / 2');
  // Another stage starts a new measurement.
  assert.equal(
    LibraryService.progressMap({ offers: [offer(800, 'installing')] }, third, 6000)['epic:x'].speed,
    undefined
  );
});

test('Epic: sizes like the Epic launcher — download size from the build manifest, size on disk apart', async () => {
  const { writeManifest } = require('../src/epic-saves.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-epic-build-'));
  try {
    const manifests = path.join(dir, 'Manifests');
    fs.mkdirSync(path.join(manifests, 'Pending'), { recursive: true });
    const game = path.join(dir, 'Control');
    fs.mkdirSync(path.join(game, '.egstore', 'Pending'), { recursive: true });
    // The build: 2000 bytes on disk, downloaded as 500 compressed bytes.
    const guid = [1, 2, 3, 4];
    const build = writeManifest({
      appName: 'control',
      buildVersion: '1',
      chunks: [{ guid, hash: 1n, sha: Buffer.alloc(20), groupNum: 1, windowSize: 2000, fileSize: 500 }],
      files: [{ filename: 'game.pak', hash: Buffer.alloc(20), parts: [{ guid, offset: 0, size: 2000 }] }],
    });
    const manifestPath = path.join(game, '.egstore', 'Pending', 'X.manifest');
    fs.writeFileSync(manifestPath, build);
    fs.mkdirSync(path.join(game, '.egstore', 'bps', 'f'), { recursive: true });
    // Half of the game data is written (the manifest file itself also lies in the folder).
    fs.writeFileSync(path.join(game, '.egstore', 'bps', 'f', 'A'), Buffer.alloc(1000 - build.length));
    fs.writeFileSync(
      path.join(manifests, 'Pending', 'X.item'),
      JSON.stringify({
        AppName: 'control',
        DisplayName: 'Control',
        InstallLocation: game,
        InstallSize: 999999, // Epic's own number is not needed when the manifest is there
        PendingManifestPath: manifestPath,
      })
    );
    const [o] = await scanEpicPending(manifests);
    assert.deepEqual(o.progress, {
      state: 'downloading',
      percent: 50,
      done: 250,
      total: 500,
      installSize: 2000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
