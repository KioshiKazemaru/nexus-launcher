// Failure paths: broken writes, malformed settings, cache limits, cleanup.
// Run via `npm test` (Electron stub preloaded).
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const electron = require('electron');
const { Storage, JsonFile } = require('../src/main/storage.cjs');

const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const fakeSafe = () => ({
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from('enc:' + s),
  decryptString: b => b.toString().slice(4),
});

test('a failed settings write does not block the following writes', async () => {
  const dir = tempDir('nexus-write-');
  try {
    const f = new JsonFile(path.join(dir, 'settings.json'), 10);
    // The target is a directory: rename fails (like EPERM while an antivirus holds the file).
    fs.mkdirSync(f.filename);
    f.data = { a: 1 };
    await assert.rejects(() => f.flush());
    fs.rmSync(f.filename, { recursive: true });
    f.data = { a: 2 };
    await f.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(f.filename, 'utf8')), { a: 2 });
    // A synchronous write on quit uses its own temp file and wins over nothing pending.
    f.data = { a: 3 };
    f.flushSync();
    assert.deepEqual(JSON.parse(fs.readFileSync(f.filename, 'utf8')), { a: 3 });
    assert.equal(fs.existsSync(f.filename + '.sync.tmp'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings of the wrong type are reset to defaults instead of breaking the app', () => {
  const dir = tempDir('nexus-types-');
  try {
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ favorites: 'oops', preferred: [], custom: null, wishlist: ['x'], autoUpdate: 'yes' })
    );
    const settings = new Storage(dir, fakeSafe()).loadSettings();
    assert.deepEqual(settings.favorites, []);
    assert.deepEqual(settings.preferred, {});
    assert.deepEqual(settings.custom, []);
    assert.equal(settings.autoUpdate, true);
    assert.deepEqual(settings.wishlist, ['x'], 'valid values are kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function integrations(loaded, saveVault = () => {}) {
  const { IntegrationsService } = require('../src/main/integrations.cjs');
  const out = { saved: null };
  const ctx = {
    vault: {},
    storage: {
      loadIntegrations: () => loaded,
      saveIntegrations: c => (out.saved = c),
      encryptionAvailable: () => true,
      saveVault,
    },
    library: { games: [] },
  };
  out.service = new IntegrationsService(ctx);
  out.ctx = ctx;
  return out;
}

test('integration cache evicts the oldest entries, not the smallest Steam app ids', () => {
  const itadSteam = {};
  for (let i = 0; i < 5000; i++) itadSteam[String(100000 + i)] = 'id' + i;
  const x = integrations({ itadSteam });
  // Newly learned apps with small numeric ids: JavaScript lists them first.
  x.service.cache.itadSteam['10'] = 'new-a';
  x.service.cache.itadSteam['20'] = 'new-b';
  x.service.save();
  const keys = Object.keys(x.saved.itadSteam);
  assert.equal(keys.length, 5000);
  assert.equal(x.saved.itadSteam['10'], 'new-a');
  assert.equal(x.saved.itadSteam['20'], 'new-b');
  assert.equal(x.saved.itadSteam['100000'], undefined, 'the oldest loaded entry is evicted');
  assert.equal(x.saved.itadSteam['100001'], undefined);
  assert.equal(x.saved.itadSteam['100002'], 'id2');
});

test('an API key that could not be saved is not kept in memory', () => {
  const x = integrations({}, () => {
    throw Error('Защищённое хранилище Windows недоступно');
  });
  x.ctx.vault.keys = { itad: 'a'.repeat(20) };
  assert.throws(() => x.service.setKey('sgdb', 'b'.repeat(32)), /недоступно/);
  assert.deepEqual(x.ctx.vault.keys, { itad: 'a'.repeat(20) });
  assert.equal(x.service.has('sgdb'), false);
});

test('old covers are removed from the disk cache; fresh ones and other files stay', async () => {
  const { ArtworkCache } = require('../src/artwork.cjs');
  const dir = tempDir('nexus-prune-');
  try {
    const name = c => c.repeat(64) + '.img';
    for (const n of [name('a'), name('b'), 'notes.txt']) fs.writeFileSync(path.join(dir, n), 'x');
    const old = new Date(Date.now() - 40 * 86400000);
    fs.utimesSync(path.join(dir, name('a')), old, old);
    fs.utimesSync(path.join(dir, 'notes.txt'), old, old);
    const removed = await new ArtworkCache(dir, async () => null).prune();
    assert.equal(removed, 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), [name('b'), 'notes.txt'].sort());
    assert.equal(await new ArtworkCache(path.join(dir, 'missing'), null).prune(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a shown notification is kept referenced until it is clicked or closed', () => {
  const { StoreService } = require('../src/main/store.cjs');
  const N = electron.Notification;
  const saved = { isSupported: N.isSupported, on: N.prototype.on, show: N.prototype.show };
  const shown = [];
  N.isSupported = () => true;
  N.prototype.on = function (event, fn) {
    (this.handlers ||= {})[event] = fn;
  };
  N.prototype.show = function () {
    shown.push(this);
  };
  try {
    let focused = 0;
    const store = Object.create(StoreService.prototype);
    store.ctx = { focusMain: () => focused++ };
    store.notifications = new Set();
    store.notify('a', 'b');
    store.notify('c', 'd');
    assert.equal(store.notifications.size, 2);
    shown[0].handlers.click();
    assert.equal(focused, 1);
    shown[1].handlers.close();
    assert.equal(store.notifications.size, 0);
  } finally {
    N.isSupported = saved.isSupported;
    N.prototype.on = saved.on;
    N.prototype.show = saved.show;
  }
});

test('an app installed while Nexus runs is classified (tools leave the library)', async () => {
  const { LibraryService } = require('../src/main/library.cjs');
  const lib = Object.create(LibraryService.prototype);
  const tool = { provider: 'steam', appId: '999', name: 'Some Tool', installed: true };
  const local = { offers: [tool], errors: [], steamRoots: ['C:/Steam'], steamAll: ['999'] };
  Object.assign(lib, {
    ctx: { log: { warn() {}, debug() {} }, hub: { publish() {} } },
    local: { offers: [], errors: [], steamRoots: ['C:/Steam'] },
    localSignature: '',
    progress: {},
    steamTypes: new Map(),
    readLocal: async () => local,
    readSteamLocalMeta: async () => {},
    rebuild() {},
    watchProgress() {},
  });
  lib.localSignature = LibraryService.signature(lib.local);
  lib.classifyLocalSteam = async l => {
    lib.steamTypes.set('999', 6); // the store says: application, not a game
    return l.offers.some(o => !lib.isGameOffer(o));
  };
  await lib.pollProgress();
  await lib.classifying;
  assert.deepEqual(lib.local.offers, []);
});

test('programs from a backup are added only after the user agrees', async () => {
  const { ActionsService } = require('../src/main/actions.cjs');
  const original = electron.dialog.showMessageBox;
  const asked = [];
  try {
    const settings = { custom: [] };
    const actions = new ActionsService({ settings });
    const list = [{ id: '1', name: 'Game', exe: 'C:/Games/game.exe' }];
    electron.dialog.showMessageBox = async (_w, options) => {
      asked.push(options.detail);
      return { response: 1 }; // "Пропустить"
    };
    assert.equal(await actions.restoreCustomGames(null, list), 0);
    assert.deepEqual(settings.custom, []);
    assert.match(asked[0], /C:\/Games\/game\.exe/, 'the path is shown before adding');
    electron.dialog.showMessageBox = async () => ({ response: 0 });
    assert.equal(await actions.restoreCustomGames(null, list), 1);
    assert.deepEqual(settings.custom, list);
    assert.equal(await actions.restoreCustomGames(null, []), 0);
  } finally {
    electron.dialog.showMessageBox = original;
  }
});
