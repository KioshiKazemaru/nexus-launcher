'use strict';
// Nexus main process: wires services together and exposes them over IPC.
//   main/storage.cjs       files, encrypted vault
//   main/log.cjs           rotating log with masked secrets
//   main/accounts.cjs      Steam/Epic accounts, sessions, login windows
//   main/library.cjs       installed + account games, merge, sync, achievements
//   main/store.cjs         store front, prices, giveaways, wishlists
//   main/integrations.cjs  IsThereAnyDeal / IGDB / SteamGridDB
//   main/actions.cjs       launch, client actions, collections, backup, diagnostics
//   main/windows.cjs       official store windows, hidden page fetch
//   main/updater.cjs       automatic updates

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  safeStorage,
  Menu,
  protocol,
  net,
} = require('electron');
Menu.setApplicationMenu(null);
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const { Storage } = require('./main/storage.cjs');
const { Log } = require('./main/log.cjs');
const { createCrashHandler } = require('./main/crash.cjs');
const { StateHub, Sections } = require('./main/hub.cjs');
const { StoreWindows, PageFetcher, withPageFallback } = require('./main/windows.cjs');
const { AccountsService } = require('./main/accounts.cjs');
const { LibraryService } = require('./main/library.cjs');
const { StoreService } = require('./main/store.cjs');
const { IntegrationsService } = require('./main/integrations.cjs');
const { ActionsService } = require('./main/actions.cjs');
const { Updater } = require('./main/updater.cjs');
const { RunningGames } = require('./main/running.cjs');
const { Uninstaller } = require('./main/uninstall.cjs');
const { SocialWindows } = require('./main/social.cjs');
const { ChatService } = require('./main/chat.cjs');
const { EpicInstaller } = require('./main/epic-install.cjs');
const { SteamInstaller } = require('./main/steam-install.cjs');
const { DiskInfo } = require('./main/disk.cjs');
const { FriendsService } = require('./main/friends.cjs');
const { ArtworkCache } = require('./artwork.cjs');
const { ownedOffers } = require('./ownership.cjs');
const { findLibraryCover } = require('./steam-library.cjs');

// A second copy only hands focus to the first one; it never starts services.
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);
protocol.registerSchemesAsPrivileged([
  { scheme: 'nexus-art', privileges: { standard: true, secure: true, supportFetchAPI: false } },
]);
if (process.platform === 'win32') app.setAppUserModelId('nexus.launcher');

const uiUrl = pathToFileURL(path.join(__dirname, '../ui/index.html')).href;
const icon = path.join(__dirname, '../ui/assets/nexus.ico');
const ctx = { vault: {} };
// Tests wait for background work through this handle (never set in normal runs).
if (process.env.NEXUS_TEST === '1') {
  globalThis.__nexusTest = ctx;
  ctx.require = require; // test tools only
}
let main = null;
let quitting = false;

ctx.log = new Log(path.join(app.getPath('userData'), 'logs'), {
  console: !app.isPackaged && process.env.NEXUS_LOG_CONSOLE === '1',
});
process.on(
  'uncaughtException',
  createCrashHandler({
    app,
    dialog,
    log: ctx.log,
    flush: () => ctx.storage?.flushSync(),
    onQuit: () => (quitting = true),
  })
);
process.on('unhandledRejection', e =>
  ctx.log.error('process', 'unhandled rejection', e instanceof Error ? e : String(e))
);

app.on('second-instance', () => ctx.focusMain?.());
app.on('window-all-closed', () => {}); // The main window decides when to quit.

ctx.focusMain = () => {
  if (!main || main.isDestroyed()) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
};
ctx.showPage = page => {
  ctx.focusMain();
  main?.webContents.send('show-page', page);
};
// A click on a notification: the game's page in the library.
ctx.showGame = id => {
  ctx.focusMain();
  main?.webContents.send('show-game', String(id));
};
ctx.mainWindow = () => (main && !main.isDestroyed() ? main : null);
ctx.toast = message => main?.webContents.send('toast', String(message).slice(0, 300));
ctx.prepareQuit = () => {
  quitting = true;
  ctx.storage?.flushSync();
  ctx.store?.recFile.flushSync();
  ctx.chat?.file.flushSync();
  ctx.log.flush();
};
ctx.online = () => {
  try {
    return net.isOnline();
  } catch {
    return true;
  }
};

