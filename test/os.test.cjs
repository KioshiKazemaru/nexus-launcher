// Windows, macOS and Linux: where Steam and Epic keep their files, which
// processes are games, what a manually added game is, what is never removed.
// The pure functions take the system as a parameter and are tested on any
// system; the scan of a real Linux home runs on Linux only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const system = require('../src/os.cjs');
const processes = require('../src/main/processes.cjs');
const epic = require('../src/platforms/epic.cjs');
const { installTargets, matchRunning } = require('../src/main/running.cjs');
const { backupCustomGames } = require('../src/backup.cjs');
const autostart = require('../src/main/autostart.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-os-'));
// Runs `fn` as another system (see src/os.cjs: platform()).
function as(platform, fn) {
  const before = process.env.NEXUS_PLATFORM;
  process.env.NEXUS_PLATFORM = platform;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.NEXUS_PLATFORM;
    else process.env.NEXUS_PLATFORM = before;
  }
}

test('Steam folders: Program Files on Windows, Application Support on macOS, native, Flatpak and Snap on Linux', () => {
  const win = system.steamRoots({
    platform: 'win32',
    env: { 'ProgramFiles(x86)': 'D:\\PF86' },
    home: 'C:\\U',
  });
  assert.equal(win[0], 'D:\\PF86\\Steam');
  assert.deepEqual(system.steamRoots({ platform: 'darwin', env: {}, home: '/Users/me' }), [
    '/Users/me/Library/Application Support/Steam',
  ]);
  const linux = system.steamRoots({ platform: 'linux', env: {}, home: '/home/me' });
  assert.equal(linux[0], '/home/me/.local/share/Steam');
  assert.ok(linux.includes('/home/me/.steam/steam'));
  assert.ok(linux.includes('/home/me/.var/app/com.valvesoftware.Steam/.local/share/Steam'));
  assert.ok(linux.includes('/home/me/snap/steam/common/.local/share/Steam'));
  assert.equal(
    system.steamRoots({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home: '/home/me' })[0],
    '/data/Steam'
  );
});

test('the Steam program and its process name per system; Flatpak and Snap only through steam:// links', () => {
  assert.deepEqual(system.steamExecutables('C:\\Steam', { platform: 'win32' }), ['C:\\Steam\\steam.exe']);
  assert.deepEqual(system.steamExecutables('/home/me/.local/share/Steam', { platform: 'linux' }), [
    '/home/me/.local/share/Steam/steam.sh',
  ]);
  assert.deepEqual(
    system.steamExecutables('/home/me/.var/app/com.valvesoftware.Steam/.local/share/Steam', {
      platform: 'linux',
    }),
    []
  );
  assert.equal(
    system.steamExecutables('/Users/me/Library/Application Support/Steam', { platform: 'darwin' })[0],
    '/Applications/Steam.app/Contents/MacOS/steam_osx'
  );
  assert.deepEqual(system.steamProcessNames('win32'), ['steam.exe']);
  assert.deepEqual(system.steamProcessNames('darwin'), ['steam_osx']);
  assert.deepEqual(system.steamProcessNames('linux'), ['steam']);
  assert.deepEqual(system.steamRegistryFiles({ platform: 'win32', env: {}, home: 'C:\\U' }), []);
  assert.equal(
    system.steamRegistryFiles({ platform: 'linux', env: {}, home: '/home/me' })[0],
    '/home/me/.steam/registry.vdf'
  );
});

test('Epic files: ProgramData on Windows, the user library on macOS, none on Linux (Heroic / Legendary instead)', () => {
  assert.deepEqual(
    system.epicFiles({ platform: 'win32', env: { ProgramData: 'C:\\ProgramData' }, home: '' }),
    {
      manifests: 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests',
      installedDat: 'C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat',
    }
  );
  assert.deepEqual(system.epicFiles({ platform: 'darwin', env: {}, home: '/Users/me' }), {
    manifests: '/Users/me/Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests',
    installedDat: '/Users/Shared/Epic/UnrealEngineLauncher/LauncherInstalled.dat',
  });
  assert.equal(system.epicFiles({ platform: 'linux', env: {}, home: '/home/me' }), null);
  const files = system.legendaryInstalledFiles({ platform: 'linux', env: {}, home: '/home/me' });
  assert.ok(files.includes('/home/me/.config/legendary/installed.json'));
  assert.ok(files.includes('/home/me/.config/heroic/legendaryConfig/legendary/installed.json'));
  assert.ok(files.some(f => f.includes('.var/app/com.heroicgameslauncher.hgl')));
  assert.deepEqual(system.legendaryInstalledFiles({ platform: 'win32', env: {}, home: 'C:\\U' }), []);
});

