// Store front in the window, modelled on the Steam store: carousel with
// screenshots and reviews, one price format, categories, price shelf.
// Run with `npm run test:ui`; skipped when Playwright is missing.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  { pathToFileURL } = require('node:url');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {}
const page = pathToFileURL(path.join(__dirname, '../../ui/index.html')).href;

function mockStore(options = {}) {
  const shot = n =>
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${n}/ss_${n}.600x338.jpg`;
  const items = [];
  for (let i = 0; i < 16; i++) {
    const steam = i % 4 !== 3;
    items.push({
      id: steam ? 'steam:' + (100 + i) : 'epic:e' + i,
      name: 'Game ' + i,
      steam: steam ? String(100 + i) : undefined,
      tags: steam ? [i % 2 ? 'Экшен' : 'Хоррор', 'Кооператив', i % 3 ? 'Инди' : 'Стратегия'] : [],
      desc: 'Описание ' + i,
      capsule: steam
        ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${100 + i}/capsule.jpg`
        : '',
      reviews: steam ? { label: 'Очень положительные', score: 8, percent: 91, count: 12345 } : null,
      released: Date.now() - 400 * 86400000,
      storeOffers: [
        steam
          ? {
              provider: 'steam',
              appId: String(100 + i),
              country: 'US',
              currency: 'USD',
              amount: 4.99 + i,
              // Steam store pages write prices this way.
              price: '$' + (4 + i) + '.99',
              priceStatus: 'ready',
              screenshots: [shot(1), shot(2), shot(3), shot(4)],
              ...(i === 0 ? { discount: 50, originalPrice: '$9.99' } : {}),
            }
          : {
              provider: 'epic',
              appId: 'e' + i,
              country: 'US',
              currency: 'USD',
              amount: 0,
              // Epic writes "0" for free games.
              price: '0',
              priceStatus: 'ready',
            },
      ],
    });
  }
  const state = {
    catalog: [],
    // With options.library: one Steam and one Epic game on the accounts.
    games: options.library
      ? [
          {
            id: 'steam:1145360',
            name: 'Hades',
            tags: [],
            offers: [{ provider: 'steam', appId: '1145360', owned: true, playtime: 2700 }],
          },
          {
            id: 'epic:Salt',
            name: 'Slay the Spire',
            tags: [],
            offers: [{ provider: 'epic', appId: 'Salt', owned: true, playtime: 1500 }],
          },
        ]
      : options.friends
        ? // The running game is installed in the library.
          [
            {
              id: 'steam:100',
              name: 'Game 0',
              tags: [],
              offers: [{ provider: 'steam', appId: '100', installed: true, owned: true }],
            },
          ]
        : [],
    // The Steam game of the library is owned: it must never be offered in the carousel.
    ownedOffers: options.library ? [{ provider: 'steam', appId: '1145360' }] : [],
    native: true,
    platform: 'win32',
    version: '0.10.4',
    online: true,
    settings: {
      remember: {},
      preferred: {},
      favorites: [],
      wishlist: [],
      recent: [],
      storeCountry: 'US',
      libraryView: 'owned',
      priceWatches: [],
      collections: [],
      hidden: [],
    },
    accounts: options.friends
      ? {
          steam: { status: 'connected', name: 'SteamPlayer' },
          epic: { status: 'connected', name: 'EpicPlayer' },
        }
      : { steam: { status: 'signedOut' }, epic: { status: 'signedOut' } },
    accountList: options.friends
      ? [
          { key: 'steam:0', provider: 'steam', status: 'connected', name: 'SteamPlayer' },
          { key: 'epic:' + 'a'.repeat(32), provider: 'epic', status: 'connected', name: 'EpicPlayer' },
        ]
      : [],
    // With options.friends: "Game 0" (Steam) is running.
    running: options.friends
      ? { 'steam:100': { name: 'Game 0', provider: 'steam', since: Date.now() - 60000 } }
      : {},
    libraryAccounts: [],
    libraryState: {},
    suggestions: [],
    integrations: { itad: {}, igdb: {}, sgdb: {}, steamWebApi: {}, encryption: true },
    free: null,
    updater: { status: 'current' },
    warnings: [],
    // With options.downloads: a Steam download and an Epic installation.
    progress: options.downloads
      ? {
          'steam:100': {
            provider: 'steam',
            state: 'downloading',
            percent: 40,
            done: 400 * 1024 ** 2,
            total: 1000 * 1024 ** 2,
            speed: 12 * 1024 ** 2,
            eta: 50,
          },
          'epic:e3': {
            provider: 'epic',
            state: 'installing',
            percent: 90,
            done: 900,
            total: 1000,
            installSize: 2048,
          },
        }
      : {},
  };
  const items0 = (provider, n) => ({
    tags: [],
    storeOffers: [
      {
        provider,
        appId: provider + n,
        country: 'US',
        currency: 'USD',
        amount: 5,
        priceStatus: 'ready',
        releaseDate: '1 окт. 2026 г.',
      },
    ],
  });
  window.__calls = [];
  window.nexus = new Proxy(
    { onStateChanged() {}, onShowPage() {}, onToast() {} },
    {
      get: (t, k) =>
        k in t
          ? t[k]
          : async p => {
              window.__calls.push([k, p]);
              if (k === 'homeCatalog')
                return {
                  items,
                  promotions: [],
                  // Popular new releases: one is owned already, one came out long ago.
                  newReleases: options.library
                    ? [
                        {
                          ...items[4],
                          id: 'steam:900',
                          name: 'New Hit',
                          steam: '900',
                          released: Date.now() - 3 * 86400000,
                          reviews: { label: 'Очень положительные', score: 8, count: 5000 },
                        },
                        {
                          ...items[5],
                          id: 'steam:901',
                          name: 'New Small',
                          steam: '901',
                          released: Date.now() - 5 * 86400000,
                          reviews: { label: 'Положительные', score: 7, count: 40 },
                        },
                        {
                          ...items[6],
                          id: 'steam:1145360',
                          name: 'Hades',
                          steam: '1145360',
                          released: Date.now() - 86400000,
                        },
                        {
                          ...items[7],
                          id: 'steam:902',
                          name: 'Old Game',
                          steam: '902',
                          released: Date.now() - 400 * 86400000,
                        },
                      ]
                    : [],
                  providers: {},
                  checkedAt: Date.now(),
                  free: null,
                };
              if (k === 'browseCatalog') {
                // Two games per store and list, e.g. "steam new 1", "epic new 2".
                const items = [1, 2].map(n => ({
                  ...items0(p.provider, n),
                  id: `${p.provider}:${p.kind}${n}`,
                  name: `${p.provider} ${p.kind} ${n}`,
                }));
                return {
                  items,
                  note:
                    p.provider === 'epic' && p.kind === 'top'
                      ? 'Самые продаваемые в Steam игры, которые есть в Epic Games'
                      : '',
                  checkedAt: Date.now(),
                };
              }
              if (k === 'browseDlc') return { items: [], checkedAt: Date.now() };
              if (k === 'getArtwork') throw Error('offline');
              if (k === 'closeGame') return { result: 'closed', state: { ...state, running: {} } };
              if (k === 'friends')
                return {
                  steam: [
                    {
                      account: { key: 'steam:0', name: 'SteamPlayer' },
                      friends: [
                        {
                          id: '76561198000000001',
                          name: 'Alpha',
                          status: 'ingame',
                          game: 'Dota 2',
                          avatar: '',
                        },
                        { id: '76561198000000002', name: 'Beta', status: 'online', game: '', avatar: '' },
                        { id: '76561198000000003', name: 'Gamma', status: 'offline', game: '', avatar: '' },
                      ],
                    },
                  ],
                  epic: [
                    {
                      account: { key: 'epic:x', name: 'EpicPlayer' },
                      friends: [
                        { id: 'b'.repeat(32), name: 'EpicPal', status: 'unknown', game: '', avatar: '' },
                      ],
                    },
                  ],
                  errors: [],
                  checkedAt: Date.now(),
                };
              if (k === 'recommendations')
                return {
                  items: [
                    {
                      ...items[1],
                      id: 'steam:1145350',
                      name: 'Hades II',
                      steam: '1145350',
                      match: 61,
                      reason: {
                        id: 'steam:1145360',
                        name: 'Hades',
                        provider: 'steam',
                        minutes: 2700,
                        tags: ['Рогалик'],
                      },
                    },
                    {
                      ...items[2],
                      id: 'steam:2379780',
                      name: 'Balatro',
                      steam: '2379780',
                      match: 48,
                      reason: {
                        id: 'epic:Salt',
                        name: 'Slay the Spire',
                        provider: 'epic',
                        minutes: 1500,
                        tags: [],
                      },
                    },
                  ],
                  profile: [
                    { tag: 'Рогалик', share: 20 },
                    { tag: 'Хоррор', share: 9 },
                  ],
                  basedOn: { steam: 1, epic: 1, epicMatched: 1 },
                  checkedAt: Date.now(),
                };
              return state;
            },
    }
  );
}

