'use strict';
// The window state, Nexus itself (updates, start with Windows, backup, logs) and links.
const { setAutoStart } = require('../autostart.cjs');
const { yearReview } = require('../../year-review.cjs');
const path = require('node:path');
const { app, session, shell } = require('electron');
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
  register('saveDiagnostics', async () => {
    const r = await actions.saveDiagnostics(ctx.mainWindow());
    return r && { file: r.file };
  });
  register('reportProblem', () => actions.reportProblem(ctx.mainWindow()));
  register('openLogs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
  // «Очистить кэш»: the pictures Chromium keeps on disk (sign-ins and settings stay).
  register('clearCache', async () => {
    const s = session.defaultSession;
    const before = await s.getCacheSize();
    await s.clearCache();
    return { freedMB: Math.round(before / 1048576) };
  });
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
  // Links of the window (menus, store and game pages): in the Nexus browser.
  register('openLink', url => ctx.openUrl(url));
  register(
    'autoUpdate',
    save(enabled => (settings.autoUpdate = bool(enabled)))
  );
  register(
    'betaUpdates',
    save(enabled => {
      settings.betaUpdates = bool(enabled);
      ctx.updater.setBeta(settings.betaUpdates);
    })
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
  register(
    'yearReview',
    year => {
      if (year !== undefined && (!Number.isInteger(year) || year < 2000 || year > 2100))
        throw Error('Некорректный год');
      return yearReview({
        year,
        log: settings.playLog,
        games: ctx.library.games || [],
        wishlist: (settings.wishlist || []).length,
      });
    },
    { quiet: true }
  );
}

module.exports = { registerAppIpc };
