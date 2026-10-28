'use strict';
// Automatic updates through electron-updater (GitHub Releases, NSIS build).
// Only active in a packaged, installed build. electron-updater verifies the
// downloaded installer against the release's SHA-512 and, on Windows, the
// publisher signature of the currently installed version.

class Updater {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = { status: 'idle', version: null, error: '' };
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
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: '' }));
      autoUpdater.on('update-available', info =>
        this.set({ status: 'downloading', version: info?.version || null })
      );
      autoUpdater.on('update-not-available', () => this.set({ status: 'current' }));
      autoUpdater.on('download-progress', p =>
        this.set({ status: 'downloading', percent: Math.round(p?.percent || 0) })
      );
      autoUpdater.on('update-downloaded', info =>
        this.set({ status: 'ready', version: info?.version || null })
      );
      // A local build has no update source (app-update.yml): not an error.
      autoUpdater.on('error', e => {
        const message = String(e?.message || e);
        this.ctx.log?.warn('update', message);
        if (/app-update\.yml/.test(message)) this.set({ status: 'unsupported', error: '' });
        else this.set({ status: 'error', error: message.slice(0, 200) });
      });
      this.updater = autoUpdater;
    } catch {
      this.updater = false;
    }
    return this.updater;
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
