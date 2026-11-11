'use strict';
// Automatic updates through electron-updater (GitHub Releases). Only active in a
// packaged, installed build. electron-updater verifies the downloaded installer
// against the release's SHA-512.
//   Linux:   the AppImage or the .deb package, whichever is installed (latest-linux.yml);
//            the .deb asks for the administrator password when it installs.
//   Windows: the installed version accepts only an installer signed by the publisher
//            "Nexus", and the builds are not code-signed. Nexus finds the new version
//            (latest.yml) and offers it; "Скачать" downloads the installer from the
//            release, checks it against the SHA-512 in latest.yml and starts it.
//   macOS:   macOS installs only updates signed by an Apple developer: "Скачать"
//            downloads the disk image (latest-mac.yml, checked the same way) and opens it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RELEASES = 'https://github.com/KioshiKazemaru/nexus-launcher/releases';
const RELEASES_API = 'https://api.github.com/repos/KioshiKazemaru/nexus-launcher/releases';

// The headlines of a release description (Markdown): the top-level points, their bold
// title when they have one, as plain text. At most 4, each at most 140 characters.
function releaseHeadlines(body) {
  if (typeof body !== 'string') return [];
  return body
    .split(/\r?\n/)
    .filter(line => /^[-*] /.test(line))
    .map(line => {
      const bold = line.match(/^[-*] \*\*(.+?)\*\*/);
      const text = (bold ? bold[1] : line.slice(2))
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.:]$/, '');
      return text.length > 140 ? text.slice(0, 139) + '…' : text;
    })
    .filter(Boolean)
    .slice(0, 4);
}
// A file of a release: a plain name, no folders.
const FILE_NAME = /^Nexus[\w.-]*\.(exe|dmg)$/;
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;

