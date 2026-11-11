// «Желаемое» synced with the Steam and Epic wishlists (main/store.cjs) and «Скидки»:
// the store sale lists page by page with the end date of each discount (src/deals.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function response(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

// A StoreService with only what the wishlist needs; each account's list is set by hand.
function wishStore(settings, lists) {
  const { StoreService } = require('../src/main/store.cjs');
  const { LruMap } = require('../src/main/hub.cjs');
  const store = Object.create(StoreService.prototype);
  store.index = new LruMap(100);
  store.catalogVersion = 0;
  store.ctx = {
    settings: {
      wishlist: [],
      wishlistFrom: {},
      wishlistDismissed: {},
      savedGames: {},
      favorites: [],
      ...settings,
    },
    storage: { saveSettings() {} },
    hub: { publish() {} },
    log: { debug() {}, warn() {} },
    accounts: {
      connected: provider =>
        provider === 'steam'
          ? [{ key: 'steam:0', id: 'S1', name: 'Me' }]
          : [{ key: 'epic:E1', id: 'E1', name: 'Me' }],
    },
  };
  store.initialPrices = async () => {};
  store.steamWishlist = async () => {
    if (lists.steam instanceof Error) throw lists.steam;
    return lists.steam.map(id => ({ id: 'steam:' + id, steam: String(id), name: 'Game ' + id, tags: [] }));
  };
  store.epicWishlist = async () => {
    if (lists.epic instanceof Error) throw lists.epic;
    return lists.epic.map(([offerId, name]) => ({
      id: 'epic:' + offerId,
      name,
      tags: [],
      storeOffers: [{ provider: 'epic', appId: offerId, namespace: 'ns', name }],
    }));
  };
  return store;
}

test('wishlists: Steam and Epic join the Nexus list, one card per game, old entries sorted out', async () => {
  const lists = {
    steam: [10, 20],
    epic: [
      ['e20', 'Game 20'],
      ['e30', 'Epic Only'],
    ],
  };
  // Entries from before origins were kept: steam:10 was imported, steam:99 added by hand.
  const store = wishStore({ wishlist: ['steam:10', 'steam:99'] }, lists);
  const report = await store.syncWishlists();
  const s = store.ctx.settings;
  assert.deepEqual(report, { steam: 1, epic: 1, removed: 0, errors: [], storeSignIn: [] });
  assert.deepEqual(s.wishlist, ['steam:10', 'steam:99', 'steam:20', 'epic:e30']);
  assert.deepEqual(s.wishlistFrom, {
    'steam:10': ['steam:S1'],
    'steam:99': ['nexus'],
    'steam:20': ['steam:S1', 'epic:E1'],
    'epic:e30': ['epic:E1'],
  });
  // The Epic copy of "Game 20" is a second price on the Steam card, not a second card.
  assert.deepEqual(
    store.index.get('steam:20').storeOffers.map(o => o.provider),
    ['steam', 'epic']
  );
  assert.ok(s.savedGames['epic:e30'], 'a new game is remembered for the window');
  assert.equal(store.wishStatus.running, false);
  assert.ok(store.wishStatus.at > 0);
});

test('wishlists: removed in the store leaves Nexus, unless it came from elsewhere too', async () => {
  const lists = { steam: [10, 20, 40], epic: [['e20', 'Game 20']] };
  const store = wishStore({}, lists);
  await store.syncWishlists();
  store.toggle({ list: 'wishlist', id: 'steam:40' }); // remove…
  store.toggle({ list: 'wishlist', id: 'steam:40' }); // …and add again in Nexus
  lists.steam = [];
  lists.epic = [['e20', 'Game 20']];
  const report = await store.syncWishlists();
  const s = store.ctx.settings;
  assert.equal(report.removed, 1);
  // 10: only Steam → gone. 20: still on Epic. 40: added in Nexus → stays.
  assert.deepEqual(s.wishlist, ['steam:20', 'steam:40']);
  assert.deepEqual(s.wishlistFrom['steam:20'], ['epic:E1']);
  assert.deepEqual(s.wishlistFrom['steam:40'], ['nexus']);
});

