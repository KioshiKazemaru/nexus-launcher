'use strict';
// Fixes after the November 2026 review: Linux secrets, the Steam community page,
// download actions, the cache, log noise, dependency versions.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Storage, noVault } = require('../src/main/storage.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-audit-'));
const safe = backend => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => backend,
  encryptString: s => Buffer.from(s),
  decryptString: b => b.toString(),
});

test('Linux without a keyring (basic_text): nothing secret is saved, the message names the keyring', () => {
  const linux = new Storage(tmp(), safe('basic_text'), 'linux');
  assert.equal(linux.encryptionAvailable(), false);
  assert.throws(() => linux.saveVault({ steam: { a: 1 } }), /GNOME Keyring или KWallet/);
  assert.equal(new Storage(tmp(), safe('gnome_libsecret'), 'linux').encryptionAvailable(), true);
  // Windows and macOS do not report a backend: unchanged.
  assert.equal(new Storage(tmp(), safe(undefined), 'win32').encryptionAvailable(), true);
  assert.match(noVault('win32'), /Windows/);
  assert.match(noVault('darwin'), /Связка ключей/);
  assert.doesNotMatch(noVault('linux'), /Windows/);
  // A vault saved earlier with the built-in key is not read back as protected.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'sessions.bin'), '{"steam":{}}');
  const again = new Storage(dir, safe('basic_text'), 'linux');
  again.vaultFile = path.join(dir, 'sessions.bin');
  assert.deepEqual(again.loadVault(), {});
  assert.match(again.warning, /GNOME Keyring/);
});

test('Steam community games page: at most once a day per account', () => {
  const { LibraryService } = require('../src/main/library.cjs');
  const lib = Object.create(LibraryService.prototype);
  const now = 1_000_000_000_000;
  assert.equal(lib.steamEnrichDue('1', now), true);
  assert.equal(lib.steamEnrichDue('1', now + 3600e3), false);
  assert.equal(lib.steamEnrichDue('2', now + 3600e3), true, 'another account');
  assert.equal(lib.steamEnrichDue('1', now + 25 * 3600e3), true);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'library.cjs'), 'utf8');
  assert.doesNotMatch(src, /\|\| !o\.playtime\)\)/, 'never played games do not start it');
});

test('download actions: a known action that returns nothing is not "unknown"', async () => {
  const { registerGamesIpc } = require('../src/main/ipc/games.cjs');
  const handlers = {};
  const ctx = {
    epicInstall: { pause: () => undefined, first: () => null },
    hub: { reply: () => ({}) },
    settings: {},
    storage: { saveSettings() {} },
  };
  try {
    registerGamesIpc((name, fn) => (handlers[name] = fn), ctx);
  } catch {
    // other handlers may need more of ctx; downloadControl is registered first
  }
  assert.ok(handlers.downloadControl);
  assert.deepEqual(await handlers.downloadControl({ id: 'epic:x', action: 'first' }), {
    result: null,
    state: {},
  });
  assert.deepEqual(await handlers.downloadControl({ id: 'epic:x', action: 'pause' }), {
    result: undefined,
    state: {},
  });
  await assert.rejects(handlers.downloadControl({ id: 'epic:x', action: 'format' }), /Неизвестное действие/);
});

test('cache limit, «Очистить кэш», no log entry for an interrupted community page', () => {
  const root = path.join(__dirname, '..');
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(read('src/main.cjs'), /appendSwitch\('disk-cache-size'/);
  assert.match(read('src/main/ipc/app.cjs'), /register\('clearCache'/);
  assert.ok(read('src/preload.cjs').includes("'clearCache'"));
  assert.ok(read('ui/app-library.js').includes('id="clear-cache"'));
  assert.ok(read('ui/app-events.js').includes("CLICK_BY_ID['clear-cache']"));
  assert.match(read('ui/app-boot.js'), /ERR_ABORTED \\\(-3\\\)/);
});

test('dependencies: patched protobufjs and adm-zip under steam-user', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.overrides['steam-appticket'], '^2.0.1');
  assert.equal(pkg.overrides['adm-zip'], '^0.6.1');
  const ver = name =>
    JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'node_modules', ...name.split('/'), 'package.json'), 'utf8')
    ).version;
  assert.ok(Number(ver('adm-zip').split('.')[1]) >= 6);
  assert.equal(ver('steam-appticket').split('.')[0], '2');
});
