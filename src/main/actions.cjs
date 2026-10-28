'use strict';
// User actions that touch the system: launching games (with playtime tracking
// for manually added .exe), install/uninstall/verify through the official
// clients, collections, backups and the diagnostics report.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const QUICK_EXIT = 90 * 1000;
const PROCESS_NAME = /^[\w .()+-]{1,100}\.exe$/i;
const { app, dialog } = require('electron');
const platforms = require('../platforms/index.cjs');
const collections = require('../collections.cjs');
const { createBackup, restoreBackup, backupCustomGames, MAX_BYTES } = require('../backup.cjs');
const { redact } = require('./log.cjs');
const { EpicPlayService } = require('./epic-play.cjs');
const { ClientInstaller } = require('./clients.cjs');

class ActionsService {
  constructor(ctx) {
    this.ctx = ctx;
    this.running = new Map(); // custom game id → start time
    this.epic = new EpicPlayService(ctx);
    this.clients = new ClientInstaller(ctx);
    this.steamStartedByNexus = false;
  }
  game(id) {
    const g = this.ctx.library.games.find(x => x.id === id);
    if (!g) throw Error('Игра не найдена');
    return g;
  }

  // ---- launching ---------------------------------------------------------

  async play({ id, provider }) {
    const g = this.game(id),
      o = g.offers.find(x => x.provider === provider);
    if (!o) throw Error('Версия игры не найдена');
    // One copy at a time: a running game is closed with "Закрыть", not started again.
    if (this.ctx.running?.isRunning(id))
      throw Error('Игра уже запущена — её можно закрыть кнопкой «Закрыть»');
    let how = 'launcher';
    if (o.provider === 'custom') await this.runCustom(o);
    else if (
      !o.installed &&
      this.ctx.settings.nexusDownloads !== false &&
      (o.provider === 'epic' || o.provider === 'steam')
    ) {
      const r = await (o.provider === 'epic' ? this.ctx.epicInstall : this.ctx.steamInstall).install(id);
      how =
        r.how === 'client'
          ? await this.openClient(
              o.provider,
              platforms.get(o.provider).launchUri(o),
              'установить игру',
              'launcher'
            )
          : r.how;
      if (how === 'canceled' || how === 'client-install') return { how };
      if (how === 'launcher') this.ctx.library.expectChange();
      this.ctx.log.info('install', `${provider}:${o.appId} (${how})`);
      return { how };
    } else if (o.provider === 'epic' && o.installed && this.epic.canStart(o)) how = await this.playEpic(o, g);
    else if (o.provider === 'steam' && o.installed && this.ctx.settings.steamSilent !== false)
      how = await this.playSteam(o);
    else
      how = await this.openClient(
        o.provider,
        platforms.get(o.provider).launchUri(o),
        o.installed ? 'запустить игру' : 'установить игру',
        'launcher'
      );
    if (how === 'canceled' || how === 'client-install') return { how };
    if (!o.installed && o.provider !== 'custom') this.ctx.library.expectChange();
    if (o.installed)
      this.ctx.settings.recent = [
        { id, time: Date.now() },
        ...this.ctx.settings.recent.filter(x => x.id !== id),
      ].slice(0, 20);
    this.ctx.settings.preferred[id] = provider;
    this.ctx.storage.saveSettings();
    this.ctx.log.info('play', `${provider}:${o.appId} (${how})`);
    this.ctx.running?.soon(8000);
    return { how };
  }
  // Epic without the Epic launcher; any failure falls back to the launcher.
  async playEpic(o, g) {
    try {
      const result = await this.epic.play(o, g);
      return result.canceled ? 'canceled' : 'direct';
    } catch (e) {
      if (/уже запущена/.test(e.message)) throw e;
      this.ctx.log.warn('epic-play', `${o.appId}: ${e.message} — Epic launcher`);
      const how = await this.openClient(
        'epic',
        platforms.get('epic').launchUri(o),
        'запустить игру',
        'launcher'
      );
      if (how === 'launcher') this.ctx.toast?.(`${e.message}. Игра запущена через Epic Games Launcher.`);
      return how;
    }
  }

