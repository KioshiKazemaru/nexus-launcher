// «Желаемое» and «Скидки» in the window: where each wishlist game came from, the
// filters, the end date of a discount, the store sale list page by page.
// Run with `npm run test:ui`; skipped without Playwright.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  { pathToFileURL } = require('node:url');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {}
const page = pathToFileURL(path.join(__dirname, '../../ui/index.html')).href;

function mockApi() {
  const DAY = 86400000;
  const end = Date.now() + 5 * DAY;
  const offer = (provider, appId, amount, discount, extra = {}) => ({
    provider,
    appId,
    country: 'RU',
    currency: 'RUB',
    amount,
    price: amount + ' ₽',
    discount,
    priceStatus: 'ready',
    ...extra,
  });
  const catalog = [
    {
      id: 'steam:10',
      name: 'Steam Wish',
      steam: '10',
      tags: [],
      storeOffers: [offer('steam', '10', 500, 50, { saleEnd: end, originalPrice: '1000 ₽' })],
    },
    { id: 'epic:aa', name: 'Epic Wish', tags: [], storeOffers: [offer('epic', 'aa', 900, 0)] },
    {
      id: 'steam:30',
      name: 'Both Wish',
      steam: '30',
      tags: [],
      storeOffers: [offer('steam', '30', 300, 0), offer('epic', 'bb', 200, 20, { saleEnd: end + DAY })],
    },
    {
      id: 'steam:40',
      name: 'Nexus Wish',
      steam: '40',
      tags: [],
      storeOffers: [offer('steam', '40', 100, 0)],
    },
  ];
  const state = {
    catalog,
    games: [],
    ownedOffers: [],
    native: true,
    platform: 'win32',
    version: '0.13.2',
    online: true,
    settings: {
      remember: {},
      preferred: {},
      favorites: [],
      wishlist: ['steam:10', 'epic:aa', 'steam:30', 'steam:40'],
      wishlistFrom: {
        'steam:10': ['steam:765'],
        'epic:aa': ['epic:e1'],
        'steam:30': ['steam:765', 'epic:e1'],
        'steam:40': ['nexus'],
      },
      recent: [],
      storeCountry: 'RU',
      libraryView: 'owned',
      priceWatches: [],
      collections: [],
      hidden: [],
    },
    accounts: { steam: { status: 'connected', name: 'Me' }, epic: { status: 'connected', name: 'Me' } },
    accountList: [
      { key: 'steam:0', provider: 'steam', status: 'connected', id: '765', name: 'Me' },
      { key: 'epic:e1', provider: 'epic', status: 'connected', id: 'e1', name: 'Me' },
    ],
    libraryAccounts: [],
    libraryState: {},
    suggestions: [],
    integrations: {},
    free: { checkedAt: Date.now(), current: [], upcoming: [] },
    updater: { status: 'current' },
    wishlistSync: {
      running: false,
      at: Date.now() - 60000,
      errors: ['Epic Games (Me): нужно войти в магазин Epic'],
      storeSignIn: [{ key: 'epic:e1', name: 'Me' }],
    },
    warnings: [],
  };
  const deal = (i, provider) => ({
    id: `${provider}:${i}`,
    name: `Deal ${provider} ${i}`,
    ...(provider === 'steam' ? { steam: String(i) } : {}),
    tags: [],
    storeOffers: [offer(provider, String(i), 100 + i, 10 + i, { saleEnd: end + i * DAY })],
  });
  const calls = [];
  window.__calls = calls;
  const reply = (name, payload) => {
    calls.push([name, payload]);
    switch (name) {
      case 'deals': {
        const first = !payload.steamStart && !payload.epicStart;
        return {
          items: first ? [deal(1, 'steam'), deal(2, 'epic')] : [deal(3, 'steam')],
          totals: { steam: 6413, epic: 812 },
          next: first ? { steamStart: 50, epicStart: null } : { steamStart: null, epicStart: null },
          errors: [],
          country: 'RU',
          checkedAt: Date.now(),
        };
      }
      case 'syncWishlists':
        return { report: { steam: 1, epic: 0, removed: 2, errors: [] }, state };
      case 'homeCatalog':
        return { items: [], promotions: [], providers: {}, checkedAt: Date.now(), free: state.free };
      case 'browseDlc':
        return { items: [], checkedAt: Date.now() };
      case 'gamePrices':
        return {
          id: payload.id,
          country: 'RU',
          storeOffers: catalog.find(g => g.id === payload.id)?.storeOffers || [],
        };
      case 'getArtwork':
      case 'achievements':
        throw Error('offline');
      case 'toggle': {
        const s = state.settings;
        s.wishlist = s.wishlist.includes(payload.id)
          ? s.wishlist.filter(x => x !== payload.id)
          : [...s.wishlist, payload.id];
        return { ...state, games: undefined, prices: undefined };
      }
      case 'stateUpdate':
        return { ...state, games: undefined, catalog: undefined, prices: undefined };
      default:
        return state;
    }
  };
  window.nexus = new Proxy(
    { onStateChanged: cb => (window.__push = cb), onShowPage() {}, onToast() {} },
    { get: (t, k) => (k in t ? t[k] : async p => reply(k, p)) }
  );
}

