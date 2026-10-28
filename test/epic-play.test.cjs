// Epic games without the Epic launcher: cloud save synchronisation against a
// fake Epic save storage, backups, conflicts and fallbacks. Run via `npm test`.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const electron = require('electron');
const { EpicPlayService, FallbackToLauncher } = require('../src/main/epic-play.cjs');
const saves = require('../src/epic-saves.cjs');

const ACCOUNT = 'a'.repeat(32);
const FIXTURE = path.join(__dirname, 'fixtures', 'legendary-save');

// In-memory Epic save storage: list, upload links and pre-signed GET/PUT.
function fakeEpic({ cloudFolder = '{InstallDir}/Saved', thirdParty = '' } = {}) {
  const store = new Map(); // full path → Buffer
  const puts = [];
  const prefix = `x/${ACCOUNT}/Game`;
  const response = (status, body, type = 'application/json') => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    },
    headers: { get: () => type },
  });
  const fetcher = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname.startsWith('catalog-public-service'))
      return response(200, {
        it: {
          customAttributes: {
            CloudSaveFolder: { value: cloudFolder },
            ...(thirdParty ? { ThirdPartyManagedApp: { value: thirdParty } } : {}),
          },
        },
      });
    if (u.hostname.startsWith('datastorage')) {
      if ((options.method || 'GET') === 'GET') {
        const files = {};
        for (const p of store.keys()) files[p] = { readLink: `https://storage.test/${p}`, lastModified: '' };
        return response(200, { files });
      }
      const { files } = JSON.parse(options.body);
      return response(200, {
        files: Object.fromEntries(files.map(f => [f, { writeLink: `https://storage.test/${prefix}/${f}` }])),
      });
    }
    if (u.hostname === 'storage.test') {
      const p = decodeURIComponent(u.pathname.slice(1));
      if (options.method === 'PUT') {
        store.set(p, Buffer.from(options.body));
        puts.push(p);
        return response(200, {});
      }
      return store.has(p) ? response(200, store.get(p), 'application/octet-stream') : response(404, {});
    }
    return response(404, {});
  };
  // Put the save packed by Legendary into the cloud.
  const addLegendarySave = () => {
    const walk = d =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(FIXTURE))
      store.set(`${prefix}/${path.relative(FIXTURE, f).replace(/\\/g, '/')}`, fs.readFileSync(f));
  };
  return { store, puts, fetcher, addLegendarySave, prefix };
}

function setup(epic) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-epic-'));
  const install = path.join(dir, 'Game');
  fs.mkdirSync(path.join(install, 'Saved'), { recursive: true });
  fs.writeFileSync(path.join(install, 'Game.exe'), 'MZ');
  const settings = {};
  const toasts = [];
  const ctx = {
    settings,
    storage: { saveSettings() {} },
    log: { info() {}, warn() {}, debug() {} },
    toast: m => toasts.push(m),
    online: () => true,
    publicFetch: epic.fetcher,
    accounts: {
      connected: () => [{ key: 'epic:' + ACCOUNT, id: ACCOUNT, name: 'Игрок' }],
      tokens: { accessToken: async () => 'token', accounts: new Map([[ACCOUNT, { displayName: 'Игрок' }]]) },
    },
    library: { scanLocal: async () => {} },
  };
  const offer = {
    provider: 'epic',
    appId: 'Game',
    name: 'Game',
    namespace: 'ns',
    itemId: 'it',
    installed: true,
    installLocation: install,
    executable: 'Game.exe',
    accountIds: [ACCOUNT],
  };
  const service = new EpicPlayService(ctx);
  const sync = () => ({
    account: { id: ACCOUNT },
    offer,
    info: { cloudFolder: '{InstallDir}/Saved' },
    folder: path.join(install, 'Saved'),
  });
  return {
    dir,
    install,
    settings,
    toasts,
    offer,
    service,
    sync,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('an older local save is replaced by the newer cloud save (Legendary format); the old one is backed up', async () => {
  const epic = fakeEpic();
  epic.addLegendarySave();
  const t = setup(epic);
  try {
    const old = path.join(t.install, 'Saved', 'Slot 1', 'progress.ini');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, 'level=1\n');
    const past = new Date(Date.UTC(2025, 0, 1));
    fs.utimesSync(old, past, past);
    assert.equal(await t.service.syncBefore('token', t.sync()), true);
    assert.equal(fs.readFileSync(old, 'utf8'), 'level=7\nname=Игрок\n');
    assert.deepEqual([...fs.readFileSync(path.join(t.install, 'Saved', 'meta.bin'))], [1, 2, 3, 0, 255]);
    // The replaced local file was copied first.
    const backups = path.join(electron.app.getPath('userData'), 'save-backups', 'Game');
    const [backup] = fs.readdirSync(backups);
    assert.equal(fs.readFileSync(path.join(backups, backup, 'Slot 1', 'progress.ini'), 'utf8'), 'level=1\n');
    assert.equal(t.settings.epicSaveSync.Game.manifest, '2026.10.15-20.01.02.manifest');
    assert.equal(epic.puts.length, 0, 'nothing was uploaded');
  } finally {
    t.cleanup();
  }
});

