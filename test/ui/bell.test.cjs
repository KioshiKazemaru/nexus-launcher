// The bell in the top strip, and «Профиль» that follows the accounts signing in.
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
  const now = Date.now();
  const state = {
    catalog: [
      {
        id: 'steam:10',
        name: 'Hades',
        steam: '10',
        tags: [],
        storeOffers: [{ provider: 'steam', appId: '10', country: 'RU', discount: 50, price: '500 ₽' }],
      },
    ],
    games: [],
    ownedOffers: [],
    native: true,
    platform: 'win32',
    version: '0.13.5',
    online: true,
    settings: {
      remember: {},
      preferred: {},
      favorites: [],
      wishlist: ['steam:10'],
      wishlistFrom: {},
      recent: [],
      storeCountry: 'RU',
      libraryView: 'owned',
      priceWatches: [],
      collections: [],
      hidden: [],
      notifyWishSales: true,
      notices: [
        {
          id: 'n1',
          kind: 'sale',
          title: 'Hades: −50%',
          body: 'Steam · 500 ₽ до 18 ноября',
          gameId: 'steam:10',
          at: now - 5 * 60000,
          read: false,
        },
        {
          id: 'n2',
          kind: 'update',
          title: 'Вышла новая версия Nexus 0.14.0',
          body: 'Скачайте и установите',
          at: now - 3 * 86400000,
          read: true,
        },
      ],
    },
    accounts: { steam: { status: 'signedOut' }, epic: { status: 'signedOut' } },
    accountList: [],
    libraryAccounts: [],
    libraryState: {},
    suggestions: [],
    integrations: {},
    free: { checkedAt: now, current: [], upcoming: [] },
    updater: { status: 'current' },
    warnings: [],
  };
  const calls = [];
  window.__calls = calls;
  window.__state = state;
  const reply = (name, payload) => {
    calls.push([name, payload]);
    const s = state.settings;
    switch (name) {
      case 'noticesRead':
        s.notices = s.notices.map(n => ({ ...n, read: true }));
        return state;
      case 'noticeRemove':
        s.notices = s.notices.filter(n => n.id !== payload);
        return state;
      case 'noticesClear':
        s.notices = [];
        return state;
      case 'profile':
        return {
          accounts: [],
          stats: { foundOnPc: 0, games: 0, top: [], byProvider: {} },
          achievements: [],
        };
      case 'homeCatalog':
        return { items: [], promotions: [], providers: {}, checkedAt: now, free: state.free };
      case 'browseDlc':
        return { items: [], checkedAt: now };
      case 'gamePrices':
        return { id: payload.id, country: 'RU', storeOffers: state.catalog[0].storeOffers };
      case 'getArtwork':
      case 'achievements':
      case 'friends':
        throw Error('offline');
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
  'the bell: unread count, opening reads them, open, remove and clear',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockApi);
      await p.goto(page);
      await p.waitForTimeout(400);
      assert.equal(await p.locator('#bell-count').innerText(), '1');
      assert.ok(await p.locator('#bell').evaluate(b => b.classList.contains('has-unread')));
      assert.ok(await p.locator('#bell-panel').isHidden());

      await p.click('#bell');
      await p.waitForTimeout(150);
      const panel = p.locator('#bell-panel');
      assert.ok(await panel.isVisible());
      assert.match(
        await panel.innerText(),
        /Hades: −50%[\s\S]*5 мин назад|Скидка · 5 мин назад[\s\S]*Hades: −50%/
      );
      assert.match(await panel.innerText(), /Вышла новая версия Nexus 0\.14\.0/);
      // Read on opening; the new one stays marked while the panel is open.
      assert.ok(await p.evaluate(() => window.__calls.some(c => c[0] === 'noticesRead')));
      assert.ok(await p.locator('#bell-count').isHidden());
      assert.equal(await panel.locator('.bell-item.unread').count(), 1);
      // Escape closes; a click outside too.
      await p.keyboard.press('Escape');
      assert.ok(await panel.isHidden());
      await p.click('#bell');
      await p.click('#content', { position: { x: 10, y: 10 } });
      assert.ok(await panel.isHidden());

      // A sale opens its game; the update notice opens «Аккаунты».
      await p.click('#bell');
      await p.click('[data-bell-open="n1"]');
      await p.waitForTimeout(200);
      assert.ok(await panel.isHidden());
      assert.equal(await p.evaluate(() => detailId), 'steam:10');
      await p.click('#bell');
      await p.click('[data-bell-open="n2"]');
      await p.waitForTimeout(150);
      assert.equal(await p.evaluate(() => page), 'accounts');
      assert.ok(await p.locator('#notify-wish-sales').isChecked());

      // Remove one, then clear all.
      await p.click('#bell');
      await p.click('[data-bell-remove="n1"]');
      await p.waitForTimeout(100);
      assert.equal(await panel.locator('.bell-item').count(), 1);
      await p.click('[data-bell-clear]');
      await p.waitForTimeout(100);
      assert.match(await panel.innerText(), /Пока ничего нет/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  '«Профиль» opened before the sign-in loads again when the account connects',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockApi);
      await p.goto(page);
      await p.waitForTimeout(400);
      await p.click('button.nav[data-page="profile"]');
      await p.waitForTimeout(200);
      const profileCalls = () => p.evaluate(() => window.__calls.filter(c => c[0] === 'profile').length);
      assert.equal(await profileCalls(), 1);
      assert.match(await p.locator('#content').innerText(), /Подключите аккаунт/);
      // ↻ is there even with no account.
      await p.click('#profile-refresh');
      await p.waitForTimeout(150);
      assert.equal(await profileCalls(), 2);
      // Steam finishes signing in: the profile loads again by itself.
      await p.evaluate(() => {
        const s = window.__state;
        window.__push({
          ...s,
          accounts: { ...s.accounts, steam: { status: 'connected', name: 'Me' } },
          accountList: [{ key: 'steam:0', provider: 'steam', status: 'connected', id: '765', name: 'Me' }],
        });
      });
      await p.waitForTimeout(300);
      assert.equal(await profileCalls(), 3);
      // Same accounts: no more loads.
      await p.evaluate(() =>
        window.__push({
          ...window.__state,
          accountList: [{ key: 'steam:0', provider: 'steam', status: 'connected', id: '765', name: 'Me' }],
        })
      );
      await p.waitForTimeout(300);
      assert.equal(await profileCalls(), 3);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'top strip menus open on a click (not on hover), switch on hover while open, close on a pick, outside or Esc',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockApi);
      await p.goto(page);
      await p.waitForTimeout(300);
      const view = p.locator('.client-menu .nav-group').nth(1); // Nexus, Вид, Друзья, Игры, Справка
      const games = p.locator('.client-menu .nav-group').nth(3);
      const menuOf = g => g.locator('.nav-menu');
      await view.locator('> button').hover();
      await p.waitForTimeout(150);
      assert.ok(await menuOf(view).isHidden(), 'hover alone does not open it');
      await view.locator('> button').click();
      assert.ok(await menuOf(view).isVisible(), 'a click opens it');
      assert.equal(await view.locator('> button').getAttribute('aria-expanded'), 'true');
      await games.locator('> button').hover();
      await p.waitForTimeout(100);
      assert.ok(await menuOf(games).isVisible(), 'moving to another one switches while open');
      assert.ok(await menuOf(view).isHidden());
      await p.keyboard.press('Escape');
      assert.ok(await menuOf(games).isHidden(), 'Esc closes');
      await view.locator('> button').click();
      await p.mouse.click(700, 600);
      assert.ok(await menuOf(view).isHidden(), 'a click elsewhere closes');
      await view.locator('> button').click();
      await menuOf(view).locator('[data-page="downloads"]').click();
      await p.waitForTimeout(150);
      assert.ok(await menuOf(view).isHidden(), 'a pick closes');
      assert.equal(await p.evaluate(() => page), 'downloads');
      // The big tabs still open on hover.
      await p.hover('button.nav[data-page="store"]');
      await p.waitForTimeout(150);
      assert.ok(await p.locator('button.nav[data-page="store"] + .nav-menu').isVisible());
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);
