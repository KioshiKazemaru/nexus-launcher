'use strict';
// The library: scanning and syncing, imports, merging, hiding, collections, games
// added by hand, per-game settings, achievements, news and the Steam Workshop.
const system = require('../../os.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dialog, shell } = require('electron');
const { gameId, wrappers } = require('./helpers.cjs');

function registerLibraryIpc(register, ctx) {
  const { library, settings, storage, actions } = ctx;
  const { withState, save } = wrappers(ctx);

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
    withState(() => library.importLegendary(ctx.mainWindow()))
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
  register('achievements', id => library.achievements(id), { overlay: true });
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
  register(
    'add',
    withState(async () => {
      // .exe on Windows, an application (.app) on macOS, any program on Linux.
      const rule = system.customGame();
      const { canceled, filePaths } = await dialog.showOpenDialog(ctx.mainWindow(), {
        title: 'Выберите исполняемый файл игры',
        properties: rule.properties,
        filters: rule.filters,
      });
      if (canceled) return;
      const exe = filePaths[0].replace(/(?!^)[\\/]+$/, '');
      if (!rule.accepts(exe)) throw Error(rule.hint);
      if (!settings.custom.some(x => x.exe.toLowerCase() === exe.toLowerCase()))
        settings.custom.push({ id: crypto.randomUUID(), name: rule.title(exe) || path.basename(exe), exe });
      storage.saveSettings();
      await library.scanLocal();
    })
  );
  register(
    'steamRoot',
    withState(async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog(ctx.mainWindow(), {
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
    'setLaunchOptions',
    withState(p => actions.setLaunchOptions(p || {}))
  );
  register('gameNews', v => ctx.news.game(gameId(v)), { quiet: true });
  register('newsFeed', () => ctx.news.feed(), { quiet: true });
  register('workshop', v => ctx.workshop.items(gameId(v)), { quiet: true });
  register('openWorkshop', p => {
    const id = String(p?.id || ''),
      appId = String(p?.appId || '');
    if (p?.folder) {
      const folder = path.resolve(String(p.folder));
      if (!/[\\/]steamapps[\\/]workshop[\\/]content[\\/]\d+$/i.test(folder)) throw Error('Папка недоступна');
      return shell.openPath(folder);
    }
    if (/^\d{1,20}$/.test(id))
      return ctx.openUrl(`https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`);
    if (/^\d{1,10}$/.test(appId)) return ctx.openUrl(`https://steamcommunity.com/app/${appId}/workshop/`);
    throw Error('Некорректный предмет Мастерской');
  });
}

module.exports = { registerLibraryIpc };
