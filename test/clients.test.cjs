// Missing official clients (Epic Games Launcher, Steam): detection, the offer
// to install, safe download and signature check. Run via `npm test`.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const electron = require('electron');
const { ClientInstaller, CLIENTS, commandExecutable, regDefault } = require('../src/main/clients.cjs');

const T = electron.__test;
function installer(extra = {}) {
  const toasts = [];
  const ctx = { log: { info() {}, warn() {} }, toast: m => toasts.push(m), hub: { publish() {} }, ...extra };
  return { c: new ClientInstaller(ctx), toasts };
}

test('the link handler command points to the client program (stale links are detected by the missing file)', () => {
  assert.equal(
    commandExecutable('"D:\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe" %1'),
    'D:\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe'
  );
  assert.equal(commandExecutable('C:\\Steam\\steam.exe -- "%1"'), 'C:\\Steam\\steam.exe');
  assert.equal(commandExecutable(''), '');
  // `reg query` output of a Russian Windows (the value name is localised).
  const out =
    '\r\nHKEY_CLASSES_ROOT\\com.epicgames.launcher\\shell\\open\\command\r\n    (По умолчанию)    REG_SZ    "D:\\Epic\\EpicGamesLauncher.exe" %1\r\n';
  assert.equal(regDefault(out), '"D:\\Epic\\EpicGamesLauncher.exe" %1');
});

