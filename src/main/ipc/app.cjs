'use strict';
// The window state, Nexus itself (updates, start with Windows, backup, logs) and links.
const { setAutoStart } = require('../autostart.cjs');
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
      /(^|\.)(steampowered\.com|steamcommunity\.com|steamstatic\.com|epicgames\.com)$/.test(u.hostname);
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
}

module.exports = { registerAppIpc };
