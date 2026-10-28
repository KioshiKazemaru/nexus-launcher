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
  u.closeEpicLauncher = async () => true; // never touches the real Epic launcher
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

test('folder guard: drive roots, system/user folders and folders with other games are refused', () => {
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
});

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
  const { u, toasts, scans } = setup(games);
  const { result, asked } = await answer(0, () => u.uninstall('steam:10', 'steam'));
  assert.deepEqual(result, { how: 'started' });
  assert.match(asked[0].message, /Удалить «Game»/);
  assert.match(asked[0].detail, /Steam Cloud/);
  assert.equal(u.progress()['steam:10'].state, 'uninstalling');
  assert.equal(u.progress()['steam:10'].total, 4000);
  await finished(u);
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
    u.closeEpicLauncher = async () => (closedLauncher++, true);
    const { result, asked } = await answer(0, () => u.uninstall('epic:fennec', 'epic'));
    assert.deepEqual(result, { how: 'started' });
    assert.match(asked[0].detail, /Epic/);
    await finished(u);
    assert.equal(closedLauncher, 1);
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

test('nothing is deleted when canceled, when the game runs, or for an unsafe folder; "через клиент" hands over', async () => {
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

  let s = setup(games);
  assert.deepEqual((await answer(2, () => s.u.uninstall('steam:10', 'steam'))).result, { how: 'canceled' });
  assert.deepEqual((await answer(1, () => s.u.uninstall('steam:10', 'steam'))).result, { how: 'client' });
  assert.equal(exists(path.join(dir, 'game.exe')), true);

  s = setup(games, { running: { isRunning: id => id === 'steam:10' } });
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
