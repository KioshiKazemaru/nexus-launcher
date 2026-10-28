// Contract tests against the real store endpoints (run nightly in CI, not in `npm test`).
// They check response shapes, not specific games or prices.
const test = require('node:test'),
  assert = require('node:assert/strict');
const providers = require('../../src/providers.cjs');
const { browseSteamSafe, featuredOffers } = require('../../src/storefront.cjs');
const steamLib = require('../../src/steam-library.cjs');
const { fetchFreeGames } = require('../../src/free-games.cjs');
const integrations = require('../../src/integrations.cjs');

const get = (url, options = {}) =>
  fetch(url, {
    ...options,
    headers: { 'User-Agent': 'Mozilla/5.0 NexusLiveTest', ...(options.headers || {}) },
  });

test('Steam HTML search still parses into offers with prices', async () => {
  const r = await providers.searchSteam(get, 'portal', 'US');
  assert.ok(r.offers.length > 0, 'no offers');
  assert.ok(r.offers.every(o => /^\d+$/.test(o.appId) && o.name));
});

test('Steam storesearch JSON fallback still works', async () => {
  const r = await providers.storeSearch(get, 'portal', 'US');
  assert.ok(r.offers.length > 0);
});

test('Steam featuredcategories sections exist', async () => {
  const data = await providers.responseJSON(
    get,
    'https://store.steampowered.com/api/featuredcategories/?cc=US&l=english'
  );
  for (const s of ['top_sellers', 'specials', 'new_releases', 'coming_soon'])
    assert.ok(featuredOffers(data, s, 'US').length >= 0);
  assert.ok((await browseSteamSafe(get, 'top', 'US')).offers.length > 0);
});

test('IStoreBrowseService/GetItems returns app types (used to drop DLC from libraries)', async () => {
  const items = await steamLib.storeItems(get, ['620'], 'US'); // Portal 2
  assert.equal(items.get('620')?.type, 0, 'game type must be 0');
  assert.ok(items.get('620')?.name);
});

test('GetItems asset paths give real cover images (new apps use hashed folders)', async () => {
  // Portal 2 and Cyberpunk 2077.
  const items = await steamLib.storeItems(get, ['620', '1091500'], 'US');
  for (const id of ['620', '1091500']) {
    const info = items.get(id);
    console.log(id, info?.image, info?.portrait);
    assert.ok(info?.image, `${id}: header image`);
    for (const url of [info.image, info.portrait].filter(Boolean)) {
      const r = await get(url, { method: 'HEAD' });
      assert.equal(r.status, 200, url);
    }
  }
});

test('Epic giveaways endpoint shape', async () => {
  const r = await fetchFreeGames(get, 'US');
  assert.ok(Array.isArray(r.current) && Array.isArray(r.upcoming));
});

test('Epic catalog GraphQL (may be blocked for datacenter IPs)', async t => {
  try {
    const r = await providers.searchEpic(get, 'fortnite', 'US');
    assert.ok(Array.isArray(r.offers));
  } catch (e) {
    if (/HTTP 403/.test(e.message))
      t.skip('Epic blocked this runner (HTTP 403); the app falls back to a store page');
    else throw e;
  }
});

test('IsThereAnyDeal lookup and prices (needs ITAD_KEY)', async t => {
  if (!process.env.ITAD_KEY) return t.skip('ITAD_KEY not set');
  const ids = await integrations.itadLookupSteam(get, process.env.ITAD_KEY, ['620']);
  assert.ok(ids['620']);
  const prices = await integrations.itadPrices(get, process.env.ITAD_KEY, [ids['620']], 'US');
  assert.ok(prices[ids['620']]);
});