test('an installed client just opens the link; a missing one is offered, never installed without asking', async () => {
  const original = electron.dialog.showMessageBox;
  const asked = [];
  try {
    const { c } = installer();
    c.installed = async () => true;
    const before = T.opened.length;
    assert.equal(
      await c.open('epic', 'com.epicgames.launcher://apps/x?action=install', 'установить игру'),
      'opened'
    );
    assert.equal(T.opened.at(-1), 'com.epicgames.launcher://apps/x?action=install');

    c.installed = async () => false;
    let installs = 0;
    c.installAndContinue = async () => installs++;
    electron.dialog.showMessageBox = async (_w, o) => {
      asked.push(o);
      return { response: 2 }; // Отмена
    };
    assert.equal(await c.open('epic', 'com.epicgames.launcher://x', 'установить игру'), 'canceled');
    assert.equal(installs, 0);
    assert.match(asked[0].message, /Чтобы установить игру, нужен Epic Games Launcher/);
    assert.match(asked[0].detail, /проверит его цифровую подпись/);
    assert.equal(T.opened.length, before + 1, 'the game link was not opened');

    electron.dialog.showMessageBox = async () => ({ response: 1 }); // Открыть сайт
    assert.equal(await c.open('steam', 'steam://install/1', 'установить игру'), 'canceled');
    assert.equal(T.opened.at(-1), CLIENTS.steam.site);

    electron.dialog.showMessageBox = async () => ({ response: 0 }); // Скачать и установить
    T.dialogs.open = null; // the folder dialog is closed: nothing is installed
    assert.equal(await c.open('epic', 'com.epicgames.launcher://x', 'установить игру'), 'canceled');
    assert.equal(installs, 0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-epic-dir-'));
    T.dialogs.open = dir;
    let chosen;
    c.installAndContinue = async (_p, _u, d) => {
      installs++;
      chosen = d;
    };
    assert.equal(await c.open('epic', 'com.epicgames.launcher://x', 'установить игру'), 'install-started');
    await c.busy.get('epic');
    assert.equal(installs, 1);
    assert.equal(chosen, path.resolve(dir), 'the chosen folder goes to the installer');
    T.dialogs.open = null;
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    electron.dialog.showMessageBox = original;
  }
});

test('a second click during the installation does not start another one', async () => {
  const { c, toasts } = installer();
  c.installed = async () => false;
  c.busy.set('epic', new Promise(() => {}));
  assert.equal(await c.open('epic', 'com.epicgames.launcher://x', 'запустить игру'), 'install-started');
  assert.match(toasts[0], /уже устанавливается/);
});

test('installers are taken only from the store servers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-client-'));
  try {
    const foreign = installer({
      publicFetch: async () => ({
        ok: true,
        url: 'https://evil.example/EpicInstaller.msi',
        headers: { get: () => null },
      }),
    });
    await assert.rejects(
      () => foreign.c.download(CLIENTS.epic, path.join(dir, 'a.msi')),
      /постороннего адреса/
    );
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    const good = installer({
      publicFetch: async () => ({
        ok: true,
        url: 'https://epicgames-download1.akamaized.net/Builds/x.msi',
        headers: { get: h => (/length/i.test(h) ? String(bytes.length) : null) },
        body: new Response(bytes).body,
      }),
    });
    const file = path.join(dir, 'b.msi');
    await good.c.download(CLIENTS.epic, file);
    assert.ok(fs.readFileSync(file).equals(bytes));
    assert.ok(!fs.existsSync(file + '.part'));
    const cut = installer({
      publicFetch: async () => ({
        ok: true,
        url: CLIENTS.epic.url,
        headers: { get: h => (/length/i.test(h) ? String(bytes.length * 2) : null) },
        body: new Response(bytes).body,
      }),
    });
    await assert.rejects(() => cut.c.download(CLIENTS.epic, path.join(dir, 'c.msi')), /прервалась/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'an installer without a valid store signature is refused',
  { skip: process.platform !== 'win32' && 'Windows signature check' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sign-'));
    try {
      const file = path.join(dir, 'EpicInstaller.msi');
      fs.writeFileSync(file, Buffer.alloc(4096, 1));
      const { c } = installer();
      await assert.rejects(() => c.checkSignature(CLIENTS.epic, file), /нет действительной подписи/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test('the chosen folder is passed to the official installers', () => {
  assert.equal(
    CLIENTS.epic.install(String.raw`C:\Temp\Epic.msi`, String.raw`D:\Epic Games`).args,
    String.raw`/i "C:\Temp\Epic.msi" INSTALLDIR="D:\Epic Games" /passive /norestart`
  );
  // NSIS: /D= last and unquoted, even with spaces.
  assert.equal(
    CLIENTS.steam.install(String.raw`C:\Temp\SteamSetup.exe`, String.raw`D:\My Games\Steam`).args,
    String.raw`/S /D=D:\My Games\Steam`
  );
  // The previous place of a client, also of a deleted one, is suggested.
  assert.equal(
    CLIENTS.epic.rootOf(String.raw`D:\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe`),
    String.raw`D:\Epic Games`
  );
  assert.equal(CLIENTS.epic.rootOf(''), '');
  assert.equal(CLIENTS.steam.rootOf(String.raw`D:\Steam\steam.exe`), String.raw`D:\Steam`);
});

test('folders that cannot be used are explained', async () => {
  const { c } = installer();
  assert.match(await c.folderProblem(CLIENTS.epic, String.raw`D:\"bad"`), /кавычек/);
  assert.match(await c.folderProblem(CLIENTS.epic, String.raw`\\server\share`), /Сетевые папки/);
  assert.match(await c.folderProblem({ ...CLIENTS.epic, needBytes: 1e18 }, os.tmpdir()), /свободно .* ГБ/);
  assert.equal(await c.folderProblem({ ...CLIENTS.epic, needBytes: 1 }, os.tmpdir()), '');
});

test('the remembered folder (or the old place of the client) is suggested in the folder dialog', async () => {
  const original = electron.dialog.showOpenDialog;
  try {
    const dir = os.tmpdir();
    const { c } = installer({
      settings: { clientInstallDirs: { steam: dir } },
      storage: { saveSettings() {} },
    });
    c.handlerExe = async () => '';
    let asked;
    electron.dialog.showOpenDialog = async (_w, o) => {
      asked = o;
      return { canceled: false, filePaths: [dir] };
    };
    c.folderProblem = async () => '';
    assert.equal(await c.chooseFolder('steam'), path.resolve(dir));
    assert.equal(asked.defaultPath, dir);
    assert.match(asked.title, /Куда установить Steam/);
    const fresh = installer({ settings: {}, storage: { saveSettings() {} } });
    fresh.c.handlerExe = async () => String.raw`Q:\gone-drive-xyz\Launcher\x.exe`;
    fresh.c.folderProblem = async () => '';
    await fresh.c.chooseFolder('epic');
    assert.equal(asked.defaultPath, CLIENTS.epic.defaultDir(), 'a missing drive is not suggested');
  } finally {
    electron.dialog.showOpenDialog = original;
  }
});
