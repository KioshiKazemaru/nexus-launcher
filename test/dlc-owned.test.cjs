'use strict';
// «Дополнения для ваших игр»: a DLC the Steam account already has is not offered.
const test = require('node:test'),
  assert = require('node:assert/strict');

const appdetails = {
  10: { success: true, data: { type: 'game', name: 'Base', dlc: [101, 102] } },
  101: { success: true, data: { type: 'dlc', name: 'Bought DLC' } },
  102: {
    success: true,
    data: {
      type: 'dlc',
      name: 'New DLC',
      steam_appid: 102,
      header_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/102/header.jpg',
      price_overview: { currency: 'USD', initial: 999, final: 499, discount_percent: 50, final_formatted: '$4.99', initial_formatted: '$9.99' },
    },
  },
};

test('DLC shelf: DLC from the account licences are left out before their prices are asked', async () => {
  const { StoreService } = require('../src/main/store.cjs');
  const store = Object.create(StoreService.prototype);
  const asked = [];
  Object.assign(store, {
    dlcCache: new Map(),
    index: new Map(),
    checkCountry() {},
    ctx: {
      log: { debug() {}, warn() {} },
      settings: { recent: [] },
      publicFetch: async url => {
        const id = new URL(url).searchParams.get('appids');
        asked.push(id);
        return { ok: true, status: 200, text: async () => JSON.stringify({ [id]: appdetails[id] }), json: async () => ({ [id]: appdetails[id] }) };
      },
      library: {
        visible: () => [{ id: 'steam:10', name: 'Base', steam: '10', offers: [{ provider: 'steam', appId: '10', owned: true }] }],
        steamLicences: async () => new Set(['10', '101']),
      },
    },
  });
  const r = await store.dlc({ country: 'US' });
  assert.deepEqual(r.items.map(g => g.id), ['steam:102']);
  assert.ok(!asked.includes('101'), 'the bought DLC is not even looked up');
});

test('Steam licences: every connected account, DLC included; a signed-out answer is unknown', async () => {
  const { LibraryService } = require('../src/main/library.cjs');
  const lib = Object.create(LibraryService.prototype);
  const answers = { 'steam:0': [10, 101], 'steam:1': [202], 'steam:2': [] };
  lib.licences = new Map();
  lib.ctx = {
    log: { debug() {} },
    accounts: {
      connected: () => Object.keys(answers).map(key => ({ key })),
      session: key => ({
        fetch: async url => ({
          ok: true,
          url,
          json: async () => ({ rgOwnedApps: answers[key] }),
        }),
      }),
    },
  };
  const ids = await lib.steamLicences();
  assert.deepEqual([...ids].sort(), ['10', '101', '202']);
  assert.equal(lib.licences.has('steam:2'), false, 'an empty list is not remembered as "owns nothing"');
});
