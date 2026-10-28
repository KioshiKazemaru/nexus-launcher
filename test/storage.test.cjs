const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Storage } = require('../src/main/storage.cjs');
const { StateHub, LruMap } = require('../src/main/hub.cjs');
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: s => Buffer.from('enc:' + s),
  decryptString: b => b.toString().slice(4),
});

test('settings migrate from v1, writes are debounced and atomic, vault is encrypted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-storage-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ version: 1, wishlist: ['x'], remember: { steam: true, epic: false } })
    );
    const s = new Storage(dir, fakeSafe());
    const settings = s.loadSettings();
    assert.equal(settings.version, 2);
    assert.deepEqual(settings.wishlist, ['x']);
    assert.deepEqual(settings.steamSlots, [0]);
    assert.deepEqual(settings.links, []);
    settings.wishlist.push('y');
    s.saveSettings();
    s.saveSettings();
    await s.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).wishlist, [
      'x',
      'y',
    ]);
    assert.equal(fs.existsSync(path.join(dir, 'settings.json.tmp')), false);
    s.saveVault({ keys: { itad: 'secret' } });
    assert.match(fs.readFileSync(path.join(dir, 'sessions.bin'), 'utf8'), /^enc:/);
    assert.deepEqual(s.loadVault(), { keys: { itad: 'secret' } });
    s.saveVault({ keys: {} });
    assert.equal(fs.existsSync(path.join(dir, 'sessions.bin')), false);
    const plain = new Storage(dir, fakeSafe(false));
    assert.throws(() => plain.saveVault({ keys: { itad: 'x' } }), /недоступно/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state hub coalesces bursts into one message; LRU evicts oldest', async () => {
  const sent = [];
  let n = 0;
  const hub = new StateHub(
    () => ++n,
    v => sent.push(v),
    20
  );
  for (let k = 0; k < 50; k++) hub.publish();
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(sent, [1]);
  const lru = new LruMap(2);
  lru.set('a', 1).set('b', 2).set('a', 3).set('c', 4);
  assert.deepEqual([...lru.keys()], ['a', 'c']);
});