test(
  'store front: carousel, one price format, categories and price shelf',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockStore);
      await p.goto(page);
      await p.waitForSelector('#showcase-block');
      // Carousel: at most 12 games, large capsule, screenshots, reviews and tags.
      assert.equal(await p.locator('.carousel-dots button').count(), 12);
      const main = p.locator('#showcase-main');
      assert.match(await main.getAttribute('src'), /100\/capsule\.jpg$/);
      assert.equal(await p.locator('.store-showcase .screenshot-grid img').count(), 4);
      assert.match(await p.locator('.store-showcase .review-summary').textContent(), /Очень положительные/);
      assert.match(await p.locator('.store-showcase .showcase-tags').textContent(), /Хоррор/);
      // Hovering a screenshot shows it large (full size, not the thumbnail).
      await p.hover('.store-showcase .screenshot-grid img >> nth=1');
      assert.match(await main.getAttribute('src'), /ss_2\.jpg$/);
      await p.hover('.store-subnav');
      assert.match(await main.getAttribute('src'), /capsule\.jpg$/);
      // Arrows change only the carousel.
      await p.click('.carousel-arrow.right');
      assert.match(await p.locator('.store-showcase h2').textContent(), /Game 1/);
      await p.click('.carousel-dots button >> nth=3');
      assert.match(await p.locator('.store-showcase h2').textContent(), /Game 3/);
      // Prices: Steam "$4.99" and Epic "0" are shown in one format.
      const content = await p.locator('#content').textContent();
      assert.match(content, /4,99\s\$/);
      assert.doesNotMatch(content, /\$4\.99/);
      assert.match(await p.locator('.store-showcase .showcase-prices').textContent(), /Бесплатно/);
      assert.match(await p.locator('#content del').first().textContent(), /^9,99\s\$$/);
      // Categories from the tags; a tile filters the catalogue.
      assert.ok((await p.locator('.category-tile').count()) >= 2);
      await p.click('.category-tile[data-store-tag="Хоррор"]');
      assert.match(await p.locator('#store-catalog h2').textContent(), /ХОРРОР/);
      const shown = await p.locator('.grid .game-card').count();
      assert.equal(shown, 8, 'only games with the tag');
      await p.click('[data-store-tag-clear]');
      assert.equal(await p.locator('.grid .game-card').count(), 16);
      // "До 10,00 $": priced games up to the limit of the region.
      assert.match(await p.locator('#content').textContent(), /ДО 10,00\s\$/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'Steam-style window: back / forward through pages, add game from the bottom bar',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockStore);
      await p.goto(page);
      await p.waitForSelector('#showcase-block');
      const current = () => p.evaluate(() => document.body.dataset.page);
      assert.equal(await p.locator('#nav-back').isDisabled(), true);
      await p.click('button.nav[data-page="library"]');
      await p.click('button.nav[data-page="wishlist"]');
      await p.click('#nav-back');
      assert.equal(await current(), 'library');
      await p.click('#nav-back');
      assert.equal(await current(), 'store');
      assert.equal(await p.locator('#nav-back').isDisabled(), true);
      await p.click('#nav-forward');
      assert.equal(await current(), 'library');
      await p.keyboard.press('Alt+ArrowRight');
      assert.equal(await current(), 'wishlist');
      // A new page after going back drops the forward steps.
      await p.keyboard.press('Alt+ArrowLeft');
      await p.click('button.nav[data-page="tracking"]');
      assert.equal(await p.locator('#nav-forward').isDisabled(), true);
      // Bottom bar: "Добавить игру" is the same action as in the side panel.
      await p.click('#footer-add');
      assert.ok(await p.evaluate(() => window.__calls.some(c => c[0] === 'add')));
      assert.equal(await p.locator('#footer-downloads').textContent(), 'Нет активных загрузок');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'recommendations from the Steam and Epic libraries, with the reason for each game',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockStore, { library: true });
      await p.goto(page);
      await p.waitForSelector('.rec-card');
      const shelf = p.locator('#recommendations');
      assert.match(await shelf.locator('h2').textContent(), /РЕКОМЕНДОВАНО НА ОСНОВЕ ИГР/);
      assert.match(await shelf.textContent(), /На основе 1 игры Steam и 1 игры Epic Games/);
      assert.equal(await shelf.locator('.rec-card').count(), 2);
      const first = shelf.locator('.rec-card').first();
      assert.match(await first.textContent(), /Потому что вы играли в Hades · 45 ч/);
      assert.match(await first.textContent(), /Совпадение 61%/);
      assert.match(await shelf.locator('.rec-card >> nth=1').textContent(), /Slay the Spire \(Epic Games\)/);
      // The favourite tags filter the catalogue.
      await shelf.locator('.rec-tag', { hasText: 'Хоррор' }).click();
      assert.match(await p.locator('#store-catalog h2').textContent(), /ХОРРОР/);
      // "↻" asks for a fresh selection.
      await p.click('#refresh-recs');
      const asked = await p.evaluate(() =>
        window.__calls.filter(c => c[0] === 'recommendations').map(c => c[1])
      );
      assert.deepEqual(asked.at(-1), { country: 'US', force: true });
      // A card opens the game.
      await first.locator('.rec-open').click();
      assert.equal(await p.locator('#details').evaluate(d => d.open), true);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'without account games the recommendations ask to sign in',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      await p.addInitScript(mockStore);
      await p.goto(page);
      await p.waitForSelector('#recommendations');
      assert.match(await p.locator('#recommendations').textContent(), /Войдите в Steam или Epic Games/);
      assert.ok(!(await p.evaluate(() => window.__calls.some(c => c[0] === 'recommendations'))));
    } finally {
      await browser.close();
    }
  }
);

