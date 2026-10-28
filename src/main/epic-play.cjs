'use strict';
// Starts Epic games without the Epic Games Launcher, like Legendary/Heroic:
// the game gets a one-time login code of the connected account on its
// command line. Cloud saves are synchronised with Epic's own save storage
// before the game starts and after it exits, in the launcher's format, so
// they stay compatible with the official launcher on other PCs.
//
// Every local save is copied to %APPDATA%\Nexus Launcher\save-backups before
// it is replaced by a cloud save. If anything here fails, the caller falls
// back to the Epic launcher (play through com.epicgames.launcher://).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app, dialog } = require('electron');
const api = require('../epic-games-api.cjs');
const saves = require('../epic-saves.cjs');

const MAX_SAVE_BYTES = 512 * 1024 * 1024; // larger folders are not synchronised
const MAX_SAVE_FILES = 5000;
const KEEP_BACKUPS = 5;

class FallbackToLauncher extends Error {}

class EpicPlayService {
  constructor(ctx) {
    this.ctx = ctx;
    this.running = new Map(); // appName → { started, exe }
    this.metaCache = new Map(); // namespace:item → { at, item }
  }
  settings() {
    return this.ctx.settings;
  }
  enabled() {
    return this.settings().epicDirectLaunch !== false;
  }
  // The connected Epic account that owns the game (or the first connected one).
  account(offer) {
    const list = this.ctx.accounts.connected('epic');
    return list.find(a => offer.accountIds?.includes(a.id)) || list[0] || null;
  }
  canStart(offer) {
    return !!(
      this.enabled() &&
      offer?.provider === 'epic' &&
      offer.installed &&
      offer.executable &&
      offer.installLocation &&
      offer.namespace &&
      offer.itemId
    );
  }
  // Full path of the game executable, never outside the install folder.
  executablePath(offer) {
    const root = path.resolve(offer.installLocation);
    const exe = path.resolve(root, String(offer.executable).replace(/^[\\/]+/, ''));
    if (
      !exe.toLowerCase().startsWith(root.toLowerCase() + path.sep) ||
      path.extname(exe).toLowerCase() !== '.exe'
    )
      throw new FallbackToLauncher('Некорректный исполняемый файл игры');
    if (!fs.existsSync(exe)) throw new FallbackToLauncher('Файл игры не найден');
    return exe;
  }
  async metadata(token, offer) {
    const key = `${offer.namespace}:${offer.itemId}`;
    const cached = this.metaCache.get(key);
    if (cached && Date.now() - cached.at < 3600000) return cached.item;
    const item = await api.catalogItem(this.ctx.publicFetch, token, offer.namespace, offer.itemId);
    this.metaCache.set(key, { at: Date.now(), item });
    return item;
  }

  // ---- launch ------------------------------------------------------------------

