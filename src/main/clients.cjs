'use strict';
// The official clients (Epic Games Launcher, Steam) that install games and
// open store links. When a client is missing — or Windows still has a link
// to a client that was deleted — Nexus offers to install it: the official
// installer is downloaded from the store's own servers, its digital
// signature is checked (Epic Games / Valve), it is installed (Windows asks
// for administrator rights) and the original action continues: the client
// opens, asks to sign in and then installs or starts the chosen game.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app, dialog, shell } = require('electron');

const run = promisify(execFile);

const CLIENTS = {
  epic: {
    name: 'Epic Games Launcher',
    protocol: 'com.epicgames.launcher',
    url: 'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.msi',
    hosts: ['launcher-public-service-prod06.ol.epicgames.com', 'epicgames-download1.akamaized.net'],
    file: 'EpicGamesLauncherInstaller.msi',
    signer: /Epic Games/i,
    signerName: 'Epic Games',
    size: '≈250 МБ',
    site: 'https://store.epicgames.com/download',
    // The folder that holds "Launcher\…" (C:\Program Files (x86)\Epic Games by default).
    defaultDir: () => path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Epic Games'),
    // Install folder of an existing (or deleted) launcher from its program path.
    rootOf: exe => (/\\Launcher\\/i.test(exe) ? exe.slice(0, exe.search(/\\Launcher\\/i)) : ''),
    needBytes: 2 * 1024 ** 3,
    // msiexec installs the MSI into INSTALLDIR; "passive" shows only a progress bar.
    install: (file, dir) => ({
      exe: 'msiexec.exe',
      args: `/i "${file}" INSTALLDIR="${dir}" /passive /norestart`,
    }),
  },
  steam: {
    name: 'Steam',
    protocol: 'steam',
    url: 'https://cdn.akamai.steamstatic.com/client/installer/SteamSetup.exe',
    hosts: ['cdn.akamai.steamstatic.com'],
    file: 'SteamSetup.exe',
    signer: /Valve/i,
    signerName: 'Valve',
    size: '≈2 МБ (сам Steam загрузится после установки)',
    site: 'https://store.steampowered.com/about/',
    defaultDir: () => path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
    rootOf: exe => path.dirname(exe),
    needBytes: 1 * 1024 ** 3,
    // NSIS: /D= must be the last argument and is never quoted, even with spaces.
    install: (file, dir) => ({ exe: file, args: `/S /D=${dir}` }),
  },
};
const OK_EXIT = new Set([0, 1641, 3010]); // 1641/3010: installed, restart requested

// "C:\path\app.exe" %1 → C:\path\app.exe
function commandExecutable(command) {
  const s = String(command || '').trim();
  const m = s.startsWith('"') ? /^"([^"]+)"/.exec(s) : /^(\S+)/.exec(s);
  return m ? m[1] : '';
}
// Default value of a registry key from `reg query` output (any Windows language).
function regDefault(stdout) {
  const line = String(stdout)
    .split(/\r?\n/)
    .find(l => /\sREG_(EXPAND_)?SZ\s/.test(l));
  return line ? line.replace(/^.*?\sREG_(EXPAND_)?SZ\s+/, '').trim() : '';
}