test('wishlists: a game removed in Nexus does not come back while it is on the store list', async () => {
  const lists = { steam: [10], epic: [] };
  const store = wishStore({}, lists);
  await store.syncWishlists();
  store.toggle({ list: 'wishlist', id: 'steam:10' });
  const s = store.ctx.settings;
  assert.deepEqual(s.wishlistDismissed, { 'steam:10': ['steam:S1'] });
  await store.syncWishlists();
  assert.deepEqual(s.wishlist, [], 'not brought back');
  // Gone from Steam: forgotten; put on the Steam wishlist again later: back in Nexus.
  lists.steam = [];
  await store.syncWishlists();
  assert.deepEqual(s.wishlistDismissed, {});
  lists.steam = [10];
  await store.syncWishlists();
  assert.deepEqual(s.wishlist, ['steam:10']);
  // Added back in Nexus by hand: Nexus and Steam.
  store.toggle({ list: 'wishlist', id: 'steam:10' });
  store.toggle({ list: 'wishlist', id: 'steam:10' });
  assert.deepEqual(s.wishlistDismissed, {});
  assert.deepEqual(s.wishlistFrom['steam:10'], ['nexus', 'steam:S1']);
});

test('wishlists: an account that cannot be read keeps its games', async () => {
  const lists = { steam: [10], epic: [['e1', 'Epic One']] };
  const store = wishStore({ wishlist: ['steam:77'] }, lists);
  await store.syncWishlists();
  lists.steam = new Error('HTTP 500');
  lists.epic = new Error('нет ответа');
  const report = await store.syncWishlists();
  const s = store.ctx.settings;
  assert.equal(report.errors.length, 2);
  assert.match(report.errors[0], /^Steam \(Me\): HTTP 500/);
  assert.deepEqual(s.wishlist, ['steam:77', 'steam:10', 'epic:e1']);
  assert.deepEqual(store.wishStatus.errors, report.errors);
});

test('wishlists: an Epic store page that is not signed in asks for «Войти в магазин Epic»', async () => {
  const store = wishStore({ wishlist: ['steam:77'] }, { steam: [10], epic: [] });
  delete store.epicWishlist; // the real one, with the store page of the account
  store.ctx.epicStorePage = key => {
    assert.equal(key, 'epic:E1');
    return {
      run: async () => ({
        error:
          'Unexpected error value: { success: false, message: "WishlistQuery/wishlistItems: com.epicgames.wishlist.notLoggedIn" }',
      }),
    };
  };
  const report = await store.syncWishlists();
  assert.deepEqual(report.storeSignIn, [{ key: 'epic:E1', name: 'Me' }]);
  assert.match(report.errors[0], /^Epic Games \(Me\): нужно войти в магазин Epic/);
  assert.deepEqual(store.wishStatus.storeSignIn, report.storeSignIn);
  // Another failure is only an error.
  store.ctx.epicStorePage = () => ({ run: async () => ({ error: 'HTTP 500' }) });
  const other = await store.syncWishlists();
  assert.deepEqual(other.storeSignIn, []);
  assert.match(other.errors[0], /HTTP 500/);
});

test('wishlists: a Steam account that signs in right after a sync is read at once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const store = wishStore({}, { steam: [10], epic: [] });
  let syncs = 0;
  const real = store.syncWishlists.bind(store);
  store.syncWishlists = () => (syncs++, real());
  store.wishRead = new Set(['epic:E1']);
  store.wishStatus = { at: Date.now() - 60000 }; // a sync a minute ago
  store.wishlistSoon('epic:E1'); // already read: waits for the 10 minutes
  assert.equal(store.wishTimer, undefined);
  store.wishlistSoon('steam:S1'); // not read yet: now
  assert.ok(store.wishTimer);
  t.mock.timers.tick(5000);
  await new Promise(r => setImmediate(r));
  await store.wishRunning;
  assert.equal(syncs, 1);
  assert.ok(store.wishRead.has('steam:S1'));
});

