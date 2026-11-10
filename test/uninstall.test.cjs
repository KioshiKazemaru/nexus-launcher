// Removing games right in Nexus: what gets deleted for Steam and Epic, and the
// guards that keep anything else untouched. Run via `npm test`.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const electron = require('electron');
const { Uninstaller, folderRisk } = require('../src/main/uninstall.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-uninstall-'));
const write = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const exists = p => fs.existsSync(p);

function setup(games, extra = {}) {
  const toasts = [],
    scans = [];
  const ctx = {
    log: { info() {}, warn() {} },
    toast: m => toasts.push(m),
    hub: { publish() {} },
    settings: {},
    library: { games, scanLocal: async () => scans.push(1) },
    mainWindow: () => null,
    ...extra,
  };
  const u = new Uninstaller(ctx);
  u.closeEpicLauncher = async () => null; // never touches the real Epic launcher
  u.startEpicLauncher = () => {};
  return { u, toasts, scans, ctx };
}
async function answer(response, fn) {
  const original = electron.dialog.showMessageBox;
  const asked = [];
  electron.dialog.showMessageBox = async (_w, o) => (asked.push(o), { response });
  try {
    return { result: await fn(), asked };
  } finally {
    electron.dialog.showMessageBox = original;
  }
}
async function finished(u) {
  for (let i = 0; i < 200 && u.jobs.size; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(u.jobs.size, 0, 'removal did not finish');
}

// These cases use Windows paths (C:\…, \\server\share): Node resolves them only on Windows.
const WINDOWS_PATHS = { skip: process.platform !== 'win32' && 'Windows paths: runs on Windows only' };

test(
  'folder guard: drive roots, system/user folders and folders with other games are refused',
  WINDOWS_PATHS,
  () => {
    const env = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\U', ProgramFiles: 'C:\\Program Files' };
    assert.match(folderRisk('', [], env), /неизвестна/);
    assert.match(folderRisk('relative\\dir', [], env), /неизвестна/);
    assert.match(folderRisk('D:\\', [], env), /корень/);
    assert.match(folderRisk('C:\\Windows', [], env), /системная/);
    assert.match(folderRisk('C:\\Users', [], env), /системная/); // holds the profile
    assert.match(folderRisk('C:\\Program Files', [], env), /системная/);
    assert.match(folderRisk('D:\\Games', ['D:\\Games\\Other'], env), /другая игра/);
    assert.match(folderRisk('D:\\Games\\A', ['d:\\games\\a'], env), /другая игра/);
    assert.equal(
      folderRisk('C:\\Program Files\\Epic Games\\Control', ['C:\\Program Files\\Epic Games\\Other'], env),
      ''
    );
    assert.equal(folderRisk('D:\\Games\\A', ['D:\\Games\\AB'], env), '');
  }
);

test('Steam: deletes the game folder, its manifest, workshop and shader cache; other games stay', async () => {
  const lib = tmp();
  const steamapps = path.join(lib, 'steamapps');
  const dir = path.join(steamapps, 'common', 'Game');
  write(path.join(dir, 'game.exe'), 'a'.repeat(1000));
  write(path.join(dir, 'data', 'pak0.pak'), 'b'.repeat(3000));
  write(path.join(steamapps, 'appmanifest_10.acf'));
  write(path.join(steamapps, 'appworkshop_10.acf'));
  write(path.join(steamapps, 'workshop', 'content', '10', 'mod.bin'));
  write(path.join(steamapps, 'shadercache', '10', 'cache.bin'));
  write(path.join(steamapps, 'common', 'Other', 'other.exe'));
  write(path.join(steamapps, 'appmanifest_20.acf'));
  const offer = (id, d) => ({
    provider: 'steam',
    appId: id,
    installed: true,
    installDir: path.join(steamapps, 'common', d),
    manifestFile: path.join(steamapps, `appmanifest_${id}.acf`),
  });
  const games = [
    { id: 'steam:10', name: 'Game', offers: [offer('10', 'Game')] },
    { id: 'steam:20', name: 'Other', offers: [offer('20', 'Other')] },
  ];
  // Steam is open and idle: restarted in the tray so it rereads its library.
  const steamCalls = [];
  const { u, toasts, scans } = setup(games, {
    actions: {
      steamExe: () => 'C:\\Steam\\steam.exe',
      processRunning: async () => true,
      runningSteamApp: async () => '0',
    },
    steamInstall: {
      stopSteam: async () => steamCalls.push('stop'),
      startSteam: () => steamCalls.push('start'),
    },
  });
  const { result, asked } = await answer(0, () => u.uninstall('steam:10', 'steam'));
  assert.deepEqual(result, { how: 'started' });
  assert.equal(asked.length, 0, 'no question before removing');
  assert.equal(u.progress()['steam:10'].state, 'uninstalling');
  // Pressed again while it runs.
  assert.deepEqual(await u.uninstall('steam:10', 'steam'), { how: 'running' });
  await finished(u);
  assert.deepEqual(steamCalls, ['stop', 'start']);
  assert.equal(exists(dir), false);
  assert.equal(exists(path.join(steamapps, 'appmanifest_10.acf')), false);
  assert.equal(exists(path.join(steamapps, 'appworkshop_10.acf')), false);
  assert.equal(exists(path.join(steamapps, 'workshop', 'content', '10')), false);
  assert.equal(exists(path.join(steamapps, 'shadercache', '10')), false);
  assert.equal(exists(path.join(steamapps, 'common', 'Other', 'other.exe')), true);
  assert.equal(exists(path.join(steamapps, 'appmanifest_20.acf')), true);
  assert.equal(scans.length, 1);
  assert.match(toasts.at(-1), /«Game» удалена/);
  assert.deepEqual(u.progress(), {});
});

test('Epic: deletes the folder, the .item manifest and the LauncherInstalled.dat entry', async () => {
  const root = tmp();
  const original = process.env.ProgramData;
  process.env.ProgramData = path.join(root, 'ProgramData');
  try {
    const dat = path.join(root, 'ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
    write(
      dat,
      JSON.stringify({
        InstallationList: [
          { AppName: 'Fennec', InstallLocation: 'x' },
          { AppName: 'Keep', InstallLocation: 'y' },
        ],
      })
    );
    const manifests = path.join(root, 'Manifests');
    write(path.join(manifests, 'AAA.item'));
    write(path.join(manifests, 'BBB.item'));
    const dir = path.join(root, 'Epic Games', 'Fennec');
    write(path.join(dir, '.egstore', 'x.manifest'));
    write(path.join(dir, 'Game.exe'), 'z'.repeat(500));
    const games = [
      {
        id: 'epic:fennec',
        name: 'Fennec',
        offers: [
          {
            provider: 'epic',
            appId: 'Fennec',
            installed: true,
            installLocation: dir,
            manifestFile: path.join(manifests, 'AAA.item'),
          },
        ],
      },
    ];
    const { u, toasts } = setup(games);
    let closedLauncher = 0;
    const started = [];
    u.closeEpicLauncher = async () => (closedLauncher++, 'C:\\Epic\\EpicGamesLauncher.exe');
    u.startEpicLauncher = exe => started.push(exe);
    const { result, asked } = await answer(0, () => u.uninstall('epic:fennec', 'epic'));
    assert.deepEqual(result, { how: 'started' });
    assert.equal(asked.length, 0, 'no question before removing');
    await finished(u);
    assert.equal(closedLauncher, 1);
    // The launcher was open: started again in the tray afterwards.
    assert.deepEqual(started, ['C:\\Epic\\EpicGamesLauncher.exe']);
    assert.equal(exists(dir), false);
    assert.equal(exists(path.join(manifests, 'AAA.item')), false);
    assert.equal(exists(path.join(manifests, 'BBB.item')), true);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(dat, 'utf8')).InstallationList.map(x => x.AppName),
      ['Keep']
    );
    assert.match(toasts.at(-1), /«Fennec» удалена/);
  } finally {
    if (original === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = original;
  }
});

test('nothing is deleted when the game runs or for an unsafe folder', async () => {
  const lib = tmp();
  const steamapps = path.join(lib, 'steamapps');
  const dir = path.join(steamapps, 'common', 'Game');
  write(path.join(dir, 'game.exe'));
  write(path.join(steamapps, 'appmanifest_10.acf'));
  const offer = {
    provider: 'steam',
    appId: '10',
    installed: true,
    installDir: dir,
    manifestFile: path.join(steamapps, 'appmanifest_10.acf'),
  };
  const games = [{ id: 'steam:10', name: 'Game', offers: [offer] }];

  let s = setup(games, { running: { isRunning: id => id === 'steam:10' } });
  await assert.rejects(
    answer(0, () => s.u.uninstall('steam:10', 'steam')),
    /закройте игру/
  );

  // A folder outside steamapps\common is never removed.
  s = setup([{ id: 'steam:10', name: 'Game', offers: [{ ...offer, installDir: lib }] }]);
  await assert.rejects(
    answer(0, () => s.u.uninstall('steam:10', 'steam')),
    /не в библиотеке Steam/
  );
  // An Epic folder that holds another installed game.
  const epicDir = path.join(lib, 'Epic');
  s = setup([
    {
      id: 'epic:a',
      name: 'A',
      offers: [
        {
          provider: 'epic',
          appId: 'A',
          installed: true,
          installLocation: epicDir,
          manifestFile: path.join(lib, 'a.item'),
        },
      ],
    },
    {
      id: 'epic:b',
      name: 'B',
      offers: [{ provider: 'epic', installed: true, installLocation: path.join(epicDir, 'B') }],
    },
  ]);
  await assert.rejects(
    answer(0, () => s.u.uninstall('epic:a', 'epic')),
    /другая игра/
  );
  // Not installed / manual game.
  await assert.rejects(s.u.uninstall('epic:zzz', 'epic'), /не установлена/);
  assert.equal(exists(path.join(dir, 'game.exe')), true);
  assert.equal(exists(path.join(steamapps, 'appmanifest_10.acf')), true);
});

test('a removal that stopped half way keeps "Удалить снова", also after a restart', async () => {
  const lib = tmp();
  const steamapps = path.join(lib, 'steamapps');
  const dir = path.join(steamapps, 'common', 'Game');
  write(path.join(dir, 'game.exe'), 'a'.repeat(100));
  write(path.join(steamapps, 'appmanifest_10.acf'));
  const offer = {
    provider: 'steam',
    appId: '10',
    installed: true,
    installDir: dir,
    manifestFile: path.join(steamapps, 'appmanifest_10.acf'),
  };
  const games = [{ id: 'steam:10', name: 'Game', offers: [offer] }];
  let saved = 0;
  const { u, toasts, ctx } = setup(games, { storage: { saveSettings: () => saved++ } });
  const realRemove = u.removeFolder.bind(u);
  u.removeFolder = async () => {
    throw Error('файл занят другой программой: game.exe');
  };
  assert.deepEqual(await u.uninstall('steam:10', 'steam'), { how: 'started' });
  await finished(u);
  // The manifest is gone (Steam counts the game as removed); the folder is still there.
  assert.equal(exists(path.join(steamapps, 'appmanifest_10.acf')), false);
  assert.equal(exists(path.join(dir, 'game.exe')), true);
  const left = u.progress()['steam:10'];
  assert.equal(left.uninstallFailed, true);
  assert.equal(left.provider, 'steam');
  assert.match(left.error, /занят/);
  assert.match(toasts.at(-1), /Удалить снова/);
  assert.ok(saved >= 1);
  assert.equal(ctx.settings.uninstallLeftovers['steam:10'].dir, dir);

  // After a restart of Nexus the game is no longer installed; one more press removes the rest.
  games[0].offers[0] = { ...offer, installed: false };
  const again = setup(games, { settings: ctx.settings, storage: { saveSettings() {} } });
  assert.equal(again.u.progress()['steam:10'].uninstallFailed, true);
  again.u.removeFolder = realRemove;
  assert.deepEqual(await again.u.uninstall('steam:10', 'steam'), { how: 'started' });
  await finished(again.u);
  assert.equal(exists(dir), false);
  assert.deepEqual(again.u.progress(), {});
  assert.deepEqual(ctx.settings.uninstallLeftovers, {});
  assert.match(again.toasts.at(-1), /«Game» удалена/);
});