// ---- state sent to the window ------------------------------------------------

const sections = new Sections();
// The window state is split so that frequent small changes stay small:
//   games     library list (sent when the library is rebuilt)
//   catalog   wishlist / saved store items (sent when those lists change)
//   prices    store offers, names and covers per game id (sent when prices arrive)
//   progress  download progress per game id (always sent, tiny)
function snapshot(full) {
  const { settings, library, store, accounts, integrations } = ctx;
  const country = settings.storeCountry;
  let visible = null;
  const vis = () => (visible ||= library.visible());
  const games = sections.pick('games', `${library.version}:${country}`, () => vis(), full);
  const catalogKey = [
    country,
    store.catalogVersion,
    settings.wishlist.join(','),
    settings.favorites.join(','),
  ].join('|');
  // Prices: everything on a full reply or when the game list / region / saved
  // items changed; otherwise only the games whose store data changed.
  const pricesKey = `${library.version}:${store.catalogVersion}:${country}`;
  let prices, pricesDelta;
  if (full || sections.sent.get('prices') !== pricesKey) {
    sections.sent.set('prices', pricesKey);
    prices = store.snapshotPrices(vis().map(g => g.id));
    store.priceDirty.clear();
  } else if (store.priceDirty.size) {
    pricesDelta = store.snapshotPrices(
      vis().map(g => g.id),
      store.priceDirty
    );
    store.priceDirty.clear();
  }
  return {
    games,
    ownedOffers: games === undefined ? undefined : ownedOffers(vis()),
    catalog: sections.pick('catalog', catalogKey, () => store.snapshotCatalog(), full),
    prices,
    pricesDelta,
    progress: {
      ...library.progressByGame(),
      ...(ctx.epicInstall?.progress() || {}),
      ...(ctx.uninstall?.progress() || {}),
    },
    // Installed Epic games with a newer build on Epic's servers.
    updates: ctx.epicInstall?.updatesMap() || {},
    running: ctx.running?.snapshot() || {},
    libraryState: library.summary(),
    libraryAccounts: library.statusList(),
    settings: {
      ...settings,
      custom: undefined,
      savedGames: undefined,
      seenGiveaways: undefined,
      knownAccounts: undefined,
      // History is long; the window shows the latest 30 entries.
      priceWatches: settings.priceWatches.map(w => ({
        ...w,
        history: (w.history || []).slice(-30),
        historyCount: w.history?.length || 0,
      })),
    },
    suggestions: library.suggestions(),
    warnings: library.local.errors,
    storageWarning: ctx.storage.warning,
    platform: process.platform,
    accounts: accounts.summary(),
    accountList: accounts.list(),
    integrations: integrations.status(),
    free: store.free,
    updater: ctx.updater.state,
    online: ctx.online(),
    version: app.getVersion(),
    native: true,
  };
}

// ---- IPC ---------------------------------------------------------------------

function register(name, fn, { quiet = false, social = false, mainWindow = true } = {}) {
  ipcMain.handle(name, async (event, ...args) => {
    const fromMain =
      mainWindow && main && event.sender === main.webContents && event.senderFrame?.url === uiUrl;
    const fromSocial = social && !!ctx.social?.senderKind(event);
    if (!fromMain && !fromSocial) {
      ctx.log.warn('ipc', `untrusted sender for ${name}`);
      throw Error('Untrusted IPC');
    }
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      if (quiet)
        ctx.log.debug('ipc', `${name}: ${error.message}${error.status ? ' HTTP ' + error.status : ''}`);
      else ctx.log.warn('ipc', `${name}: ${error.message}`);
      return { ok: false, error: error.message || 'Не удалось выполнить действие' };
    }
  });
}
const withState =
  fn =>
  async (...args) => {
    await fn(...args);
    return ctx.hub.reply();
  };
