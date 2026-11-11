'use strict';
// Automatic updates through electron-updater (GitHub Releases). Only active in a
// packaged, installed build. electron-updater verifies the downloaded installer
// against the release's SHA-512.
//   Linux:   the AppImage or the .deb package, whichever is installed (latest-linux.yml);
//            the .deb asks for the administrator password when it installs.
//   Windows: the installed version accepts only an installer signed by the publisher
//            "Nexus", and the builds are not code-signed. Nexus finds the new version
//            (latest.yml) and offers its release page; the user installs it by hand.
//   macOS:   the same: macOS installs only updates signed by an Apple developer
//            (latest-mac.yml).

const RELEASES = 'https://github.com/KioshiKazemaru/nexus-launcher/releases';

class Updater {
  constructor(ctx, platform = process.platform) {
    this.ctx = ctx;
    this.manual = platform === 'darwin' || platform === 'win32';
    this.state = { status: 'idle', version: null, error: '', manual: this.manual };
    this.updater = null;
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
      autoUpdater.on('update-available', info => this.found(info?.version));
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
  found(version) {
    const v = /^\d+\.\d+\.\d+$/.test(String(version)) ? String(version) : null;
    this.set({ status: this.manual ? 'manual' : 'downloading', version: v });
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
  // The release page of the new version (macOS: the update is installed by hand).
  releaseUrl() {
    const v = this.state.version;
    return v ? `${RELEASES}/tag/v${v}` : `${RELEASES}/latest`;
  }
  openRelease() {
    return require('electron').shell.openExternal(this.releaseUrl());
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

module.exports = { Updater };
