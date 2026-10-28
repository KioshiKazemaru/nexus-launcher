const test = require('node:test'),
  assert = require('node:assert/strict');
const w = require('../src/wishlist.cjs');
const safe = url => (String(url || '').startsWith('https://cdn1.epicgames.com/') ? url : '');

test('Steam wishlist is ordered by priority; empty is allowed, broken is not', () => {
  assert.deepEqual(
    w.parseSteamWishlist({
      response: { items: [{ appid: 2, priority: 2 }, { appid: 1, priority: 1 }, { appid: 'x' }] },
    }),
    ['1', '2']
  );
  assert.deepEqual(w.parseSteamWishlist({ response: {} }), []);
  assert.throws(() => w.parseSteamWishlist({}));
  assert.deepEqual(w.steamWishlistGames(['10'], new Map([['10', { name: 'Ten' }]]))[0], {
    id: 'steam:10',
    steam: '10',
    name: 'Ten',
    image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg',
    tags: [],
    desc: '',
  });
});

test('Epic wishlist keeps valid offers with store links and safe images only', () => {
  const offerId = 'f'.repeat(32);
  const games = w.parseEpicWishlist(
    {
      items: [
        {
          offerId,
          namespace: 'n',
          title: 'Alan Wake 2',
          slug: 'alan-wake-2',
          images: [{ type: 'Thumbnail', url: 'https://cdn1.epicgames.com/a.jpg' }],
        },
        { offerId: 'bad', title: 'x' },
      ],
    },
    safe
  );
  assert.equal(games.length, 1);
  assert.equal(games[0].id, 'epic:' + offerId);
  assert.equal(games[0].storeOffers[0].url, 'https://store.epicgames.com/p/alan-wake-2');
  assert.throws(() => w.parseEpicWishlist({ error: 'HTTP 401' }, safe), /401/);
});
