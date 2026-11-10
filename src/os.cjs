'use strict';
// What differs between Windows, macOS and Linux: where Steam and Epic keep
// their files, what a game file looks like, which folders are never removed
// and which features exist. Everything takes the platform as a parameter, so
// each system is tested on any other.
//
// Epic Games has no launcher for Linux: there the installed Epic games are
// those of Heroic Games Launcher / Legendary, and they are started through them.

const path = require('node:path');
const os = require('node:os');

// The system Nexus behaves for. Tests set NEXUS_PLATFORM to run the code of
// one system on another (the Windows scenarios run on Linux CI).
function platform() {
  return process.env.NEXUS_PLATFORM || process.platform;
}
const P = name => (name === 'win32' ? path.win32 : path.posix);

function context({ platform: p = platform(), env = process.env, home } = {}) {
  return { p, env, home: home || env.HOME || env.USERPROFILE || os.homedir(), join: P(p).join };
}

// Folders where the Steam client may be installed (the first existing ones are used).
function steamRoots(options) {
  const { p, env, home, join } = context(options);
  if (p === 'win32')
    return [
      join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
      join(env.ProgramFiles || 'C:\\Program Files', 'Steam'),
    ];
  if (p === 'darwin') return [join(home, 'Library', 'Application Support', 'Steam')];
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return [
    join(data, 'Steam'),
    join(home, '.steam', 'steam'),
    join(home, '.steam', 'root'),
    join(home, '.steam', 'debian-installation'),
    // Flatpak and Snap keep their own home.
    join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
    join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
    join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
  ];
}

// The program that starts Steam from a Steam folder ('' = only steam:// links).
function steamExecutables(root, options) {
  const { p, join } = context(options);
  // (tests keep a Windows Steam folder in a temporary folder of the system they run on)
  if (p === 'win32')
    return [(String(root).startsWith('/') ? path.posix : path.win32).join(root, 'steam.exe')];
  if (p === 'darwin')
    return [
      '/Applications/Steam.app/Contents/MacOS/steam_osx',
      join(root, 'Steam.AppBundle', 'Steam', 'Contents', 'MacOS', 'steam_osx'),
    ];
  // Flatpak and Snap copies are started by their own wrappers, not by steam.sh.
  if (/[\\/](\.var[\\/]app|snap)[\\/]/.test(root)) return [];
  return [join(root, 'steam.sh')];
}
// Process names of the running Steam client.
function steamProcessNames(p = platform()) {
  return p === 'win32' ? ['steam.exe'] : p === 'darwin' ? ['steam_osx'] : ['steam'];
}
// Steam's own registry file on macOS and Linux (RunningAppID lives there).
function steamRegistryFiles(options) {
  const { p, home, join } = context(options);
  if (p === 'win32') return [];
  if (p === 'darwin') return [join(home, 'Library', 'Application Support', 'Steam', 'registry.vdf')];
  return [
    join(home, '.steam', 'registry.vdf'),
    join(home, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'registry.vdf'),
    join(home, 'snap', 'steam', 'common', '.steam', 'registry.vdf'),
  ];
}