class Updater {
  constructor(ctx, platform = process.platform) {
    this.ctx = ctx;
    this.platform = platform;
    this.manual = platform === 'darwin' || platform === 'win32';
    this.state = { status: 'idle', version: null, error: '', manual: this.manual, progress: null };
    this.updater = null;
    this.files = [];
    this.fetch = (...a) => globalThis.fetch(...a);
    this.tempDir = () => os.tmpdir();
  }
  available() {
    return !!this.load();
  }
  load() {
    if (this.updater !== null) return this.updater;
    const { app } = require('electron');
    if (!app.isPackaged) return (this.updater = false);
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = !this.manual;
      autoUpdater.autoInstallOnAppQuit = !this.manual;
      autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: '' }));
      autoUpdater.on('update-available', info => this.found(info?.version, info?.files));
      autoUpdater.on('update-not-available', () => this.set({ status: 'current' }));
      autoUpdater.on('download-progress', p =>
        this.set({ status: 'downloading', percent: Math.round(p?.percent || 0) })
      );
      autoUpdater.on('update-downloaded', info =>
        this.set({ status: 'ready', version: info?.version || null })
      );
      autoUpdater.on('error', e => this.failed(e));
      this.updater = autoUpdater;
    } catch {
      this.updater = false;
    }
    return this.updater;
  }
  found(version, files = []) {
    const v = /^\d+\.\d+\.\d+$/.test(String(version)) ? String(version) : null;
    this.files = Array.isArray(files) ? files : [];
    this.set({ status: this.manual ? 'manual' : 'downloading', version: v, notes: [] });
    // Only with the real updater (tests and local builds ask nothing of GitHub).
    if (v && this.updater) this.loadNotes(v).catch(e => this.ctx.log?.warn('update', 'notes: ' + e.message));
    if (this.manual && v)
      this.ctx.notices?.add([
        {
          kind: 'update',
          key: 'update:' + v,
          title: `Вышла новая версия Nexus ${v}`,
          body: 'Скачайте и установите её в окне обновления или в «Аккаунтах»',
        },
      ]);
  }
  // «Что нового»: the headlines of the release description on GitHub.
  async loadNotes(version) {
    const res = await this.fetch(`${RELEASES_API}/tags/v${version}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw Error(`HTTP ${res.status}`);
    const notes = releaseHeadlines((await res.json())?.body);
    if (this.state.version === version) this.set({ notes });
  }
  // A build without an update source is not an error: a local build (no app-update.yml)
  // or Linux started outside the AppImage and the .deb package. An installer the system
  // refuses for its missing signature is offered for download instead.
  failed(e) {
    const message = String(e?.message || e);
    this.ctx.log?.warn('update', message);
    if (/app-update\.yml|APPIMAGE env/.test(message)) this.set({ status: 'unsupported', error: '' });
    else if (/not signed by the application owner/.test(message) && this.state.version)
      this.set({ status: 'manual', manual: true, error: '' });
    else this.set({ status: 'error', error: message.slice(0, 200) });
  }
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.ctx.hub.publish();
  }
  async check() {
    const u = this.load();
    if (!u) {
      this.set({ status: 'unsupported' });
      return this.state;
    }
    try {
      await u.checkForUpdates();
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    }
    return this.state;
  }
  // The release page of the new version.
  releaseUrl() {
    const v = this.state.version;
    return v ? `${RELEASES}/tag/v${v}` : `${RELEASES}/latest`;
  }
  openRelease() {
    return require('electron').shell.openExternal(this.releaseUrl());
  }
  // The installer for this system in the release: the .exe on Windows, the disk image
  // for this processor on macOS.
  installerFile(arch = process.arch) {
    const ext = this.platform === 'win32' ? '.exe' : '.dmg';
    const cpu = arch === 'arm64' ? '-arm64.' : '-x64.';
    return (
      this.files.find(
        f =>
          FILE_NAME.test(String(f?.url)) &&
          f.url.endsWith(ext) &&
          SHA512.test(String(f.sha512)) &&
          (ext === '.exe' || f.url.includes(cpu))
      ) || null
    );
  }
  // "Скачать": the installer goes to the temporary folder, is checked against the
  // SHA-512 of latest.yml, then started (Windows: Nexus quits so the installer can
  // replace it) or opened (macOS). Without a file to download, the release page opens.
  async download() {
    const file = this.manual && this.state.version ? this.installerFile() : null;
    if (!file) return this.openRelease();
    if (this.state.progress !== null) return;
    const url = `${RELEASES}/download/v${this.state.version}/${file.url}`;
    const target = path.join(this.tempDir(), file.url);
    this.set({ progress: 0, error: '' });
    try {
      const res = await this.fetch(url);
      if (!res.ok || !res.body) throw Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || Number(file.size) || 0;
      const hash = crypto.createHash('sha512');
      const out = fs.createWriteStream(target);
      let got = 0,
        shown = 0;
      try {
        for await (const chunk of res.body) {
          hash.update(chunk);
          got += chunk.length;
          if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
          const percent = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
          if (percent !== shown) this.set({ progress: (shown = percent) });
        }
      } finally {
        await new Promise(r => out.end(r));
      }
      if (hash.digest('base64') !== file.sha512) {
        fs.rmSync(target, { force: true });
        throw Error('файл не совпадает с релизом');
      }
      this.set({ progress: 100 });
      await this.start(target);
    } catch (e) {
      this.ctx.log?.warn('update', e.message);
      this.set({ progress: null, error: 'Не удалось скачать установщик: ' + e.message });
      throw Error('Не удалось скачать установщик: ' + e.message);
    }
  }
  async start(file) {
    const { shell, app } = require('electron');
    if (this.platform !== 'win32') {
      const failure = await shell.openPath(file);
      this.set({ progress: null });
      if (failure) throw Error(failure);
      return;
    }
    // Save sign-in sessions first: quitting for the installer skips the usual exit steps.
    await this.ctx.accounts?.captureSessions().catch(e => this.ctx.log?.warn('vault', e.message));
    require('node:child_process').spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
    this.ctx.prepareQuit?.();
    app.quit();
  }
  async install() {
    const u = this.load();
    if (!u || this.state.status !== 'ready') throw Error('Обновление ещё не загружено');
    // Save sign-in sessions first: quitting for the update skips the usual exit steps.
    await this.ctx.accounts?.captureSessions().catch(e => this.ctx.log?.warn('vault', e.message));
    this.ctx.prepareQuit();
    u.quitAndInstall(false, true);
  }
}

module.exports = { Updater, releaseHeadlines };