  // Opens a link of the official client; a missing client is offered for
  // installation first (see clients.cjs). Returns `opened`, 'client-install' or 'canceled'.
  async openClient(provider, uri, action, opened) {
    const r = await this.clients.open(provider, uri, action);
    return r === 'opened' ? opened : r === 'install-started' ? 'client-install' : 'canceled';
  }

  // ---- Steam without its window --------------------------------------------------

  steamExe() {
    for (const root of this.ctx.library.local.steamRoots || []) {
      const exe = path.join(root, 'steam.exe');
      if (fs.existsSync(exe)) return exe;
    }
    return null;
  }
  // Steam has to run for its games (DRM, Steam Cloud, achievements), but its
  // window does not: when Steam is closed, Nexus starts it hidden in the tray
  // ("-silent") together with the game, and closes it again after the game
  // if the user wants that.
  async playSteam(o) {
    const exe = process.platform === 'win32' ? this.steamExe() : null;
    if (!exe || (await this.processRunning('steam.exe')))
      return this.openClient('steam', platforms.get('steam').launchUri(o), 'запустить игру', 'steam');
    const child = spawn(exe, ['-silent', '-applaunch', String(o.appId)], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.on('error', e => this.ctx.log.warn('steam', e.message));
    child.unref();
    this.steamStartedByNexus = true;
    if (this.ctx.settings.steamCloseAfter !== false)
      this.closeSteamAfter(exe, String(o.appId)).catch(e => this.ctx.log.warn('steam', e.message));
    return 'steam-silent';
  }
  // Steam keeps the running game in HKCU\Software\Valve\Steam\RunningAppID.
  async runningSteamApp() {
    try {
      const { stdout } = await promisify(execFile)(
        'reg.exe',
        ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'RunningAppID'],
        { windowsHide: true, timeout: 5000 }
      );
      const m = /RunningAppID\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
      return m ? String(parseInt(m[1], 16)) : '0';
    } catch {
      return '0';
    }
  }
  async closeSteamAfter(exe, appId) {
    // Wait for the game to start (Steam may update it first), then for it to end.
    const startBy = Date.now() + 30 * 60 * 1000;
    while (Date.now() < startBy && (await this.runningSteamApp()) !== appId) await this.sleep(10000);
    if ((await this.runningSteamApp()) !== appId) return;
    while ((await this.runningSteamApp()) === appId) await this.sleep(15000);
    // Steam Cloud uploads the saves right after the game: give it time.
    await this.sleep(60000);
    const now = await this.runningSteamApp();
    if (now !== '0' || !this.steamStartedByNexus) return;
    spawn(exe, ['-shutdown'], { detached: true, stdio: 'ignore', shell: false }).unref();
    this.steamStartedByNexus = false;
    this.ctx.log.info('steam', 'closed after the game (it was started hidden by Nexus)');
  }
  // Nexus starts the .exe itself, so it can measure how long the process runs.
  // Games that start another process and exit at once are counted only until
  // the first process exits.
  async runCustom(o) {
    const custom = this.ctx.settings.custom.find(x => x.id === o.appId);
    if (!custom || !fs.existsSync(custom.exe)) throw Error('Файл игры не найден');
    if (this.running.has(custom.id)) throw Error('Игра уже запущена');
    const started = Date.now();
    await new Promise((resolve, reject) => {
      const child = spawn(custom.exe, [], {
        cwd: path.dirname(custom.exe),
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        this.running.set(custom.id, started);
        child.once('exit', () =>
          this.childExited(custom, started).catch(e => this.ctx.log.warn('playtime', e.message))
        );
        child.unref();
        resolve();
      });
    });
  }
  // Launchers start the game as another process and exit at once. With a
  // "game process" set for the entry, Nexus keeps counting while that process runs.
  async childExited(custom, started) {
    const quick = Date.now() - started < QUICK_EXIT;
    if (custom.trackProcess && process.platform === 'win32') {
      await this.sleep(5000);
      const deadline = started + 24 * 3600 * 1000;
      while (Date.now() < deadline && (await this.processRunning(custom.trackProcess)))
        await this.sleep(15000);
      return this.stopCustom(custom.id, started);
    }
    this.stopCustom(custom.id, started);
    if (quick)
      this.ctx.toast?.(
        `«${custom.name}» закрылся сразу после запуска — похоже, это лаунчер. Укажите процесс игры на её странице, чтобы считать время.`
      );
  }
  sleep(ms) {
    return new Promise(r => setTimeout(r, ms).unref?.());
  }
  async processRunning(image) {
    try {
      const { stdout } = await promisify(execFile)(
        'tasklist',
        ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'],
        {
          windowsHide: true,
          timeout: 8000,
        }
      );
      return stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
    } catch {
      return false;
    }
  }
  setTrackProcess({ id, process: image }) {
    const g = this.game(id);
    const o = g.offers.find(x => x.provider === 'custom');
    const custom = o && this.ctx.settings.custom.find(x => x.id === o.appId);
    if (!custom) throw Error('Процесс можно указать только для игры, добавленной вручную');
    const value = typeof image === 'string' ? image.trim() : '';
    if (value && !PROCESS_NAME.test(value)) throw Error('Укажите имя файла процесса, например game.exe');
    if (value) custom.trackProcess = value;
    else delete custom.trackProcess;
    this.ctx.storage.saveSettings();
    this.ctx.library.scanLocal().catch(e => this.ctx.log.warn('scan', e.message));
  }
  stopCustom(id, started, now = Date.now()) {
    this.running.delete(id);
    const minutes = Math.max(0, Math.round((now - started) / 60000));
    const old = this.ctx.settings.customPlaytime[id] || { minutes: 0 };
    this.ctx.settings.customPlaytime[id] = {
      minutes: (old.minutes || 0) + minutes,
      lastPlayed: Math.floor(now / 1000),
    };
    this.ctx.storage.saveSettings();
    this.ctx.library.scanLocal().catch(e => this.ctx.log.warn('scan', e.message));
  }
  // install | uninstall | verify through the official client.
  async clientAction({ id, provider, action }) {
    if (!['install', 'uninstall', 'verify'].includes(action)) throw Error('Неизвестное действие');
    const g = this.game(id),
      o = g.offers.find(x => x.provider === provider);
    if (!o || o.provider === 'custom') throw Error('Действие доступно только для игр Steam и Epic');
    if (action === 'install' && o.installed) throw Error('Игра уже установлена');
    if (action !== 'install' && !o.installed) throw Error('Игра не установлена');
    const uri = platforms.get(provider).clientUri(action, o);
    const how = await this.openClient(
      provider,
      uri,
      { install: 'установить игру', uninstall: 'удалить игру', verify: 'проверить файлы игры' }[action],
      'client'
    );
    if (how !== 'client') return { uri, how, viaLibrary: false };
    this.ctx.library.expectChange();
    this.ctx.log.info('client', `${action} ${provider}:${o.appId}`);
    return { uri, viaLibrary: uri.endsWith('://library') };
  }

