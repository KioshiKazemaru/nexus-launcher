'use strict';
// Installing Steam games without Steam's window. Steam games need the Steam
// client to run anyway (DRM, Steam Cloud), so Steam does the download — Nexus
// only starts it: it writes the game's appmanifest (state "update required")
// into the chosen Steam library and (re)starts Steam hidden in the tray
// ("-silent"). Steam reads the manifest on start and downloads the game in the
// background; Nexus shows the progress from the same manifest.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dialog } = require('electron');
const { parseVdf } = require('../core.cjs');

const gb = n => (n / 1024 ** 3).toFixed(1);
const INFO_MS = 5 * 60000;

// Steam's own folder name rules (no characters Windows forbids).
function installDirName(name) {
  const n = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  return n || 'Game';
}
const vdfString = s =>
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

// The appmanifest Steam reads on start: StateFlags 1026 = update required + update started.
function appManifest({ appId, name, installdir, owner }) {
  const rows = [
    ['appid', appId],
    ['Universe', '1'],
    ['name', name],
    ['StateFlags', '1026'],
    ['installdir', installdir],
    ['LastUpdated', '0'],
    ['SizeOnDisk', '0'],
    ['buildid', '0'],
    ['LastOwner', owner || '0'],
    ['BytesToDownload', '0'],
    ['BytesDownloaded', '0'],
    ['AutoUpdateBehavior', '0'],
    ['AllowOtherDownloadsWhileRunning', '0'],
    ['ScheduledAutoUpdate', '0'],
  ];
  return `"AppState"\n{\n${rows.map(([k, v]) => `\t"${k}"\t\t"${vdfString(v)}"`).join('\n')}\n}\n`;
}

