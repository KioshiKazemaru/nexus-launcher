const test = require('node:test'),
  assert = require('node:assert/strict');
const { featuredOffers, fetchHome } = require('../src/storefront.cjs');
const { ownedOffers, ownsOffer } = require('../src/ownership.cjs');
const steam = {
  top_sellers: {
    items: [
      {
        id: 570,
        name: 'Dota 2',
        final_price: 0,
        original_price: 0,
        currency: 'USD',
        header_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/570/header.jpg',
      },
    ],
  },
  specials: {
    items: [
      {
        id: 1174180,
        name: 'Red Game',
        final_price: 900,
        original_price: 1800,
        discount_percent: 50,
        currency: 'USD',
      },
    ],
  },
};
function response(payload) {
  return { ok: true, text: async () => JSON.stringify(payload) };
}
const epic = {
  data: {
    Catalog: {
      searchStore: {
        elements: [
          {
            id: 'egid',
            namespace: 'ns',
            title: 'Red Game',
            categories: [{ path: 'games' }],
            productSlug: 'red-game',
            items: [{ id: 'item', namespace: 'ns' }],
            price: {
              totalPrice: {
                currencyCode: 'USD',
                originalPrice: 1200,
                discountPrice: 600,
                currencyInfo: { decimals: 2 },
                fmtPrice: { originalPrice: '$12', discountPrice: '$6' },
              },
            },
          },
        ],
        paging: { total: 1 },
      },
    },
  },
};
const steamSearch = async url => {
  const u = new URL(url),
    sale = u.searchParams.get('specials') === '1',
    id = sale ? '1174180' : '570',
    name = sale ? 'Red Game' : 'Dota 2',
    price = sale ? '$9.00' : 'Бесплатно';
  return response({
    results_html: `<a class="search_result_row" href="https://store.steampowered.com/app/${id}/"><span class="title">${name}</span><div class="discount_final_price">${price}</div>${sale ? '<div data-discount="50" data-price-final="900"></div>' : ''}</a>`,
    total_count: 1,
  });
};
test('live home includes Steam and Epic offers with real prices and sale', async () => {
  const result = await fetchHome({ steam: steamSearch, epic: async () => response(epic) }, 'US');
  assert.equal(result.providers.steam.ok, true);
  assert.equal(result.providers.epic.ok, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.promotions[0].storeOffers[0].amount, 9);
  assert.equal(result.promotions[0].storeOffers[1].amount, 6);
  assert.equal(featuredOffers(steam, 'top_sellers', 'US')[0].price, 'Бесплатно');
});
test('one unavailable provider keeps real remaining offers and reports failure', async () => {
  const result = await fetchHome(
    {
      steam: steamSearch,
      epic: async () => {
        throw Error('HTTP 403');
      },
    },
    'US'
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.providers.epic.ok, false);
  assert.match(result.providers.epic.error, /403/);
});
test('owned badge requires exact provider and product, not similar title or installation', () => {
  const owned = ownedOffers([
    {
      offers: [
        { provider: 'steam', appId: '570', owned: true },
        { provider: 'epic', appId: 'app', namespace: 'ns', itemId: 'base', owned: true },
        { provider: 'steam', appId: '1174180', installed: true },
      ],
    },
  ]);
  assert.equal(ownsOffer(owned, { provider: 'steam', appId: '570' }), true);
  assert.equal(ownsOffer(owned, { provider: 'steam', appId: '1174180' }), false);
  assert.equal(ownsOffer(owned, { provider: 'epic', appId: 'app', namespace: 'other' }), false);
  assert.equal(
    ownsOffer(owned, {
      provider: 'epic',
      appId: 'edition',
      namespace: 'ns',
      items: [{ namespace: 'ns', id: 'base' }],
    }),
    true
  );
  assert.equal(
    ownsOffer(owned, {
      provider: 'epic',
      appId: 'edition',
      namespace: 'ns',
      items: [{ namespace: 'ns', id: 'deluxe' }],
    }),
    false
  );
});