test('after playing, a changed save is uploaded: chunks first, the manifest last', async () => {
  const epic = fakeEpic();
  epic.addLegendarySave();
  const t = setup(epic);
  try {
    await t.service.syncBefore('token', t.sync()); // download, as above
    const file = path.join(t.install, 'Saved', 'Slot 1', 'progress.ini');
    fs.writeFileSync(file, 'level=8\nname=Игрок\n'); // the game saved
    await t.service.syncAfter('token', t.sync());
    assert.ok(epic.puts.length >= 2);
    assert.match(epic.puts.at(-1), /\/manifests\/.+\.manifest$/, 'the manifest is written last');
    // The uploaded save restores the new content (and the Epic launcher can read it: same format).
    const manifestPath = epic.puts.at(-1);
    const m = saves.readManifest(epic.store.get(manifestPath));
    const chunks = new Map(
      m.chunks.map(c => {
        const ch = saves.readChunk(epic.store.get(`${epic.prefix}/${c.path}`));
        return [saves.guidKey(ch.guid), ch.data];
      })
    );
    const files = Object.fromEntries(saves.unpackSave(m, chunks).map(f => [f.path, f.data.toString('utf8')]));
    assert.equal(files['Slot 1/progress.ini'], 'level=8\nname=Игрок\n');
    assert.equal(m.meta.appName, 'Game' + ACCOUNT);
    assert.equal(m.custom.CloudSaveFolder, '{InstallDir}/Saved');
    // Nothing changed since: no second upload.
    const count = epic.puts.length;
    await t.service.syncAfter('token', t.sync());
    assert.equal(epic.puts.length, count);
  } finally {
    t.cleanup();
  }
});

test('changed in the cloud and on this PC: the user decides, and can cancel the start', async () => {
  const epic = fakeEpic();
  epic.addLegendarySave();
  const t = setup(epic);
  const original = electron.dialog.showMessageBox;
  try {
    await t.service.syncBefore('token', t.sync());
    // Played here …
    fs.writeFileSync(path.join(t.install, 'Saved', 'meta.bin'), 'local');
    // … and on another PC (a newer manifest in the cloud).
    const newer = `${epic.prefix}/manifests/2099.01.01-00.00.00.manifest`;
    epic.store.set(newer, epic.store.get(`${epic.prefix}/manifests/2026.10.15-20.01.02.manifest`));
    const asked = [];
    electron.dialog.showMessageBox = async (_w, o) => {
      asked.push(o.message);
      return { response: 2 }; // "Отменить запуск"
    };
    assert.equal(await t.service.syncBefore('token', t.sync()), false);
    assert.match(asked[0], /изменились и в облаке, и на этом ПК/);
    assert.equal(
      fs.readFileSync(path.join(t.install, 'Saved', 'meta.bin'), 'utf8'),
      'local',
      'nothing replaced'
    );
    electron.dialog.showMessageBox = async () => ({ response: 1 }); // keep this PC's save
    assert.equal(await t.service.syncBefore('token', t.sync()), true);
    assert.match(epic.puts.at(-1), /\.manifest$/, 'the local save went to the cloud');
  } finally {
    electron.dialog.showMessageBox = original;
    t.cleanup();
  }
});

test('games of EA / Ubisoft and unsafe executables go to the Epic launcher', async () => {
  const t = setup(fakeEpic({ thirdParty: 'The EA App' }));
  try {
    await assert.rejects(
      () => t.service.play(t.offer, { name: 'Game' }),
      e => e instanceof FallbackToLauncher && /The EA App/.test(e.message)
    );
    assert.throws(
      () => t.service.executablePath({ ...t.offer, executable: '../../Windows/notepad.exe' }),
      FallbackToLauncher
    );
    assert.throws(() => t.service.executablePath({ ...t.offer, executable: 'Missing.exe' }), /не найден/);
    assert.equal(t.service.canStart({ ...t.offer, executable: '' }), false);
    t.settings.epicDirectLaunch = false;
    assert.equal(t.service.canStart(t.offer), false, 'the setting turns direct starts off');
  } finally {
    t.cleanup();
  }
});

test('Nexus keeps its own playtime for Epic games started without the launcher', () => {
  const t = setup(fakeEpic());
  try {
    t.service.addPlaytime(t.offer, 0, 30 * 60000);
    t.service.addPlaytime(t.offer, 0, 15 * 60000);
    assert.equal(t.settings.nexusPlaytime['epic:Game'].minutes, 45);
  } finally {
    t.cleanup();
  }
});

test('"Играть": if Nexus cannot start the game itself, the Epic launcher starts it', async () => {
  const { ActionsService } = require('../src/main/actions.cjs');
  const T = electron.__test;
  const before = T.opened.length;
  const toasts = [];
  const offer = {
    provider: 'epic',
    appId: 'Game',
    namespace: 'ns',
    itemId: 'it',
    installed: true,
    installLocation: 'C:/x',
    executable: 'Game.exe',
  };
  const ctx = {
    settings: { recent: [], preferred: {} },
    storage: { saveSettings() {} },
    log: { info() {}, warn() {} },
    toast: m => toasts.push(m),
    library: { games: [{ id: 'epic:Game', offers: [offer] }], expectChange() {} },
  };
  const actions = new ActionsService(ctx);
  actions.clients.installed = async () => true; // the Epic launcher is there
  actions.epic.play = async () => {
    throw new FallbackToLauncher('Аккаунт Epic не подключён в Nexus');
  };
  const r = await actions.play({ id: 'epic:Game', provider: 'epic' });
  assert.equal(r.how, 'launcher');
  assert.match(T.opened.at(-1), /^com\.epicgames\.launcher:\/\/apps\/ns%3Ait%3AGame\?action=launch/);
  assert.equal(T.opened.length, before + 1);
  assert.match(toasts[0], /через Epic Games Launcher/);
  // A started game reports the direct start.
  actions.epic.play = async () => ({ direct: true });
  assert.equal((await actions.play({ id: 'epic:Game', provider: 'epic' })).how, 'direct');
  assert.equal(T.opened.length, before + 1, 'no launcher this time');
});
