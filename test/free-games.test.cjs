const test = require('node:test'),
  assert = require('node:assert/strict');
const f = require('../src/free-games.cjs');
const now = Date.parse('2026-10-14T12:00:00Z');
const promo = (start, end, percent = 0) => [
  {
    promotionalOffers: [{ startDate: start, endDate: end, discountSetting: { discountPercentage: percent } }],
  },
];
const element = (id, promotions) => ({
  id,
  namespace: 'ns' + id,
  title: 'Game ' + id,
  keyImages: [
    { type: 'OfferImageWide', url: 'https://cdn1.epicgames.com/w.jpg' },
    { type: 'Thumbnail', url: 'https://evil.test/x.jpg' },
  ],
  offerMappings: [{ pageType: 'productHome', pageSlug: 'game-' + id }],
  promotions,
});

test('current and upcoming giveaways; paid discounts are not giveaways', () => {
  const data = {
    data: {
      Catalog: {
        searchStore: {
          elements: [
            element('a', { promotionalOffers: promo('2026-10-09T15:00:00Z', '2026-10-16T15:00:00Z') }),
            element('b', { promotionalOffers: promo('2026-10-09T15:00:00Z', '2026-10-16T15:00:00Z', 50) }),
            element('c', {
              promotionalOffers: [],
              upcomingPromotionalOffers: promo('2026-10-16T15:00:00Z', '2026-10-23T15:00:00Z'),
            }),
            element('d', null),
          ],
        },
      },
    },
  };
  const r = f.parseFreeGames(data, now);
  assert.deepEqual(
    r.current.map(g => g.appId),
    ['a']
  );
  assert.deepEqual(
    r.upcoming.map(g => g.appId),
    ['c']
  );
  assert.equal(r.current[0].url, 'https://store.epicgames.com/p/game-a');
  assert.equal(r.current[0].image, 'https://cdn1.epicgames.com/w.jpg');
  assert.throws(() => f.parseFreeGames({}));
});

test('only new giveaways trigger a notification', () => {
  const g = { namespace: 'n', appId: 'a', start: 1 };
  assert.equal(f.newGiveaways([g], []).length, 1);
  assert.equal(f.newGiveaways([g], [f.giveawayKey(g)]).length, 0);
});
