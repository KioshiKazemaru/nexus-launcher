'use strict';
// A friend in a game not in the user's library: the name comes from the Steam store.
const test = require('node:test'),
  assert = require('node:assert/strict');
const { PresenceService } = require('../src/main/presence.cjs');

test('friend game names: library first, then one store request; a miss is retried later', async () => {
  const requests = [];
  const ctx = {
    library: { games: [{ name: 'Dota 2', offers: [{ provider: 'steam', appId: '570' }] }] },
    settings: { storeCountry: 'US' },
    log: { debug() {} },
    publicFetch: async url => {
      const ids = JSON.parse(new URL(url).searchParams.get('input_json')).ids.map(x => x.appid);
      requests.push(ids);
      return {
        ok: true,
        json: async () => ({
          response: {
            store_items: ids.filter(id => id === 1808500).map(id => ({ appid: id, name: 'ARC Raiders' })),
          },
        }),
      };
    },
  };
  const presence = Object.create(PresenceService.prototype);
  presence.ctx = ctx;
  presence.appNames = new Map();
  await presence.appNamesFor(null, ['570', '1808500', '999']);
  assert.deepEqual(requests, [[1808500, 999]], 'one request, only for games not in the library');
  assert.equal(await presence.appName(null, 570), 'Dota 2');
  assert.equal(await presence.appName(null, '1808500'), 'ARC Raiders');
  assert.equal(await presence.appName(null, 999), '');
  assert.equal(requests.length, 1, 'known names and a fresh miss are not asked again');
  presence.appNameMiss.set(999, Date.now() - 700000);
  await presence.appName(null, 999);
  assert.equal(requests.length, 2, 'a miss is retried after ten minutes');
});