const isProvider = p => p === 'steam' || p === 'epic';
const isAccountKey = k => typeof k === 'string' && /^(steam:\d{1,2}|epic:[a-f0-9]{32}|steam|epic)$/i.test(k);
const optionalAccount = k => {
  if (k !== undefined && k !== null && !isAccountKey(k)) throw Error('Неизвестный аккаунт');
  return k || undefined;
};
const bool = (v, name = 'значение') => {
  if (typeof v !== 'boolean') throw Error('Некорректное ' + name);
  return v;
};

function registerIpc() {
  const { library, store, accounts, integrations, settings, storage, actions } = ctx;
  const save = fn =>
    withState(async (...a) => {
      await fn(...a);
      storage.saveSettings();
    });

  register('state', () => ctx.hub.now()); // complete state
  register('stateUpdate', () => ctx.hub.reply()); // unchanged large sections omitted
  // A missing cover is normal (not every game has every image size): not a warning.
  register('getArtwork', url => ctx.artwork.get(url), { quiet: true });
  register(
    'refreshAccounts',
    withState(() => accounts.refreshAll())
  );
  register('searchCatalog', p => store.search(p));
  register('browseCatalog', p => store.browse(p));
  register('homeCatalog', p => store.home(p));
  register('browseDlc', p => store.dlc(p));
  register('recommendations', p => store.recommendations(p));
  register('gamePrices', p => store.gamePrices(p));
  register('gameDeals', p => store.deals(p));
  register('watchHistory', key => settings.priceWatches.find(w => w.key === key)?.history || []);
  register(
    'refreshCatalogPrices',
    withState(() => store.initialPrices())
  );
  register(
    'watchPrice',
    withState(p => store.watch(p))
  );
  register(
    'checkPrices',
    withState(() => store.watcher.check())
  );
  register(
    'removeWatch',
    withState(key => store.unwatch(key))
  );
  register(
    'priceTarget',
    withState(p => store.target(p))
  );
  register(
    'country',
    save(country => {
      store.checkCountry(country);
      settings.storeCountry = country;
      store.initialPrices().catch(e => ctx.log.warn('prices', e.message));
    })
  );
  register(
    'scan',
    withState(() => library.scanLocal())
  );
  register(
    'syncLibraries',
    withState(() => library.syncAll(true))
  );
  register(
    'importLegendary',
    withState(() => library.importLegendary(main))
  );
  register(
    'steamImport',
    withState(p => library.importSteamApi(p))
  );
  register(
    'libraryView',
    save(view => {
      if (!['installed', 'owned'].includes(view)) throw Error('Некорректный вид библиотеки');
      settings.libraryView = view;
    })
  );
  register(
    'toggle',
    withState(p => store.toggle(p))
  );
  register(
    'preferred',
    save(({ id, provider }) => {
      if (!['steam', 'epic', 'custom'].includes(provider) || typeof id !== 'string' || id.length > 200)
        throw Error('Некорректная платформа');
      settings.preferred[id] = provider;
    })
  );
  register(
    'remember',
    withState(({ provider, enabled }) => {
      if (!isProvider(provider)) throw Error('Некорректные параметры');
      return accounts.setRemember(provider, bool(enabled));
    })
  );
  register('login', p => {
    const args = typeof p === 'string' ? { provider: p } : p || {};
    if (!isProvider(args.provider)) throw Error('Неизвестный магазин');
    return accounts.login({ provider: args.provider, add: args.add === true });
  });
  register(
    'epicCode',
    withState(text => accounts.epicCode(text))
  );
  register('browser', p => {
    if (!isProvider(p)) throw Error('Неизвестный магазин');
    return accounts.openInBrowser(p);
  });
  register(
    'forget',
    withState(key => {
      if (!isAccountKey(key)) throw Error('Неизвестный аккаунт');
      return accounts.forget(key);
    })
  );
  register('buy', ({ id, provider, account }) => {
    const acc = optionalAccount(account);
    const url = store.buyUrl({ id, provider, account: acc });
    const target = accounts.checkoutTarget(provider, acc, true);
    ctx.windows.open({ key: target.key, provider, session: target.session, url, purpose: 'checkout' });
    return { opened: true, account: target.account?.name || null };
  });
  register('claimFree', ({ appId, account }) => {
    const acc = optionalAccount(account);
    const url = store.claimUrl({ appId });
    const target = accounts.checkoutTarget('epic', acc, true);
    ctx.windows.open({
      key: target.key,
      provider: 'epic',
      session: target.session,
      url,
      purpose: 'checkout',
    });
    return { opened: true, account: target.account?.name || null };
  });
  register('freeGames', () => store.freeGames(true));
  register('importWishlists', async () => ({
    report: await store.importWishlists(),
    state: ctx.hub.reply(),
  }));
  register('play', async p => ({ result: await actions.play(p), state: ctx.hub.reply() }));
  register('clientAction', async p => ({ result: await actions.clientAction(p), state: ctx.hub.reply() }));
  register('achievements', id => library.achievements(id));
  register(
    'setTrackProcess',
    withState(p => actions.setTrackProcess(p))
  );
  register(
    'linkGames',
    withState(({ a, b }) => library.link(a, b))
  );
  register(
    'splitGame',
    withState(id => library.split(id))
  );
  register(
    'setHidden',
    withState(p => actions.setHidden(p))
  );
  register(
    'createCollection',
    withState(name => actions.createCollection(name))
  );
  register(
    'deleteCollection',
    withState(id => actions.deleteCollection(id))
  );
  register(
    'setInCollection',
    withState(p => actions.setInCollection(p))
  );
  register('importSteamCollections', async () => ({
    report: await library.importSteamCollections(),
    state: ctx.hub.reply(),
  }));
  register('exportBackup', () => actions.exportBackup(main));
  register('importBackup', async () => ({
    result: await actions.importBackup(main),
    state: ctx.hub.reply(),
  }));
  register('saveDiagnostics', () => actions.saveDiagnostics(main));
  register('openLogs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
  register('rendererError', message => {
    ctx.log.error('ui', String(message).slice(0, 2000));
  });
  register(
    'setKey',
    withState(({ name, value }) => integrations.setKey(name, value))
  );
  register(
    'notifyGiveaways',
    save(enabled => (settings.notifyGiveaways = bool(enabled)))
  );
  register(
    'networkChanged',
    withState(online => (online ? onlineAgain() : undefined))
  );
  register(
    'add',
    withState(async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog(main, {
        title: 'Выберите исполняемый файл игры',
        properties: ['openFile'],
        filters: [{ name: 'Приложение Windows', extensions: ['exe'] }],
      });
      if (canceled) return;
      const exe = filePaths[0];
      if (path.extname(exe).toLowerCase() !== '.exe') throw Error('Выберите .exe');
      if (!settings.custom.some(x => x.exe.toLowerCase() === exe.toLowerCase()))
        settings.custom.push({ id: crypto.randomUUID(), name: path.basename(exe, '.exe'), exe });
      storage.saveSettings();
      await library.scanLocal();
    })
  );
  register(
    'steamRoot',
    withState(async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog(main, {
        title: 'Папка Steam или библиотеки Steam (с steamapps внутри)',
        properties: ['openDirectory'],
      });
      if (canceled) return;
      if (!fs.existsSync(path.join(filePaths[0], 'steamapps')))
        throw Error('В выбранной папке нет steamapps');
      settings.steamRoot = filePaths[0];
      storage.saveSettings();
      await library.scanLocal();
    })
  );
  register(
    'autoStart',
    save(enabled => {
      app.setLoginItemSettings({ openAtLogin: bool(enabled), path: process.execPath });
      settings.autoStart = enabled;
    })
  );
  // Starting games: Epic without its launcher, cloud saves, Steam hidden.
  const LAUNCH_SETTINGS = [
    'epicDirectLaunch',
    'epicCloudSaves',
    'steamSilent',
    'steamCloseAfter',
    'nexusDownloads',
  ];
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
  register('closeGame', async id => {
    if (typeof id !== 'string' || id.length > 300) throw Error('Некорректная игра');
    return { result: await ctx.running.close(id), state: ctx.hub.reply() };
  });
  // Downloads without the launchers' windows (Epic: Nexus itself; Steam: Steam in the tray).
  register('downloadControl', async p => {
    const { id, action } = p || {};
    if (typeof id !== 'string' || id.length > 300) throw Error('Некорректная игра');
    const e = ctx.epicInstall;
    const result =
      action === 'pause'
        ? e.pause(id)
        : action === 'first'
          ? e.first(id)
          : action === 'now'
            ? e.now(id)
            : action === 'resume'
              ? e.resume(id)
              : action === 'cancel'
                ? await e.cancel(id)
                : action === 'update'
                  ? await e.update(id)
                  : action === 'repair'
                    ? await e.repair(id)
                    : null;
    if (result === null) throw Error('Неизвестное действие');
    return { result, state: ctx.hub.reply() };
  });
  register('checkUpdates', async () => ({
    result: await ctx.epicInstall.checkUpdates(),
    state: ctx.hub.reply(),
  }));
  // The install window: sizes, folder, optional parts and DLC of an Epic game.
  const gameId = v => {
    if (typeof v !== 'string' || v.length > 300) throw Error('Некорректная игра');
    return v;
  };
  register('installOptions', v => ctx.epicInstall.options(gameId(v)));
  register('chooseInstallRoot', v => ctx.epicInstall.chooseRoot(typeof v === 'string' ? v : ''));
  register('startInstall', async p => {
    const tags = p?.tags === null ? null : Array.isArray(p?.tags) ? p.tags.slice(0, 200).map(String) : null;
    const dlcs = Array.isArray(p?.dlcs) ? p.dlcs.slice(0, 200).map(String) : [];
    const result = await ctx.epicInstall.start(gameId(p?.id), { root: String(p?.root || ''), tags, dlcs });
    return { result, state: ctx.hub.reply() };
  });
  register('gameDlcs', v => ctx.epicInstall.dlcs(gameId(v)), { quiet: true });
  // Gamepad mode: the window goes full screen.
  register('bigPicture', on => {
    main?.setFullScreen(on === true);
    return true;
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
      const s = settings;
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
  // Friends of the connected Steam and Epic accounts (with Steam status).
  register('friends', p => ctx.friends.list({ force: p?.force === true }), { quiet: true, social: true });
  // "Друзья и чат" as their own windows; chat with Steam and Epic friends.
  register('openFriendsWindow', () => ctx.social.openFriends());
  register('openChat', conv => ctx.social.openChat(String(conv || '')), { social: true });
  register('socialInfo', () => ctx.friends.me(), { social: true, quiet: true });
  register('chatTabs', () => ctx.social.takePending().map(k => ctx.social.friendInfo(k)), {
    social: true,
    mainWindow: false,
  });
  register('friendInfo', conv => ctx.social.friendInfo(String(conv || '')), {
    social: true,
    mainWindow: false,
    quiet: true,
  });
  register('chatMessages', conv => ctx.chat.messages(String(conv || '')), {
    social: true,
    mainWindow: false,
    quiet: true,
  });
  register(
    'chatSend',
    p => {
      if (typeof p?.text !== 'string' || p.text.length > 4000) throw Error('Слишком длинное сообщение');
      return ctx.chat.send(String(p.conv || ''), p.text);
    },
    { social: true, mainWindow: false }
  );
  register(
    'chatViewing',
    list => ctx.chat.setViewing(Array.isArray(list) ? list.slice(0, 50).map(String) : []),
    {
      social: true,
      mainWindow: false,
      quiet: true,
    }
  );
  register('focusMain', () => ctx.focusMain(), { social: true, mainWindow: false });
  register(
    'openProfile',
    ({ provider, id } = {}) => {
      if (provider !== 'steam' || !/^7656119\d{10}$/.test(String(id))) throw Error('Профиль недоступен');
      return shell.openExternal(`https://steamcommunity.com/profiles/${id}/`);
    },
    { social: true }
  );
  register('epicSyncSaves', async id => {
    const g = library.games.find(x => x.id === id);
    const o = g?.offers.find(x => x.provider === 'epic' && x.installed);
    if (!o) throw Error('Игра Epic не установлена');
    return { result: await actions.epic.syncNow(o), state: ctx.hub.reply() };
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

// Back online: verify accounts again and reload libraries and the store front.
let lastOnline = true;
async function onlineAgain() {
  ctx.log.info('network', 'online again');
  await ctx.accounts.refreshAll();
  ctx.store.freeGames(true).catch(e => ctx.log.warn('free', e.message));
}
function watchNetwork() {
  setInterval(() => {
    const now = ctx.online();
    if (now !== lastOnline) {
      lastOnline = now;
      ctx.log.info('network', now ? 'online' : 'offline');
      ctx.hub.publish();
      if (now) onlineAgain().catch(e => ctx.log.warn('network', e.message));
    }
  }, 5000).unref();
}
// Periodic network jobs are skipped while offline instead of failing noisily.
const whenOnline = (name, job) => () => {
  if (!ctx.online()) return;
  Promise.resolve()
    .then(job)
    .catch(e => ctx.log.warn(name, e.message));
};

// Local Steam covers: nexus-art://steam/<appid>/<portrait|header|hero>
function registerArtProtocol() {
  protocol.handle('nexus-art', async request => {
    try {
      const u = new URL(request.url);
      const [, appId, kind] = u.pathname.split('/');
      if (u.hostname !== 'steam' || !/^\d+$/.test(appId || '')) return new Response('', { status: 404 });
      for (const dir of ctx.library.steamCacheDirs()) {
        const file = await findLibraryCover(fs.promises, path, dir, appId, kind);
        if (file) return net.fetch(pathToFileURL(file).href);
      }
    } catch (e) {
      ctx.log.warn('nexus-art', e.message);
    }
    return new Response('', { status: 404 });
  });
}

// Sign-in sessions are saved on quit, but a stuck cookie store must not keep
// Nexus running in the background forever.
const QUIT_TIMEOUT = 5000;
function withQuitTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('saving sessions timed out')), QUIT_TIMEOUT);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function start() {
  if (process.platform !== 'win32' && !process.argv.includes('--dev-linux')) {
    dialog.showErrorBox('Nexus для Windows', 'Эта сборка предназначена для Windows 10/11 x64.');
    app.quit();
    return;
  }
  ctx.log.info('app', `start ${app.getVersion()} electron ${process.versions.electron}`);
  ctx.storage = new Storage(app.getPath('userData'), safeStorage);
  ctx.settings = ctx.storage.loadSettings();
  ctx.vault = ctx.storage.loadVault();
  if (ctx.storage.warning) ctx.log.warn('storage', ctx.storage.warning);
  const publicSession = session.fromPartition('nexus-public-catalog');
  ctx.publicFetch = (url, options = {}) => publicSession.fetch(url, { ...options, credentials: 'omit' });
  const catalogPage = new PageFetcher({
    session: publicSession,
    origin: 'https://store.epicgames.com',
    startUrl: 'https://store.epicgames.com/',
  });
  ctx.epicFetch = withPageFallback(ctx.publicFetch, catalogPage);
  ctx.routedFetch = (url, options) =>
    String(url).startsWith('https://store.epicgames.com/')
      ? ctx.epicFetch(url, options)
      : ctx.publicFetch(url, options);
  // One hidden store page per Epic web session (wishlist import of each account).
  const accountPages = new Map();
  ctx.epicStorePage = accountKey => {
    const target = ctx.accounts.checkoutTarget('epic', accountKey);
    if (!accountPages.has(target.key))
      accountPages.set(
        target.key,
        new PageFetcher({
          session: target.session,
          origin: 'https://store.epicgames.com',
          startUrl: 'https://store.epicgames.com/',
          idleMs: 120000,
        })
      );
    return accountPages.get(target.key);
  };

  ctx.hub = new StateHub(
    snapshot,
    state => {
      if (main && !main.isDestroyed()) main.webContents.send('state-changed', state);
    },
    120,
    e => ctx.log.error('state', 'snapshot failed', e)
  );
  ctx.windows = new StoreWindows({
    getMain: () => main,
    onAuthActivity: key => key.startsWith('steam:') && ctx.accounts.scheduleAuth(key),
    onClosed: (key, _provider, purpose) =>
      ctx.accounts.windowClosed(key, purpose).catch(e => ctx.log.warn('window', e.message)),
  });
  ctx.integrations = new IntegrationsService(ctx);
  ctx.accounts = new AccountsService(ctx);
  ctx.library = new LibraryService(ctx);
  ctx.store = new StoreService(ctx);
  ctx.actions = new ActionsService(ctx);
  ctx.updater = new Updater(ctx);
  ctx.running = new RunningGames(ctx);
  ctx.uninstall = new Uninstaller(ctx);
  ctx.epicInstall = new EpicInstaller(ctx);
  ctx.steamInstall = new SteamInstaller(ctx);
  ctx.disk = new DiskInfo(ctx);
  ctx.friends = new FriendsService(ctx);
  ctx.social = new SocialWindows(ctx, { icon });
  ctx.chat = new ChatService(ctx);
  ctx.artwork = new ArtworkCache(ctx.storage.file('covers'), ctx.publicFetch);
  ctx.artwork.prune().catch(e => ctx.log.warn('art', e.message));
  registerArtProtocol();

  await ctx.accounts.init();
  await ctx.library.scanLocal();

  main = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: '#10151d',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#171d25', symbolColor: '#aeb6c0', height: 34 },
    title: 'Nexus · Steam + Epic',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  main.removeMenu();
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  main.webContents.on('will-navigate', e => e.preventDefault());
  main.webContents.on('render-process-gone', (_e, d) => ctx.log.error('ui', `renderer gone: ${d.reason}`));
  main.on('closed', () => {
    main = null;
    app.quit();
  });
  registerIpc();
  await main.loadURL(uiUrl);

  lastOnline = ctx.online();
  watchNetwork();
  ctx.running.start();
  ctx.chat.start();
  ctx.epicInstall.init();
  ctx.accounts.refreshAll().catch(e => ctx.log.warn('accounts', e.message));
  whenOnline('prices', () => ctx.store.initialPrices())();
  whenOnline('watch', () => ctx.store.watcher.check())();
  whenOnline('free', () => ctx.store.freeGames())();
  if (ctx.settings.autoUpdate)
    setTimeout(
      whenOnline('update', () => ctx.updater.check()),
      15000
    ).unref();
  setInterval(
    whenOnline('watch', () => ctx.store.watcher.check()),
    3600000
  ).unref();
  setInterval(
    whenOnline('accounts', () => ctx.accounts.refreshAll()),
    300000
  ).unref();
  // New builds of installed Epic games (the "Обновить" button).
  setTimeout(
    whenOnline('updates', () => ctx.epicInstall.checkUpdates()),
    90000
  ).unref();
  setInterval(
    whenOnline('updates', () => ctx.epicInstall.checkUpdates()),
    6 * 3600000
  ).unref();
  setInterval(
    whenOnline('free', () => ctx.store.freeGames(true)),
    6 * 3600000
  ).unref();
  setInterval(
    whenOnline('update', () => ctx.settings.autoUpdate && ctx.updater.check()),
    6 * 3600000
  ).unref();
}

// A failure during start would otherwise leave an invisible process behind.
app.whenReady().then(() => {
  if (!primary) return;
  return start().catch(e => {
    ctx.log.error('app', 'start failed', e);
    ctx.storage?.flushSync();
    ctx.log.flush();
    try {
      dialog.showErrorBox(
        'Nexus не запустился',
        `${String(e?.message || e).slice(0, 300)}\n\nПодробности — в журнале: %APPDATA%\\Nexus Launcher\\logs`
      );
    } catch {}
    quitting = true;
    app.exit(1);
  });
});

app.on('before-quit', event => {
  if (quitting || !ctx.storage || !ctx.accounts) return;
  event.preventDefault();
  quitting = true;
  for (const key of ctx.accounts.monitor.keys()) ctx.accounts.stopLogin(key);
  withQuitTimeout(ctx.accounts.captureSessions())
    .catch(e => ctx.log.warn('vault', e.message))
    .finally(() => {
      ctx.log.info('app', 'quit');
      ctx.storage.flushSync();
      try {
        ctx.store?.recFile.flushSync();
        ctx.chat?.stop();
        ctx.steamInstall?.stop();
        ctx.social?.closeAll();
      } catch {}
      ctx.log.flush();
      app.quit();
    });
});