test('wishlists: a Steam account whose sign-in expired is read as a public wishlist', async () => {
  const store = wishStore(
    {
      wishlist: ['steam:10'],
      knownAccounts: { 'steam:0': { id: '76561198000000002', name: 'Old' } },
    },
    { steam: [], epic: [] }
  );
  delete store.steamWishlist; // the real one
  store.ctx.accounts.connected = () => [];
  store.ctx.accounts.session = () => assert.fail('no session without a sign-in');
  let wish = [
    { appid: 10, priority: 1 },
    { appid: 20, priority: 0 },
  ];
  store.ctx.publicFetch = async url => {
    if (url.includes('IWishlistService')) {
      const u = new URL(url);
      assert.equal(u.searchParams.get('steamid'), '76561198000000002');
      assert.equal(u.searchParams.get('access_token'), null);
      return response({ response: wish.length ? { items: wish } : {} });
    }
    return response({ response: { store_items: [] } });
  };
  const report = await store.syncWishlists();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(store.ctx.settings.wishlist, ['steam:10', 'steam:20']);
  assert.deepEqual(store.ctx.settings.wishlistFrom['steam:20'], ['steam:76561198000000002']);
  // A private wishlist answers like an empty one: the games stay, the reason is shown.
  wish = [];
  const closed = await store.syncWishlists();
  assert.match(closed.errors[0], /Steam \(Old\): нет входа в Steam, а список желаемого закрыт/);
  assert.deepEqual(store.ctx.settings.wishlist, ['steam:10', 'steam:20']);
});

test('Epic store sign-in: a one-time code of the account, back to the store wishlist', async () => {
  const store = wishStore({}, { steam: [], epic: [] });
  store.ctx.accounts.tokens = { accessToken: async id => (assert.equal(id, 'E1'), 'tok') };
  store.ctx.publicFetch = async (url, o) => {
    assert.match(url, /account\/api\/oauth\/exchange$/);
    assert.equal(o.headers.Authorization, 'bearer tok');
    return response({ code: 'a'.repeat(32) });
  };
  const u = new URL(await store.epicStoreSignInUrl({ id: 'E1' }));
  assert.equal(u.origin + u.pathname, 'https://www.epicgames.com/id/exchange');
  assert.equal(u.searchParams.get('exchangeCode'), 'a'.repeat(32));
  assert.equal(u.searchParams.get('redirectUrl'), 'https://store.epicgames.com/ru/wishlist');
});

test('wishlists: an old entry stays "unknown" until every account was read', async () => {
  const store = wishStore({ wishlist: ['steam:77'] }, { steam: [10], epic: new Error('HTTP 403') });
  await store.syncWishlists();
  // Epic could not be read: steam:77 may still be on the Epic list.
  assert.deepEqual(store.ctx.settings.wishlistFrom['steam:77'], ['legacy']);
  assert.deepEqual(store.wishOrigins('steam:77'), ['legacy']);
});

test('Steam: the price and the end of a discount from the store purchase options', () => {
  const { parseSaleInfo } = require('../src/steam-library.cjs');
  const sales = parseSaleInfo({
    response: {
      store_items: [
        {
          appid: 227300,
          best_purchase_option: {
            final_price_in_cents: '31700',
            original_price_in_cents: '126900',
            formatted_final_price: '317 руб',
            formatted_original_price: '1269 руб',
            discount_pct: 75,
            active_discounts: [{ discount_end_date: 1795539600 }, { discount_end_date: 1795456800 }],
          },
        },
        { appid: 1, best_purchase_option: { final_price_in_cents: '999', discount_pct: 0 } },
        { appid: 'x', best_purchase_option: {} },
      ],
    },
  });
  assert.deepEqual(sales.get('227300'), {
    discount: 75,
    amount: 317,
    originalAmount: 1269,
    price: '317 руб',
    originalPrice: '1269 руб',
    saleEnd: 1795456800000,
  });
  assert.equal(sales.get('1').saleEnd, null, 'no discount, no end');
  assert.equal(sales.size, 2);
  assert.throws(() => parseSaleInfo({}), /Steam/);
});

