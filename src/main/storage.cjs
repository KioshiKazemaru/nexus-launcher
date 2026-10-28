'use strict';
// Persistent files in %APPDATA%\Nexus Launcher:
//   settings.json        — preferences, lists, price watches (plain JSON)
//   sessions.bin         — DPAPI-encrypted vault: cookies, Epic refresh tokens, API keys
//   owned-library.json   — last account libraries per account
//   integrations.json    — cache of external ids / metadata
// Writes are atomic (temp file + rename), asynchronous and debounced; flushSync()
// is used on quit.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const defaults = () => ({
  version: 2,
  remember: { steam: false, epic: false },
  steamSlots: [0],
  preferred: {},
  favorites: [],
  wishlist: [],
  recent: [],
  custom: [],
  steamRoot: '',
  autoStart: false,
  storeCountry: 'US',
  savedGames: {},
  priceWatches: [],
  libraryView: 'installed',
  links: [],
  splits: [],
  seenGiveaways: [],
  notifyGiveaways: true,
  autoUpdate: true,
  hidden: [],
  collections: [],
  customPlaytime: {},
  epicPartitions: {},
  purchaseAccount: {},
  knownAccounts: {},
  diagnostics: true,
  // Starting games: Epic without the Epic launcher (with cloud saves), Steam hidden in the tray.
  epicDirectLaunch: true,
  // Downloads of Epic games by Nexus itself (main/epic-install.cjs).
  nexusDownloads: true,
  epicJobs: {},
  epicInstallRoot: '',
  epicCloudSaves: true,
  steamSilent: true,
  steamCloseAfter: true,
  epicSaveSync: {},
  nexusPlaytime: {},
  clientInstallDirs: {}, // where the user installed Epic Games Launcher / Steam last time
});

class JsonFile {
  constructor(filename, delay = 400) {
    this.filename = filename;
    this.delay = delay;
    this.timer = null;
    this.data = null;
    this.writing = Promise.resolve();
  }
  readSync(fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.filename, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') this.corrupt = true;
      return fallback;
    }
  }
  schedule(data) {
    this.data = data;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(() => {}), this.delay);
  }
  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.data === null) return;
    const text = typeof this.data === 'function' ? this.data() : JSON.stringify(this.data, null, 2);
    this.data = null;
    const tmp = this.filename + '.tmp';
    // A failed write (e.g. EPERM while an antivirus holds the file) must not
    // block every later write: the chain continues after a rejection.
    const write = this.writing
      .catch(() => {})
      .then(async () => {
        await fsp.writeFile(tmp, text, { mode: 0o600 });
        await fsp.rename(tmp, this.filename);
      });
    this.writing = write.catch(() => {});
    return write;
  }
  flushSync() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.data === null) return;
    const text = typeof this.data === 'function' ? this.data() : JSON.stringify(this.data, null, 2);
    this.data = null;
    // Own temp file: an asynchronous write may still be using ".tmp".
    const tmp = this.filename + '.sync.tmp';
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, this.filename);
  }
}

class Storage {
  constructor(dir, safeStorage) {
    this.dir = dir;
    this.safeStorage = safeStorage;
    fs.mkdirSync(dir, { recursive: true });
    this.settingsFile = new JsonFile(path.join(dir, 'settings.json'));
    this.ownedFile = new JsonFile(path.join(dir, 'owned-library.json'), 1000);
    this.integrationsFile = new JsonFile(path.join(dir, 'integrations.json'), 2000);
    this.vaultFile = path.join(dir, 'sessions.bin');
    this.warning = '';
  }
  file(name) {
    return path.join(this.dir, name);
  }
  loadSettings() {
    const settings = defaults();
    const saved = this.settingsFile.readSync(null);
    if (this.settingsFile.corrupt) this.warning = 'Настройки повреждены; загружены значения по умолчанию.';
    if (saved && typeof saved === 'object') Object.assign(settings, saved);
    // Migrate v1 → v2 and repair partially written or hand-edited files: a
    // value of the wrong type (a list that is not an array, …) is reset.
    const kind = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    for (const [k, v] of Object.entries(defaults())) if (kind(settings[k]) !== kind(v)) settings[k] = v;
    if (!Array.isArray(settings.steamSlots) || !settings.steamSlots.includes(0)) settings.steamSlots = [0];
    settings.version = 2;
    this.settings = settings;
    return settings;
  }
  saveSettings() {
    this.settingsFile.schedule(() => JSON.stringify(this.settings, null, 2));
  }
  loadOwned() {
    return this.ownedFile.readSync({}) || {};
  }
  saveOwned(cache) {
    this.ownedFile.schedule(() => JSON.stringify(cache));
  }
  loadIntegrations() {
    return this.integrationsFile.readSync({}) || {};
  }
  saveIntegrations(cache) {
    this.integrationsFile.schedule(() => JSON.stringify(cache));
  }
  encryptionAvailable() {
    try {
      return this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }
  loadVault() {
    try {
      if (!fs.existsSync(this.vaultFile)) return {};
      if (!this.encryptionAvailable()) throw Error('no encryption');
      return JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.vaultFile)));
    } catch {
      this.warning = 'Сохранённый вход не удалось восстановить. Войдите снова.';
      return {};
    }
  }
  // Vault writes are rare and must not be lost: synchronous and atomic.
  saveVault(vault) {
    const empty = !Object.values(vault).some(v => v && (typeof v !== 'object' || Object.keys(v).length));
    if (empty) {
      fs.rmSync(this.vaultFile, { force: true });
      return;
    }
    if (!this.encryptionAvailable())
      throw Error('Защищённое хранилище Windows недоступно. Сохранение входа и ключей отключено.');
    const tmp = this.vaultFile + '.tmp';
    fs.writeFileSync(tmp, this.safeStorage.encryptString(JSON.stringify(vault)), { mode: 0o600 });
    fs.renameSync(tmp, this.vaultFile);
  }
  async flush() {
    await Promise.all([this.settingsFile.flush(), this.ownedFile.flush(), this.integrationsFile.flush()]);
  }
  flushSync() {
    for (const f of [this.settingsFile, this.ownedFile, this.integrationsFile]) {
      try {
        f.flushSync();
      } catch {}
    }
  }
}

module.exports = { Storage, JsonFile, defaults };
