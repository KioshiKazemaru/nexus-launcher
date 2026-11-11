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
//   main/presence.cjs      my status, friends' status, activity feed, achievement notices
//   main/tray.cjs          tray icon (closing the window keeps Nexus running)
//   main/overlay.cjs       in-game overlay (Shift+Tab) and the FPS corner
//   main/news.cjs, workshop.cjs, profile.cjs   game news, Steam Workshop, profile page

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  safeStorage,
  Menu,
  protocol,
  net,
} = require('electron');
// Windows and Linux: no menu bar. macOS always has one, and its «Правка» items
// are what make ⌘C / ⌘V / ⌘Q work in the window.
Menu.setApplicationMenu(
  process.platform === 'darwin'
    ? Menu.buildFromTemplate([
        {
          label: 'Nexus',
          submenu: [
            { role: 'about', label: 'О программе Nexus' },
            { type: 'separator' },
            { role: 'hide', label: 'Скрыть Nexus' },
            { role: 'hideOthers', label: 'Скрыть остальные' },
            { role: 'unhide', label: 'Показать все' },
            { type: 'separator' },
            { role: 'quit', label: 'Выйти из Nexus' },
          ],
        },
        {
          label: 'Правка',
          submenu: [
            { role: 'undo', label: 'Отменить' },
            { role: 'redo', label: 'Повторить' },
            { type: 'separator' },
            { role: 'cut', label: 'Вырезать' },
            { role: 'copy', label: 'Копировать' },
            { role: 'paste', label: 'Вставить' },
            { role: 'selectAll', label: 'Выбрать всё' },
          ],
        },
        {
          label: 'Окно',
          submenu: [
            { role: 'minimize', label: 'Свернуть' },
            { role: 'togglefullscreen', label: 'Полноэкранный режим' },
          ],
        },
      ])
    : null
);
const fs = require('node:fs');
const path = require('node:path');
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
const { PresenceService } = require('./main/presence.cjs');
const { NexusTray } = require('./main/tray.cjs');
const { Overlay } = require('./main/overlay.cjs');
const { NewsService } = require('./main/news.cjs');
const { WorkshopService } = require('./main/workshop.cjs');
const { ProfileService } = require('./main/profile.cjs');
const { registerAllIpc } = require('./main/ipc/index.cjs');
const EventEmitter = require('node:events');
const { ArtworkCache } = require('./artwork.cjs');
const { ownedOffers } = require('./ownership.cjs');
const { findLibraryCover } = require('./steam-library.cjs');
const system = require('./os.cjs');

// A second copy only hands focus to the first one; it never starts services.
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);
protocol.registerSchemesAsPrivileged([
  { scheme: 'nexus-art', privileges: { standard: true, secure: true, supportFetchAPI: false } },
]);
if (process.platform === 'win32') app.setAppUserModelId('nexus.launcher');

const uiUrl = pathToFileURL(path.join(__dirname, '../ui/index.html')).href;
const icon = path.join(
  __dirname,
  '../ui/assets/' + (process.platform === 'win32' ? 'nexus.ico' : 'nexus.png')
);
const ctx = { vault: {}, gameEvents: new EventEmitter() };
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
// macOS: a click on the Dock icon shows the window hidden by its close button.
app.on('activate', () => ctx.focusMain?.());
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
// A friend's profile page in the main window.
ctx.showFriend = id => {
  ctx.focusMain();
  main?.webContents.send('show-friend', String(id));
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
  const features = system.features();
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
      // Windows-only abilities read as switched off elsewhere.
      ...(features.epicDownloads ? {} : { nexusDownloads: false }),
      ...(features.epicDirect ? {} : { epicDirectLaunch: false, epicCloudSaves: false }),
      custom: undefined,
      savedGames: undefined,
      seenGiveaways: undefined,
      wishlistDismissed: undefined,
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
    // What Nexus does itself on this system (src/os.cjs); the window hides the rest.
    features,
    accounts: accounts.summary(),
    accountList: accounts.list(),
    integrations: integrations.status(),
    free: store.free,
    wishlistSync: store.wishStatus || null,
    updater: ctx.updater.state,
    online: ctx.online(),
    version: app.getVersion(),
    native: true,
  };
}

// ---- IPC ---------------------------------------------------------------------