test('Epic: the end of a discount from the price rules, only for a sale', () => {
  const { parseEpicSearch } = require('../src/providers.cjs');
  const element = (discountPrice, rules) => ({
    id: 'o' + discountPrice,
    namespace: 'ns',
    title: 'Game ' + discountPrice,
    categories: [{ path: 'games/edition/base' }],
    keyImages: [],
    price: {
      totalPrice: { currencyCode: 'RUB', originalPrice: 1000, discountPrice, fmtPrice: {} },
      lineOffers: [{ appliedRules: rules }],
    },
  });
  const { offers } = parseEpicSearch({
    data: {
      Catalog: {
        searchStore: {
          elements: [
            element(500, [{ endDate: '2026-11-20T15:00:00.000Z' }, { endDate: '2026-11-18T15:00:00.000Z' }]),
            element(1000, [{ endDate: '2026-11-20T15:00:00.000Z' }]),
            element(700, [{ endDate: null }]),
          ],
        },
      },
    },
  });
  assert.equal(offers[0].saleEnd, Date.parse('2026-11-18T15:00:00.000Z'));
  assert.equal(offers[1].saleEnd, undefined, 'full price: no sale end');
  assert.equal(offers[2].saleEnd, undefined);
});

function steamRow(id, discount) {
  return `<a class="search_result_row" href="https://store.steampowered.com/app/${id}/x/"><div class="search_capsule"><img src="https://shared.akamai.steamstatic.com/a.jpg"></div><span class="title">Steam ${id}</span><div data-discount="${discount}"></div><div class="discount_final_price">500 руб</div><div data-price-final="50000"></div></a>`;
}

test('Steam sales: one search page, the end of every discount in one request', async () => {
  const { steamDeals } = require('../src/deals.cjs');
  const asked = [];
  const fetcher = async url => {
    asked.push(url);
    if (url.includes('/search/results/'))
      return response({
        results_html: steamRow(1, 50) + steamRow(2, 0) + steamRow(3, 20),
        total_count: 6413,
      });
    const ids = JSON.parse(new URL(url).searchParams.get('input_json')).ids.map(x => x.appid);
    assert.deepEqual(ids, [1, 3], 'only the discounted games');
    return response({
      response: {
        store_items: [
          {
            appid: 1,
            best_purchase_option: {
              final_price_in_cents: '45000',
              original_price_in_cents: '90000',
              formatted_final_price: '450 руб',
              discount_pct: 50,
              active_discounts: [{ discount_end_date: 1795539600 }],
            },
          },
        ],
      },
    });
  };
  const r = await steamDeals(fetcher, 'RU', 50, 'price');
  const search = new URL(asked[0]).searchParams;
  assert.equal(search.get('specials'), '1');
  assert.equal(search.get('start'), '50');
  assert.equal(search.get('sort_by'), 'Price_ASC');
  assert.equal(search.get('cc'), 'RU');
  assert.deepEqual(
    r.offers.map(o => [o.appId, o.discount, o.amount, o.saleEnd || null]),
    [
      ['1', 50, 450, 1795539600000],
      ['3', 20, 500, null],
    ]
  );
  assert.equal(r.total, 6413);
  assert.equal(r.next, 100);
  // Without the purchase options the list still shows the discounts.
  const plain = await steamDeals(
    async url =>
      url.includes('/search/results/')
        ? response({ results_html: steamRow(1, 50), total_count: 1 })
        : { ok: false, status: 500 },
    'RU'
  );
  assert.deepEqual(
    plain.offers.map(o => [o.appId, o.discount]),
    [['1', 50]]
  );
  await assert.rejects(steamDeals(fetcher, 'XX'), /регион/);
  await assert.rejects(steamDeals(fetcher, 'RU', -1), /страница/);
  await assert.rejects(steamDeals(fetcher, 'RU', 0, 'random'), /порядок/);
});

