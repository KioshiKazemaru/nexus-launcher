const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {
  parseVdf,
  mergeGames,
  chooseOffer,
  launchUri,
  scanSteam,
  scanEpic,
  storeUrl,
} = require('../src/core.cjs');
test('Steam VDF: nested libraries and escaped Windows path', () => {
  const v = parseVdf('"libraryfolders" { "0" { "path" "C:\\\\Steam" } "1" { "path" "D:\\\\Games" } }');
  assert.equal(v.libraryfolders[1].path, 'D:\\Games');
  assert.throws(() => parseVdf('"root" { "x" "y"'));
});
test('same mapped title merges across platforms and defaults to Steam', () => {
  const games = mergeGames([
    { provider: 'epic', name: 'Cyberpunk 2077', appId: 'epic', installed: true },
    { provider: 'steam', name: 'Cyberpunk 2077', appId: '1091500', installed: true },
  ]);
  assert.equal(games.length, 1);
  assert.equal(games[0].offers.length, 2);
  assert.equal(chooseOffer(games[0]).provider, 'steam');
  assert.equal(chooseOffer(games[0], 'epic').provider, 'epic');
});
test('library: edition words do not split a game, catalog noAutoMerge and lookalikes stay separate', () => {
  const games = mergeGames([
    { provider: 'steam', name: 'Control Ultimate Edition', appId: '870780' },
    { provider: 'epic', name: 'Control', appId: 'ctrl' },
    { provider: 'epic', name: 'Cyberpunk 2077: Ultimate Edition', appId: 'cp-ultimate' },
    { provider: 'steam', name: 'Cyberpunk 2077', appId: '1091500' },
    { provider: 'epic', name: 'Cyberpunk 2078', appId: 'other' },
  ]);
  // Owning Cyberpunk Ultimate on Epic means owning Cyberpunk; "Control" is a
  // catalog entry marked noAutoMerge; "2078" is a different title.
  assert.equal(games.length, 4);
  assert.equal(games.find(g => g.id === 'cyberpunk').offers.length, 2);
});
test('manual link and split override automatic matching; two offers of one store never auto-merge', () => {
  const offers = [
    { provider: 'steam', name: 'Batman: Arkham Knight', appId: '208650' },
    { provider: 'epic', name: 'Batman Arkham Knight Premium', appId: 'bak', namespace: 'ns' },
    { provider: 'steam', name: 'Hades', appId: '1' },
    { provider: 'steam', name: 'Hades', appId: '2' },
  ];
  assert.equal(mergeGames(offers).length, 3);
  assert.equal(
    mergeGames(offers).find(g => g.name === 'Hades') &&
      mergeGames(offers).filter(g => g.name === 'Hades').length,
    2
  );
  const split = mergeGames(offers, { splits: new Set(['epic:ns:bak|steam:208650']) });
  assert.equal(split.length, 4);
  const linked = mergeGames(offers, { links: [['steam:1', 'steam:2']] });
  assert.equal(linked.filter(g => g.name === 'Hades').length, 1);
});
test('external ids join different titles; the same app owned by two accounts keeps both owners', () => {
  const games = mergeGames(
    [
      {
        provider: 'steam',
        name: 'FINAL FANTASY VII REMAKE INTERGRADE',
        appId: '1462040',
        owned: true,
        accountId: 'a',
      },
      {
        provider: 'epic',
        name: 'Final Fantasy VII Remake',
        appId: 'ff7',
        namespace: 'n',
        owned: true,
        accountId: 'e',
      },
      {
        provider: 'steam',
        name: 'FINAL FANTASY VII REMAKE INTERGRADE',
        appId: '1462040',
        owned: true,
        accountId: 'b',
      },
    ],
    { externalId: o => (o.provider === 'steam' || o.appId === 'ff7' ? 'itad:ff7' : '') }
  );
  assert.equal(games.length, 1);
  assert.deepEqual(games[0].offers.find(o => o.provider === 'steam').accountIds, ['a', 'b']);
  assert.equal(games[0].mergedBy, 'external');
});
test('Steam API + local scan keeps installation and verified ownership', () => {
  const [g] = mergeGames([
    { provider: 'steam', name: 'Hades', appId: '1145360', installed: false, licenseUnknown: false },
    { provider: 'steam', name: 'Hades', appId: '1145360', installed: true, licenseUnknown: true },
  ]);
  assert.equal(g.offers.length, 1);
  assert.equal(g.offers[0].installed, true);
  assert.equal(g.offers[0].licenseUnknown, false);
});
test('launch URIs validate Steam ids and encode Epic identifiers', () => {
  assert.equal(
    launchUri({ provider: 'steam', appId: '1091500', installed: true }),
    'steam://rungameid/1091500'
  );
  assert.equal(
    launchUri({ provider: 'steam', appId: '1091500', installed: false }),
    'steam://install/1091500'
  );
  assert.equal(
    launchUri({ provider: 'epic', namespace: 'a', itemId: 'b', appId: 'c', installed: true }),
    'com.epicgames.launcher://apps/a%3Ab%3Ac?action=launch&silent=true'
  );
  assert.equal(
    launchUri({ provider: 'epic', namespace: 'a', itemId: 'b', appId: 'c', installed: false, owned: true }),
    'com.epicgames.launcher://apps/a%3Ab%3Ac?action=install&silent=true'
  );
  assert.equal(
    launchUri({ provider: 'epic', appId: 'c', installed: false, owned: true }),
    'com.epicgames.launcher://library'
  );
  assert.throws(() => launchUri({ provider: 'steam', appId: '123&evil=true' }));
});
test('Steam scan follows secondary library, skips damaged manifests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
  try {
    const a = path.join(root, 'a'),
      b = path.join(root, 'b');
    for (const x of [a, b]) fs.mkdirSync(path.join(x, 'steamapps'), { recursive: true });
    fs.writeFileSync(
      path.join(a, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders" { "1" { "path" "${b}" } }`
    );
    fs.writeFileSync(
      path.join(b, 'steamapps', 'appmanifest_1145360.acf'),
      '"AppState" { "appid" "1145360" "name" "Hades" "StateFlags" "4" }'
    );
    fs.writeFileSync(path.join(b, 'steamapps', 'appmanifest_12.acf'), '"AppState" { broken');
    const r = await scanSteam([a]);
    assert.equal(r.offers.length, 1);
    assert.equal(r.offers[0].installed, true);
    assert.equal(r.errors.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('Epic scan excludes incomplete installs and addons; LauncherInstalled.dat adds missing installs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
  try {
    const m = {
      AppName: 'x',
      DisplayName: 'Hades',
      InstallLocation: root,
      CatalogNamespace: 'n',
      CatalogItemId: 'c',
    };
    fs.writeFileSync(path.join(root, 'good.item'), JSON.stringify(m));
    fs.writeFileSync(
      path.join(root, 'partial.item'),
      JSON.stringify({ ...m, AppName: 'p', bIsIncompleteInstall: true })
    );
    fs.writeFileSync(
      path.join(root, 'dlc.item'),
      JSON.stringify({ ...m, AppName: 'dlc', MainGameAppName: 'x' })
    );
    const r = await scanEpic(root);
    assert.equal(r.offers.length, 1);
    assert.equal(r.offers[0].appId, 'x');
    const game = path.join(root, 'Fortnite');
    fs.mkdirSync(game);
    const dat = path.join(root, 'LauncherInstalled.dat');
    fs.writeFileSync(
      dat,
      JSON.stringify({
        InstallationList: [
          { AppName: 'x', InstallLocation: root, NamespaceId: 'n', ItemId: 'c' },
          { AppName: 'Fortnite', InstallLocation: game, NamespaceId: 'fn', ItemId: 'i' },
          { AppName: 'Gone', InstallLocation: path.join(root, 'missing'), NamespaceId: 'g', ItemId: 'g' },
          { AppName: 'UE_5.3', InstallLocation: root, NamespaceId: 'ue', ItemId: 'u' },
        ],
      })
    );
    const both = await scanEpic(root, dat);
    assert.deepEqual(both.offers.map(o => o.appId).sort(), ['Fortnite', 'x']);
    assert.equal(both.offers.find(o => o.appId === 'Fortnite').namespace, 'fn');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('store links go to official HTTPS domains, unknown names use search', () => {
  assert.equal(
    storeUrl('steam', { steam: '1145360', name: 'Hades' }),
    'https://store.steampowered.com/app/1145360/'
  );
  assert.match(storeUrl('epic', { name: 'A & B' }), /^https:\/\/store.epicgames.com\/browse\?q=A%20%26%20B/);
  assert.throws(() => storeUrl('other', { name: 'x' }));
});

test('local and account copies of one Steam app keep both language titles', () => {
  const { mergeGames } = require('../src/core.cjs');
  const games = mergeGames([
    { provider: 'steam', appId: '1', name: 'Garage Jumping Simulator', installed: true },
    { provider: 'steam', appId: '1', name: 'Симулятор Прыгания по Гаражам', owned: true, accountId: 'a' },
    { provider: 'epic', appId: 'e1', name: 'Garage Jumping Simulator', owned: true, accountId: 'b' },
  ]);
  assert.equal(games.length, 1);
});