function register(name, fn, { quiet = false, social = false, mainWindow = true, overlay = false } = {}) {
  ipcMain.handle(name, async (event, ...args) => {
    const fromMain =
      mainWindow && main && event.sender === main.webContents && event.senderFrame?.url === uiUrl;
    const fromSocial = social && !!ctx.social?.senderKind(event);
    const fromOverlay = overlay && !!ctx.overlay?.isSender(event);
    if (!fromMain && !fromSocial && !fromOverlay) {
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
// The channels themselves live in main/ipc, one file per service.
function registerIpc() {
  registerAllIpc(register, ctx, { onlineAgain });
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
      // Not in the local Steam cache (a friend's game, a new one): the store's address.
      const { ArtResolver } = require('./main/art-resolver.cjs');
      ctx.artResolver ||= new ArtResolver({
        fetch: (url, o) => ctx.publicFetch(url, o),
        country: () => ctx.settings?.storeCountry || 'US',
      });
      const remote = await ctx.artResolver.url(appId, kind);
      if (remote && /^https:\/\/[\w.-]+\.steamstatic\.com\//.test(remote)) return ctx.publicFetch(remote);
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
    onClosed: (key, _provider, purpose) => {
      ctx.accounts.windowClosed(key, purpose).catch(e => ctx.log.warn('window', e.message));
      // Signed in to the Epic store for the wishlist: read it now.
      if (purpose === 'wishlist') ctx.store.syncWishlists().catch(e => ctx.log.warn('wishlist', e.message));
    },
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
  ctx.presence = new PresenceService(ctx);
  ctx.news = new NewsService(ctx);
  ctx.workshop = new WorkshopService(ctx);
  ctx.profile = new ProfileService(ctx);
  ctx.overlay = new Overlay(ctx);
  ctx.tray = new NexusTray(ctx, { icon });
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
    show: false,
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
  // Like Steam: the close button keeps Nexus running in the tray.
  main.on('close', e => {
    if (quitting || ctx.settings.closeToTray === false || !ctx.tray?.tray) return;
    e.preventDefault();
    main.hide();
    ctx.tray.hidden();
  });
  main.on('closed', () => {
    main = null;
    app.quit();
  });
  // Started with Windows and "запускать свёрнутым": only the tray icon.
  const startHidden = process.argv.includes('--hidden') && ctx.settings.startHidden === true;
  main.once('ready-to-show', () => {
    if (!startHidden) main.show();
  });
  registerIpc();
  await main.loadURL(uiUrl);

  lastOnline = ctx.online();
  watchNetwork();
  ctx.running.start();
  ctx.chat.start();
  ctx.tray.create();
  ctx.presence.start();
  ctx.overlay.start();
  ctx.epicInstall.init();
  ctx.accounts.refreshAll().catch(e => ctx.log.warn('accounts', e.message));
  whenOnline('prices', () => ctx.store.initialPrices())();
  whenOnline('watch', () => ctx.store.watcher.check())();
  whenOnline('free', () => ctx.store.freeGames())();
  // Pages that wait on the network (friends, recommendations, profile) are
  // prepared in the background shortly after start: their first opening is instant.
  if (process.env.NEXUS_TEST !== '1')
    setTimeout(
      whenOnline('prefetch', async () => {
        await Promise.allSettled([
          ctx.friends.list(),
          ctx.store.recommendations({ country: ctx.settings.storeCountry || 'US' }),
        ]);
        await ctx.profile.info();
      }),
      8000
    ).unref();
  if (ctx.settings.autoUpdate)
    setTimeout(
      whenOnline('update', () => ctx.updater.check()),
      15000
    ).unref();
  setInterval(
    whenOnline('watch', () => ctx.store.watcher.check()),
    3600000
  ).unref();
  // Store wishlists: after sign-in (library.cjs asks for it) and every 3 hours.
  setInterval(
    whenOnline('wishlist', () => ctx.store.syncWishlists()),
    3 * 3600000
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
        `${String(e?.message || e).slice(0, 300)}\n\nПодробности — в журнале: ${path.join(app.getPath('userData'), 'logs')}`
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
        ctx.presence?.stop();
        ctx.overlay?.stop();
        ctx.tray?.destroy();
        ctx.steamInstall?.stop();
        ctx.social?.closeAll();
      } catch {}
      ctx.log.flush();
      app.quit();
    });
});
