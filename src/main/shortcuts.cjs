'use strict';
// Desktop shortcuts of library games, like Steam's «Добавить ярлык на рабочий стол».
// A shortcut starts Nexus with --play=<game id>: Nexus starts the game the way its
// «Играть» does (Epic without its launcher, Steam in the background, saves synced),
// or, if Nexus already runs, the running copy gets the argument (second-instance).
// Windows: a .lnk; Linux: a .desktop file. A shortcut Nexus made is removed when
// the game is no longer installed. settings.shortcuts: { game id: file name }.
const fs = require('node:fs');
const path = require('node:path');

const PLAY = '--play=';
const GAME_ID = /^[\w:.#@-]{1,200}$/;

function playArg(argv) {
  const a = (Array.isArray(argv) ? argv : []).find(x => typeof x === 'string' && x.startsWith(PLAY));
  const id = a ? a.slice(PLAY.length).replace(/^"|"$/g, '') : '';
  return GAME_ID.test(id) ? id : '';
}
// A file name Windows and Linux accept, from the game's title.
function safeName(name) {
  return (
    String(name || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 80) || 'Игра'
  );
}
function desktopEntry({ name, exec, icon }) {
  const quote = s => `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${String(name).replace(/[\r\n]/g, ' ')}`,
    `Exec=${exec.map(quote).join(' ')}`,
    icon ? `Icon=${icon}` : '',
    'Terminal=false',
    'Categories=Game;',
    '',
  ]
    .filter(l => l !== '')
    .join('\n');
}

class Shortcuts {
  constructor(ctx, { shell, app, platform = process.platform, fsImpl = fs } = {}) {
    this.ctx = ctx;
    this.shell = shell;
    this.app = app;
    this.platform = platform;
    this.fs = fsImpl;
  }
  supported() {
    return this.platform === 'win32' || this.platform === 'linux';
  }
  list() {
    const s = this.ctx.settings;
    if (!s.shortcuts || typeof s.shortcuts !== 'object' || Array.isArray(s.shortcuts)) s.shortcuts = {};
    return s.shortcuts;
  }
  game(id) {
    return (this.ctx.library.games || []).find(g => g.id === id) || null;
  }
  file(base) {
    return path.join(this.app.getPath('desktop'), base + (this.platform === 'win32' ? '.lnk' : '.desktop'));
  }
  exists(id) {
    const base = this.list()[id];
    return !!base && this.fs.existsSync(this.file(base));
  }
  // The copy a shortcut starts: the chosen store, else Steam, else any installed one.
  offer(g) {
    const installed = (g?.offers || []).filter(o => o.installed);
    return (
      installed.find(o => o.provider === this.ctx.settings.preferred?.[g.id]) ||
      installed.find(o => o.provider === 'steam') ||
      installed[0] ||
      null
    );
  }
  // How the shortcut starts Nexus: the packaged app, or electron with the app folder.
  command(id) {
    const exe = (this.platform === 'linux' && process.env.APPIMAGE) || process.execPath;
    const args = [...(this.app.isPackaged ? [] : [this.app.getAppPath()]), PLAY + id];
    return { exe, args };
  }
  create(id) {
    if (!this.supported()) throw Error('На этой системе Nexus пока не создаёт ярлыки');
    const g = this.game(id);
    if (!g || !GAME_ID.test(id)) throw Error('Игра не найдена');
    if (!this.offer(g)) throw Error('Сначала установите игру');
    const base = safeName(g.name);
    const file = this.file(base);
    const { exe, args } = this.command(id);
    if (this.platform === 'win32') {
      const quoted = args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
      const ok = this.shell.writeShortcutLink(file, this.fs.existsSync(file) ? 'replace' : 'create', {
        target: exe,
        args: quoted,
        description: `${g.name} · Nexus Launcher`,
        icon: exe,
        iconIndex: 0,
      });
      if (!ok) throw Error('Windows не создал ярлык');
    } else {
      this.fs.writeFileSync(file, desktopEntry({ name: g.name, exec: [exe, ...args] }), { mode: 0o755 });
    }
    this.list()[id] = base;
    this.ctx.storage.saveSettings();
    this.ctx.log.info('shortcuts', `created for ${id}`);
    return true;
  }
  remove(id) {
    const base = this.list()[id];
    if (base) {
      try {
        this.fs.rmSync(this.file(base), { force: true });
      } catch (e) {
        this.ctx.log.warn('shortcuts', e.message);
      }
      delete this.list()[id];
      this.ctx.storage.saveSettings();
      this.ctx.log.info('shortcuts', `removed for ${id}`);
    }
    return false;
  }
  // Shortcuts of games removed from the PC go too (only the ones Nexus made).
  cleanup() {
    for (const id of Object.keys(this.list())) {
      const g = this.game(id);
      if (!g) continue; // the library is not loaded yet, or the account is signed out
      if (!this.offer(g)) this.remove(id);
      else if (!this.exists(id)) {
        delete this.list()[id];
        this.ctx.storage.saveSettings();
      }
    }
  }
  // Started from a shortcut.
  launch(id) {
    const g = this.game(id);
    const o = this.offer(g);
    if (!o) {
      this.ctx.focusMain?.();
      this.ctx.toast?.(g ? `«${g.name}» не установлена` : 'Игра из ярлыка не найдена в библиотеке');
      return Promise.resolve(null);
    }
    this.ctx.log.info('shortcuts', `play ${id} (${o.provider})`);
    return this.ctx.actions
      .play({ id, provider: o.provider })
      .then(r => (this.ctx.hub?.publish(), r))
      .catch(e => {
        this.ctx.focusMain?.();
        this.ctx.toast?.(e.message);
        return null;
      });
  }
}

module.exports = { Shortcuts, playArg, safeName, desktopEntry, PLAY };