test('what Nexus does itself: everything on Windows; macOS and Linux use the clients for Epic', () => {
  const win = system.features('win32');
  assert.ok(win.epicDirect && win.epicDownloads && win.steamDownloads && win.clientInstaller && win.fps);
  for (const p of ['darwin', 'linux']) {
    const f = system.features(p);
    assert.equal(f.epicDirect, false, p);
    assert.equal(f.epicDownloads, false, p);
    assert.equal(f.steamDownloads, false, p);
    assert.equal(f.clientInstaller, false, p);
  }
  assert.equal(system.features('darwin').epicLauncher, true);
  assert.equal(system.features('linux').epicLauncher, false);
});

test('Legendary / Heroic installed.json: installed games with their folders; DLC, missing folders and bad ids are skipped', async () => {
  const dir = tmp();
  const game = path.join(dir, 'Games', 'Hades');
  fs.mkdirSync(game, { recursive: true });
  const file = path.join(dir, 'heroic', 'legendaryConfig', 'legendary', 'installed.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      Min: { app_name: 'Min', title: 'Hades', install_path: game, install_size: 1234, version: '1.0' },
      MinDlc: { app_name: 'MinDlc', title: 'Hades OST', install_path: game, is_dlc: true },
      Gone: { app_name: 'Gone', title: 'Gone', install_path: path.join(dir, 'nope') },
      'bad id': { app_name: '../evil', title: 'Evil', install_path: game },
    })
  );
  const offers = await epic.scanLegendary([path.join(dir, 'missing.json'), file, file]);
  assert.equal(offers.length, 1);
  assert.deepEqual(
    {
      provider: offers[0].provider,
      appId: offers[0].appId,
      name: offers[0].name,
      installed: offers[0].installed,
      via: offers[0].via,
      installLocation: offers[0].installLocation,
      installSize: offers[0].installSize,
    },
    {
      provider: 'epic',
      appId: 'Min',
      name: 'Hades',
      installed: true,
      via: 'legendary',
      installLocation: game,
      installSize: 1234,
    }
  );
  assert.match(offers[0].legendaryFile, /heroic/);
});

test(
  'Linux processes: the program of /proc/<pid>/exe and the Windows program of a Wine / Proton game',
  { skip: process.platform === 'win32' && 'needs symbolic links' },
  async () => {
    const proc = tmp();
    const add = (pid, exe, cmdline) => {
      fs.mkdirSync(path.join(proc, String(pid)));
      if (exe) fs.symlinkSync(exe, path.join(proc, String(pid), 'exe'));
      fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), cmdline.join('\0') + '\0');
    };
    add(10, '/home/me/Games/Native/game.x86_64', ['./game.x86_64', '-windowed']);
    add(11, '/home/me/Steam/Proton/files/bin/wine64-preloader', [
      'Z:\\home\\me\\Steam\\steamapps\\common\\Portal 2\\portal2.exe',
      '-novid',
    ]);
    add(12, '/usr/bin/old (deleted)', ['/usr/bin/old']);
    add(13, null, ['kworker']); // another user's process: its program cannot be read
    fs.mkdirSync(path.join(proc, 'self'));
    fs.writeFileSync(path.join(proc, 'uptime'), '1');
    const list = await processes.linuxProcesses(proc);
    const of = pid => list.filter(p => p.pid === pid).map(p => p.path);
    assert.deepEqual(of(10), ['/home/me/Games/Native/game.x86_64']);
    assert.ok(of(11).includes('/home/me/Steam/steamapps/common/Portal 2/portal2.exe'));
    assert.deepEqual(of(12), ['/usr/bin/old']);
    assert.deepEqual(of(13), []);
    assert.equal(processes.winePath('C:\\windows\\system32\\x.exe'), '');
    assert.deepEqual(await processes.linuxProcesses(path.join(proc, 'missing')), []);
  }
);