// Steam libraries of every Steam folder (libraryfolders.vdf).
async function steamLibraries(roots) {
  const libs = new Set((roots || []).filter(Boolean).map(r => path.resolve(r)));
  for (const root of [...libs]) {
    try {
      const v =
        parseVdf(await fsp.readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8'))
          .libraryfolders || {};
      for (const [k, x] of Object.entries(v))
        if (/^\d+$/.test(k)) {
          const p = typeof x === 'string' ? x : x?.path;
          if (p) libs.add(path.resolve(p.replace(/\\\\/g, '\\')));
        }
    } catch {}
  }
  const out = [];
  for (const lib of libs) {
    if (!fs.existsSync(path.join(lib, 'steamapps'))) continue;
    let free = 0;
    try {
      const st = await fsp.statfs(path.parse(lib).root);
      free = st.bavail * st.bsize;
    } catch {}
    out.push({ path: lib, free });
  }
  return out;
}

// appinfo (folder name, Windows depot sizes) through an anonymous Steam connection.
function parseAppInfo(appinfo) {
  const depots = appinfo?.depots || {};
  let size = 0,
    download = 0;
  for (const [id, dpt] of Object.entries(depots)) {
    if (!/^\d+$/.test(id) || !dpt?.manifests?.public) continue;
    const os = String(dpt.config?.oslist || '');
    if (os && !/windows/i.test(os)) continue;
    if (dpt.config?.language && dpt.config.language !== 'english' && dpt.config.language !== 'russian')
      continue;
    // DLC content, optional packs, low-violence and 32-bit builds are not part of a normal install.
    if (
      dpt.dlcappid ||
      dpt.config?.optionaldlc ||
      dpt.config?.lowviolence === '1' ||
      dpt.config?.osarch === '32'
    )
      continue;
    const m = dpt.manifests.public;
    size += Number(m.size) || 0;
    download += Number(m.download) || Number(m.size) || 0;
  }
  return {
    name: String(appinfo?.common?.name || ''),
    installdir: String(appinfo?.config?.installdir || ''),
    size,
    download,
  };
}

class SteamInstaller {
  constructor(ctx, { SteamUserImpl } = {}) {
    this.ctx = ctx;
    this.SteamUserImpl = SteamUserImpl;
    this.anon = null;
    this.info = new Map();
  }
  async anonymous() {
    if (this.anon) return this.anon;
    const SteamUser = this.SteamUserImpl || require('steam-user');
    const client = new SteamUser({
      protocol: SteamUser.EConnectionProtocol?.WebSocket,
      autoRelogin: false,
      dataDirectory: null,
      enablePicsCache: false,
    });
    this.anon = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Error('Steam не ответил')), 20000);
      client.once('loggedOn', () => (clearTimeout(t), resolve(client)));
      client.once('error', e => (clearTimeout(t), reject(e)));
      client.logOn({ anonymous: true });
    }).catch(e => {
      this.anon = null;
      throw e;
    });
    clearTimeout(this.anonTimer);
    this.anonTimer = setTimeout(() => this.closeAnonymous(), INFO_MS);
    this.anonTimer.unref?.();
    return this.anon;
  }
  closeAnonymous() {
    const p = this.anon;
    this.anon = null;
    p?.then(c => c.logOff()).catch(() => {});
  }
  async appInfo(appId) {
    if (this.info.has(appId)) return this.info.get(appId);
    try {
      const client = await this.anonymous();
      const r = await client.getProductInfo([Number(appId)], [], true);
      const info = parseAppInfo(r?.apps?.[appId]?.appinfo);
      this.info.set(appId, info);
      return info;
    } catch (e) {
      this.ctx.log.debug?.('steam-install', `appinfo ${appId}: ${e.message}`);
      return { name: '', installdir: '', size: 0, download: 0 };
    }
  }
  // Returns { how: 'steam-download' | 'client' | 'canceled' }.
  async install(gameId) {
    const g = (this.ctx.library.games || []).find(x => x.id === gameId);
    const offer = g?.offers.find(o => o.provider === 'steam');
    if (!offer) throw Error('Игра Steam не найдена');
    if (offer.installed) throw Error('Игра уже установлена');
    const exe = this.ctx.actions.steamExe();
    if (!exe) return { how: 'client' }; // no Steam yet: the client installer takes over
    const appId = String(offer.appId);
    if (!/^\d+$/.test(appId)) throw Error('Некорректная игра Steam');
    const libs = await steamLibraries(this.ctx.library.local.steamRoots);
    if (!libs.length) return { how: 'client' };
    // Steam already has this install (started or paused in Steam): it continues it.
    if (libs.some(l => fs.existsSync(path.join(l.path, 'steamapps', `appmanifest_${appId}.acf`))))
      return { how: 'client' };
    const steamOpen = await this.ctx.actions.processRunning('steam.exe');
    const playing = steamOpen && (await this.ctx.actions.runningSteamApp()) !== '0';
    if (playing) return { how: 'client' }; // Steam is not restarted under a running game
    const info = await this.appInfo(appId);
    const name = info.name || g.name;
    const installdir = installDirName(info.installdir || name);
    const need = info.size || 0;
    // Up to three libraries as buttons (most free space first).
    const choices = [...libs].sort((a, b) => b.free - a.free).slice(0, 3);
    const buttons = [
      ...choices.map(l => `${l.path} (свободно ${gb(l.free)} ГБ)`),
      'Через окно Steam',
      'Отмена',
    ];
    const { response } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
      type: 'question',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      title: 'Установка игры',
      message: `Установить «${name}»? Выберите библиотеку Steam`,
      detail: `${need ? `На диске: около ${gb(need)} ГБ` + (info.download ? ` · скачать: ${gb(info.download)} ГБ` : '') + '\n' : ''}Загрузку выполнит Steam в фоне, без своего окна; прогресс — на странице «Загрузки».${steamOpen ? '\n\nSteam сейчас открыт: Nexus перезапустит его в фоне, чтобы он увидел новую игру.' : ''}`,
    });
    if (response === buttons.length - 1) return { how: 'canceled' };
    if (response === buttons.length - 2) return { how: 'client' };
    const lib = choices[response];
    // The size is an estimate (all Windows depots): a warning, not a refusal.
    if (need && lib.free < need + 512 * 1024 ** 2) {
      const { response: go } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
        type: 'warning',
        buttons: ['Всё равно установить', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        message: 'Места может не хватить',
        detail: `В библиотеке ${lib.path} свободно ${gb(lib.free)} ГБ, а игре может понадобиться до ${gb(need)} ГБ.`,
      });
      if (go !== 0) return { how: 'canceled' };
    }
    const file = path.join(lib.path, 'steamapps', `appmanifest_${appId}.acf`);
    if (steamOpen) await this.stopSteam(exe);
    const owner =
      this.ctx.accounts.connected('steam').find(a => a.id === offer.accountId)?.id || offer.accountId;
    await fsp.writeFile(file, appManifest({ appId, name, installdir, owner }));
    this.startSteam(exe);
    this.ctx.library.expectChange(30 * 60 * 1000);
    this.ctx.log.info('steam-install', `${appId} → ${lib.path}${steamOpen ? ' (Steam restarted)' : ''}`);
    return { how: 'steam-download' };
  }
  async stopSteam(exe) {
    spawn(exe, ['-shutdown'], { detached: true, stdio: 'ignore', shell: false }).unref();
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (!(await this.ctx.actions.processRunning('steam.exe'))) return;
    }
    throw Error('Steam не закрылся — установите игру через окно Steam');
  }
  startSteam(exe) {
    const child = spawn(exe, ['-silent'], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.on('error', e => this.ctx.log.warn('steam-install', e.message));
    child.unref();
  }
  stop() {
    this.closeAnonymous();
  }
}

module.exports = { SteamInstaller, appManifest, steamLibraries, parseAppInfo, installDirName };