  // Returns { direct: true } when the game was started by Nexus. Throws
  // FallbackToLauncher when the Epic launcher has to start it instead.
  async play(offer, game) {
    if (!this.canStart(offer)) throw new FallbackToLauncher('Прямой запуск недоступен');
    if (this.running.has(offer.appId)) throw Error('Игра уже запущена');
    const exe = this.executablePath(offer);
    const account = this.account(offer);
    if (!account) throw new FallbackToLauncher('Аккаунт Epic не подключён в Nexus');
    const online = this.ctx.online();
    let token = null,
      info = { canRunOffline: offer.canRunOffline !== false };
    if (online) {
      token = await this.ctx.accounts.tokens.accessToken(account.id);
      const item = await this.metadata(token, offer).catch(e => {
        this.ctx.log.warn('epic-play', `metadata: ${e.message}`);
        return null;
      });
      info = { ...api.launchInfo(item), canRunOffline: offer.canRunOffline !== false };
      if (info.thirdParty)
        throw new FallbackToLauncher(
          `Игру запускает лаунчер ${info.thirdParty}: Nexus передаёт её Epic Launcher`
        );
    } else if (!info.canRunOffline) throw new FallbackToLauncher('Эта игра не запускается без сети');

    // Saves first: a game must never start on an older save than the cloud has.
    let sync = null;
    if (online && info.cloudFolder && this.settings().epicCloudSaves !== false) {
      sync = { account, offer, info, folder: this.saveFolder(offer, account, info.cloudFolder) };
      if (sync.folder) {
        const proceed = await this.syncBefore(token, sync).catch(e => {
          this.ctx.log.warn('epic-saves', `${offer.appId}: ${e.message}`);
          this.ctx.toast?.(
            `Облачные сохранения «${game?.name || offer.name}» не синхронизированы: ${e.message}`
          );
          return true;
        });
        if (proceed === false) return { direct: true, canceled: true };
      } else sync = null;
    }

    const loginCode = online ? await api.gameLoginCode(this.ctx.publicFetch, token) : '';
    let ovtPath = '';
    if (online && offer.ownershipToken) {
      const ovt = await api.ownershipToken(
        this.ctx.publicFetch,
        token,
        account.id,
        offer.namespace,
        offer.itemId
      );
      const dir = path.join(app.getPath('userData'), 'tmp');
      await fsp.mkdir(dir, { recursive: true });
      ovtPath = path.join(dir, `${offer.namespace}${offer.itemId}.ovt`);
      await fsp.writeFile(ovtPath, ovt, { mode: 0o600 });
    }
    const args = api.launchArgs({
      appName: offer.appId,
      namespace: offer.namespace,
      accountId: account.id,
      displayName: this.ctx.accounts.tokens.accounts.get(account.id)?.displayName || account.name || '',
      loginCode,
      ovtPath,
      launchCommand: offer.launchCommand,
      extraArgs: info.extraArgs,
    });
    const started = Date.now();
    await new Promise((resolve, reject) => {
      const child = spawn(exe, args, {
        cwd: path.dirname(exe),
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      child.once('error', e => reject(new FallbackToLauncher(`Игра не запустилась: ${e.message}`)));
      child.once('spawn', () => {
        this.running.set(offer.appId, { started, exe });
        child.once('exit', () =>
          this.exited(offer, exe, started, sync).catch(e => this.ctx.log.warn('epic-play', e.message))
        );
        child.unref();
        resolve();
      });
    });
    // The login code is in the arguments: they are never logged.
    this.ctx.log.info('epic-play', `started ${offer.appId} without the Epic launcher`);
    return { direct: true };
  }
  // A game may restart itself as another process with the same executable:
  // the session ends when no process of that executable is left.
  async exited(offer, exe, started, sync) {
    const image = path.basename(exe);
    await this.sleep(4000);
    const deadline = started + 24 * 3600 * 1000;
    while (Date.now() < deadline && (await this.processRunning(image))) await this.sleep(15000);
    this.running.delete(offer.appId);
    this.addPlaytime(offer, started);
    if (sync) {
      try {
        const token = await this.ctx.accounts.tokens.accessToken(sync.account.id);
        await this.syncAfter(token, sync);
      } catch (e) {
        this.ctx.log.warn('epic-saves', `${offer.appId} upload: ${e.message}`);
        this.ctx.toast?.(
          `Сохранения не загружены в облако Epic: ${e.message}. Nexus попробует при следующем запуске.`
        );
      }
    }
    this.ctx.library.scanLocal().catch(e => this.ctx.log.warn('scan', e.message));
  }
  // Epic records playtime only for its own launcher: Nexus keeps its own.
  addPlaytime(offer, started, now = Date.now()) {
    const key = `epic:${offer.appId}`;
    const s = this.settings();
    s.nexusPlaytime ||= {};
    const old = s.nexusPlaytime[key] || { minutes: 0 };
    s.nexusPlaytime[key] = {
      minutes: (old.minutes || 0) + Math.max(0, Math.round((now - started) / 60000)),
      lastPlayed: Math.floor(now / 1000),
    };
    this.ctx.storage.saveSettings();
  }
  sleep(ms) {
    return new Promise(r => setTimeout(r, ms).unref?.());
  }
  async processRunning(image) {
    if (process.platform !== 'win32') return false;
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

  // ---- cloud saves ----------------------------------------------------------------

  saveFolder(offer, account, template) {
    const folder = saves.resolveSaveFolder(template, {
      installdir: offer.installLocation,
      epicid: account.id,
      appdata: process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'),
      userdir: app.getPath('documents'),
      userprofile: app.getPath('home'),
      usersavedgames: path.join(app.getPath('home'), 'Saved Games'),
    });
    return folder ? path.resolve(folder) : null;
  }
  async localFiles(sync) {
    const out = [];
    let bytes = 0;
    const walk = async (dir, base) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full, base);
        else if (e.isFile()) {
          const rel = path.relative(base, full).replace(/\\/g, '/');
          const st = await fsp.stat(full);
          out.push({ path: rel, full, size: st.size, mtime: st.mtimeMs });
          bytes += st.size;
          if (out.length > MAX_SAVE_FILES || bytes > MAX_SAVE_BYTES)
            throw Error('Папка сохранений слишком большая для синхронизации');
        }
      }
    };
    await walk(sync.folder, sync.folder);
    const keep = new Set(
      saves.filterSaveFiles(
        out.map(f => f.path),
        sync.info
      )
    );
    return out.filter(f => keep.has(f.path));
  }
  state(appId) {
    return this.settings().epicSaveSync?.[appId] || null;
  }
  setState(appId, value) {
    const s = this.settings();
    s.epicSaveSync ||= {};
    s.epicSaveSync[appId] = { ...value, at: Date.now() };
    this.ctx.storage.saveSettings();
  }
  async syncBefore(token, sync) {
    const { offer, account } = sync;
    const files = await api.cloudFiles(this.ctx.publicFetch, token, account.id, offer.appId);
    const remote = api.latestManifest(files);
    const local = await this.localFiles(sync);
    const localTime = Math.max(0, ...local.map(f => f.mtime));
    let decision = saves.syncDecision({
      localTime,
      remote: remote?.name || null,
      lastSync: this.state(offer.appId),
    });
    if (decision === 'conflict') decision = await this.askConflict(offer, localTime, remote);
    if (decision === 'cancel') return false;
    if (decision === 'download') await this.download(sync, files, remote, local);
    else if (decision === 'upload') await this.upload(token, sync, local);
    else if (decision === 'same' || decision === 'none')
      this.setState(offer.appId, { manifest: remote?.name || null, localTime });
    this.ctx.log.info('epic-saves', `${offer.appId}: before play — ${decision}`);
    return true;
  }
  async syncAfter(token, sync) {
    const local = await this.localFiles(sync);
    const localTime = Math.max(0, ...local.map(f => f.mtime));
    const last = this.state(sync.offer.appId);
    if (!local.length || (last && localTime <= (last.localTime || 0) + 2000)) {
      this.ctx.log.info('epic-saves', `${sync.offer.appId}: after play — nothing changed`);
      return;
    }
    await this.upload(token, sync, local);
    this.ctx.log.info('epic-saves', `${sync.offer.appId}: after play — uploaded`);
    this.ctx.toast?.(`Сохранения «${sync.offer.name}» загружены в облако Epic.`);
  }
  async askConflict(offer, localTime, remote) {
    const fmt = t => (t ? new Date(t).toLocaleString('ru-RU') : '—');
    const { response } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
      type: 'question',
      buttons: ['Взять из облака', 'Оставить с этого ПК', 'Отменить запуск'],
      defaultId: 0,
      cancelId: 2,
      title: 'Облачные сохранения Epic',
      message: `Сохранения «${offer.name}» изменились и в облаке, и на этом ПК`,
      detail: `В облаке: ${fmt(saves.manifestDate(remote?.name))}\nНа этом ПК: ${fmt(localTime)}\n\nВерсия с ПК в любом случае будет скопирована в резервные копии Nexus.`,
    });
    return ['download', 'upload', 'cancel'][response] || 'cancel';
  }
  // Copies the current local save before it is replaced; keeps the latest few.
  async backup(sync, local) {
    if (!local.length) return null;
    const root = path.join(
      app.getPath('userData'),
      'save-backups',
      sync.offer.appId.replace(/[^\w.-]/g, '_')
    );
    const dir = path.join(root, new Date().toISOString().replace(/[:.]/g, '-'));
    for (const f of local) {
      const dest = path.join(dir, ...f.path.split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(f.full, dest);
    }
    const old = (await fsp.readdir(root)).sort().slice(0, -KEEP_BACKUPS);
    for (const name of old) await fsp.rm(path.join(root, name), { recursive: true, force: true });
    return dir;
  }
  async download(sync, files, remote, local) {
    const fetcher = this.ctx.publicFetch;
    const manifest = saves.readManifest(await api.downloadLink(fetcher, files[remote.path].readLink));
    const chunks = new Map();
    for (const c of manifest.chunks) {
      const entry = files[api.chunkRemotePath(remote.path, c.path)];
      if (!entry?.readLink) throw Error('В облаке не хватает части сохранения');
      const chunk = saves.readChunk(await api.downloadLink(fetcher, entry.readLink));
      chunks.set(saves.guidKey(chunk.guid), chunk.data);
    }
    // Everything is checked (SHA-1 per file) before a single local file is touched.
    const unpacked = saves.unpackSave(manifest, chunks);
    const root = path.resolve(sync.folder);
    for (const f of unpacked) {
      const dest = path.resolve(root, ...f.path.split('/'));
      if (!dest.toLowerCase().startsWith(root.toLowerCase() + path.sep))
        throw Error('Некорректный путь в сохранении');
    }
    const backup = await this.backup(sync, local);
    const when = saves.manifestDate(remote.name) || Date.now();
    for (const f of unpacked) {
      const dest = path.resolve(root, ...f.path.split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, f.data);
      await fsp.utimes(dest, new Date(when), new Date(when));
    }
    this.setState(sync.offer.appId, { manifest: remote.name, localTime: when });
    this.ctx.log.info(
      'epic-saves',
      `${sync.offer.appId}: downloaded ${unpacked.length} files${backup ? ', local copy kept' : ''}`
    );
  }
  async upload(token, sync, local) {
    if (!local.length) return;
    const data = await Promise.all(
      local.map(async f => ({ path: f.path, data: await fsp.readFile(f.full) }))
    );
    const localTime = Math.max(...local.map(f => f.mtime));
    const { manifestPath, uploads } = saves.packSave(data, {
      appName: sync.offer.appId,
      accountId: sync.account.id,
      cloudFolder: sync.info.cloudFolder,
      date: new Date(localTime),
    });
    const links = await api.cloudUploadLinks(this.ctx.publicFetch, token, sync.account.id, sync.offer.appId, [
      ...uploads.keys(),
    ]);
    // Chunks first, the manifest last: a half-finished upload is never the newest save.
    const order = [...uploads.keys()].sort((a, b) => (a === manifestPath ? 1 : b === manifestPath ? -1 : 0));
    for (const p of order) {
      const link =
        links[p]?.writeLink || Object.entries(links).find(([k]) => k.endsWith('/' + p))?.[1]?.writeLink;
      if (!link) throw Error('Epic не выдал ссылку для части сохранения');
      await api.uploadLink(this.ctx.publicFetch, link, uploads.get(p));
    }
    this.setState(sync.offer.appId, { manifest: manifestPath.split('/').pop(), localTime });
  }
  // "Синхронизировать сейчас" on the game page.
  async syncNow(offer) {
    const account = this.account(offer);
    if (!account) throw Error('Войдите в аккаунт Epic в Nexus');
    const token = await this.ctx.accounts.tokens.accessToken(account.id);
    const info = api.launchInfo(await this.metadata(token, offer));
    if (!info.cloudFolder) return { supported: false };
    const folder = this.saveFolder(offer, account, info.cloudFolder);
    if (!folder) return { supported: false };
    await this.syncBefore(token, { account, offer, info, folder });
    return { supported: true, folder };
  }
}

module.exports = { EpicPlayService, FallbackToLauncher };