test(
  'carousel takes turns: recommended for you, popular new releases, top sellers; owned games are skipped',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockStore, { library: true });
      await p.goto(page);
      await p.waitForSelector('.rec-card');
      await p.waitForFunction(
        () => document.querySelector('.feature-label')?.textContent === 'Рекомендуем вам'
      );
      const slides = [];
      for (let i = 0; i < 7; i++) {
        await p.click(`.carousel-dots button >> nth=${i}`);
        slides.push({
          name: await p.locator('.store-showcase h2').textContent(),
          label: await p.locator('.store-showcase .feature-label').textContent(),
          note: (await p.locator('.store-showcase .feature-note').count())
            ? await p.locator('.store-showcase .feature-note').textContent()
            : '',
        });
      }
      assert.deepEqual(
        slides.map(x => x.label),
        [
          'Рекомендуем вам',
          'Новинка',
          'Лидер продаж',
          'Рекомендуем вам',
          'Новинка',
          'Лидер продаж',
          'Лидер продаж',
        ]
      );
      assert.equal(slides[0].name, 'Hades II');
      assert.match(slides[0].note, /Потому что вы играли в Hades/);
      assert.equal(slides[1].name, 'New Hit', 'the most played new release first');
      assert.match(slides[1].note, /^Вышла /);
      assert.equal(slides[4].name, 'New Small');
      const names = slides.map(x => x.name);
      assert.ok(!names.includes('Hades'), 'an owned game is never featured');
      assert.ok(!names.includes('Old Game'), 'an old game is not a new release');
      assert.ok((await p.locator('.carousel-dots button').count()) <= 12);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'list preview like Steam: facts, tags without placeholders, large screenshots, cover never over the prices',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockStore);
      await p.goto(page);
      await p.waitForSelector('.store-list-row');
      const panel = p.locator('#store-list-preview');
      // Steam game: release date, reviews, stores, 4 screenshots in one column.
      await p.hover('.store-list-row[data-list-preview="steam:100"]');
      assert.match(await panel.locator('.preview-facts').textContent(), /Обзоры:.*Очень положительные/);
      assert.match(await panel.locator('.preview-facts').textContent(), /Магазины: Steam/);
      assert.equal(await panel.locator('.preview-images > img').count(), 4);
      const boxes = await panel
        .locator('.preview-images > img')
        .evaluateAll(list => list.map(i => i.getBoundingClientRect().left));
      assert.equal(new Set(boxes.map(Math.round)).size, 1, 'screenshots one under another');
      // Epic game without a gallery: no placeholder tags, the cover keeps its own space.
      await p.hover('.store-list-row[data-list-preview="epic:e3"]');
      const text = await panel.textContent();
      assert.doesNotMatch(text, /Метки пока недоступны|Моя библиотека/);
      assert.equal(await panel.locator('.preview-images.no-shots').count(), 1);
      const [cover, prices] = await Promise.all([
        panel.locator('.preview-images').evaluate(e => e.getBoundingClientRect().bottom),
        panel.locator('.preview-prices').evaluate(e => e.getBoundingClientRect().top),
      ]);
      assert.ok(cover <= prices + 1, 'the cover does not cover the prices');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'accounts page: "Запуск игр" switches are sent to the main process',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockStore);
      await p.goto(page);
      await p.click('button.nav[data-page="accounts"]');
      const card = p.locator('.launch-card');
      assert.match(await card.textContent(), /без Epic Games Launcher/);
      for (const name of ['epicDirectLaunch', 'epicCloudSaves', 'steamSilent', 'steamCloseAfter'])
        assert.equal(await card.locator(`[data-launch-setting="${name}"]`).isChecked(), true, name);
      await card.locator('[data-launch-setting="steamSilent"]').uncheck();
      const sent = await p.evaluate(() =>
        window.__calls.filter(c => c[0] === 'launchSetting').map(c => c[1])
      );
      assert.deepEqual(sent, [{ name: 'steamSilent', value: false }]);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'store lists: new releases, top sellers and coming soon from Steam and Epic, together or each store',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockStore);
      await p.goto(page);
      await p.waitForSelector('.store-list-tabs');
      const rows = () => p.locator('.store-list-row strong').allTextContents();
      assert.deepEqual(await p.locator('.store-list-tabs [data-store-list]').allTextContents(), [
        'Актуальное',
        'Новинки',
        'Лидеры',
        'Скоро',
        'Скидки',
        'Бесплатные',
      ]);
      await p.click('[data-store-list="new"]');
      await p.waitForFunction(() => document.querySelectorAll('.store-list-row').length === 4);
      assert.deepEqual(
        await rows(),
        ['steam new 1', 'epic new 1', 'steam new 2', 'epic new 2'],
        'both stores take turns'
      );
      await p.click('[data-list-store="epic"]');
      assert.deepEqual(await rows(), ['epic new 1', 'epic new 2']);
      await p.click('[data-store-list="coming"]');
      await p.waitForFunction(
        () => document.querySelector('.store-list-row strong')?.textContent === 'epic coming 1'
      );
      assert.deepEqual(await rows(), ['epic coming 1', 'epic coming 2']);
      await p.click('[data-store-list="top"]');
      await p.waitForSelector('.list-note');
      assert.match(await p.locator('.list-note').textContent(), /которые есть в Epic Games/);
      await p.click('[data-list-store="steam"]');
      await p.waitForFunction(
        () => document.querySelector('.store-list-row strong')?.textContent === 'steam top 1'
      );
      assert.equal(await p.locator('.list-note').count(), 0);
      const asked = await p.evaluate(() =>
        window.__calls.filter(c => c[0] === 'browseCatalog').map(c => c[1].provider + ':' + c[1].kind)
      );
      for (const k of ['steam:new', 'epic:new', 'epic:coming', 'epic:top', 'steam:top'])
        assert.ok(asked.includes(k), k);
      assert.match(await p.locator('.store-list-row em').first().textContent(), /Дата выхода: 1 окт. 2026/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'downloads: Steam and Epic installations with stage, speed and time left; the bottom bar shows the first',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockStore, { downloads: true });
      await p.goto(page);
      await p.waitForSelector('#showcase-block');
      assert.match(
        await p.locator('#footer-downloads').textContent(),
        /^2 загрузки · Game 0 · Загрузка · 40% · 12 МБ\/с · осталось 50 сек.$/
      );
      assert.equal(await p.locator('#footer-downloads-bar').evaluate(e => e.style.width), '40%');
      await p.click('.footer-downloads');
      assert.equal(await p.evaluate(() => document.body.dataset.page), 'downloads');
      const rows = p.locator('.download-row');
      assert.equal(await rows.count(), 2);
      const first = await rows.nth(0).textContent();
      assert.match(first, /Game 0/);
      assert.match(first, /Steam/);
      assert.match(first, /400 МБ из 1\s000 МБ/);
      assert.match(first, /12 МБ\/с/);
      const second = await rows.nth(1).textContent();
      assert.match(second, /Game 3/);
      assert.match(second, /Epic Games/);
      assert.match(second, /Установка/);
      assert.match(second, /900 Б из 1\s000 Б · на диске 2 КБ/, 'download size, then the size on disk');
      await rows.nth(1).locator('[data-client-downloads]').click();
      const asked = await p.evaluate(() =>
        window.__calls.filter(c => c[0] === 'openClientDownloads').map(c => c[1])
      );
      assert.deepEqual(asked, ['epic']);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'downloads page without downloads explains where they come from',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      await p.addInitScript(mockStore);
      await p.goto(page);
      await p.click('.footer-downloads');
      assert.match(await p.locator('#content').textContent(), /Нет активных загрузок/);
      assert.equal(await p.locator('#footer-downloads').textContent(), 'Нет активных загрузок');
    } finally {
      await browser.close();
    }
  }
);

