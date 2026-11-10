'use strict';
// "Запускать Nexus при входе в систему": the login items of Windows and macOS,
// an autostart entry (~/.config/autostart/nexus-launcher.desktop) on Linux.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

function desktopFile(env = process.env) {
  return path.join(
    env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'autostart',
    'nexus-launcher.desktop'
  );
}
// Exec= of a desktop entry: an argument with spaces or special characters is quoted.
function desktopExec(file, args = []) {
  const quote = s => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["`$\\])/g, '\\$1')}"`);
  return [file, ...args].map(quote).join(' ');
}
function desktopEntry(file, hidden) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Nexus Launcher',
    'Comment=Steam + Epic Games',
    `Exec=${desktopExec(file, hidden ? ['--hidden'] : [])}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function setAutoStart(enabled, hidden) {
  if (process.platform === 'linux') {
    const file = desktopFile();
    if (!enabled) return fs.rmSync(file, { force: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // An AppImage is mounted at a new path on every start: its own file is the program.
    fs.writeFileSync(file, desktopEntry(process.env.APPIMAGE || process.execPath, hidden));
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: process.execPath,
    args: hidden ? ['--hidden'] : [],
  });
}

module.exports = { setAutoStart, desktopEntry, desktopExec, desktopFile };
