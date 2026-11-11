'use strict';
// Desktop shortcuts of games, the DLC of a Steam game and the «Свойства» window.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Shortcuts, playArg, safeName, desktopEntry } = require('../src/main/shortcuts.cjs');
const steamLib = require('../src/steam-library.cjs');

test('shortcuts: the game id from the command line, a safe file name', () => {
  assert.equal(playArg(['nexus.exe', '--play=steam:570']), 'steam:570');
  assert.equal(playArg(['x', '--play="epic:abc-1"']), 'epic:abc-1');
  assert.equal(playArg(['x', '--play=../../evil']), '');
  assert.equal(playArg(['x', '--play=a b']), '');
  assert.equal(playArg(['x']), '');
  assert.equal(safeName('Half-Life: Alyx?'), 'Half-Life Alyx');
  assert.equal(safeName('a/b\\c<d>|e*'), 'abcde');
  assert.equal(safeName('Game. '), 'Game');
  assert.equal(safeName(''), 'Игра');
  const entry = desktopEntry({ name: 'X\nY', exec: ['/opt/nexus', '--play=steam:1'] });
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.ok(entry.includes('Name=X Y'));
  assert.ok(entry.includes('Exec="/opt/nexus" "--play=steam:1"'));
});

function fixture(platform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-shortcuts-'));
  const links = [];
  const saved = [];
  const ctx = {
    settings: { preferred: {} },
    library: {
      games: [
        { id: 'steam:570', name: 'Dota 2', offers: [{ provider: 'steam', installed: true }] },
        { id: 'epic:x', name: 'Not here', offers: [{ provider: 'epic', installed: false }] },
      ],
    },
    storage: { saveSettings: () => saved.push(1) },
    log: { info() {}, warn() {} },
    actions: { play: async p => ({ played: p }) },
    hub: { publish() {} },
  };
  const shell = {
    writeShortcutLink: (file, op, o) => {
      links.push({ file, op, o });
      fs.writeFileSync(file, 'lnk');
      return true;
    },
  };
  const app = { getPath: () => dir, isPackaged: true, getAppPath: () => '/app' };
  return { s: new Shortcuts(ctx, { shell, app, platform }), ctx, links, dir };
}

test('shortcuts: created, found, removed with the game; the game starts from one', async () => {
  const { s, ctx, links, dir } = fixture('win32');
  s.create('steam:570');
  assert.equal(links.length, 1);
  assert.equal(links[0].file, path.join(dir, 'Dota 2.lnk'));
  assert.equal(links[0].o.args, '--play=steam:570');
  assert.equal(links[0].op, 'create', 'a new shortcut is created, not replaced');
  assert.equal(ctx.settings.shortcuts['steam:570'], 'Dota 2');
  assert.equal(s.exists('steam:570'), true);
  assert.throws(() => s.create('epic:x'), /установите/);
  assert.throws(() => s.create('nope'), /не найдена/);
  assert.deepEqual(await s.launch('steam:570'), { played: { id: 'steam:570', provider: 'steam' } });
  // Uninstalled: the shortcut Nexus made goes away.
  ctx.library.games[0].offers[0].installed = false;
  s.cleanup();
  assert.equal(fs.existsSync(path.join(dir, 'Dota 2.lnk')), false);
  assert.deepEqual(ctx.settings.shortcuts, {});
  // Not installed any more: launching only explains it.
  const toasts = [];
  ctx.toast = m => toasts.push(m);
  assert.equal(await s.launch('steam:570'), null);
  assert.match(toasts[0], /не установлена/);
});

test('shortcuts: Linux writes a .desktop file; macOS is not supported yet', () => {
  const linux = fixture('linux');
  linux.s.create('steam:570');
  const text = fs.readFileSync(path.join(linux.dir, 'Dota 2.desktop'), 'utf8');
  assert.match(text, /--play=steam:570/);
  linux.s.remove('steam:570');
  assert.equal(fs.existsSync(path.join(linux.dir, 'Dota 2.desktop')), false);
  assert.throws(() => fixture('darwin').s.create('steam:570'), /не создаёт ярлыки/);
});

test('DLC: names, prices, discounts and free ones from GetItems', () => {
  const items = steamLib.parseDlcItems({
    response: {
      store_items: [
        {
          appid: 10,
          name: 'Season Pass',
          visible: true,
          best_purchase_option: {
            discount_pct: 50,
            formatted_final_price: '500 ₸',
            formatted_original_price: '1000 ₸',
          },
        },
        { appid: 11, name: 'Soundtrack', is_free: true },
        { appid: 12, name: 'Hidden', visible: false },
        { appid: 'x', name: 'Bad' },
        { appid: 13, name: 'Soon', release: { is_coming_soon: true } },
      ],
    },
  });
  assert.deepEqual(
    items.map(x => [x.appId, x.name, x.price, x.originalPrice, x.discount, x.free, x.comingSoon]),
    [
      ['10', 'Season Pass', '500 ₸', '1000 ₸', 50, false, false],
      ['11', 'Soundtrack', '', '', 0, true, false],
      ['13', 'Soon', '', '', 0, false, true],
    ]
  );
  assert.throws(() => steamLib.parseDlcItems({}), /дополнения/);
});

test('«Свойства»: tabs, the reused boxes, menu items for it and the shortcut', () => {
  const ui = f => fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8');
  const props = ui('app-props.js');
  for (const t of ['Общие', 'Установленные файлы', 'Дополнения']) assert.ok(props.includes(`'${t}'`), t);
  for (const box of ['launchOptionsBox(g)', 'collectionsBox(g)', 'gameDlcSection(g)'])
    assert.ok(props.includes(box), box);
  const menu = ui('app-gamemenu.js');
  assert.ok(menu.includes('properties: id => openProps(id)'), '«Свойства…» opens the window');
  assert.ok(menu.includes("call('gameShortcut'"), 'the shortcut item');
  const html = ui('index.html');
  assert.ok(html.indexOf('app-props.js') > html.indexOf('app-gamemenu.js'));
  assert.ok(ui('app-library.js').includes('storeDlcSection(g)'), 'DLC on the store page');
  assert.ok(ui('app-library.js').includes('dlcSummary(owned)'), 'DLC on the library page');
});
