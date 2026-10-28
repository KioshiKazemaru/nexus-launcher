'use strict';
// Installs, updates and repairs Epic games without the Epic launcher (see
// ../epic-download.cjs). A job downloads every needed chunk once (several at a
// time), writes it into the files, checks the files and registers the game
// where the Epic launcher keeps its installs, so both Nexus and the Epic
// launcher see it. Jobs can be paused and continue after a restart of Nexus.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dialog } = require('electron');
const d = require('../epic-download.cjs');
const { readChunk } = require('../epic-saves.cjs');
const api = require('../epic-games-api.cjs');

const programData = () => process.env.ProgramData || 'C:\\ProgramData';
const epicManifestDir = () => path.join(programData(), 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
const launcherInstalledFile = () =>
  path.join(programData(), 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
const WORKERS = 8;
const TMP = '.nexus-new';
const gb = n => (n / 1024 ** 3).toFixed(1);

class Paused extends Error {}

// A few open files at once (a game can have tens of thousands).
class FilePool {
  constructor(max = 48) {
    this.max = max;
    this.open = new Map();
  }
  async get(file) {
    let h = this.open.get(file);
    if (h) {
      this.open.delete(file);
      this.open.set(file, h); // most recently used last
      return h;
    }
    if (this.open.size >= this.max) {
      const [oldFile, oldHandle] = this.open.entries().next().value;
      this.open.delete(oldFile);
      await oldHandle.close().catch(() => {});
    }
    h = await fsp.open(file, 'r+');
    this.open.set(file, h);
    return h;
  }
  async closeAll() {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.all(all.map(h => h.close().catch(() => {})));
  }
}

async function fileSha1(file) {
  const hash = crypto.createHash('sha1');
  await new Promise((resolve, reject) =>
    fs
      .createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on('data', b => hash.update(b))
      .on('end', resolve)
      .on('error', reject)
  );
  return hash.digest();
}

class EpicInstaller {
  constructor(ctx, { fetcher } = {}) {
    this.ctx = ctx;
    this.fetch = fetcher || ((u, o) => ctx.publicFetch(u, o));
    this.jobs = new Map(); // gameId → job
    this.updates = new Map(); // gameId → new build version
  }
  get saved() {
    return (this.ctx.settings.epicJobs ||= {});
  }
  save() {
    this.ctx.storage.saveSettings();
  }
  // Interrupted jobs come back paused after a restart.
  init() {
    for (const [gameId, s] of Object.entries(this.saved))
      if (s?.appId && s.installDir)
        this.jobs.set(gameId, { ...s, gameId, state: 'paused', done: s.done || 0 });
  }
  // ---- for the window ------------------------------------------------------------
  progress() {
    const out = {};
    for (const [id, j] of this.jobs) {
      const speed = j.state === 'downloading' ? this.speed(j) : 0;
      const left = Math.max(0, (j.total || 0) - (j.done || 0));
      out[id] = {
        state: j.state,
        provider: 'epic',
        nexus: true,
        kind: j.kind,
        done: j.done || 0,
        total: j.total || undefined,
        installSize: j.installSize || undefined,
        percent: j.total ? Math.min(99, Math.floor(((j.done || 0) / j.total) * 100)) : undefined,
        speed: speed || undefined,
        eta: speed > 0 ? Math.round(left / speed) : undefined,
        error: j.error || undefined,
        // Place in the queue (1 = next).
        queue:
          j.state === 'queued' || j.state === 'scheduled'
            ? [...this.jobs.values()]
                .filter(x => x.state === 'queued' || x.state === 'scheduled')
                .sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0))
                .indexOf(j) + 1
            : undefined,
      };
    }
    return out;
  }
  speed(j) {
    const s = j.samples || [];
    if (s.length < 2) return 0;
    const [a, b] = [s[0], s[s.length - 1]];
    return b.t > a.t ? ((b.bytes - a.bytes) / (b.t - a.t)) * 1000 : 0;
  }
  sample(j) {
    const now = Date.now();
    (j.samples ||= []).push({ t: now, bytes: j.done });
    while (j.samples.length > 2 && now - j.samples[0].t > 10000) j.samples.shift();
  }
  updatesMap() {
    return Object.fromEntries(this.updates);
  }
  publish() {
    this.ctx.hub?.publish();
  }
  // ---- what to install -------------------------------------------------------------
  game(gameId) {
    const g = (this.ctx.library.games || []).find(x => x.id === gameId);
    if (!g) throw Error('Игра не найдена');
    return g;
  }
  ownedOffer(g) {
    const o = g.offers.find(
      x => x.provider === 'epic' && x.namespace && x.itemId && (x.owned || x.installed)
    );
    if (!o) throw Error('Для загрузки нужна игра из библиотеки аккаунта Epic');
    return o;
  }
  account(offer) {
    const list = this.ctx.accounts.connected('epic');
    const a =
      list.find(x => x.id === offer.accountId) ||
      list.find(x => (offer.accountIds || []).includes(x.id)) ||
      list[0];
    if (!a) throw Error('Войдите в аккаунт Epic Games в «Аккаунтах»');
    return a;
  }
  async token(accountId) {
    return this.ctx.accounts.tokens.accessToken(accountId);
  }
  async assets(token, offer) {
    const r = await this.fetch(d.assetsUrl(offer), {
      headers: { Authorization: `bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 403 || r.status === 404) throw Error('Epic не выдал файлы: игры нет в этом аккаунте');
    if (!r.ok) throw Error(`Epic: HTTP ${r.status}`);
    return d.parseAssets(await r.json());
  }
  async manifest(assets) {
    let last;
    for (const m of assets.manifests) {
      try {
        const r = await this.fetch(m.url, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw Error(`HTTP ${r.status}`);
        const bytes = Buffer.from(await r.arrayBuffer());
        return { bytes, manifest: d.parseManifest(bytes) };
      } catch (e) {
        last = e;
      }
    }
    throw Error(`Манифест игры не загрузился: ${last?.message || 'нет ответа'}`);
  }
  async catalogInfo(token, offer) {
    try {
      const item = await api.catalogItem(this.fetch, token, offer.namespace, offer.itemId);
      const attr = name => item?.customAttributes?.[name]?.value;
      return {
        folder: attr('FolderName'),
        ownershipToken: String(attr('OwnershipToken')).toLowerCase() === 'true',
        canRunOffline: String(attr('CanRunOffline')).toLowerCase() !== 'false',
        thirdParty: attr('ThirdPartyManagedApp') || attr('partnerLinkType') || '',
        title: item?.title,
      };
    } catch {
      return {};
    }
  }
  // Default place for Epic games: next to the games already installed, else <system drive>\Epic Games.
  defaultRoot() {
    if (this.ctx.settings.epicInstallRoot) return this.ctx.settings.epicInstallRoot;
    const installed = (this.ctx.library.games || [])
      .flatMap(g => g.offers)
      .find(o => o.provider === 'epic' && o.installLocation);
    if (installed && !/\\Program Files( \(x86\))?\\/i.test(installed.installLocation))
      return path.dirname(installed.installLocation);
    return path.join((process.env.SystemDrive || 'C:') + '\\', 'Epic Games');
  }
  async folderProblem(root, need) {
    if (!path.isAbsolute(root) || /["%]/.test(root)) return 'Выберите обычную папку на диске.';
    if (/^\\\\/.test(root)) return 'Сетевые папки не подходят: выберите папку на диске этого ПК.';
    if (/\\(Windows|Program Files( \(x86\))?)(\\|$)/i.test(root))
      return 'В Program Files и Windows Nexus писать не может без прав администратора — выберите другую папку, например D:\\Games.';
    try {
      const st = await fsp.statfs(path.parse(root).root);
      const free = st.bavail * st.bsize;
      if (free < need + 512 * 1024 ** 2)
        return `На диске ${path.parse(root).root} свободно ${gb(free)} ГБ, а игре нужно ${gb(need)} ГБ.`;
      await fsp.mkdir(root, { recursive: true });
      const probe = path.join(root, `.nexus-write-test-${process.pid}`);
      await fsp.writeFile(probe, '');
      await fsp.rm(probe, { force: true });
    } catch (e) {
      return e.code === 'EPERM' || e.code === 'EACCES'
        ? 'Нет прав на запись в эту папку — выберите другую.'
        : 'Эта папка недоступна.';
    }
    return '';
  }
  // ---- install / update / repair -----------------------------------------------------
  // Returns { how: 'started' | 'client' | 'canceled' }.
  async install(gameId) {
    const g = this.game(gameId);
    if (this.jobs.get(gameId) && this.jobs.get(gameId).state !== 'paused')
      throw Error('Игра уже загружается');
    if (this.jobs.get(gameId)) return this.resume(gameId);
    const offer = this.ownedOffer(g);
    if (offer.installed) throw Error('Игра уже установлена');
    const account = this.account(offer);
    const token = await this.token(account.id);
    const [assets, info] = await Promise.all([this.assets(token, offer), this.catalogInfo(token, offer)]);
    if (info.thirdParty)
      this.ctx.log.info(
        'epic-install',
        `${offer.appId}: third-party ${info.thirdParty} (its launcher will be needed to play)`
      );
    const { manifest } = await this.manifest(assets);
    const p = d.plan(manifest);
    const title = g.name || info.title || offer.appId;
    let root = this.defaultRoot();
    for (;;) {
      const folder = path.join(root, d.folderName(title, info.folder));
      const { response } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
        type: 'question',
        buttons: ['Установить', 'Выбрать папку…', 'Через Epic Games Launcher', 'Отмена'],
        defaultId: 0,
        cancelId: 3,
        title: 'Установка игры',
        message: `Установить «${title}»?`,
        detail: `Скачать: ${gb(p.downloadSize)} ГБ · на диске: ${gb(p.installSize)} ГБ\nПапка: ${folder}\n\nNexus скачает игру с серверов Epic сам, без Epic Games Launcher. Загрузку можно поставить на паузу на странице «Загрузки».${info.thirdParty ? '\n\nЭта игра работает через лаунчер издателя (EA, Ubisoft и т. п.): для игры понадобится он.' : ''}`,
      });
      if (response === 3) return { how: 'canceled' };
      if (response === 2) return { how: 'client' };
      if (response === 1) {
        const r = await dialog.showOpenDialog(this.ctx.mainWindow?.() || null, {
          title: 'Папка для игр Epic',
          defaultPath: root,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (!r.canceled && r.filePaths[0]) root = r.filePaths[0];
        continue;
      }
      const problem = await this.folderProblem(root, p.installSize);
      if (problem) {
        await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
          type: 'warning',
          title: 'Эта папка не подходит',
          message: problem,
        });
        continue;
      }
      if (
        fs.existsSync(folder) &&
        (await fsp.readdir(folder)).length &&
        !fs.existsSync(path.join(folder, '.egstore'))
      ) {
        const { response: r2 } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
          type: 'warning',
          buttons: ['Установить сюда', 'Выбрать другую папку'],
          defaultId: 1,
          cancelId: 1,
          message: `Папка ${folder} не пустая`,
          detail: 'Файлы игры с такими же именами будут перезаписаны.',
        });
        if (r2 !== 0) continue;
      }
      this.ctx.settings.epicInstallRoot = root;
      return this.begin(gameId, {
        kind: 'install',
        appId: offer.appId,
        namespace: offer.namespace,
        itemId: offer.itemId,
        accountId: account.id,
        title,
        installDir: folder,
        ownershipToken: !!info.ownershipToken,
        canRunOffline: info.canRunOffline !== false,
      });
    }
  }
  // Update to the current build: only new and changed files are downloaded.
  async update(gameId) {
    const g = this.game(gameId);
    const offer = g.offers.find(o => o.provider === 'epic' && o.installed);
    if (!offer) throw Error('Игра не установлена');
    if (this.ctx.running?.isRunning(gameId)) throw Error('Сначала закройте игру');
    if (this.jobs.has(gameId)) return this.resume(gameId);
    const owned = this.ownedOffer(g);
    return this.begin(gameId, {
      kind: 'update',
      appId: offer.appId,
      namespace: offer.namespace || owned.namespace,
      itemId: offer.itemId || owned.itemId,
      accountId: this.account(owned).id,
      title: g.name,
      installDir: offer.installLocation,
      itemFile: offer.manifestFile,
    });
  }
  // Check the files and download the damaged ones again.
  async repair(gameId) {
    const g = this.game(gameId);
    const offer = g.offers.find(o => o.provider === 'epic' && o.installed);
    if (!offer?.installLocation) throw Error('Игра не установлена');
    if (this.ctx.running?.isRunning(gameId)) throw Error('Сначала закройте игру');
    if (this.jobs.has(gameId)) throw Error('С игрой уже идёт загрузка');
    const owned = this.ownedOffer(g);
    return this.begin(gameId, {
      kind: 'repair',
      appId: offer.appId,
      namespace: offer.namespace || owned.namespace,
      itemId: offer.itemId || owned.itemId,
      accountId: this.account(owned).id,
      title: g.name,
      installDir: offer.installLocation,
      itemFile: offer.manifestFile,
    });
  }
  begin(gameId, spec) {
    const job = { ...spec, gameId, state: 'downloading', done: 0, total: 0 };
    this.jobs.set(gameId, job);
    this.saved[gameId] = spec;
    this.save();
    this.launch(job);
    return { how: 'started' };
  }
  resume(gameId) {
    const job = this.jobs.get(gameId);
    if (!job) throw Error('Загрузка не найдена');
    if (job.state !== 'paused' && job.state !== 'error') return { how: 'started' };
    job.state = 'downloading';
    job.error = '';
    job.pause = false;
    this.launch(job);
    return { how: 'started' };
  }
  pause(gameId) {
    const job = this.jobs.get(gameId);
    if (!job) throw Error('Загрузка не найдена');
    if (job.running) job.pause = true;
    else {
      job.state = 'paused';
      delete job.queuedAt;
    }
    this.publish();
    this.next();
    return true;
  }
  // "▲ Первой": the job is the next one to download.
  first(gameId) {
    const job = this.jobs.get(gameId);
    if (!job) throw Error('Загрузка не найдена');
    const waiting = [...this.jobs.values()].filter(j => j.queuedAt);
    job.queuedAt = Math.min(Date.now(), ...waiting.map(j => j.queuedAt)) - 1;
    if (job.state === 'paused' || job.state === 'error') this.resume(gameId);
    this.publish();
    return true;
  }
  // "Загрузить сейчас": this job ignores the download schedule.
  now(gameId) {
    const job = this.jobs.get(gameId);
    if (!job) throw Error('Загрузка не найдена');
    job.ignoreSchedule = true;
    if (job.state === 'paused' || job.state === 'error') return this.resume(gameId);
    if (!job.running) this.launch(job);
    return { how: 'started' };
  }
  // ---- queue and schedule -------------------------------------------------------------
  // Downloads may run only in the hours the user chose (e.g. at night).
  allowedNow(job, date = new Date()) {
    const s = this.ctx.settings.downloadSchedule;
    if (job?.ignoreSchedule || !s?.enabled) return true;
    const min = t => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
      return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null;
    };
    const from = min(s.from),
      to = min(s.to);
    if (from === null || to === null || from === to) return true;
    const now = date.getHours() * 60 + date.getMinutes();
    return from < to ? now >= from && now < to : now >= from || now < to;
  }
  // The next waiting job starts when nothing downloads (and the schedule allows it).
  next() {
    if ([...this.jobs.values()].some(j => j.running)) return;
    const waiting = [...this.jobs.values()]
      .filter(j => j.state === 'queued' || j.state === 'scheduled')
      .sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
    const job = waiting.find(j => this.allowedNow(j));
    if (job) this.launch(job);
    else if (waiting.length) this.armSchedule();
  }
  armSchedule() {
    if (this.scheduleTimer) return;
    this.scheduleTimer = setInterval(() => {
      if (![...this.jobs.values()].some(j => j.state === 'scheduled' || j.state === 'queued')) {
        clearInterval(this.scheduleTimer);
        this.scheduleTimer = null;
        return;
      }
      this.next();
    }, 60000);
    this.scheduleTimer.unref?.();
  }
  async cancel(gameId) {
    const job = this.jobs.get(gameId);
    if (!job) throw Error('Загрузка не найдена');
    const { response } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
      type: 'warning',
      buttons: ['Отменить загрузку', 'Продолжить'],
      defaultId: 1,
      cancelId: 1,
      message: `Отменить ${job.kind === 'install' ? 'установку' : job.kind === 'update' ? 'обновление' : 'проверку'} «${job.title}»?`,
      detail:
        job.kind === 'install'
          ? `Скачанные файлы будут удалены из ${job.installDir}.`
          : 'Установленная версия игры останется как была.',
    });
    if (response !== 0) return false;
    job.pause = true;
    job.canceled = true;
    await job.running?.catch(() => {});
    this.jobs.delete(gameId);
    delete this.saved[gameId];
    this.save();
    if (job.kind === 'install')
      await fsp.rm(job.installDir, { recursive: true, force: true }).catch(() => {});
    else await this.removeTemp(job).catch(() => {});
    this.publish();
    return true;
  }
  launch(job) {
    // One download at a time: the others wait in the queue (or for the schedule).
    const active = [...this.jobs.values()].some(j => j !== job && j.running);
    if (active || !this.allowedNow(job)) {
      job.state = active ? 'queued' : 'scheduled';
      job.queuedAt ??= Date.now();
      this.publish();
      if (!active) this.armSchedule();
      return;
    }
    delete job.queuedAt;
    job.state = 'downloading';
    this.publish();
    job.running = this.run(job)
      .catch(e => {
        if (e instanceof Paused) {
          // The user's pause, or the end of the allowed hours.
          if (!job.canceled) {
            job.state = job.pause ? 'paused' : 'scheduled';
            if (job.state === 'scheduled') job.queuedAt ??= Date.now();
          }
          return;
        }
        job.state = 'error';
        job.error = e.message;
        this.ctx.log.warn('epic-install', `${job.appId}: ${e.message}`);
        this.ctx.toast?.(`«${job.title}»: ${e.message}`);
        this.notify(`Загрузка «${job.title}» остановилась`, e.message, job.gameId);
      })
      .finally(() => {
        job.running = null;
        job.pause = false;
        this.publish();
        this.next();
      });
  }
  // A Windows notification (setting "Уведомлять о загрузках").
  notify(title, body, gameId) {
    if (this.ctx.settings.downloadNotify === false) return;
    try {
      this.ctx.store?.notify?.(title, body, () => gameId && this.ctx.showGame?.(gameId));
    } catch {}
  }
  // Waits so that downloads stay under the user's limit (KB/s; 0 = no limit).
  async throttle(bytes) {
    const limit = Number(this.ctx.settings.downloadLimit) * 1024;
    if (!(limit > 0)) return;
    const now = Date.now();
    this.nextSlot = Math.max(this.nextSlot || 0, now) + (bytes / limit) * 1000;
    const wait = this.nextSlot - now - 1000; // up to one second of burst
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  // ---- the job ---------------------------------------------------------------------
  stateFile(job) {
    return path.join(job.installDir, '.egstore', 'nexus-download.json');
  }
  async readState(job) {
    try {
      return JSON.parse(await fsp.readFile(this.stateFile(job), 'utf8'));
    } catch {
      return null;
    }
  }
  async writeState(job, data) {
    await fsp.mkdir(path.dirname(this.stateFile(job)), { recursive: true });
    const tmp = this.stateFile(job) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, this.stateFile(job));
  }
  async oldManifest(job) {
    const item = job.itemFile ? JSON.parse(await fsp.readFile(job.itemFile, 'utf8').catch(() => '{}')) : {};
    const dir = item.ManifestLocation || path.join(job.installDir, '.egstore');
    const names = (await fsp.readdir(dir).catch(() => [])).filter(n => n.endsWith('.manifest'));
    const pick =
      names.find(n => n.toUpperCase() === `${String(item.InstallationGuid || '').toUpperCase()}.MANIFEST`) ||
      names[0];
    if (!pick) return { item, manifest: null };
    return { item, manifest: d.parseManifest(await fsp.readFile(path.join(dir, pick))) };
  }
  async run(job) {
    if (this.ctx.running?.isRunning(job.gameId)) throw Error('Сначала закройте игру');
    const token = await this.token(job.accountId);
    const assets = await this.assets(token, job);
    const { bytes, manifest } = await this.manifest(assets);
    job.buildVersion = assets.buildVersion;
    let files = null; // all
    let removed = [];
    let old = { item: {}, manifest: null };
    if (job.kind === 'update') {
      old = await this.oldManifest(job);
      const diff = d.diff(old.manifest, manifest);
      files = diff.changed;
      removed = diff.removed;
    } else if (job.kind === 'repair') {
      old = await this.oldManifest(job);
      job.state = 'verifying';
      this.publish();
      files = await this.badFiles(job, manifest, null, false);
    }
    const temp = job.kind !== 'install';
    for (let attempt = 0; ; attempt++) {
      const p = d.plan(manifest, files);
      job.total = p.downloadSize;
      job.installSize = p.installSize;
      const st = await this.readState(job);
      const done = new Set(
        st && st.build === assets.buildVersion && st.kind === job.kind && attempt === 0 ? st.done : []
      );
      job.done = p.chunks.filter(c => done.has(c.key)).reduce((n, c) => n + (c.chunk.fileSize || 0), 0);
      job.state = 'downloading';
      this.publish();
      await this.prepareFiles(job, p.files, temp);
      await this.download(job, assets, p, done, temp);
      job.state = 'verifying';
      this.publish();
      const bad = await this.badFiles(
        job,
        manifest,
        p.files.map(f => f.filename),
        temp
      );
      if (!bad.length) break;
      if (attempt >= 1)
        throw Error(`после повторной загрузки не сходятся файлы: ${bad.slice(0, 3).join(', ')}`);
      files = bad;
      await this.writeState(job, { build: assets.buildVersion, kind: job.kind, done: [] });
    }
    job.state = 'installing';
    this.publish();
    if (temp) await this.commitTemp(job, manifest, files, removed);
    await this.register(job, assets, manifest, bytes, old.item);
    await fsp.rm(this.stateFile(job), { force: true });
    this.jobs.delete(job.gameId);
    delete this.saved[job.gameId];
    this.updates.delete(job.gameId);
    this.save();
    await this.ctx.library.scanLocal().catch(e => this.ctx.log.warn('scan', e.message));
    this.ctx.log.info('epic-install', `${job.appId}: ${job.kind} ${assets.buildVersion} done`);
    this.ctx.toast?.(
      job.kind === 'install'
        ? `«${job.title}» установлена — можно играть.`
        : job.kind === 'update'
          ? `«${job.title}» обновлена.`
          : `Файлы «${job.title}» проверены и исправлены.`
    );
    this.notify(
      job.kind === 'install'
        ? `«${job.title}» установлена`
        : job.kind === 'update'
          ? `«${job.title}» обновлена`
          : `«${job.title}» проверена`,
      job.kind === 'install'
        ? 'Можно играть — нажмите, чтобы открыть игру в Nexus.'
        : 'Игра готова к запуску.',
      job.gameId
    );
    if (job.kind === 'install') await this.offerPrereqs(job, manifest).catch(() => {});
  }
  async prepareFiles(job, files, temp) {
    let n = 0;
    for (const f of files) {
      const target = d.safeTarget(job.installDir, f.filename) + (temp ? TMP : '');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const h = await fsp.open(target, fs.constants.O_RDWR | fs.constants.O_CREAT);
      try {
        if ((await h.stat()).size !== f.size) await h.truncate(f.size);
      } finally {
        await h.close();
      }
      if (job.pause) throw new Paused();
      if (++n % 500 === 0) this.publish();
    }
  }
  // Epic lists several CDNs; their speed differs a lot by region. Each one has a
  // running score (ms per KiB, failures count as slow) and the best is tried first.
  cdnOrder(assets) {
    const score = (this.cdnScores ||= new Map());
    return assets.manifests
      .map((m, i) => ({ base: m.base, s: score.get(m.base) ?? i * 0.01 }))
      .sort((a, b) => a.s - b.s)
      .map(x => x.base);
  }
  rate(base, msPerKb) {
    const score = (this.cdnScores ||= new Map());
    const old = score.get(base);
    score.set(base, old === undefined ? msPerKb : old * 0.8 + msPerKb * 0.2);
  }
  async fetchChunk(assets, c) {
    let last;
    for (let i = 0; i < assets.manifests.length * 2; i++) {
      const order = this.cdnOrder(assets);
      const base = order[i % order.length];
      const t0 = Date.now();
      try {
        const r = await this.fetch(`${base}/${c.chunk.path}`, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw Error(`HTTP ${r.status}`);
        const raw = Buffer.from(await r.arrayBuffer());
        this.rate(base, (Date.now() - t0) / Math.max(1, raw.length / 1024));
        await this.throttle(raw.length);
        const data = readChunk(raw).data;
        if (c.chunk.sha && !crypto.createHash('sha1').update(data).digest().equals(c.chunk.sha))
          throw Error('повреждённая часть');
        return data;
      } catch (e) {
        last = e;
        this.rate(base, 1000);
        await new Promise(r => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw Error(`часть ${c.key} не скачалась (${last?.message})`);
  }
  async download(job, assets, p, done, temp) {
    const queue = p.chunks.filter(c => !done.has(c.key));
    const pool = new FilePool();
    let saveAt = Date.now();
    const persist = () =>
      this.writeState(job, { build: assets.buildVersion, kind: job.kind, done: [...done] });
    try {
      // The first failure stops every worker (they would keep downloading otherwise).
      let abort = null;
      const worker = async () => {
        for (let c = queue.shift(); c && !abort; c = queue.shift()) {
          if (job.pause || !this.allowedNow(job)) throw (abort = new Paused());
          let data;
          try {
            data = await this.fetchChunk(assets, c);
          } catch (e) {
            throw (abort = e);
          }
          for (const t of c.targets) {
            const h = await pool.get(d.safeTarget(job.installDir, t.file) + (temp ? TMP : ''));
            await h.write(data, t.chunkOffset, t.size, t.fileOffset);
          }
          done.add(c.key);
          job.done += c.chunk.fileSize || 0;
          this.sample(job);
          if (Date.now() - saveAt > 5000) {
            saveAt = Date.now();
            await persist();
            this.publish();
          }
        }
      };
      const results = await Promise.allSettled(Array.from({ length: WORKERS }, worker));
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw abort || failed.reason;
    } finally {
      await pool.closeAll();
      await persist().catch(() => {});
    }
  }
  // Files whose SHA-1 differs from the manifest (all files when `names` is null).
  async badFiles(job, manifest, names, temp) {
    const wanted = names ? new Set(names) : null;
    const bad = [];
    let n = 0;
    for (const f of manifest.files) {
      if (wanted && !wanted.has(f.filename)) continue;
      if (f.symlinkTarget) continue;
      const file = d.safeTarget(job.installDir, f.filename) + (temp ? TMP : '');
      try {
        if ((await fsp.stat(file)).size !== f.size || !(await fileSha1(file)).equals(f.hash))
          bad.push(f.filename);
      } catch {
        bad.push(f.filename);
      }
      if (++n % 100 === 0) {
        if (job.pause) throw new Paused();
        this.publish();
      }
    }
    return bad;
  }
  async commitTemp(job, manifest, files, removed) {
    const names = files || manifest.files.map(f => f.filename);
    for (const name of names) {
      const target = d.safeTarget(job.installDir, name);
      await fsp.rename(target + TMP, target);
    }
    for (const name of removed)
      await fsp.rm(d.safeTarget(job.installDir, name), { force: true }).catch(() => {});
  }
  async removeTemp(job) {
    const walk = async dir => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith(TMP)) await fsp.rm(p, { force: true });
      }
    };
    await walk(job.installDir);
    await fsp.rm(this.stateFile(job), { force: true });
  }
  // Where the Epic launcher (and Nexus) find installed games.
  async register(job, assets, manifest, bytes, oldItem = {}) {
    const installGuid = /^[0-9A-F]{32}$/i.test(oldItem.InstallationGuid || '')
      ? oldItem.InstallationGuid
      : crypto.randomBytes(16).toString('hex').toUpperCase();
    const egstore = path.join(job.installDir, '.egstore');
    await fsp.mkdir(egstore, { recursive: true });
    for (const n of await fsp.readdir(egstore))
      if (n.endsWith('.manifest') && n.toUpperCase() !== `${installGuid}.MANIFEST`)
        await fsp.rm(path.join(egstore, n), { force: true });
    await fsp.writeFile(path.join(egstore, `${installGuid}.manifest`), bytes);
    await fsp.writeFile(
      path.join(egstore, `${installGuid}.mancpn`),
      JSON.stringify(
        { FormatVersion: 0, AppName: job.appId, CatalogItemId: job.itemId, CatalogNamespace: job.namespace },
        null,
        '\t'
      )
    );
    // An existing record keeps the launcher's own fields; the build data is replaced.
    const item = {
      ...oldItem,
      ...d.launcherItem({
        manifest,
        assets,
        offer: { appId: job.appId, namespace: job.namespace, itemId: job.itemId },
        title: job.title,
        installDir: job.installDir,
        installGuid,
        ownershipToken: job.ownershipToken ?? String(oldItem.OwnershipToken).toLowerCase() === 'true',
        canRunOffline: job.canRunOffline ?? oldItem.bCanRunOffline !== false,
      }),
    };
    const itemFile = job.itemFile || path.join(epicManifestDir(), `${installGuid}.item`);
    try {
      await fsp.mkdir(path.dirname(itemFile), { recursive: true });
      await fsp.writeFile(itemFile, JSON.stringify(item, null, '\t'));
    } catch (e) {
      // Without access to the Epic folder Nexus keeps the record in its own folder.
      const own = path.join(this.ctx.storage.file('epic-manifests'), `${installGuid}.item`);
      await fsp.mkdir(path.dirname(own), { recursive: true });
      await fsp.writeFile(own, JSON.stringify(item, null, '\t'));
      this.ctx.log.warn('epic-install', `item in Nexus folder (${e.code || e.message})`);
    }
    await this.updateLauncherInstalled(job, assets).catch(e =>
      this.ctx.log.warn('epic-install', `dat: ${e.message}`)
    );
  }
  async updateLauncherInstalled(job, assets) {
    const file = launcherInstalledFile();
    let json = { InstallationList: [] };
    try {
      json = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const list = (Array.isArray(json.InstallationList) ? json.InstallationList : []).filter(
      x => x?.AppName !== job.appId
    );
    list.push({
      InstallLocation: job.installDir,
      NamespaceId: job.namespace,
      ItemId: job.itemId,
      ArtifactId: job.appId,
      AppVersion: assets.buildVersion,
      AppName: job.appId,
    });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.nexus.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ ...json, InstallationList: list }, null, '\t'));
    await fsp.rename(tmp, file);
  }
  // Components the game needs (Visual C++, DirectX…), as the Epic launcher runs them.
  async offerPrereqs(job, manifest) {
    const rel = manifest.meta.prereqPath;
    if (!rel) return;
    const exe = d.safeTarget(job.installDir, rel);
    if (!fs.existsSync(exe)) return;
    const { response } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
      type: 'question',
      buttons: ['Установить', 'Пропустить'],
      defaultId: 0,
      cancelId: 1,
      message: `Установить компоненты для «${job.title}»?`,
      detail: `${manifest.meta.prereqName || 'Необходимые компоненты'} — без них игра может не запуститься. Windows может попросить разрешение.`,
    });
    if (response !== 0) return;
    const child = spawn(exe, api.splitArgs(manifest.meta.prereqArgs || ''), {
      cwd: path.dirname(exe),
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: false,
    });
    child.on('error', e => this.ctx.log.warn('epic-install', `prereq: ${e.message}`));
    child.unref();
  }
  // ---- updates ---------------------------------------------------------------------
  // Installed games whose build is older than the current one on Epic's servers.
  async checkUpdates() {
    const games = (this.ctx.library.games || []).filter(g =>
      g.offers.some(o => o.provider === 'epic' && o.installed && o.version)
    );
    for (const g of games) {
      if (this.jobs.has(g.id)) continue;
      const inst = g.offers.find(o => o.provider === 'epic' && o.installed);
      let owned;
      try {
        owned = this.ownedOffer(g);
        const token = await this.token(this.account(owned).id);
        const assets = await this.assets(token, {
          ...inst,
          namespace: inst.namespace || owned.namespace,
          itemId: inst.itemId || owned.itemId,
        });
        if (assets.buildVersion && assets.buildVersion !== inst.version)
          this.updates.set(g.id, assets.buildVersion);
        else this.updates.delete(g.id);
      } catch (e) {
        this.ctx.log.debug?.('epic-install', `update check ${inst.appId}: ${e.message}`);
      }
    }
    this.publish();
    // Like the Epic launcher: new builds are downloaded by themselves (in the queue and the schedule).
    if (this.ctx.settings.epicAutoUpdate !== false)
      for (const id of this.updates.keys())
        if (!this.jobs.has(id) && !this.ctx.running?.isRunning(id))
          await this.update(id).catch(e =>
            this.ctx.log.warn('epic-install', `auto-update ${id}: ${e.message}`)
          );
    return this.updatesMap();
  }
}

module.exports = { EpicInstaller, FilePool, fileSha1, Paused };
