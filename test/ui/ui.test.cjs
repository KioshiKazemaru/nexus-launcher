// Browser tests of the window (ui/) with a mocked `window.nexus` API.
// Run with `npm run test:ui` (needs the `playwright` dev dependency and
// `npx playwright install chromium`). Skipped when Playwright is missing.
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
  const now = Date.now();
  const games = [];
  for (let i = 0; i < 300; i++)
    games.push({
      id: 'steam:' + (1000 + i),
      name: 'Game ' + String(i).padStart(3, '0'),
      steam: String(1000 + i),
      playtime: i * 7,
      lastPlayed: 0,
      portrait: 'nexus-art://steam/' + (1000 + i) + '/portrait',
      hidden: i === 5,
      collections: i < 3 ? ['c1'] : [],
      progress: i === 7 ? { state: 'downloading', percent: 40 } : null,
      offers: [
        {
          provider: 'steam',
          appId: String(1000 + i),
          owned: true,
          installed: i % 3 === 0,
          accountIds: ['76561198000000001'],
        },
      ],
    });
  games.push({
    id: 'cyber',
    name: 'Cyberpunk 2077',
    steam: '1091500',
    mergedBy: 'title',
    playtime: 120,
    collections: [],
    offers: [
      {
        provider: 'steam',
        appId: '1091500',
        owned: true,
        installed: true,
        playtime: 100,
        accountIds: ['a', 'b'],
      },
      {
        provider: 'epic',
        appId: 'cp',
        namespace: 'n',
        itemId: 'i',
        owned: true,
        installed: false,
        playtime: 20,
      },
    ],
    storeOffers: [
      {
        provider: 'steam',
        appId: '1091500',
        amount: 999,
        currency: 'RUB',
        price: '999 ₽',
        country: 'RU',
        priceStatus: 'ready',
        url: 'https://store.steampowered.com/app/1091500/',
      },
      {
        provider: 'epic',
        appId: 'x',
        amount: 799,
        currency: 'RUB',
        price: '799 ₽',
        country: 'RU',
        priceStatus: 'ready',
        url: 'https://store.epicgames.com/p/cp',
      },
    ],
  });
  const state = {
    catalog: [],
    games,
    ownedOffers: [],
    native: true,
    platform: 'win32',
    version: '0.10.0',
    online: true,
    settings: {
      remember: { steam: true, epic: true },
      preferred: {},
      favorites: [],
      wishlist: [],
      recent: [],
      storeCountry: 'RU',
      libraryView: 'owned',
      priceWatches: [
        {
          key: 'k',
          name: 'Hades',
          provider: 'steam',
          country: 'RU',
          history: [{ at: now, amount: 1, currency: 'RUB' }],
          historyCount: 120,
          current: { amount: 1, currency: 'RUB' },
        },
      ],
      notifyGiveaways: true,
      autoUpdate: true,
      collections: [{ id: 'c1', name: 'Кооператив', games: games.slice(0, 3).map(g => g.id) }],
      hidden: ['steam:1005'],
    },
    accounts: {
      steam: { status: 'connected', name: 'Alpha' },
      epic: { status: 'connected', name: 'EpicA', purchaseAccount: null },
    },
    accountList: [
      { key: 'steam:0', provider: 'steam', status: 'connected', id: '76561198000000001', name: 'Alpha' },
      {
        key: 'epic:' + 'a'.repeat(32),
        provider: 'epic',
        status: 'connected',
        id: 'a'.repeat(32),
        name: 'EpicA',
      },
      {
        key: 'epic:' + 'b'.repeat(32),
        provider: 'epic',
        status: 'connected',
        id: 'b'.repeat(32),
        name: 'EpicB',
      },
    ],
    libraryAccounts: [
      {
        key: 'steam:0',
        provider: 'steam',
        status: 'connected',
        name: 'Alpha',
        library: { status: 'ready', count: 301, checkedAt: now },
      },
    ],
    libraryState: { steam: { status: 'ready' }, epic: { status: 'ready' } },
    suggestions: [
      {
        a: 'steam:359550',
        b: 'epic:n:r6',
        aName: 'Rainbow Six Siege',
        bName: 'Rainbow Six Siege X',
        score: 0.88,
      },
    ],
    integrations: {
      itad: { enabled: true },
      igdb: { enabled: false },
      sgdb: { enabled: false },
      steamWebApi: { enabled: false },
      encryption: true,
    },
    free: {
      checkedAt: now,
      current: [
        {
          appId: 'f1',
          namespace: 'n',
          name: 'Free Game',
          start: now - 1e8,
          end: now + 3e8,
          url: 'https://store.epicgames.com/p/free',
        },
      ],
      upcoming: [],
    },
    updater: { status: 'current' },
    warnings: [],
  };
  const calls = [];
  window.__calls = calls;
  window.__push = null;
  const reply = (name, payload) => {
    calls.push([name, payload]);
    switch (name) {
      case 'homeCatalog':
        return {
          items: games.slice(-1),
          promotions: [],
          providers: {},
          checkedAt: Date.now(),
          free: state.free,
        };
      case 'gameDeals':
        return {
          enabled: true,
          found: true,
          deals: [
            {
              shop: 'Steam',
              shopId: 61,
              price: { amount: 999, currency: 'RUB' },
              storeLow: { amount: 499, currency: 'RUB' },
            },
          ],
          historyLow: { amount: 499, currency: 'RUB' },
        };
      case 'gamePrices':
        return {
          id: payload.id,
          country: 'RU',
          storeOffers: games.find(g => g.id === payload.id)?.storeOffers || [],
        };
      case 'achievements':
        return {
          available: true,
          account: 'Alpha',
          total: 2,
          unlocked: 1,
          percent: 50,
          list: [
            { id: 'a', name: 'Первый', unlocked: true, unlockedAt: 1700000000 },
            { id: 'b', name: 'Второй', unlocked: false },
          ],
        };
      case 'browseDlc':
        return { items: [], checkedAt: Date.now() };
      case 'buy':
      case 'claimFree':
        return { opened: true, account: 'EpicB' };
      case 'getArtwork':
        throw Error('offline');
      case 'uninstallGame':
        return {
          result: { how: 'started' },
          state: {
            ...state,
            games: undefined,
            catalog: undefined,
            prices: undefined,
            progress: { [payload.id]: { state: 'uninstalling', provider: payload.provider, percent: 10 } },
          },
        };
      case 'toggle':
      case 'preferred':
      case 'stateUpdate':
        // Like the main process: replies omit the unchanged game list.
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
  'window works with a large library and the new features',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockApi);
      await p.goto(page);
      await p.waitForTimeout(500);
      // Giveaways with account choice (two Epic accounts).
      assert.equal(await p.locator('#claim-account option').count(), 2);
      await p.selectOption('#claim-account', 'epic:' + 'b'.repeat(32));
      await p.click('[data-claim]');
      // Library: lazy grid, hidden game excluded, collection filter.
      await p.click('button.nav[data-page="library"]');
      await p.waitForTimeout(200);
      assert.equal(await p.locator('.library-grid .library-card').count(), 120);
      assert.equal(await p.locator('text=Game 005').count(), 0);
      await p.check('#show-hidden');
      assert.ok((await p.locator('text=Game 005').count()) > 0);
      await p.click('[data-collection="c1"]');
      assert.equal(await p.locator('.library-grid .library-card').count(), 3);
      await p.click('[data-collection=""]');
      // A focused <select> must not block updates pushed from the main process.
      await p.selectOption('#library-sort', 'playtime');
      // Pushed status update without games (as the main process sends it).
      const push = library =>
        p.evaluate(library => {
          const base = {
            accountList: [{ key: 'steam:0', provider: 'steam', status: 'connected', name: 'Alpha' }],
            accounts: { steam: { status: 'connected', name: 'Alpha' }, epic: { status: 'signedOut' } },
            libraryState: {},
            suggestions: [{ a: 'steam:1', b: 'epic:n:x', aName: 'A', bName: 'A X', score: 0.9 }],
            settings: {
              remember: {},
              preferred: {},
              favorites: [],
              wishlist: [],
              recent: [],
              storeCountry: 'RU',
              libraryView: 'owned',
              priceWatches: [],
              collections: [],
              hidden: [],
            },
            warnings: [],
          };
          window.__push({
            ...base,
            libraryAccounts: [
              { key: 'steam:0', provider: 'steam', status: 'connected', name: 'Alpha', library },
            ],
          });
        }, library);
      await push({ status: 'loading', count: 5 });
      await p.waitForTimeout(200);
      assert.match(await p.locator('#library-status').innerText(), /Проверяем библиотеку/);
      assert.equal(
        await p.locator('.library-grid .library-card').count(),
        120,
        'games kept from the previous state'
      );
      // A price update changes only that card; the rest of the page is not re-rendered.
      await p.evaluate(() => {
        document
          .querySelector('.library-card[data-price-game="steam:1298"]')
          .setAttribute('data-marker', 'progress');
        document
          .querySelector('.library-card[data-price-game="steam:1297"]')
          .setAttribute('data-marker', 'untouched');
      });
      await p.evaluate(() =>
        window.__push({
          accountList: [{ key: 'steam:0', provider: 'steam', status: 'connected', name: 'Alpha' }],
          accounts: { steam: { status: 'connected', name: 'Alpha' }, epic: { status: 'signedOut' } },
          libraryState: {},
          libraryAccounts: [
            {
              key: 'steam:0',
              provider: 'steam',
              status: 'connected',
              name: 'Alpha',
              library: { status: 'ready', count: 6, checkedAt: Date.now() },
            },
          ],
          suggestions: [{ a: 'steam:1', b: 'epic:n:x', aName: 'A', bName: 'A X', score: 0.9 }],
          settings: {
            remember: {},
            preferred: {},
            favorites: [],
            wishlist: [],
            recent: [],
            storeCountry: 'RU',
            libraryView: 'owned',
            priceWatches: [],
            collections: [],
            hidden: [],
          },
          warnings: [],
          pricesDelta: {
            'steam:1299': {
              o: [
                {
                  provider: 'steam',
                  appId: '1299',
                  amount: 123,
                  currency: 'RUB',
                  price: '123 ₽',
                  country: 'RU',
                  priceStatus: 'ready',
                },
              ],
              n: 'Game 000',
              i: '',
            },
          },
          progress: { 'steam:1298': { state: 'downloading', percent: 70 } },
        })
      );
      await p.waitForTimeout(200);
      assert.equal(
        await p.locator('[data-marker="progress"]').count(),
        0,
        'card with new progress was redrawn'
      );
      assert.equal(
        await p.locator('[data-marker="untouched"]').count(),
        1,
        'other cards were not re-rendered'
      );
      assert.match(await p.locator('.library-card[data-price-game="steam:1299"]').textContent(), /123/);
      assert.equal(await p.locator('.card-progress i[style*="70%"]').count(), 1);
      // The suggestions panel stays open across updates.
      await p.click('.merge-suggestions summary');
      await push({ status: 'ready', count: 6, checkedAt: Date.now() });
      await p.waitForTimeout(200);
      assert.equal(await p.locator('.merge-suggestions').getAttribute('open'), '');
      // Game page: achievements, collections, client actions, merged note.
      await p.fill('#search', 'Cyber');
      await p.click('.library-card [data-detail]');
      await p.waitForTimeout(300);
      assert.match(await p.locator('.library-game-page').innerText(), /ДОСТИЖЕНИЯ · 1\/2/);
      // "Удалить" removes the game right in Nexus (the main process asks first).
      await p.click('[data-uninstall]');
      assert.deepEqual(
        await p.evaluate(() => window.__calls.filter(c => c[0] === 'uninstallGame').map(c => c[1])),
        [{ id: 'cyber', provider: 'steam' }]
      );
      assert.match(await p.locator('#toast').textContent(), /Удаление началось/);
      assert.equal(await p.locator('[data-uninstall]').isDisabled(), true);
      assert.match(await p.locator('.library-game-page').innerText(), /Удаление/);
      assert.ok(await p.locator('[data-split]').count());
      // A reply without the game list keeps the library intact.
      await p.click('#library-favorite');
      await p.waitForTimeout(150);
      assert.match(await p.locator('.library-game-page h1').textContent(), /Cyberpunk/);
      // Updates that arrive while typing wait until the field loses focus.
      await p.click('button.nav[data-page="accounts"]');
      await p.fill('[data-key-input="itad"]', 'typing…');
      await p.evaluate(() =>
        window.__push({
          accountList: [{ key: 'steam:0', provider: 'steam', status: 'connected', id: '1', name: 'Renamed' }],
          accounts: { steam: { status: 'connected', name: 'Renamed' }, epic: { status: 'signedOut' } },
          libraryState: {},
          libraryAccounts: [],
          suggestions: [],
          settings: {
            remember: {},
            preferred: {},
            favorites: [],
            wishlist: [],
            recent: [],
            storeCountry: 'RU',
            libraryView: 'owned',
            priceWatches: [],
            collections: [],
            hidden: [],
          },
          warnings: [],
          games: [
            {
              id: 'steam:1',
              name: 'Новая игра',
              steam: '1',
              offers: [{ provider: 'steam', appId: '1', owned: true }],
            },
          ],
        })
      );
      await p.waitForTimeout(150);
      assert.equal(
        await p.inputValue('[data-key-input="itad"]'),
        'typing…',
        'the field is not wiped while typing'
      );
      await p.click('h1');
      await p.waitForTimeout(150);
      assert.match(await p.locator('#content').textContent(), /Renamed/);
      await p.click('button.nav[data-page="library"]');
      await p.waitForTimeout(150);
      assert.match(
        await p.locator('.library-grid').textContent(),
        /Новая игра/,
        'postponed game list applied'
      );
      // Offline banner.
      await p.context().setOffline(true);
      await p.waitForTimeout(100);
      assert.equal(await p.locator('#offline-banner').isVisible(), true);
      await p.context().setOffline(false);
      // Returning to the window asks only for changes, never the whole state again.
      const before = await p.locator('.library-grid .library-card').count();
      const fullBefore = await p.evaluate(() => window.__calls.filter(c => c[0] === 'state').length);
      await p.evaluate(() => window.dispatchEvent(new Event('focus')));
      await p.waitForTimeout(150);
      assert.equal(await p.evaluate(() => window.__calls.filter(c => c[0] === 'state').length), fullBefore);
      assert.ok(await p.evaluate(() => window.__calls.some(c => c[0] === 'stateUpdate')));
      assert.equal(await p.locator('.library-grid .library-card').count(), before, 'game list kept');
      assert.deepEqual(errors, []);
      const names = await p.evaluate(() => window.__calls.map(c => c[0]));
      for (const n of ['claimFree', 'achievements']) assert.ok(names.includes(n), n);
      const claim = await p.evaluate(() => window.__calls.find(c => c[0] === 'claimFree')[1]);
      assert.equal(claim.account, 'epic:' + 'b'.repeat(32));
    } finally {
      await browser.close();
    }
  }
);

test('demo mode without the native API', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(page);
    await p.waitForTimeout(400);
    await p.click('button.nav[data-page="accounts"]');
    await p.click('#demo');
    await p.click('.library-card [data-detail]');
    await p.click('[data-library-back]');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