// Files of the Epic Games Launcher (Windows, macOS). null on Linux.
// A set ProgramData means the Windows layout (always set on Windows).
function epicFiles(options) {
  const { p, env, home, join } = context(options);
  if (p === 'win32' || env.ProgramData) {
    const data = env.ProgramData || 'C:\\ProgramData';
    // Tests point ProgramData at a temporary folder of the system they run on.
    const w = data.startsWith('/') ? path.posix.join : path.win32.join;
    return {
      manifests: w(data, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
      installedDat: w(data, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'),
    };
  }
  if (p === 'darwin')
    return {
      manifests: join(
        home,
        'Library',
        'Application Support',
        'Epic',
        'EpicGamesLauncher',
        'Data',
        'Manifests'
      ),
      installedDat: '/Users/Shared/Epic/UnrealEngineLauncher/LauncherInstalled.dat',
    };
  return null;
}
// installed.json of Legendary and of Heroic's built-in Legendary (Linux, macOS).
function legendaryInstalledFiles(options) {
  const { p, env, home, join } = context(options);
  if (p === 'win32') return [];
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const list = [
    join(config, 'legendary', 'installed.json'),
    join(config, 'heroic', 'legendaryConfig', 'legendary', 'installed.json'),
    join(
      home,
      '.var',
      'app',
      'com.heroicgameslauncher.hgl',
      'config',
      'heroic',
      'legendaryConfig',
      'legendary',
      'installed.json'
    ),
  ];
  if (p === 'darwin')
    list.push(
      join(home, 'Library', 'Application Support', 'heroic', 'legendaryConfig', 'legendary', 'installed.json')
    );
  return list;
}

// Folders that are never removed with a game.
function protectedDirs(options) {
  const { p, env, home } = context(options);
  if (p === 'win32')
    return [
      env.SystemRoot || 'C:\\Windows',
      env.ProgramFiles || 'C:\\Program Files',
      env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      env.ProgramData || 'C:\\ProgramData',
      env.USERPROFILE,
      env.APPDATA,
      env.LOCALAPPDATA,
    ].filter(Boolean);
  const system = ['/bin', '/boot', '/dev', '/etc', '/lib', '/opt', '/proc', '/sbin', '/sys', '/usr', '/var'];
  const user = p === 'darwin' ? ['Library', 'Applications', 'Documents', 'Desktop'] : ['.config', '.local'];
  return [
    ...system,
    ...(p === 'darwin' ? ['/Applications', '/Library', '/System', '/Users', '/Volumes', '/private'] : []),
    ...(p === 'linux' ? ['/home', '/mnt', '/media', '/run', '/snap'] : []),
    home,
    ...user.map(x => path.posix.join(home, x)),
  ].filter(Boolean);
}

// A game added by hand: Windows .exe, a macOS .app or program, any Linux program.
function customGame(p = platform()) {
  if (p === 'win32')
    return {
      filters: [{ name: 'Игры и программы', extensions: ['exe'] }],
      properties: ['openFile'],
      accepts: file => /\.exe$/i.test(file),
      hint: 'Выберите .exe',
      title: file => path.win32.basename(file).replace(/\.exe$/i, ''),
      absolute: file => /^[A-Za-z]:[\\/]/.test(file),
      processName: /^[\w .()+-]{1,100}\.exe$/i,
      processExample: 'game.exe',
    };
  const base = file => path.posix.basename(String(file).replace(/\/+$/, ''));
  return {
    filters: p === 'darwin' ? [{ name: 'Приложения', extensions: ['app', '*'] }] : [],
    properties: ['openFile'],
    // Windows programs need Wine or Proton: those games are added to Steam instead.
    accepts: file => !/\.(exe|msi|bat|dll)$/i.test(file),
    hint:
      p === 'darwin'
        ? 'Выберите приложение (.app) или исполняемый файл. Игры для Windows (.exe) на macOS не запускаются.'
        : 'Выберите исполняемый файл игры (.sh, .AppImage, .x86_64…). Игры для Windows (.exe) добавьте в Steam: он запустит их через Proton.',
    title: file => base(file).replace(/\.(app|sh|AppImage|x86_64|x86|bin|run)$/i, ''),
    absolute: file => String(file).startsWith('/'),
    processName: /^[\w .()+-]{1,100}$/,
    processExample: p === 'darwin' ? 'Game' : 'game.x86_64',
  };
}

// What Nexus does itself on this system.
//   epicDirect      start Epic games without the Epic launcher and sync their cloud saves;
//   epicDownloads   download and install Epic games (Windows builds);
//   steamDownloads  start Steam installs without the Steam window;
//   clientInstaller download and install the official clients;
//   epicLauncher    the official Epic Games Launcher exists.
function features(p = platform()) {
  const win = p === 'win32';
  return {
    epicDirect: win,
    epicDownloads: win,
    steamDownloads: win,
    clientInstaller: win,
    fps: win,
    epicLauncher: p !== 'linux',
  };
}

module.exports = {
  platform,
  steamRoots,
  steamExecutables,
  steamProcessNames,
  steamRegistryFiles,
  epicFiles,
  legendaryInstalledFiles,
  protectedDirs,
  customGame,
  features,
};
