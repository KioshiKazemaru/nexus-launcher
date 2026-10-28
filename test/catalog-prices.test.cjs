const test = require('node:test'),
  assert = require('node:assert/strict');
const { steamOffer, CatalogPrices, fetchGameOffers } = require('../src/catalog-prices.cjs');
const game = { id: 'game', steam: '123', name: 'A game' };
test('card price includes currency, original price and discount; missing is never zero', () => {
  const p = steamOffer(
    {
      success: true,
      data: {
        price_overview: {
          currency: 'EUR',
          final: 1999,
          initial: 3999,
          final_formatted: '19,99€',
          initial_formatted: '39,99€',
          discount_percent: 50,
        },
      },
    },
    game,
    'DE'
  );
  assert.equal(p.amount, 19.99);
  assert.equal(p.country, 'DE');
  assert.equal(p.originalPrice, '39,99€');
  assert.equal(p.discount, 50);
  assert.equal(steamOffer({ success: false }, game, 'RU').amount, null);
  assert.equal(steamOffer({ success: true, data: { is_free: true } }, game, 'DE').amount, 0);
});
test('catalog hydration isolates country and shares simultaneous requests', async () => {
  let calls = 0;
  const cache = new CatalogPrices(async () => {
    calls++;
    return {
      ok: true,
      text: async () => JSON.stringify({ 123: { success: true, data: { is_free: true } } }),
    };
  });
  const [a, b] = await Promise.all([cache.get(game, 'US'), cache.get(game, 'US')]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  await cache.get(game, 'DE');
  assert.equal(calls, 2);
  await cache.get(game, 'DE', true);
  assert.equal(calls, 3);
});
test('Epic failure does not remove the Steam card price', async () => {
  const results = await fetchGameOffers(
    async url => {
      if (url.includes('epicgames')) throw Error('HTTP 403');
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            123: {
              success: true,
              data: { price_overview: { currency: 'USD', final: 999, final_formatted: '$9.99' } },
            },
          }),
      };
    },
    { ...game, epic: 'a-game' },
    'US'
  );
  assert.equal(results.find(o => o.provider === 'steam').price, '$9.99');
  assert.equal(results.find(o => o.provider === 'epic').priceStatus, 'error');
});
test('Steam page metadata supplies real preview description, genres and screenshots', () => {
  const offer = steamOffer(
    {
      success: true,
      data: {
        short_description: '<b>Explore</b> the world',
        genres: [{ description: 'Adventure' }],
        screenshots: [
          { path_thumbnail: 'https://shared.akamai.steamstatic.com/shot.jpg' },
          { path_thumbnail: 'https://evil.example/shot.jpg' },
        ],
        release_date: { date: '10 Oct, 2026', coming_soon: true },
      },
    },
    game,
    'US'
  );
  assert.equal(offer.description, 'Explore the world');
  assert.deepEqual(offer.tags, ['Adventure']);
  assert.deepEqual(offer.screenshots, ['https://shared.akamai.steamstatic.com/shot.jpg']);
  assert.equal(offer.comingSoon, true);
});

test('owned Epic game is priced when search omits items but its namespace has one game', async () => {
  const el = (id, title, categories, extra = {}) => ({
    id,
    namespace: 'ns1',
    title,
    categories: categories.map(path => ({ path })),
    keyImages: [],
    items: [],
    price: {
      totalPrice: {
        currencyCode: 'KZT',
        originalPrice: 410000,
        discountPrice: 410000,
        currencyInfo: { decimals: 2 },
        fmtPrice: { originalPrice: '4 100 ₸', discountPrice: '4 100 ₸' },
      },
    },
    ...extra,
  });
  const body = {
    // A field error next to usable data must not discard the results.
    errors: [{ message: 'mappings failed' }],
    data: {
      Catalog: {
        searchStore: {
          elements: [el('offer-game', '20XX', ['games']), el('offer-dlc', '20XX Soundtrack', ['addons'])],
          paging: { total: 2 },
        },
      },
    },
  };
  const fetcher = async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const game = {
    id: 'epic:x',
    name: '20XX',
    offers: [{ provider: 'epic', appId: 'Flamingo', namespace: 'ns1', itemId: 'item-1' }],
  };
  const offers = await fetchGameOffers(fetcher, game, 'KZ');
  const epic = offers.find(o => o.provider === 'epic');
  assert.equal(epic.priceStatus, 'ready');
  assert.equal(epic.appId, 'offer-game');
  assert.equal(epic.amount, 4100);
});
