'use strict';
// Playing and installing: launch, client actions, downloads without the launchers'
// windows, the install window, storage, uninstall and Epic cloud saves.
const { shell } = require('electron');
const { bool, gameId, isProvider, wrappers } = require('./helpers.cjs');

// Starting games: Epic without its launcher, cloud saves, Steam hidden.
const LAUNCH_SETTINGS = [
  'epicDirectLaunch',
  'epicCloudSaves',
  'steamSilent',
  'steamCloseAfter',
  'nexusDownloads',
];

function registerGamesIpc(register, ctx) {
  const { library, settings, actions } = ctx;
  const { save } = wrappers(ctx);

  register('play', async p => ({ result: await actions.play(p), state: ctx.hub.reply() }));
  register('clientAction', async p => ({ result: await actions.clientAction(p), state: ctx.hub.reply() }));
  register(
    'launchSetting',
    save(({ name, value }) => {
      if (!LAUNCH_SETTINGS.includes(name)) throw Error('Неизвестная настройка');
      settings[name] = bool(value);
    })
  );
  // Pause / cancel live in the clients: opens their downloads view.
  register('openClientDownloads', provider => {
    if (!isProvider(provider)) throw Error('Неизвестный магазин');
    const uri = provider === 'steam' ? 'steam://open/downloads' : 'com.epicgames.launcher://library';
    return actions.openClient(provider, uri, 'открыть загрузки', 'opened');
  });
  // "Закрыть" on a running game.
  register(
    'closeGame',
    async id => {
      if (typeof id !== 'string' || id.length > 300) throw Error('Некорректная игра');
      return { result: await ctx.running.close(id), state: ctx.hub.reply() };
    },
    { overlay: true }
  );
  // Downloads without the launchers' windows (Epic: Nexus itself; Steam: Steam in the tray).
  register('downloadControl', async p => {
    const { id, action } = p || {};
    if (typeof id !== 'string' || id.length > 300) throw Error('Некорректная игра');
    // An unknown action is an error; a known one may well return nothing.
    if (!DOWNLOAD_ACTIONS.includes(action)) throw Error('Неизвестное действие');
    const result = await downloadAction(ctx.epicInstall, id, action);
    return { result, state: ctx.hub.reply() };
  });
  register('checkUpdates', async () => ({
    result: await ctx.epicInstall.checkUpdates(),
    state: ctx.hub.reply(),
  }));
  // The install window: sizes, folder, optional parts and DLC of an Epic game.
  register('installOptions', v => ctx.epicInstall.options(gameId(v)));
  register('chooseInstallRoot', v => ctx.epicInstall.chooseRoot(typeof v === 'string' ? v : ''));
  register('startInstall', async p => {
    const tags = p?.tags === null ? null : Array.isArray(p?.tags) ? p.tags.slice(0, 200).map(String) : null;
    const dlcs = Array.isArray(p?.dlcs) ? p.dlcs.slice(0, 200).map(String) : [];
    const result = await ctx.epicInstall.start(gameId(p?.id), { root: String(p?.root || ''), tags, dlcs });
    return { result, state: ctx.hub.reply() };
  });
  register('gameDlcs', v => ctx.epicInstall.dlcs(gameId(v)), { quiet: true });
  // «Управление» → «Добавить ярлык на рабочий стол» / «Удалить ярлык с рабочего стола».
  register('gameShortcut', p => {
    const id = gameId(p?.id);
    if (p?.action === 'create') ctx.shortcuts.create(id);
    else if (p?.action === 'remove') ctx.shortcuts.remove(id);
    else if (p?.action !== 'status') throw Error('Неизвестное действие');
    return { exists: ctx.shortcuts.exists(id), supported: ctx.shortcuts.supported() };
  });
  // "Хранилище": drives, free space, games by size.
  register('storageInfo', () => ctx.disk.info(), { quiet: true });
  register('openGameFolder', dir => {
    if (!ctx.disk.allowed(dir)) throw Error('Это не папка установленной игры');
    return shell.openPath(String(dir)).then(err => {
      if (err) throw Error(err);
      return true;
    });
  });
  // A game already on disk; moving an installed game.
  register('importGame', async v => ({
    result: await ctx.epicInstall.importFolder(gameId(v)),
    state: ctx.hub.reply(),
  }));
  register('moveGame', async v => ({
    result: await ctx.epicInstall.move(gameId(v)),
    state: ctx.hub.reply(),
  }));
  register('installDlc', async p => ({
    result: await ctx.epicInstall.installDlc(gameId(p?.id), String(p?.appId || '')),
    state: ctx.hub.reply(),
  }));
  // Download settings: limit, allowed hours, auto-updates, notifications.
  register(
    'downloadSettings',
    save(p => {
      applyDownloadSettings(settings, p);
      ctx.epicInstall.next();
    })
  );
  // "Удалить": removes the game files right in Nexus (or hands over to the client).
  register('uninstallGame', async p => {
    const { id, provider } = p || {};
    if (typeof id !== 'string' || id.length > 300 || !isProvider(provider)) throw Error('Некорректная игра');
    let result = await ctx.uninstall.uninstall(id, provider);
    if (result.how === 'client')
      result = { how: 'client', result: await actions.clientAction({ id, provider, action: 'uninstall' }) };
    return { result, state: ctx.hub.reply() };
  });
  register('epicSyncSaves', async id => {
    const g = library.games.find(x => x.id === id);
    const o = g?.offers.find(x => x.provider === 'epic' && x.installed);
    if (!o) throw Error('Игра Epic не установлена');
    return { result: await actions.epic.syncNow(o), state: ctx.hub.reply() };
  });
}

// A button of a Nexus download; null for an unknown one.
const DOWNLOAD_ACTIONS = ['pause', 'first', 'now', 'resume', 'cancel', 'update', 'repair'];
function downloadAction(e, id, action) {
  const run = {
    pause: () => e.pause(id),
    first: () => e.first(id),
    now: () => e.now(id),
    resume: () => e.resume(id),
    cancel: () => e.cancel(id),
    update: () => e.update(id),
    repair: () => e.repair(id),
  };
  return Object.hasOwn(run, action) ? run[action]() : null;
}

function applyDownloadSettings(s, p) {
  if (p?.downloadLimit !== undefined) {
    const n = Math.round(Number(p.downloadLimit));
    if (!Number.isFinite(n) || n < 0 || n > 10 * 1024 * 1024) throw Error('Некорректный лимит скорости');
    s.downloadLimit = n;
  }
  if (p?.schedule) {
    const t = v => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v).padStart(5, '0') : null);
    const from = t(p.schedule.from),
      to = t(p.schedule.to);
    if (!from || !to) throw Error('Время укажите как ЧЧ:ММ');
    s.downloadSchedule = { enabled: !!p.schedule.enabled, from, to };
  }
  if (p?.epicAutoUpdate !== undefined) s.epicAutoUpdate = !!p.epicAutoUpdate;
  if (p?.downloadNotify !== undefined) s.downloadNotify = !!p.downloadNotify;
}

module.exports = { registerGamesIpc, LAUNCH_SETTINGS };
