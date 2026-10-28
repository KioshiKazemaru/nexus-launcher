'use strict';
// Removing a game from this PC directly in Nexus (Steam and Epic Games).
//   Steam: the game folder (steamapps\common\…), its appmanifest, Workshop
//          content and shader cache of the app. Steam notices the removed
//          manifest and shows the game as not installed.
//   Epic:  the game folder, its .item manifest and its entry in
//          LauncherInstalled.dat. The Epic launcher, if open, is closed first:
//          it would otherwise write the game back into its lists.
// Saves stay: Steam Cloud / Epic cloud saves and saves in AppData/Documents are
// not touched. Saves inside the game folder (some Epic games) are copied to
// save-backups and, when possible, uploaded to the Epic cloud before deletion.
//
// Safety: only a folder that belongs to exactly this game is removed — never a
// drive root, a system or user folder, a library root or a folder that holds
// another installed game.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { dialog } = require('electron');
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
  }
  // For the downloads view: { gameId: progress }.
  progress() {
    return Object.fromEntries(
      [...this.jobs].map(([id, j]) => [
        id,
        {
          state: 'uninstalling',
          provider: j.provider,
          done: j.done,
          total: j.total,
          percent: j.total ? Math.min(99, Math.floor((j.done / j.total) * 100)) : undefined,
        },
      ])
    );
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
      return { dir, files: [offer.manifestFile], extraDirs: [], roots: [], epicApp: offer.appId };
    }
    throw Error('Удалять с диска можно только игры Steam и Epic Games');
  }
  async uninstall(gameId, provider) {
    const game = (this.ctx.library.games || []).find(g => g.id === gameId);
    const offer = game?.offers.find(o => o.provider === provider && o.installed);
    if (!game || !offer) throw Error('Игра не установлена');
    if (this.jobs.has(gameId)) throw Error('Игра уже удаляется');
    if (this.ctx.epicInstall?.jobs.has(gameId))
      throw Error('Сначала остановите загрузку игры на странице «Загрузки»');
    if (this.ctx.running?.isRunning(gameId)) throw Error('Сначала закройте игру');
    const plan = this.plan(game, offer);
    const risk = folderRisk(plan.dir, [...this.otherFolders(gameId), ...plan.roots]);
    if (risk) throw Error(`Nexus не удалит ${plan.dir}: ${risk}`);
    const size = await folderBytes(plan.dir);
    const store = provider === 'steam' ? 'Steam' : 'Epic Games';
    const { response } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
      type: 'warning',
      buttons: ['Удалить', `Удалить через ${store}`, 'Отмена'],
      defaultId: 2,
      cancelId: 2,
      title: 'Удаление игры',
      message: `Удалить «${game.name}» с этого компьютера?`,
      detail: `Будет удалено ${(size / 1024 ** 3).toFixed(1)} ГБ:\n${plan.dir}\n\nСохранения в облаке ${provider === 'steam' ? 'Steam Cloud' : 'Epic'} и в папках «Документы»/AppData останутся; игра останется в вашей библиотеке, её можно установить снова.`,
    });
    if (response === 1) return { how: 'client' };
    if (response !== 0) return { how: 'canceled' };
    if (provider === 'epic' && !(await this.closeEpicLauncher())) return { how: 'canceled' };
    if (provider === 'epic') await this.keepSaves(game, offer);
    this.jobs.set(gameId, { provider, done: 0, total: size });
    this.ctx.hub.publish();
    // In the background: big games take a while; the downloads view shows the progress.
    this.remove(gameId, game, plan, size).catch(e => {
      this.ctx.log.warn('uninstall', `${gameId}: ${e.message}`);
      this.ctx.toast?.(`«${game.name}» удалена не полностью: ${e.message}`);
    });
    return { how: 'started' };
  }
  async remove(gameId, game, plan, size) {
    const job = this.jobs.get(gameId);
    try {
      // The manifests first: the clients stop treating the game as installed.
      for (const file of plan.files) await fsp.rm(file, { force: true });
      if (plan.epicApp) await this.removeFromLauncherInstalled(plan.epicApp);
      await this.removeFolder(plan.dir, job);
      for (const extra of plan.extraDirs)
        await fsp.rm(extra, { recursive: true, force: true }).catch(() => {});
      this.ctx.log.info('uninstall', `${gameId}: removed ${size} bytes`);
      this.ctx.toast?.(`«${game.name}» удалена. Освобождено ${(size / 1024 ** 3).toFixed(1)} ГБ.`);
    } finally {
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
  // The Epic launcher keeps its install list in memory: it is closed first.
  async closeEpicLauncher() {
    if (process.platform !== 'win32') return true;
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
    if (!(await runningNow())) return true;
    const { response } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
      type: 'question',
      buttons: ['Закрыть Epic Launcher и удалить', 'Отмена'],
      defaultId: 0,
      cancelId: 1,
      title: 'Epic Games Launcher открыт',
      message: 'Чтобы удалить игру, Nexus закроет Epic Games Launcher',
      detail:
        'Иначе лаунчер может вернуть удалённую игру в свой список. Загрузки в Epic будут приостановлены.',
    });
    if (response !== 0) return false;
    await run('taskkill.exe', ['/IM', 'EpicGamesLauncher.exe', '/T', '/F'], {
      windowsHide: true,
      timeout: 15000,
    }).catch(() => {});
    for (let i = 0; i < 10 && (await runningNow()); i++) await new Promise(r => setTimeout(r, 500));
    return !(await runningNow());
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