test('Epic sales: the sale list of the catalogue page by page, games only', async () => {
  const { epicDeals } = require('../src/deals.cjs');
  let variables;
  const el = (id, discountPrice, path = 'games/edition/base') => ({
    id,
    namespace: 'ns',
    title: 'Epic ' + id,
    categories: [{ path }],
    keyImages: [],
    price: {
      totalPrice: {
        currencyCode: 'RUB',
        originalPrice: 1000,
        discountPrice,
        fmtPrice: { discountPrice: '1 ₽' },
      },
      lineOffers: [{ appliedRules: [{ endDate: '2026-11-18T15:00:00.000Z' }] }],
    },
  });
  const fetcher = async url => {
    variables = JSON.parse(new URL(url).searchParams.get('variables'));
    return response({
      data: {
        Catalog: {
          searchStore: {
            elements: [el('a', 500), el('b', 1000), el('c', 300, 'addons/dlc')],
            paging: { total: 812 },
          },
        },
      },
    });
  };
  const r = await epicDeals(fetcher, 'RU', 40, 'price', Date.UTC(2026, 10, 11));
  assert.equal(variables.start, 40);
  assert.equal(variables.onSale, true);
  assert.equal(variables.sortBy, 'currentPrice');
  assert.equal(variables.releaseDate, '[,2026-11-11T00:00:00.000Z]');
  assert.deepEqual(
    r.offers.map(o => [o.appId, o.discount, o.saleEnd]),
    [['a', 50, Date.parse('2026-11-18T15:00:00.000Z')]]
  );
  assert.equal(r.total, 812);
  assert.equal(r.next, 80);
  const last = await epicDeals(fetcher, 'RU', 800, 'popular');
  assert.equal(last.next, null, 'the last page');
});

test('discounts: both stores interleaved, each with its own cursor; a failed store is reported', async () => {
  const { StoreService } = require('../src/main/store.cjs');
  const { LruMap } = require('../src/main/hub.cjs');
  const store = Object.create(StoreService.prototype);
  store.index = new LruMap(100);
  store.priceDirty = new Set();
  store.ctx = {
    settings: { storeCountry: 'RU' },
    publicFetch: async url =>
      url.includes('/search/results/')
        ? response({ results_html: steamRow(1, 50) + steamRow(2, 30), total_count: 2 })
        : response({ response: { store_items: [] } }),
  };
  store.epicFetch = async () => ({ ok: false, status: 403 });
  const r = await store.deals({ provider: 'all' });
  assert.deepEqual(
    r.items.map(g => g.id),
    ['steam:1', 'steam:2']
  );
  assert.deepEqual(r.errors, ['Epic Games: HTTP 403']);
  assert.deepEqual(r.next, { steamStart: 50, epicStart: null });
  assert.equal(store.index.get('steam:1').storeOffers[0].discount, 50, 'opens as a store page');
  // A failed answer is not cached: the next request asks again.
  store.epicFetch = async () =>
    response({
      data: {
        Catalog: {
          searchStore: {
            elements: [
              {
                id: 'e',
                namespace: 'ns',
                title: 'Epic e',
                categories: [{ path: 'games/edition/base' }],
                keyImages: [],
                price: {
                  totalPrice: { currencyCode: 'RUB', originalPrice: 1000, discountPrice: 500, fmtPrice: {} },
                },
              },
            ],
            paging: { total: 1 },
          },
        },
      },
    });
  const again = await store.deals({ provider: 'all' });
  assert.deepEqual(
    again.items.map(g => g.id),
    ['steam:1', 'epic:e', 'steam:2']
  );
  assert.deepEqual(again.errors, []);
  // Only Epic; a store with no more pages is not asked.
  const epicOnly = await store.deals({ provider: 'epic', steamStart: 0, epicStart: null });
  assert.deepEqual(epicOnly.items, []);
  await assert.rejects(store.deals({ provider: 'gog' }), /магазин/);
});

// The window's scripts share one global scope: a second top-level declaration of the
// same name stops the whole window (let/const) or silently replaces a function.
test('window scripts declare each top-level name once', () => {
  const espree = require('espree');
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([\w.-]+\.js)"><\/script>/g)]
    .map(m => m[1])
    .filter(f => f !== 'demo.js');
  assert.ok(scripts.includes('app-deals.js'));
  const seen = new Map();
  const dups = [];
  for (const file of scripts) {
    const ast = espree.parse(fs.readFileSync(path.join(__dirname, '../ui', file), 'utf8'), {
      ecmaVersion: 2024,
      sourceType: 'script',
    });
    for (const n of ast.body) {
      const names =
        n.type === 'FunctionDeclaration'
          ? [n.id.name]
          : n.type === 'VariableDeclaration'
            ? n.declarations.filter(d => d.id.type === 'Identifier').map(d => d.id.name)
            : [];
      for (const name of names) {
        if (seen.has(name)) dups.push(`${name}: ${seen.get(name)} и ${file}`);
        seen.set(name, file);
      }
    }
  }
  assert.deepEqual(dups, []);
});