  // ---- collections --------------------------------------------------------

  createCollection(name) {
    const c = collections.createCollection(
      this.ctx.settings,
      name,
      'c-' + crypto.randomBytes(6).toString('hex')
    );
    this.ctx.storage.saveSettings();
    this.ctx.library.rebuild();
    return c;
  }
  deleteCollection(id) {
    const before = this.ctx.settings.collections.length;
    this.ctx.settings.collections = this.ctx.settings.collections.filter(c => c.id !== id);
    if (before === this.ctx.settings.collections.length) throw Error('Коллекция не найдена');
    this.ctx.storage.saveSettings();
    this.ctx.library.rebuild();
  }
  setInCollection({ collection, id, include }) {
    collections.setInCollection(this.ctx.settings, collection, id, include === true);
    this.ctx.storage.saveSettings();
    this.ctx.library.rebuild();
  }
  setHidden({ id, hidden }) {
    collections.setHidden(this.ctx.settings, id, hidden === true);
    this.ctx.storage.saveSettings();
    this.ctx.library.rebuild();
  }

  // ---- backup ---------------------------------------------------------------

  async exportBackup(main) {
    const { canceled, filePath } = await dialog.showSaveDialog(main, {
      title: 'Резервная копия настроек Nexus',
      defaultPath: `nexus-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Резервная копия Nexus', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    const data = createBackup(this.ctx.settings, this.ctx.library.ownedCache, app.getVersion());
    await fsp.writeFile(filePath, JSON.stringify(data, null, 1), { mode: 0o600 });
    this.ctx.log.info('backup', 'exported');
    return { file: path.basename(filePath) };
  }
  async importBackup(main) {
    const { canceled, filePaths } = await dialog.showOpenDialog(main, {
      title: 'Восстановить настройки Nexus',
      properties: ['openFile'],
      filters: [{ name: 'Резервная копия Nexus', extensions: ['json'] }],
    });
    if (canceled) return null;
    const stat = await fsp.stat(filePaths[0]);
    // Checked before reading: a huge file must not be loaded into memory.
    if (!stat.isFile() || stat.size > MAX_BYTES) throw Error('Файл резервной копии слишком большой');
    let data;
    try {
      data = JSON.parse(await fsp.readFile(filePaths[0], 'utf8'));
    } catch {
      throw Error('Файл повреждён или не является JSON');
    }
    const library = restoreBackup(this.ctx.settings, data, stat.size);
    await this.restoreCustomGames(main, backupCustomGames(this.ctx.settings, data));
    try {
      this.ctx.store.checkCountry(this.ctx.settings.storeCountry);
    } catch {
      this.ctx.settings.storeCountry = 'US';
    }
    for (const [k, v] of Object.entries(library))
      if (!this.ctx.library.ownedCache[k]) this.ctx.library.ownedCache[k] = v;
    this.ctx.library.saveOwned();
    this.ctx.storage.saveSettings();
    await this.ctx.library.scanLocal();
    this.ctx.log.info('backup', 'restored');
    return { restored: true };
  }
  // "Play" starts the program of a manually added game, so programs named by a
  // backup file are added only after the user has seen the paths.
  async restoreCustomGames(main, list) {
    if (!list.length) return 0;
    const shown = list.slice(0, 10).map(c => `• ${c.name}: ${c.exe}`);
    if (list.length > shown.length) shown.push(`… и ещё ${list.length - shown.length}`);
    const { response } = await dialog.showMessageBox(main, {
      type: 'warning',
      buttons: ['Добавить', 'Пропустить'],
      defaultId: 1,
      cancelId: 1,
      title: 'Игры, добавленные вручную',
      message: `Добавить программы из резервной копии (${list.length})?`,
      detail: `Кнопка «Играть» запускает указанный файл. Добавляйте, только если копия ваша.\n\n${shown.join('\n')}`,
    });
    if (response !== 0) return 0;
    this.ctx.settings.custom.push(...list);
    return list.length;
  }

  // ---- diagnostics ----------------------------------------------------------

  diagnosticsText() {
    const { accounts, library, integrations, settings } = this.ctx;
    const lines = [
      `Nexus ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform} ${os.release()} ${process.arch}`,
      `Создано: ${new Date().toISOString()}`,
      '',
      '== Аккаунты ==',
      ...accounts.list().map(a => `${a.key}: ${a.status}${a.message ? ' — ' + a.message : ''}`),
      '',
      '== Библиотеки ==',
      ...library
        .statusList()
        .map(
          a =>
            `${a.key}: ${a.library.status} · ${a.library.count || 0} игр${a.library.message ? ' — ' + a.library.message : ''}`
        ),
      `Игр в объединённой библиотеке: ${library.games.length}; на диске: ${library.local.offers.length}; папки Steam: ${library.local.steamRoots.length}`,
      `Ошибки сканирования: ${library.local.errors.join('; ') || 'нет'}`,
      '',
      '== Сервисы ==',
      JSON.stringify(integrations.status()),
      `Регион: ${settings.storeCountry}; отслеживаний цен: ${settings.priceWatches.length}; коллекций: ${settings.collections.length}`,
      '',
      '== Журнал (последние 500 строк) ==',
      ...this.ctx.log.tail(500),
    ];
    // Account ids are shortened; tokens are already masked by the log.
    return redact(lines.join('\n'))
      .replace(/\b(7656119\d{6})\d{4}\b/g, '$1····')
      .replace(/\b([a-f0-9]{6})[a-f0-9]{26}\b/gi, '$1····');
  }
  async saveDiagnostics(main) {
    const { canceled, filePath } = await dialog.showSaveDialog(main, {
      title: 'Сохранить диагностику Nexus',
      defaultPath: `nexus-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: 'Текст', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return null;
    await fsp.writeFile(filePath, this.diagnosticsText(), 'utf8');
    return { file: path.basename(filePath) };
  }
}

module.exports = { ActionsService };
