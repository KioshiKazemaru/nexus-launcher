'use strict';
// Removing a game from this PC directly in Nexus (Steam and Epic Games).
//   Steam: the game folder (steamapps\common\…), its appmanifest, Workshop
//          content and shader cache of the app. Steam notices the removed
//          manifest and shows the game as not installed.
//   Epic:  the game folder, its .item manifest and its entry in
//          LauncherInstalled.dat. The Epic launcher, if open, is closed first
//          (it would otherwise write the game back into its lists) and started
//          again in the tray afterwards.
// No questions: "Удалить" removes at once. Steam, if open and no Steam game is
// running, is restarted hidden so it rereads its library. When removal stops
// half way (a file in use), the game keeps a "Удалить снова" button.
// Saves stay: Steam Cloud / Epic cloud saves and saves in AppData/Documents are
// not touched. Saves inside the game folder (some Epic games) are copied to
// save-backups and, when possible, uploaded to the Epic cloud before deletion.
//
// Safety: only a folder that belongs to exactly this game is removed — never a
// drive root, a system or user folder, a library root or a folder that holds
// another installed game.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { folderBytes } = require('../core.cjs');

const run = promisify(execFile);
const programData = () => process.env.ProgramData || 'C:\\ProgramData';

const inside = (child, parent) => {
  const c = path.resolve(child).toLowerCase(),
    p = path.resolve(parent).toLowerCase();
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Why a folder must not be removed for this game ('' when it may).
function folderRisk(dir, otherDirs = [], env = process.env) {
  if (!dir || !path.isAbsolute(dir)) return 'папка игры неизвестна';
  const d = path.resolve(dir);
  if (same(d, path.parse(d).root)) return 'это корень диска';
  const protectedDirs = [
    env.SystemRoot || 'C:\\Windows',
    env.ProgramFiles || 'C:\\Program Files',
    env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    env.ProgramData || 'C:\\ProgramData',
    env.USERPROFILE,
    env.APPDATA,
    env.LOCALAPPDATA,
  ].filter(Boolean);
  if (protectedDirs.some(p => same(d, p) || inside(p, d))) return 'это системная или пользовательская папка';
  for (const other of otherDirs) {
    if (!other) continue;
    if (same(other, d) || inside(other, d)) return 'в этой папке установлена другая игра';
  }
  return '';
}

class Uninstaller {
  constructor(ctx) {
    this.ctx = ctx;
    this.jobs = new Map(); // gameId → { state: 'uninstalling', done, total, provider }
    // Removals that stopped half way, kept across restarts: gameId → { provider, name, dir, extraDirs, error }.
    this.failed = new Map(
      Object.entries(ctx.settings?.uninstallLeftovers || {}).filter(
        ([, x]) => x && typeof x.dir === 'string' && path.isAbsolute(x.dir)
      )
    );
  }
  saveFailed() {
    if (!this.ctx.settings) return;
    this.ctx.settings.uninstallLeftovers = Object.fromEntries(this.failed);
    this.ctx.storage?.saveSettings();
  }
  // For the downloads view: { gameId: progress }.
  progress() {
    return Object.fromEntries([
      ...[...this.failed].map(([id, x]) => [
        id,
        {
          state: 'error',
          provider: x.provider,
          uninstallFailed: true,
          error: 'Удаление не завершено: ' + x.error,
        },
      ]),
      ...[...this.jobs].map(([id, j]) => [
        id,
        {
          state: 'uninstalling',
          provider: j.provider,
          done: j.done,
          total: j.total,
          percent: j.total ? Math.min(99, Math.floor((j.done / j.total) * 100)) : undefined,
        },
      ]),
    ]);
  }
  // Every other installed game folder (none of them may be removed with this one).
  otherFolders(gameId) {
    return (this.ctx.library.games || [])
      .filter(g => g.id !== gameId)
      .flatMap(g => g.offers || [])
      .filter(o => o.installed)
      .map(o => o.installDir || o.installLocation)
      .filter(Boolean);
  }
  plan(game, offer) {
    if (offer.provider === 'steam') {
      const dir = offer.installDir;
      if (!dir || !offer.manifestFile) throw Error('Nexus не нашёл папку игры Steam');
      const steamapps = path.dirname(offer.manifestFile);
      if (!inside(dir, path.join(steamapps, 'common'))) throw Error('папка игры не в библиотеке Steam');
      const id = String(offer.appId);
      return {
        dir,
        files: [offer.manifestFile, path.join(steamapps, `appworkshop_${id}.acf`)],
        extraDirs: [path.join(steamapps, 'workshop', 'content', id), path.join(steamapps, 'shadercache', id)],
        roots: [path.dirname(steamapps)],
      };
    }
    if (offer.provider === 'epic') {
      const dir = offer.installLocation;
      if (!dir || !offer.manifestFile) throw Error('Nexus не нашёл папку игры Epic');
      return {
        dir,
        files: [offer.manifestFile],
        extraDirs: [],
        roots: [],
        epicApp: offer.appId,
        dlcOf: offer.appId,
      };
    }
    throw Error('Удалять с диска можно только игры Steam и Epic Games');
  }
  async uninstall(gameId, provider) {
    // Pressed again while it runs: nothing new to do.
    if (this.jobs.has(gameId)) return { how: 'running' };
    const game = (this.ctx.library.games || []).find(g => g.id === gameId);
    const left = this.failed.get(gameId);
    const offer = game?.offers.find(o => o.provider === provider && o.installed);
    if (!offer && left) return this.retry(gameId, game, left);
    if (!game || !offer) throw Error('Игра не установлена');
    if (this.ctx.epicInstall?.moves?.has(gameId)) throw Error('Игра сейчас переносится');
    if (this.ctx.epicInstall?.jobs.has(gameId))
      throw Error('Сначала остановите загрузку игры на странице «Загрузки»');
    if (this.ctx.running?.isRunning(gameId)) throw Error('Сначала закройте игру');
    const plan = this.plan(game, offer);
    const risk = folderRisk(plan.dir, [...this.otherFolders(gameId), ...plan.roots]);
    if (risk) throw Error(`Nexus не удалит ${plan.dir}: ${risk}`);
    this.jobs.set(gameId, { provider, done: 0, total: 0 });
    this.ctx.hub.publish();
    // In the background: big games take a while; the downloads view shows the progress.
    this.run(gameId, game, offer, plan).catch(e => this.ctx.log.warn('uninstall', `${gameId}: ${e.message}`));
    return { how: 'started' };
  }
  async run(gameId, game, offer, plan) {
    const job = this.jobs.get(gameId);
    let epicExe = null;
    try {
      job.total = await folderBytes(plan.dir);
      if (offer.provider === 'epic') {
        epicExe = await this.closeEpicLauncher();
        await this.keepSaves(game, offer);
      }
    } catch (e) {
      this.jobs.delete(gameId);
      this.ctx.hub.publish();
      this.ctx.toast?.(`«${game.name}» не удалена: ${e.message}`);
      throw e;
    }
    await this.remove(gameId, game, plan, job.total, {
      manifestsGone: () => (offer.provider === 'steam' ? this.refreshSteam() : null),
      after: async () => {
        if (epicExe) this.startEpicLauncher(epicExe);
      },
    });
  }
  // A removal that stopped half way: the rest of the folder, then the extras.
  async retry(gameId, game, left) {
    const risk = folderRisk(left.dir, this.otherFolders(gameId));
    if (risk) throw Error(`Nexus не удалит ${left.dir}: ${risk}`);
    const plan = { dir: left.dir, files: [], extraDirs: left.extraDirs || [], roots: [] };
    this.jobs.set(gameId, { provider: left.provider, done: 0, total: 0 });
    this.ctx.hub.publish();
    const name = game?.name || left.name || 'Игра';
    (async () => {
      const job = this.jobs.get(gameId);
      job.total = await folderBytes(left.dir).catch(() => 0);
      await this.remove(gameId, { name }, plan, job.total, {});
    })().catch(e => this.ctx.log.warn('uninstall', `${gameId} retry: ${e.message}`));
    return { how: 'started' };
  }
  async remove(gameId, game, plan, size, hooks = {}) {
    const job = this.jobs.get(gameId);
    try {
      // The manifests first: the clients stop treating the game as installed.
      for (const file of plan.files) await fsp.rm(file, { force: true });
      // Records of the game's DLC (their files are inside the game folder).
      if (plan.dlcOf)
        for (const dir of new Set(plan.files.map(f => path.dirname(f))))
          for (const n of await fsp.readdir(dir).catch(() => [])) {
            if (!n.endsWith('.item')) continue;
            const p = path.join(dir, n);
            try {
              const v = JSON.parse(await fsp.readFile(p, 'utf8'));
              if (v.MainGameAppName === plan.dlcOf && v.AppName !== plan.dlcOf)
                await fsp.rm(p, { force: true });
            } catch {}
          }
      if (plan.epicApp) await this.removeFromLauncherInstalled(plan.epicApp);
      // Not awaited: Steam restarts in the tray while the files go.
      hooks.manifestsGone?.();
      await this.removeFolder(plan.dir, job);
      for (const extra of plan.extraDirs)
        await fsp.rm(extra, { recursive: true, force: true }).catch(() => {});
      if (this.failed.delete(gameId)) this.saveFailed();
      this.ctx.log.info('uninstall', `${gameId}: removed ${size} bytes`);
      this.ctx.toast?.(`«${game.name}» удалена. Освобождено ${(size / 1024 ** 3).toFixed(1)} ГБ.`);
    } catch (e) {
      // The manifests are gone (the clients count the game as removed); the rest waits for "Удалить снова".
      this.failed.set(gameId, {
        provider: job?.provider,
        name: game.name,
        dir: plan.dir,
        extraDirs: plan.extraDirs,
        error: e.message,
      });
      this.saveFailed();
      this.ctx.toast?.(`«${game.name}» удалена не полностью: ${e.message}. Нажмите «Удалить снова».`);
      throw e;
    } finally {
      await hooks.after?.().catch(() => {});
      this.jobs.delete(gameId);
      await this.ctx.library.scanLocal().catch(e => this.ctx.log.warn('scan', e.message));
      this.ctx.hub.publish();
    }
  }
  // File by file, so the progress moves; a file in use stops with a clear message.
  async removeFolder(dir, job) {
    let tick = 0;
    const walk = async d => {
      let entries;
      try {
        entries = await fsp.readdir(d, { withFileTypes: true });
      } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) await walk(p);
        else {
          let size = 0;
          try {
            size = (await fsp.lstat(p)).size;
            await fsp.rm(p, { force: true });
          } catch (err) {
            if (err.code === 'EBUSY' || err.code === 'EPERM')
              throw Error(`файл занят другой программой: ${path.relative(dir, p)}`);
            throw err;
          }
          job.done += size;
          if (++tick % 200 === 0) this.ctx.hub.publish();
        }
      }
      await fsp.rmdir(d).catch(() => {});
    };
    await walk(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
  async removeFromLauncherInstalled(appName) {
    const file = path.join(programData(), 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
    let json;
    try {
      json = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(json?.InstallationList)) return;
    const next = json.InstallationList.filter(x => x?.AppName !== appName);
    if (next.length === json.InstallationList.length) return;
    const tmp = file + '.nexus.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ ...json, InstallationList: next }, null, '\t'));
    await fsp.rename(tmp, file);
  }
  // The Epic launcher keeps its install list in memory: it is closed first, without asking.
  // Returns the launcher's exe when it was open (to start it again in the tray), else null.
  async closeEpicLauncher() {
    if (process.platform !== 'win32') return null;
    const runningNow = async () => {
      try {
        const { stdout } = await run(
          'tasklist',
          ['/FI', 'IMAGENAME eq EpicGamesLauncher.exe', '/FO', 'CSV', '/NH'],
          {
            windowsHide: true,
            timeout: 8000,
          }
        );
        return /epicgameslauncher\.exe/i.test(stdout);
      } catch {
        return false;
      }
    };
    if (!(await runningNow())) return null;
    let exe = '';
    try {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-Process EpicGamesLauncher -ErrorAction SilentlyContinue | Select-Object -First 1).Path',
        ],
        { windowsHide: true, timeout: 10000 }
      );
      exe = stdout.trim();
    } catch {}
    await run('taskkill.exe', ['/IM', 'EpicGamesLauncher.exe', '/T', '/F'], {
      windowsHide: true,
      timeout: 15000,
    }).catch(() => {});
    for (let i = 0; i < 10 && (await runningNow()); i++) await new Promise(r => setTimeout(r, 500));
    if (await runningNow()) throw Error('Epic Games Launcher не закрылся');
    return /epicgameslauncher\.exe$/i.test(exe) && path.isAbsolute(exe) ? exe : null;
  }
  startEpicLauncher(exe) {
    try {
      spawn(exe, ['-silent'], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', shell: false })
        .on('error', e => this.ctx.log.warn('uninstall', 'Epic launcher: ' + e.message))
        .unref();
    } catch (e) {
      this.ctx.log.warn('uninstall', 'Epic launcher: ' + e.message);
    }
  }
  // Steam reads its library on start: restarted hidden, unless a Steam game runs.
  async refreshSteam() {
    try {
      const actions = this.ctx.actions;
      const exe = actions?.steamExe?.();
      if (!exe || !(await actions.processRunning('steam.exe'))) return;
      if ((await actions.runningSteamApp?.()) !== '0') return;
      await this.ctx.steamInstall.stopSteam(exe);
      this.ctx.steamInstall.startSteam(exe);
      this.ctx.log.info('uninstall', 'Steam restarted in the tray');
    } catch (e) {
      this.ctx.log.warn('uninstall', 'Steam restart: ' + e.message);
    }
  }
  // Saves inside the game folder would go with it: copied and uploaded first.
  async keepSaves(game, offer) {
    const epic = this.ctx.actions?.epic;
    if (!epic) return;
    try {
      const account = epic.account(offer);
      if (!account) return;
      const token = await this.ctx.accounts.tokens.accessToken(account.id);
      const info = require('../epic-games-api.cjs').launchInfo(await epic.metadata(token, offer));
      const folder = info.cloudFolder && epic.saveFolder(offer, account, info.cloudFolder);
      if (!folder || !inside(folder, offer.installLocation)) return;
      const sync = { account, offer, info, folder };
      const local = await epic.localFiles(sync);
      if (!local.length) return;
      const backup = await epic.backup(sync, local);
      if (this.ctx.settings.epicCloudSaves !== false) await epic.upload(token, sync, local);
      this.ctx.log.info(
        'uninstall',
        `${offer.appId}: saves in the game folder kept${backup ? ' (backup)' : ''}`
      );
    } catch (e) {
      this.ctx.log.warn('uninstall', `${offer.appId} saves: ${e.message}`);
    }
  }
}

module.exports = { Uninstaller, folderRisk };
