const test = require('node:test'),
  assert = require('node:assert/strict');
const { parseLegendaryList } = require('../src/legendary-import.cjs');
test('Legendary export imports games including uninstalled, but not DLC and Unreal assets', () => {
  const games = [
    {
      app_name: 'GameApp',
      app_title: 'Game',
      namespace: 'main',
      catalog_item_id: 'item',
      metadata: { keyImages: [{ type: 'OfferImageWide', url: 'https://cdn1.epicgames.com/game.jpg' }] },
      dlcs: [{ app_name: 'Addon' }],
    },
    { app_name: 'UEAsset', app_title: 'Asset', namespace: 'ue', catalog_item_id: 'asset' },
    { app_name: 'Dlc', app_title: 'Add-on', namespace: 'main', catalog_item_id: 'dlc', is_dlc: true },
  ];
  const result = parseLegendaryList(games, 'account');
  assert.equal(result.length, 1);
  assert.equal(result[0].accountId, 'account');
  assert.equal(result[0].owned, true);
  assert.equal(result[0].installed, false);
  assert.match(result[0].image, /epicgames.com/);
});
test('Legendary export rejects malformed structure and never trusts names alone', () => {
  assert.throws(() => parseLegendaryList({ games: [] }, 'id'), /JSON-массив/);
  assert.throws(() => parseLegendaryList([{ app_title: 'Game' }], 'id'), /нет подходящих игр/);
});
test('Legendary Windows metadata and assets carry exact Epic namespace and catalog item', () => {
  const games = [
    {
      app_name: 'App',
      app_title: 'Game',
      metadata: {
        namespace: 'namespace',
        id: 'item',
        keyImages: [{ type: 'DieselGameBox', url: 'https://cdn1.epicgames.com/game.jpg' }],
        categories: [{ path: 'games' }],
      },
      asset_infos: { Windows: { app_name: 'App', catalog_item_id: 'item', namespace: 'namespace' } },
      dlcs: [],
    },
  ];
  const [offer] = parseLegendaryList(games, 'account');
  assert.equal(offer.namespace, 'namespace');
  assert.equal(offer.itemId, 'item');
  assert.equal(offer.appId, 'App');
  assert.ok(offer.image);
});
