// The bell (src/main/notices.cjs): wishlist sales, giveaways and new versions, each
// announced once, newest first, at most 50.
const test = require('node:test'),
  assert = require('node:assert/strict');
const { Notices, saleNotices, plural } = require('../src/main/notices.cjs');

function makeCtx() {
  let saved = 0,
    published = 0;
  return {
    settings: { notices: [], noticeKeys: {} },
    storage: { saveSettings: () => saved++ },
    hub: { publish: () => published++ },
    counts: () => ({ saved, published }),
  };
}

test('notices: each key once, newest first, a summary for several system notifications', () => {
  const ctx = makeCtx();
  const shown = [];
  const n = new Notices(ctx, (title, body, notice) => shown.push([title, body, notice.kind]));
  const sale = { kind: 'sale', key: 'sale:a:steam:1', title: 'A: −50%', body: 'Steam · 100 ₽', gameId: 'a' };
  assert.equal(n.add([sale]).length, 1);
  assert.deepEqual(shown, [['A: −50%', 'Steam · 100 ₽', 'sale']]);
  // The same sale again: nothing new, even after the bell was cleared.
  assert.equal(n.add([sale]).length, 0);
  n.clear();
  assert.equal(n.add([sale]).length, 0);
  assert.deepEqual(ctx.settings.notices, []);

  const two = n.add([
    { kind: 'giveaway', key: 'g:1', title: 'Бесплатно в Epic Games: X' },
    { kind: 'update', key: 'update:0.14.0', title: 'Вышла новая версия Nexus 0.14.0' },
    { kind: 'unknown', key: 'x', title: 'skipped' },
    { kind: 'sale', title: 'no key' },
  ]);
  assert.equal(two.length, 2);
  assert.equal(shown.length, 2);
  assert.match(shown[1][0], /2 новых уведомления/);
  assert.equal(ctx.settings.notices[0].kind, 'giveaway');
  assert.equal(ctx.settings.notices.filter(x => !x.read).length, 2);

  // Opened: everything read; one removed.
  n.readAll();
  assert.equal(ctx.settings.notices.filter(x => !x.read).length, 0);
  n.remove(ctx.settings.notices[0].id);
  assert.deepEqual(
    ctx.settings.notices.map(x => x.kind),
    ['update']
  );

  // Without the system notification: only the bell.
  n.add([{ kind: 'sale', key: 'quiet', title: 'Q' }], { system: false });
  assert.equal(shown.length, 2);
  assert.equal(ctx.settings.notices[0].title, 'Q');

  // At most 50, the oldest go.
  n.add(
    Array.from({ length: 60 }, (_, i) => ({ kind: 'sale', key: 'many' + i, title: 'M' + i })),
    {
      system: false,
    }
  );
  assert.equal(ctx.settings.notices.length, 50);
  assert.equal(ctx.settings.notices[0].title, 'M0');
});

test('notices: keys older than 90 days are forgotten', () => {
  const ctx = makeCtx();
  ctx.settings.noticeKeys = { old: Date.now() - 91 * 86400000, fresh: Date.now() - 86400000 };
  const n = new Notices(ctx);
  n.add([{ kind: 'sale', key: 'new', title: 'N' }]);
  assert.deepEqual(Object.keys(ctx.settings.noticeKeys).sort(), ['fresh', 'new']);
});

