'use strict';
// The window state, Nexus itself (updates, start with Windows, backup, logs) and links.
const { setAutoStart } = require('../autostart.cjs');
const { yearReview } = require('../../year-review.cjs');
const path = require('node:path');
const { app, shell } = require('electron');
const { bool, wrappers } = require('./helpers.cjs');

function registerAppIpc(register, ctx, { onlineAgain }) {
  const { settings, actions } = ctx;
  const { withState, save } = wrappers(ctx);

  register('state', () => ctx.hub.now()); // complete state
  register('stateUpdate', () => ctx.hub.reply()); // unchanged large sections omitted
  // A missing cover is normal (not every game has every image size): not a warning.
  register('getArtwork', url => ctx.artwork.get(url), { quiet: true });
  register('exportBackup', () => actions.exportBackup(ctx.mainWindow()));
  register('importBackup', async () => ({
    result: await actions.importBackup(ctx.mainWindow()),
    state: ctx.hub.reply(),
  }));
  register('saveDiagnostics', () => actions.saveDiagnostics(ctx.mainWindow()));
  register('openLogs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
  register('rendererError', message => {
    ctx.log.error('ui', String(message).slice(0, 2000));
  });
  register(
    'networkChanged',
    withState(online => (online ? onlineAgain() : undefined))
  );
  register(
    'autoStart',
    save(enabled => {
      setAutoStart(bool(enabled), settings.startHidden === true);
      settings.autoStart = enabled;
    })
  );
  // Gamepad mode: the window goes full screen.
  register('bigPicture', on => {
    ctx.mainWindow()?.setFullScreen(on === true);
    return true;
  });
  register('openLink', url => {
    const u = new URL(String(url || ''));
    const ok =
      u.protocol === 'https:' &&
      (/(^|\.)(steampowered\.com|steamcommunity\.com|steamstatic\.com|epicgames\.com)$/.test(u.hostname) ||
        // The Nexus repository itself («Справка»: issues, privacy policy).
        (u.hostname === 'github.com' &&
          !u.username &&
          !u.password &&
          /^\/KioshiKazemaru\/nexus-launcher(\/|$)/.test(u.pathname)));
    if (!ok) throw Error('Ссылка недоступна');
    return shell.openExternal(u.href);
  });
  register(
    'autoUpdate',
    save(enabled => (settings.autoUpdate = bool(enabled)))
  );
  register(
    'checkUpdate',
    withState(() => ctx.updater.check())
  );
  register('installUpdate', () => ctx.updater.install());
  // Windows, macOS: the new version's release page, or its installer downloaded and started.
  register('openUpdatePage', () => ctx.updater.openRelease());
  register('downloadUpdate', () => ctx.updater.download());
  // «Nexus» → «Выход» in the top menu, like «Выйти из Nexus» in the tray.
  register('quitApp', () => app.quit());
  // «Итоги Nexus»: the year from the session log and the libraries.
  register('yearReview', year => {
    if (year !== undefined && (!Number.isInteger(year) || year < 2000 || year > 2100)) throw Error('Некорректный год');
    return yearReview({
      year,
      log: settings.playLog,
      games: ctx.library.games || [],
      wishlist: (settings.wishlist || []).length,
    });
  }, { quiet: true });
}

module.exports = { registerAppIpc };