test(
  'in game: green status on top, "Закрыть" instead of "Играть", friends list like Steam',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockStore, { friends: true });
      await p.goto(page);
      await p.waitForSelector('#showcase-block');
      // Top: the Steam account plays "Game 0" (green), Epic is just online.
      const steamChip = p.locator('.profile-chip').first();
      assert.match(await steamChip.getAttribute('class'), /in-game/);
      assert.match(await steamChip.textContent(), /В игре: Game 0/);
      assert.doesNotMatch(await p.locator('.profile-chip').nth(1).getAttribute('class'), /in-game/);
      // Friends.
      await p.waitForFunction(() =>
        /в сети/.test(document.querySelector('#friends-count')?.textContent || '')
      );
      assert.match(await p.locator('#friends-count').textContent(), /2 в сети/);
      // The friends list is its own window (see test/ui/social.test.cjs).
      await p.click('#friends-toggle');
      assert.ok(await p.evaluate(() => window.__calls.some(c => c[0] === 'openFriendsWindow')));
      assert.equal(await p.locator('#friends-panel').count(), 0);
      // The running game cannot be started again: its button closes it.
      await p.evaluate(() => showDetail('steam:100'));
      await p.waitForSelector('#detail-stop');
      assert.equal(await p.locator('#details #play').count(), 0);
      await p.click('#detail-stop');
      assert.deepEqual(
        await p.evaluate(() => window.__calls.filter(c => c[0] === 'closeGame').map(c => c[1])),
        ['steam:100']
      );
      // Closed: "Играть" again, and the account is no longer "В игре".
      await p.waitForSelector('#details #play');
      assert.doesNotMatch(await p.locator('.profile-chip').first().getAttribute('class'), /in-game/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);
