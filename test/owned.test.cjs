const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  steamOwned,
  parseSteamGames,
  parseSteamStoreLibrary,
  parseEpicLibraryPage,
  epicOwned,
  filterLibrary,
} = require('../src/owned.cjs');
const { mergeGames, launchUri } = require('../src/core.cjs');
const id = '76561198012345678';
test('installed list is installs only; owned list adds uninstalled account games to installs', () => {
  const games = [
    { id: 'a', offers: [{ installed: true, owned: false }] },
    { id: 'b', offers: [{ installed: false, owned: true }] },
    { id: 'c', offers: [{ installed: true, owned: true }] },
  ];
  assert.deepEqual(
    filterLibrary(games, 'installed').map(g => g.id),
    ['a', 'c']
  );
  assert.deepEqual(
    filterLibrary(games, 'owned').map(g => g.id),
    ['a', 'b', 'c']
  );
});
test('Steam account list does not assume installation; empty list is explicit', () => {
  assert.equal(steamOwned([123], id)[0].owned, true);
  assert.equal(steamOwned([123], id)[0].installed, false);
  assert.deepEqual(steamOwned([], id), []);
  assert.throws(() => steamOwned(null, id));
  assert.equal(
    parseSteamGames('<script>var rgGames = [{"appid":123,"name":"Game"}];</script>', id)[0].name,
    'Game'
  );
  assert.throws(() => parseSteamGames('<p>Private profile</p>', id));
});
test('signed-in Steam Store array becomes owned uninstalled account games', () => {
  const offers = parseSteamStoreLibrary({ rgOwnedApps: [570, 1174180] }, id);
  assert.deepEqual(
    offers.map(x => x.appId),
    ['570', '1174180']
  );
  assert.ok(offers.every(x => x.owned && !x.installed && x.accountId === id));
  assert.throws(() => parseSteamStoreLibrary({ rgWishlist: [570] }, id), /список игр/);
});
test('merging local install with account entitlement preserves both independently', () => {
  const cloud = {
      provider: 'steam',
      appId: '123',
      name: 'Game',
      installed: false,
      owned: true,
      accountId: id,
      licenseUnknown: false,
    },
    local = {
      provider: 'steam',
      appId: '123',
      name: 'Game',
      installed: true,
      source: 'local',
      licenseUnknown: true,
    };
  const g = mergeGames([cloud, local])[0];
  assert.equal(g.offers[0].owned, true);
  assert.equal(g.offers[0].installed, true);
  assert.equal(g.offers[0].accountId, id);
  assert.equal(mergeGames([local])[0].offers[0].owned, undefined);
});
test('Epic library maps exact app identity and excludes assets/DLC/private sandboxes', () => {
  const item = { appName: 'app', namespace: 'ns', catalogItemId: 'item', metadata: { title: 'Title' } };
  const p = parseEpicLibraryPage(
    {
      records: [
        item,
        { ...item, namespace: 'ue' },
        { ...item, metadata: { mainGameItem: { id: 'base' } } },
        { ...item, sandboxType: 'PRIVATE' },
      ],
      responseMetadata: { nextCursor: 'next' },
    },
    'account'
  );
  assert.equal(p.offers.length, 1);
  assert.equal(p.offers[0].itemId, 'item');
  assert.equal(p.offers[0].owned, true);
  assert.equal(p.cursor, 'next');
});
test('Epic pagination gets all records, denial is not an empty owned library', async () => {
  let calls = 0;
  const items = await epicOwned(
    async (url, opts) => {
      assert.equal(opts.redirect, 'error');
      calls++;
      return {
        ok: true,
        json: async () => ({
          records: [
            { appName: 'app' + calls, namespace: 'ns', catalogItemId: 'id' + calls, title: 'Game' + calls },
          ],
          responseMetadata: calls === 1 ? { nextCursor: 'second' } : {},
        }),
      };
    },
    'test-token',
    'account'
  );
  assert.equal(items.length, 2);
  assert.equal(calls, 2);
  await assert.rejects(() => epicOwned(async () => ({ ok: false, status: 403 }), 'token', 'id'), /403/);
});
test('Epic uninstalled owned game opens the official client library', () => {
  assert.equal(
    launchUri({ provider: 'epic', appId: 'app', owned: true, installed: false }),
    'com.epicgames.launcher://library'
  );
});
test('switching accounts immediately hides previous entitlements, but retains local installs', () => {
  const { scopedGames } = require('../src/owned.cjs');
  const games = [
    { id: 'cloud', offers: [{ provider: 'epic', accountId: 'old', owned: true, installed: false }] },
    { id: 'local', offers: [{ provider: 'epic', accountId: 'old', owned: true, installed: true }] },
  ];
  const visible = scopedGames(games, { epic: { id: 'new', status: 'connected' } });
  assert.deepEqual(
    visible.map(g => g.id),
    ['local']
  );
  assert.equal(visible[0].offers[0].owned, false);
  assert.equal(games[0].offers[0].owned, true);
});