test(
  'macOS processes from ps; a running .app counts as its manually added game',
  { skip: path.sep !== '/' },
  () => {
    const list = processes.parsePs(
      [
        '    1 /sbin/launchd',
        '  412 /Applications/Hades.app/Contents/MacOS/Hades',
        '  413 /Applications/My Game.app/Contents/MacOS/My Game',
        '  999 (bash)',
        '',
      ].join('\n')
    );
    assert.deepEqual(list[1], { pid: 412, path: '/Applications/Hades.app/Contents/MacOS/Hades' });
    assert.equal(list.length, 3);
    const games = [
      {
        id: 'custom:1',
        name: 'My Game',
        offers: [{ provider: 'custom', installed: true, exe: '/Applications/My Game.app' }],
      },
      {
        id: 'steam:620',
        name: 'Portal 2',
        offers: [
          { provider: 'steam', installed: true, installDir: '/home/me/Steam/steamapps/common/Portal 2' },
        ],
      },
    ];
    const running = matchRunning(
      [
        ...list,
        // Linux lists a Proton game twice (wine and the game's .exe): one pid.
        { pid: 7, path: '/home/me/Steam/steamapps/common/Portal 2/portal2.exe' },
        { pid: 7, path: '/home/me/Steam/steamapps/common/Portal 2/portal2.exe' },
      ],
      installTargets(games)
    );
    assert.deepEqual(running['custom:1'].pids, [413]);
    assert.deepEqual(running['steam:620'].pids, [7]);
  }
);

test('a manually added game: .exe on Windows, an application on macOS, any program but .exe on Linux', () => {
  const win = system.customGame('win32');
  assert.ok(win.accepts('C:\\Games\\Game.exe') && !win.accepts('C:\\Games\\Game.sh'));
  assert.equal(win.title('C:\\Games\\Game.exe'), 'Game');
  assert.ok(win.processName.test('game.exe') && !win.processName.test('game'));
  const mac = system.customGame('darwin');
  assert.ok(mac.accepts('/Applications/Hades.app') && !mac.accepts('/Users/me/setup.exe'));
  assert.equal(mac.title('/Applications/Hades.app'), 'Hades');
  assert.ok(mac.absolute('/Applications/Hades.app') && !mac.absolute('C:\\Games\\Game.exe'));
  const linux = system.customGame('linux');
  assert.ok(linux.accepts('/home/me/Games/game.x86_64') && linux.accepts('/home/me/Games/start.sh'));
  assert.equal(linux.accepts('/home/me/Games/game.exe'), false);
  assert.match(linux.hint, /Proton/);
  assert.equal(linux.title('/home/me/Games/Celeste.AppImage'), 'Celeste');
  assert.ok(linux.processName.test('game.x86_64') && !linux.processName.test('../game'));
});

test('a backup restores only game files of this system', () => {
  const data = {
    settings: {
      custom: [
        { id: '1', name: 'Win', exe: 'C:\\Games\\Game.exe', trackProcess: 'game.exe' },
        { id: '2', name: 'Linux', exe: '/home/me/Games/game.x86_64', trackProcess: 'game.x86_64' },
        { id: '3', name: 'Relative', exe: 'game.sh' },
      ],
    },
  };
  const names = p => as(p, () => backupCustomGames({ custom: [] }, data).map(c => c.name));
  assert.deepEqual(names('win32'), ['Win']);
  assert.deepEqual(names('linux'), ['Linux']);
  assert.deepEqual(names('darwin'), ['Linux']);
  assert.equal(as('linux', () => backupCustomGames({ custom: [] }, data))[0].trackProcess, 'game.x86_64');
});

test('folders never removed with a game on macOS and Linux', { skip: path.sep !== '/' }, () => {
  const { folderRisk } = require('../src/main/uninstall.cjs');
  const env = { HOME: '/home/me' };
  const risk = (p, dir, others = []) => as(p, () => folderRisk(dir, others, env));
  assert.match(risk('linux', '/'), /корень/);
  assert.match(risk('linux', '/home/me'), /системная/);
  assert.match(risk('linux', '/home'), /системная/);
  assert.match(risk('linux', '/usr'), /системная/);
  assert.match(risk('linux', '/home/me/.local'), /системная/);
  assert.equal(risk('linux', '/home/me/.local/share/Steam/steamapps/common/Portal 2'), '');
  assert.equal(risk('linux', '/mnt/games/SteamLibrary/steamapps/common/Hades'), '');
  assert.match(
    risk('linux', '/mnt/games/SteamLibrary', ['/mnt/games/SteamLibrary/steamapps/common/Hades']),
    /другая игра/
  );
  const mac = { HOME: '/Users/me' };
  const macRisk = dir => as('darwin', () => folderRisk(dir, [], mac));
  assert.match(macRisk('/Applications'), /системная/);
  assert.match(macRisk('/Users/me/Library'), /системная/);
  assert.match(macRisk('/Users'), /системная/);
  assert.equal(macRisk('/Users/me/Library/Application Support/Steam/steamapps/common/Hades'), '');
});

