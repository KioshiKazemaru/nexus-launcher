// Steam Families in the window: labels in the library and on the game page,
// the «Семейная библиотека» filter, the profile counts and its empty state.
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

function mockApi(connected) {
  const ME = '76561198000000001',
    MOM = '76561198000000009';
  const steam = (i, extra) => ({
    id: 'steam:' + (2000 + i),
    name: 'Game ' + i,
    steam: String(2000 + i),
    playtime: 0,
    lastPlayed: 0,
    collections: [],
    librarySource: extra.librarySource,
    offers: [{ provider: 'steam', appId: String(2000 + i), installed: true, accountIds: [], ...extra }],
  });
  const games = connected
    ? [
        steam(0, { librarySource: 'family', familyOwners: [{ id: MOM, name: 'Мама' }] }),
        steam(1, { librarySource: 'unconfirmed' }),
        steam(2, { librarySource: 'own', owned: true, accountIds: [ME] }),
      ]
    : [0, 1, 2].map(i => steam(i, { librarySource: 'local' }));
  const account = { key: 'steam:0', provider: 'steam', status: 'connected', id: ME, name: 'Kid' };
  const state = {
    catalog: [],
    games,
    ownedOffers: [],
    native: true,
    platform: 'win32',
    version: '0.12.15',
    online: true,
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
    accounts: connected
      ? { steam: { status: 'connected', name: 'Kid' }, epic: { status: 'signedOut' } }
      : { steam: { status: 'signedOut' }, epic: { status: 'signedOut' } },
    accountList: connected ? [account] : [],
    libraryAccounts: connected
      ? [{ ...account, library: { status: 'ready', count: 1, checkedAt: Date.now() } }]
      : [],
    libraryState: {},
    suggestions: [],
    integrations: {},
    free: { checkedAt: Date.now(), current: [], upcoming: [] },
    updater: { status: 'current' },
    warnings: [],
  };
  const stats = connected
    ? {
        games: 1,
        family: 1,
        unconfirmed: 1,
        foundOnPc: 1,
        installed: 2,
        played: 0,
        neverPlayed: 2,
        minutes: 0,
        playedThisMonth: 0,
        byProvider: {
          steam: { games: 1, family: 1, minutes: 0 },
          epic: { games: 0, family: 0, minutes: 0 },
          custom: { games: 0, family: 0, minutes: 0 },
        },
        top: [],
      }
    : {
        games: 0,
        family: 0,
        unconfirmed: 0,
        foundOnPc: 3,
        installed: 0,
        played: 0,
        neverPlayed: 0,
        minutes: 0,
        playedThisMonth: 0,
        byProvider: {
          steam: { games: 0, family: 0, minutes: 0 },
          epic: { games: 0, family: 0, minutes: 0 },
          custom: { games: 0, family: 0, minutes: 0 },
        },
        top: [],
      };
  const profile = {
    steamProfile: connected ? { id: ME, name: 'Kid', recent: [] } : null,
    epic: [],
    accounts: connected ? [{ provider: 'steam', name: 'Kid', id: ME }] : [],
    stats,
    achievements: [],
    status: 'online',
  };
  const reply = (name, payload) => {
    switch (name) {
      case 'libraryView':
        state.settings.libraryView = payload;
        return state;
      case 'profile':
        return profile;
      case 'profileComments':
        return { comments: [], total: 0, canPost: false };
      case 'homeCatalog':
        return { items: [], promotions: [], providers: {}, checkedAt: Date.now(), free: state.free };
      case 'browseDlc':
        return { items: [], checkedAt: Date.now() };
      case 'gamePrices':
        return { id: '', country: 'RU', storeOffers: [] };
      case 'getArtwork':
      case 'achievements':
        throw Error('offline');
      case 'toggle':
      case 'preferred':
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

async function open(browser, connected) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.addInitScript(mockApi, connected);
  // Covers come from the Steam CDN, which this test never waits for.
  await p.route(/^https?:/, r => r.abort());
  await p.goto(page);
  await p.waitForTimeout(400);
  return { p, errors };
}

test(
  'Steam account: family owner on cards and the game page, the family filter, own and family counted apart',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const { p, errors } = await open(browser, true);
      await p.click('button.nav[data-page="library"]');
      await p.waitForTimeout(200);
      // «Имеющиеся»: own, family and unconfirmed games are all there, with their labels.
      assert.equal(await p.locator('.library-grid .library-card').count(), 3);
      const family = p.locator('.library-card:has-text("Game 0") .pill.source-family');
      assert.equal(await family.textContent(), 'Семья');
      assert.equal(await family.getAttribute('title'), 'Семейная библиотека · владелец: Мама');
      assert.equal(
        await p.locator('.library-card:has-text("Game 1") .pill.source-unconfirmed').getAttribute('title'),
        'Доступна через Steam (не на вашем аккаунте)'
      );
      assert.equal(await p.locator('.library-card:has-text("Game 2") .pill[class*="source-"]').count(), 0);
      // The left panel: «Семейная библиотека» shows only the family games.
      await p.selectOption('#side-source', 'family');
      await p.waitForTimeout(150);
      assert.equal(await p.locator('.library-grid .library-card').count(), 1);
      assert.match(await p.locator('#library-tree').textContent(), /Game 0/);
      assert.doesNotMatch(await p.locator('#library-tree').textContent(), /Game 2/);
      await p.selectOption('#side-source', 'all');
      // The game page says where the game comes from.
      await p.click('.library-card:has-text("Game 0") [data-detail]');
      await p.waitForTimeout(200);
      assert.equal(
        (await p.locator('.library-source.source-family').textContent()).trim(),
        'Семейная библиотека · владелец: Мама'
      );
      // Profile: «Steam: 1 игра · из семьи: 1».
      await p.click('[data-page="profile"]');
      await p.waitForTimeout(300);
      const side = await p.locator('.sp-stats').first().textContent();
      assert.match(side, /Из семейной библиотеки\s*1/);
      assert.match(
        await p.locator('.sp-stats', { hasText: 'По платформам' }).textContent(),
        /1 игра · из семьи: 1/
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'no account: found games only in «Скачанные» with «Найдено на ПК»; the profile has no numbers',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const { p, errors } = await open(browser, false);
      await p.click('button.nav[data-page="library"]');
      await p.waitForTimeout(200);
      assert.equal(await p.locator('.library-grid .library-card').count(), 0, '«Имеющиеся» is empty');
      await p.click('[data-library-view="installed"]');
      await p.waitForTimeout(200);
      assert.equal(await p.locator('.library-grid .library-card').count(), 3);
      assert.equal(await p.locator('.library-card .pill.source-local').count(), 3);
      assert.equal(
        await p.locator('.library-card .pill.source-local').first().textContent(),
        'Найдено на ПК'
      );
      await p.click('[data-page="profile"]');
      await p.waitForTimeout(300);
      const text = await p.locator('#main').textContent();
      assert.match(text, /Подключите аккаунт Steam или Epic Games/);
      assert.match(text, /найдено 3 игры/);
      assert.equal(await p.locator('.stat-tile, .sp-stat').count(), 0, 'no statistics');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);