class ClientInstaller {
  constructor(ctx) {
    this.ctx = ctx;
    this.busy = new Map(); // provider → promise of a running installation
  }
  // Program the link handler starts ('' when no handler is registered).
  async handlerExe(provider) {
    const c = CLIENTS[provider];
    try {
      const { stdout } = await run('reg.exe', ['query', `HKCR\\${c.protocol}\\shell\\open\\command`, '/ve'], {
        windowsHide: true,
        timeout: 5000,
      });
      return commandExecutable(regDefault(stdout));
    } catch {
      return '';
    }
  }
  // Installed = the link handler is registered AND its program exists.
  async installed(provider) {
    if (!CLIENTS[provider] || process.platform !== 'win32') return true;
    const exe = await this.handlerExe(provider);
    return !!exe && fs.existsSync(exe);
  }
  // Where to install: the user chooses. The previous location of the client
  // (also of a deleted one) is suggested when its drive is still there.
  async chooseFolder(provider) {
    const c = CLIENTS[provider];
    const remembered = this.ctx.settings?.clientInstallDirs?.[provider];
    const old = c.rootOf(await this.handlerExe(provider));
    const driveOk = p => !!p && fs.existsSync(path.parse(p).root);
    const suggested = [remembered, old].find(driveOk) || c.defaultDir();
    for (;;) {
      const { canceled, filePaths } = await dialog.showOpenDialog(this.ctx.mainWindow?.() || null, {
        title: `Куда установить ${c.name}?`,
        defaultPath: suggested,
        buttonLabel: 'Установить сюда',
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      });
      if (canceled || !filePaths?.[0]) return null;
      const dir = path.resolve(filePaths[0]);
      const problem = await this.folderProblem(c, dir);
      if (!problem) {
        this.ctx.settings && ((this.ctx.settings.clientInstallDirs ||= {})[provider] = dir);
        this.ctx.storage?.saveSettings();
        return dir;
      }
      const { response } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
        type: 'warning',
        buttons: ['Выбрать другую папку', 'Отмена'],
        defaultId: 0,
        cancelId: 1,
        title: 'Эта папка не подходит',
        message: problem,
      });
      if (response !== 0) return null;
    }
  }
  // Why a folder cannot be used ('' when it can).
  async folderProblem(c, dir) {
    if (!path.isAbsolute(dir) || /["%]/.test(dir))
      return 'Выберите обычную папку на диске (без кавычек и знака %).';
    if (/^\\\\/.test(dir)) return 'Сетевые папки не подходят: выберите папку на диске этого ПК.';
    try {
      const st = await fsp.statfs(path.parse(dir).root);
      const free = st.bavail * st.bsize;
      if (free < c.needBytes)
        return `На диске ${path.parse(dir).root} свободно ${(free / 1024 ** 3).toFixed(1)} ГБ, а ${c.name} нужно не меньше ${c.needBytes / 1024 ** 3} ГБ.`;
    } catch {
      return 'Этот диск недоступен.';
    }
    return '';
  }
  // Opens a client link (steam://…, com.epicgames.launcher://…). Returns
  // 'opened', 'install-started' or 'canceled'.
  async open(provider, uri, action = 'открыть игру') {
    if (await this.installed(provider)) {
      await shell.openExternal(uri);
      return 'opened';
    }
    return this.offerInstall(provider, uri, action);
  }
  async offerInstall(provider, uri, action) {
    const c = CLIENTS[provider];
    if (this.busy.has(provider)) {
      this.ctx.toast?.(`${c.name} уже устанавливается. Игра откроется, когда установка закончится.`);
      return 'install-started';
    }
    const { response } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
      type: 'question',
      buttons: ['Скачать и установить', 'Открыть сайт', 'Отмена'],
      defaultId: 0,
      cancelId: 2,
      title: `${c.name} не установлен`,
      message: `Чтобы ${action}, нужен ${c.name}`,
      detail: `Nexus спросит, в какую папку установить, скачает официальный установщик с серверов ${provider === 'epic' ? 'Epic Games' : 'Valve'} (${c.size}), проверит его цифровую подпись и установит — Windows попросит разрешение администратора.\n\nПосле установки ${c.name} откроется: войдите в аккаунт, и выбранная игра откроется в нём автоматически.`,
    });
    if (response === 1) {
      await shell.openExternal(c.site);
      return 'canceled';
    }
    if (response !== 0) return 'canceled';
    const dir = await this.chooseFolder(provider);
    if (!dir) return 'canceled';
    const task = this.installAndContinue(provider, uri, dir)
      .catch(e => {
        this.ctx.log.warn('client-install', `${provider}: ${e.message}`);
        this.ctx.toast?.(`${c.name} не установлен: ${e.message}`);
      })
      .finally(() => {
        this.busy.delete(provider);
        this.ctx.hub?.publish();
      });
    this.busy.set(provider, task);
    return 'install-started';
  }
  async installAndContinue(provider, uri, installDir) {
    const c = CLIENTS[provider];
    const dir = path.join(app.getPath('userData'), 'downloads');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, c.file);
    try {
      this.ctx.toast?.(`Скачиваем ${c.name}…`);
      await this.download(c, file);
      await this.checkSignature(c, file);
      this.ctx.toast?.(`Устанавливаем ${c.name}. Подтвердите запрос Windows.`);
      await this.runInstaller(c, file, installDir);
      // The installer registers the link handler; give Windows a moment.
      for (let i = 0; i < 30 && !(await this.installed(provider)); i++) await this.sleep(2000);
      if (!(await this.installed(provider))) throw Error('установка завершилась, но лаунчер не найден');
      // Report honestly where the client really is (an installer may ignore the folder).
      const exe = await this.handlerExe(provider);
      const inside = exe.toLowerCase().startsWith(installDir.toLowerCase() + path.sep);
      this.ctx.log.info(
        'client-install',
        `${provider} installed${inside ? '' : ' (not in the chosen folder)'}`
      );
      this.ctx.toast?.(
        inside
          ? `${c.name} установлен в ${installDir}. Войдите в аккаунт — игра откроется в нём.`
          : `${c.name} установлен, но не в выбранную папку, а в ${path.dirname(exe)}. Войдите в аккаунт — игра откроется в нём.`
      );
      await shell.openExternal(uri);
    } finally {
      await fsp.rm(file, { force: true }).catch(() => {});
      await fsp.rm(file + '.part', { force: true }).catch(() => {});
    }
  }
  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
  // Downloads only from the client's own hosts (redirects are checked too).
  async download(c, file) {
    const r = await this.ctx.publicFetch(c.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    const host = new URL(r.url || c.url).hostname;
    if (!r.ok) throw Error(`загрузка: HTTP ${r.status}`);
    if (!c.hosts.includes(host)) throw Error(`установщик пришёл с постороннего адреса (${host})`);
    const total = Number(r.headers.get('content-length')) || 0;
    const part = file + '.part';
    const out = fs.createWriteStream(part);
    let done = 0,
      shown = 0;
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        done += value.length;
        if (!out.write(Buffer.from(value))) await new Promise(res => out.once('drain', res));
        const percent = total ? Math.floor((done / total) * 100) : 0;
        if (percent >= shown + 25 && percent < 100) {
          shown = percent - (percent % 25);
          this.ctx.toast?.(`Скачиваем ${c.name}: ${shown}%`);
        }
      }
    } finally {
      await new Promise(res => out.end(res));
    }
    if (total && done !== total) throw Error('загрузка прервалась');
    if (done < 1024 * 1024 && c.file.endsWith('.msi')) throw Error('скачан неполный установщик');
    await fsp.rename(part, file);
  }
  // The installer must carry a valid signature of the store itself.
  async checkSignature(c, file) {
    const script =
      '$s = Get-AuthenticodeSignature -LiteralPath $env:NEXUS_FILE; ' +
      '[pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress';
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 60000,
      env: { ...process.env, NEXUS_FILE: file },
    });
    const sig = JSON.parse(stdout);
    if (sig.Status !== 'Valid')
      throw Error(`у установщика нет действительной подписи (${sig.Status || 'нет'}): файл удалён`);
    if (!c.signer.test(sig.Subject || '')) throw Error(`установщик подписан не ${c.signerName}: файл удалён`);
  }
  // Runs the installer with administrator rights (Windows shows its own prompt).
  async runInstaller(c, file, dir) {
    const { exe, args } = c.install(file, dir);
    const script =
      '$p = Start-Process -FilePath $env:NEXUS_EXE -ArgumentList $env:NEXUS_ARGS -Verb RunAs -Wait -PassThru; exit $p.ExitCode';
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 45 * 60 * 1000,
        env: { ...process.env, NEXUS_EXE: exe, NEXUS_ARGS: args },
      });
    } catch (e) {
      if (/cancel|отмен/i.test(String(e.stderr || e.message)))
        throw Error('установка отменена в окне Windows');
      if (Number.isInteger(e.code) && OK_EXIT.has(e.code)) return;
      throw Error(`установщик завершился с кодом ${e.code ?? '?'}`);
    }
  }
}

module.exports = { ClientInstaller, CLIENTS, commandExecutable, regDefault };