test('Linux autostart entry: the program (an AppImage keeps its own path), quoted when needed', () => {
  assert.equal(
    autostart.desktopExec('/opt/Nexus/nexus-launcher', ['--hidden']),
    '/opt/Nexus/nexus-launcher --hidden'
  );
  assert.equal(
    autostart.desktopExec('/home/me/My Apps/Nexus-0.13.0.AppImage'),
    '"/home/me/My Apps/Nexus-0.13.0.AppImage"'
  );
  const entry = autostart.desktopEntry('/opt/Nexus/nexus-launcher', true);
  assert.match(entry, /^\[Desktop Entry\]\nType=Application\n/);
  assert.match(entry, /\nExec=\/opt\/Nexus\/nexus-launcher --hidden\n/);
  assert.equal(
    autostart.desktopFile({ XDG_CONFIG_HOME: '/cfg' }),
    path.join('/cfg', 'autostart', 'nexus-launcher.desktop')
  );
});

// A real Linux home: Steam (reached through the ~/.steam/steam link too) and Heroic.
test(
  'Linux: the library scan finds Steam in the home folder once and the Epic games of Heroic',
  { skip: process.platform !== 'linux' && 'runs on Linux only' },
  async () => {
    const home = tmp();
    const steam = path.join(home, '.local', 'share', 'Steam');
    fs.mkdirSync(path.join(steam, 'steamapps', 'common', 'Portal 2'), { recursive: true });
    fs.writeFileSync(
      path.join(steam, 'steamapps', 'appmanifest_620.acf'),
      '"AppState" { "appid" "620" "name" "Portal 2" "StateFlags" "4" "installdir" "Portal 2" }'
    );
    fs.mkdirSync(path.join(home, '.steam'));
    fs.symlinkSync(steam, path.join(home, '.steam', 'steam'));
    const hades = path.join(home, 'Games', 'Hades');
    fs.mkdirSync(hades, { recursive: true });
    const installed = path.join(home, '.config', 'heroic', 'legendaryConfig', 'legendary', 'installed.json');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(
      installed,
      JSON.stringify({ Min: { app_name: 'Min', title: 'Hades', install_path: hades } })
    );

    const saved = { ...process.env };
    Object.assign(process.env, { HOME: home, NEXUS_PLATFORM: 'linux' });
    for (const k of ['NEXUS_NO_SYSTEM_SCAN', 'ProgramData', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'])
      delete process.env[k];
    try {
      const { LibraryService } = require('../src/main/library.cjs');
      const library = new LibraryService({
        settings: { steamRoot: '', custom: [], customPlaytime: {} },
        storage: { loadOwned: () => ({}), file: () => path.join(home, 'nexus-epic') },
        log: { warn() {}, debug() {} },
      });
      const local = await library.readLocal();
      assert.deepEqual(local.steamRoots, [fs.realpathSync(steam)], 'the link and the folder are one Steam');
      const portal = local.offers.find(o => o.provider === 'steam');
      assert.equal(portal.appId, '620');
      assert.equal(portal.installDir, path.join(fs.realpathSync(steam), 'steamapps', 'common', 'Portal 2'));
      const epicGame = local.offers.find(o => o.provider === 'epic');
      assert.equal(epicGame.name, 'Hades');
      assert.equal(epicGame.via, 'legendary');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }
);

test('Heroic link: the documented launch form with runner and launch options; bad ids are refused', () => {
  assert.equal(epic.heroicUri('Salt'), 'heroic://launch?appName=Salt&runner=legendary');
  const u = new URL(epic.heroicUri('Min', ['-windowed', 'a b']));
  assert.equal(u.protocol, 'heroic:');
  assert.equal(u.hostname, 'launch');
  assert.equal(u.searchParams.get('appName'), 'Min');
  assert.equal(u.searchParams.get('runner'), 'legendary');
  assert.deepEqual(u.searchParams.getAll('arg'), ['-windowed', 'a b']);
  assert.throws(() => epic.heroicUri('../x'), /Некорректная/);
});

test('Linux Epic games: Heroic opens them (and installs missing ones); without Heroic its site is offered', async () => {
  const electron = require('electron');
  const T = electron.__test;
  const { ActionsService } = require('../src/main/actions.cjs');
  const changes = [];
  const actions = new ActionsService({
    settings: { launchOptions: {} },
    library: { expectChange: () => changes.push(1) },
    log: { warn() {}, info() {} },
  });
  const opened = () => T.opened.filter(u => u.startsWith('heroic:') || u.includes('heroicgameslauncher'));
  T.opened.length = 0;
  actions.clients.schemeRegistered = async () => true;
  const heroicGame = {
    provider: 'epic',
    appId: 'Salt',
    installed: true,
    via: 'legendary',
    legendaryFile: '/h/.config/heroic/legendaryConfig/legendary/installed.json',
  };
  assert.equal(await actions.playLegendary(heroicGame, '-novid'), 'heroic');
  assert.deepEqual(opened(), ['heroic://launch?appName=Salt&runner=legendary&arg=-novid']);
  // Not installed: Heroic asks to install it, Nexus watches for the new install.
  assert.equal(await actions.playLegendary({ provider: 'epic', appId: 'Min', installed: false }), 'heroic');
  assert.equal(opened()[1], 'heroic://launch?appName=Min&runner=legendary');
  assert.equal(changes.length, 1);
  // No Heroic: nothing is opened but its site, if the user wants it.
  actions.clients.schemeRegistered = async () => false;
  const original = electron.dialog.showMessageBox;
  electron.dialog.showMessageBox = async () => ({ response: 0 });
  try {
    assert.equal(await actions.playLegendary(heroicGame), 'canceled');
  } finally {
    electron.dialog.showMessageBox = original;
  }
  assert.equal(opened()[2], 'https://heroicgameslauncher.com/');
});

// macOS layout, scanned on any Unix: Steam in ~/Library and a game of the Epic Games Launcher.
test(
  'macOS: the library scan finds Steam in Application Support and the games of Epic Games Launcher',
  { skip: process.platform === 'win32' && 'Unix paths' },
  async () => {
    const home = tmp();
    const steam = path.join(home, 'Library', 'Application Support', 'Steam');
    fs.mkdirSync(path.join(steam, 'steamapps', 'common', 'Hades'), { recursive: true });
    fs.writeFileSync(
      path.join(steam, 'steamapps', 'appmanifest_1145360.acf'),
      '"AppState" { "appid" "1145360" "name" "Hades" "StateFlags" "4" "installdir" "Hades" }'
    );
    const manifests = path.join(
      home,
      'Library',
      'Application Support',
      'Epic',
      'EpicGamesLauncher',
      'Data',
      'Manifests'
    );
    fs.mkdirSync(manifests, { recursive: true });
    const game = path.join(home, 'Games', 'Fortnite');
    fs.mkdirSync(game, { recursive: true });
    fs.writeFileSync(
      path.join(manifests, 'A1.item'),
      JSON.stringify({
        AppName: 'Fortnite',
        DisplayName: 'Fortnite',
        InstallLocation: game,
        CatalogNamespace: 'fn',
        CatalogItemId: 'fi',
        LaunchExecutable: 'Fortnite.app',
      })
    );
    const saved = { ...process.env };
    Object.assign(process.env, { HOME: home, NEXUS_PLATFORM: 'darwin' });
    for (const k of ['NEXUS_NO_SYSTEM_SCAN', 'ProgramData', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'])
      delete process.env[k];
    try {
      const { LibraryService } = require('../src/main/library.cjs');
      const library = new LibraryService({
        settings: { steamRoot: '', custom: [], customPlaytime: {} },
        storage: { loadOwned: () => ({}), file: () => path.join(home, 'nexus-epic') },
        log: { warn() {}, debug() {} },
      });
      const local = await library.readLocal();
      assert.deepEqual(local.steamRoots, [fs.realpathSync(steam)]);
      assert.equal(local.offers.find(o => o.provider === 'steam')?.name, 'Hades');
      const fortnite = local.offers.find(o => o.provider === 'epic');
      assert.equal(fortnite.appId, 'Fortnite');
      assert.equal(fortnite.via, undefined, 'a game of Epic Games Launcher, not of Heroic');
      assert.equal(require('../src/platforms/epic.cjs').manifestDir(), manifests);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }
);