test('store front: Steam details fill the games; a details failure keeps the store front', async () => {
  const { withSteamDetails } = require('../src/storefront.cjs');
  const games = [
    {
      id: 'steam:10',
      name: 'A',
      desc: '',
      tags: [],
      storeOffers: [
        { provider: 'steam', appId: '10' },
        { provider: 'epic', appId: 'a' },
      ],
    },
    { id: 'epic:b', name: 'B', tags: [], storeOffers: [{ provider: 'epic', appId: 'b' }] },
  ];
  const requested = [];
  const fetcher = async url => {
    requested.push(String(url));
    if (/GetTagList/.test(url))
      return { ok: true, json: async () => ({ response: { tags: [{ tagid: 19, name: 'Экшен' }] } }) };
    return {
      ok: true,
      json: async () => ({
        response: {
          store_items: [
            {
              appid: 10,
              success: 1,
              basic_info: { short_description: 'Описание' },
              tagids: [19],
              reviews: {
                summary_filtered: {
                  review_count: 5,
                  percent_positive: 80,
                  review_score: 7,
                  review_score_label: 'Положительные',
                },
              },
            },
          ],
        },
      }),
    };
  };
  const [a, b] = await withSteamDetails(fetcher, games, 'US');
  assert.equal(a.desc, 'Описание');
  assert.deepEqual(a.tags, ['Экшен']);
  assert.equal(a.reviews.label, 'Положительные');
  assert.equal(a.storeOffers[0].description, 'Описание');
  assert.deepEqual(a.storeOffers[1], { provider: 'epic', appId: 'a' }, 'other stores are untouched');
  assert.equal(b, games[1], 'Epic-only games are unchanged');
  assert.equal(requested.filter(u => /GetItems/.test(u)).length, 1, 'one request for all games');
  await assert.rejects(
    () => withSteamDetails(async () => ({ ok: false, status: 503 }), games, 'US'),
    /HTTP 503/
  );
});

test('new releases are the popular new releases of the Steam store, newest first', async () => {
  const { browseSteam } = require('../src/providers.cjs');
  let asked;
  await browseSteam(
    async url => {
      asked = new URL(url);
      return { ok: true, text: async () => JSON.stringify({ results_html: '', total_count: 0 }) };
    },
    'new',
    'US'
  );
  assert.equal(asked.searchParams.get('filter'), 'popularnew');
  assert.equal(asked.searchParams.get('sort_by'), 'Released_DESC');
});

test('"Лидеры" for Epic: Steam top sellers that Epic sells too, with the Epic price and an explanation', async () => {
  const { StoreService } = require('../src/main/store.cjs');
  const { LruMap } = require('../src/main/hub.cjs');
  const store = Object.create(StoreService.prototype);
  const top = ['Hades', 'Dota 2', 'Fall Guys'].map((name, i) => ({
    id: 100 + i,
    name,
    final_price: 999,
    original_price: 999,
    currency: 'USD',
  }));
  store.ctx = {
    log: { debug() {} },
    // Steam: the search page is empty, the featured top sellers answer.
    publicFetch: async url =>
      /featuredcategories/.test(url)
        ? response({ top_sellers: { items: top } })
        : response({ results_html: '', total_count: 0 }),
  };
  store.epicFetch = async url => {
    const keywords = JSON.parse(new URL(url).searchParams.get('variables')).keywords;
    const element = {
      id: 'e-' + keywords,
      namespace: 'ns-' + keywords,
      title: keywords === 'Fall Guys' ? 'Fall Guys: Ultimate Knockout' : keywords,
      categories: [{ path: 'games/edition/base' }],
      keyImages: [],
      offerMappings: [{ pageType: 'productHome', pageSlug: 'slug' }],
      price: {
        totalPrice: {
          currencyCode: 'USD',
          discountPrice: 1249,
          originalPrice: 2499,
          fmtPrice: { discountPrice: '12,49 $' },
        },
      },
    };
    // Dota 2 is not sold by Epic.
    const elements = keywords === 'Dota 2' ? [] : [element];
    return response({ data: { Catalog: { searchStore: { elements, paging: { total: elements.length } } } } });
  };
  store.browseCache = new Map();
  store.index = new LruMap(100);
  const r = await store.browseEpicList('top', 'US');
  assert.deepEqual(
    r.items.map(g => g.name),
    ['Hades'],
    'only exact titles count (Fall Guys has another title on Epic), games Epic does not sell are left out'
  );
  assert.equal(r.items[0].storeOffers[0].provider, 'epic');
  assert.equal(r.items[0].storeOffers[0].amount, 12.49);
  assert.match(r.note, /Epic Games/);
  assert.equal(r.provider, 'epic');
  assert.equal(await store.browseEpicList('top', 'US'), r, 'cached');
});