test('wishlist sales as notices: the best discount of this region, a new sale is a new key', () => {
  const names = { steam: 'Steam', epic: 'Epic Games' };
  const date = t => new Date(t).toISOString().slice(0, 10);
  const end = Date.UTC(2026, 10, 18);
  const games = [
    {
      id: 'steam:1',
      name: 'Hades',
      image: 'https://shared.akamai.steamstatic.com/a.jpg',
      storeOffers: [
        { provider: 'steam', country: 'KZ', discount: 50, price: '2 000 ₸', saleEnd: end },
        { provider: 'epic', country: 'KZ', discount: 30, price: '2 800 ₸' },
      ],
    },
    // Another region's old offer and a game without a discount: nothing.
    {
      id: 'steam:2',
      name: 'Old',
      storeOffers: [{ provider: 'steam', country: 'US', discount: 80, price: '$1' }],
    },
    {
      id: 'steam:3',
      name: 'Full',
      storeOffers: [{ provider: 'steam', country: 'KZ', discount: 0, price: '1 ₸' }],
    },
    {
      id: 'epic:4',
      name: 'Epic only',
      storeOffers: [{ provider: 'epic', country: 'KZ', discount: 25, amount: 9 }],
    },
  ];
  const list = saleNotices(games, 'KZ', names, date);
  assert.deepEqual(
    list.map(n => [n.key, n.title, n.body]),
    [
      [`sale:steam:1:steam:${end}`, 'Hades: −50%', 'Steam · 2 000 ₸ до 2026-11-18'],
      ['sale:epic:4:epic:25', 'Epic only: −25%', 'Epic Games · 9'],
    ]
  );
  assert.equal(list[0].gameId, 'steam:1');
  assert.equal(plural(21, 'a', 'b', 'c'), 'a');
  assert.equal(plural(12, 'a', 'b', 'c'), 'c');
  assert.equal(plural(3, 'a', 'b', 'c'), 'b');
});

test("the wishlist sale check sends the region's sales to the bell, quietly when switched off", () => {
  const { StoreService } = require('../src/main/store.cjs');
  const { LruMap } = require('../src/main/hub.cjs');
  const store = Object.create(StoreService.prototype);
  store.index = new LruMap(10);
  const added = [];
  store.ctx = {
    settings: { wishlist: ['steam:1', 'gone'], storeCountry: 'KZ', notifyWishSales: false },
    notices: { add: (list, opts) => (added.push([list, opts]), list) },
  };
  store.find = id => store.index.get(id);
  store.country = () => 'KZ';
  store.index.set('steam:1', {
    id: 'steam:1',
    name: 'Hades',
    storeOffers: [{ provider: 'steam', country: 'KZ', discount: 40, price: '1 ₸' }],
  });
  const list = store.checkWishSales();
  assert.equal(list.length, 1);
  assert.equal(added[0][1].system, false);
});

test('a new Nexus version on Windows goes to the bell once', () => {
  const { Updater } = require('../src/main/updater.cjs');
  const added = [];
  const u = new Updater(
    { hub: { publish() {} }, log: { warn() {} }, notices: { add: list => added.push(...list) } },
    'win32'
  );
  u.found('0.14.0');
  assert.equal(added.length, 1);
  assert.equal(added[0].key, 'update:0.14.0');
  // Linux installs it itself: no notice.
  const linux = new Updater(
    { hub: { publish() {} }, log: { warn() {} }, notices: { add: () => added.push(1) } },
    'linux'
  );
  linux.found('0.14.0');
  assert.equal(added.length, 1);
});

test('«Что нового»: the headlines of the release description', async () => {
  const { Updater, releaseHeadlines } = require('../src/main/updater.cjs');
  const body = [
    '- **«Скачать и установить» — в один клик.** В окне «Вышла новая версия»...',
    '  - **Windows:** Nexus закрывается и запускает установщик.',
    '- Файл, который не совпадает с релизом, удаляется, см. [релизы](https://github.com/x).',
    '* **Третий.**',
    '- **Четвёртый**',
    '- **Пятый**',
    'Текст без списка',
  ].join('\r\n');
  assert.deepEqual(releaseHeadlines(body), [
    '«Скачать и установить» — в один клик',
    'Файл, который не совпадает с релизом, удаляется, см. релизы',
    'Третий',
    'Четвёртый',
  ]);
  assert.deepEqual(releaseHeadlines(null), []);
  assert.equal(releaseHeadlines('- ' + 'x'.repeat(300))[0].length, 140);

  const u = new Updater({ hub: { publish() {} }, log: { warn() {} } }, 'win32');
  const asked = [];
  u.fetch = async url => (asked.push(url), { ok: true, json: async () => ({ body }) });
  u.found('0.13.6');
  assert.deepEqual(asked, [], 'no GitHub request without the real updater');
  await u.loadNotes('0.13.6');
  assert.deepEqual(asked, [
    'https://api.github.com/repos/KioshiKazemaru/nexus-launcher/releases/tags/v0.13.6',
  ]);
  assert.equal(u.state.notes.length, 4);
  // A newer version found meanwhile keeps its own notes.
  u.found('0.13.7');
  await u.loadNotes('0.13.6');
  assert.deepEqual(u.state.notes, []);
});