test(
  'wishlist: where each game came from, filters, discount end, sync and removal',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockApi);
      await p.goto(page);
      await p.waitForTimeout(400);
      await p.click('button.nav[data-page="wishlist"]');
      await p.waitForTimeout(150);
      const content = p.locator('#content');
      assert.match(await content.innerText(), /4 игр/);
      assert.match(await content.innerText(), /Синхронизировано со Steam и Epic/);
      assert.match(
        await content.innerText(),
        /нужно войти в магазин Epic/,
        'an account that failed is shown'
      );
      // «Войти в магазин Epic» opens the store window of that account.
      await p.click('[data-epic-store-signin="epic:e1"]');
      await p.waitForTimeout(100);
      assert.deepEqual(await p.evaluate(() => window.__calls.find(c => c[0] === 'epicStoreSignIn')), [
        'epicStoreSignIn',
        'epic:e1',
      ]);
      const card = name => p.locator('.game-card', { hasText: name });
      assert.match(await card('Both Wish').innerText(), /Желаемое Steam[\s\S]*Желаемое Epic Games/);
      assert.match(await card('Nexus Wish').innerText(), /Добавлено в Nexus/);
      // The discount and the day it ends.
      assert.match(await card('Steam Wish').innerText(), /−50%[\s\S]*до \d+ [а-я]+/);
      // Filters with counts.
      assert.match(await p.locator('[data-wish-filter="steam"]').innerText(), /2/);
      await p.click('[data-wish-filter="epic"]');
      assert.equal(await p.locator('#content .game-card').count(), 2);
      await p.click('[data-wish-filter="sale"]');
      assert.deepEqual(await p.locator('#content .game-card .card-info > strong').allTextContents(), [
        'Steam Wish',
        'Both Wish',
      ]);
      await p.click('[data-wish-filter="nexus"]');
      assert.deepEqual(await p.locator('#content .game-card .card-info > strong').allTextContents(), [
        'Nexus Wish',
      ]);
      await p.click('[data-wish-filter="all"]');
      await p.selectOption('#wish-sort', 'name');
      assert.equal(
        await p.locator('#content .game-card .card-info > strong').first().textContent(),
        'Both Wish'
      );
      // Sync now.
      await p.click('#sync-wishlists');
      await p.waitForTimeout(150);
      assert.match(await p.locator('#toast').innerText(), /новых из Steam 1, из Epic 0, убрано 2/);
      // Removing a Steam wishlist game in Nexus: it stays on the Steam wishlist.
      await card('Steam Wish').locator('[data-wish]').click();
      await p.waitForTimeout(150);
      assert.match(await p.locator('#toast').innerText(), /В списке желаемого Steam игра остаётся/);
      assert.equal(await card('Steam Wish').count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'discounts: wishlist games on sale first, store sales page by page with end dates',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockApi);
      await p.goto(page);
      await p.waitForTimeout(400);
      await p.click('button.nav[data-page="tracking"]');
      await p.waitForTimeout(300);
      const blocks = p.locator('.deals-block');
      // Wishlist games on sale, the one ending sooner first.
      assert.deepEqual(await blocks.nth(0).locator('.game-card strong').allInnerTexts(), [
        'Steam Wish',
        'Both Wish',
      ]);
      const store = p.locator('.deals-block', { hasText: 'Все скидки магазинов' });
      assert.match(await store.innerText(), /Steam: 6\s?413 · Epic Games: 812 игр со скидкой/);
      assert.equal(await store.locator('.game-card').count(), 2);
      assert.match(await store.locator('.game-card').first().innerText(), /−11%[\s\S]*до \d+ [а-я]+/);
      // The next page.
      await p.click('#deals-more');
      await p.waitForTimeout(200);
      assert.equal(await store.locator('.game-card').count(), 3);
      assert.equal(await p.locator('#deals-more').count(), 0, 'no more pages');
      const more = await p.evaluate(() => window.__calls.filter(c => c[0] === 'deals').map(c => c[1]));
      assert.deepEqual(more[1], { provider: 'all', sort: 'popular', steamStart: 50, epicStart: null });
      // The discount order sorts the loaded games.
      await p.selectOption('#deals-sort', 'discount');
      await p.waitForTimeout(100);
      assert.equal(await store.locator('.game-card strong').first().innerText(), 'Deal steam 3');
      // Another store reloads from its first page.
      await p.click('[data-deals-provider="epic"]');
      await p.waitForTimeout(200);
      const last = await p.evaluate(() => window.__calls.filter(c => c[0] === 'deals').at(-1)[1]);
      assert.equal(last.provider, 'epic');
      assert.equal(last.steamStart, 0);
      // A store game opens its store page.
      await store.locator('.game-card [data-detail]').first().click();
      await p.waitForTimeout(200);
      assert.deepEqual(await p.evaluate(() => [page, detailId]), ['game', 'epic:2']);
      assert.match(await p.locator('#content').innerText(), /Deal epic 2/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);
