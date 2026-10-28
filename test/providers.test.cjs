const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  parseSteamSearch,
  parseEpicSearch,
  combineOffers,
  searchStores,
  browseSteam,
  imageUrl,
} = require('../src/providers.cjs');
const steamHtml = `<a class="search_result_row" href="https://store.steampowered.com/app/1091500/Cyberpunk/"><span class="title">Cyberpunk 2077</span><div class="search_capsule"><img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg"></div><div class="discount_final_price">29,99€</div><div class="discount_original_price">59,99€</div></a>`;
const epic = {
  data: {
    Catalog: {
      searchStore: {
        elements: [
          {
            id: 'epic-cp',
            namespace: 'ns',
            title: 'Cyberpunk 2077',
            description: 'Story',
            categories: [{ path: 'games/edition/base' }],
            keyImages: [{ type: 'OfferImageWide', url: 'https://cdn1.epicgames.com/cp.jpg' }],
            offerMappings: [{ pageType: 'productHome', pageSlug: 'cyberpunk-2077' }],
            items: [{ id: 'item', namespace: 'ns' }],
            price: {
              totalPrice: {
                currencyCode: 'EUR',
                fmtPrice: { discountPrice: '24,99€', originalPrice: '59,99€' },
              },
            },
          },
        ],
        paging: { count: 1, total: 1 },
      },
    },
  },
};
test('live Steam shape yields cover, price and direct product link', () => {
  const r = parseSteamSearch({ results_html: steamHtml, total_count: 1 });
  assert.equal(r.offers[0].price, '29,99€');
  assert.match(r.offers[0].image, /steamstatic/);
  assert.equal(r.offers[0].url, 'https://store.steampowered.com/app/1091500/');
});
test('Epic GraphQL shape yields cover, price, catalog item and product link', () => {
  const r = parseEpicSearch(epic);
  assert.equal(r.offers[0].price, '24,99€');
  assert.equal(r.offers[0].items[0].id, 'item');
  assert.equal(r.offers[0].url, 'https://store.epicgames.com/p/cyberpunk-2077');
});
test('combined card keeps prices separate and puts Steam first', () => {
  const games = combineOffers([
    ...parseEpicSearch(epic).offers,
    ...parseSteamSearch({ results_html: steamHtml }).offers,
  ]);
  assert.equal(games.length, 1);
  assert.equal(games[0].id, 'cyberpunk');
  assert.equal(games[0].storeOffers[0].provider, 'steam');
  assert.equal(games[0].storeOffers[1].price, '24,99€');
});
test('different editions are not collapsed by catalogue aliases', () => {
  const a = parseSteamSearch({ results_html: steamHtml }).offers[0],
    b = { ...parseEpicSearch(epic).offers[0], name: 'Cyberpunk 2077: Ultimate Edition' };
  assert.equal(combineOffers([a, b]).length, 2);
});
test('invalid asset hosts and protocols are rejected', () => {
  for (const url of [
    'file:///C:/secret',
    'https://steamstatic.com.evil.test/a',
    'javascript:alert(1)',
    'https://evil.test/img',
  ])
    assert.equal(imageUrl(url), '');
  assert.ok(imageUrl('https://cdn1.epicgames.com/a.jpg'));
});
test('partial provider failure keeps Steam results inside the app', async () => {
  const steam = async () => ({
      ok: true,
      text: async () => JSON.stringify({ results_html: steamHtml, total_count: 1 }),
    }),
    epic = async () => ({ ok: false, status: 403 });
  const r = await searchStores({ steam, epic }, 'Cyberpunk', 'DE');
  assert.equal(r.items.length, 1);
  assert.equal(r.providers.steam.ok, true);
  assert.equal(r.providers.epic.ok, false);
  assert.match(r.providers.epic.error, /403/);
});
test('Epic title without a product mapping cannot become an external search redirect', () => {
  const json = structuredClone(epic);
  delete json.data.Catalog.searchStore.elements[0].offerMappings;
  assert.equal(parseEpicSearch(json).offers[0].url, null);
});
test('browse categories use a fixed Steam filter and reject arbitrary URLs', async () => {
  let requested;
  const fetcher = async url => {
    requested = new URL(url);
    return { ok: true, text: async () => JSON.stringify({ results_html: steamHtml, total_count: 1 }) };
  };
  const list = await browseSteam(fetcher, 'sales', 'DE');
  assert.equal(list.offers[0].appId, '1091500');
  assert.equal(requested.hostname, 'store.steampowered.com');
  assert.equal(requested.searchParams.get('specials'), '1');
  assert.equal(requested.searchParams.get('cc'), 'DE');
  await assert.rejects(browseSteam(fetcher, '../../login', 'DE'), /подборка/);
});
test('Epic screenshots are taken only from storefront media fields', () => {
  const fixture = structuredClone(epic);
  fixture.data.Catalog.searchStore.elements[0].keyImages.push(
    { type: 'Screenshot', url: 'https://cdn1.epicgames.com/shot.jpg' },
    { type: 'Screenshot', url: 'https://evil.example/shot.jpg' }
  );
  // A 640 px copy from the Epic CDN instead of the 1920 px original.
  assert.deepEqual(parseEpicSearch(fixture).offers[0].screenshots, [
    'https://cdn1.epicgames.com/shot.jpg?resize=1&w=640&h=360&quality=medium',
  ]);
});
test('Epic store gallery (featuredMedia) are screenshots; genres and modes become Russian tags', () => {
  const fixture = structuredClone(epic);
  const el = fixture.data.Catalog.searchStore.elements[0];
  el.keyImages.push(
    { type: 'featuredMedia', url: 'https://cdn1.epicgames.com/spt-assets/a/1.jpg' },
    { type: 'featuredMedia', url: 'https://cdn1.epicgames.com/spt-assets/a/1.jpg' },
    { type: 'featuredMedia', url: 'https://cdn2.epicgames.com/spt-assets/a/2.png' }
  );
  el.tags = [
    { name: 'Single Player', groupName: 'feature' },
    { name: 'Strategy', groupName: 'genre' },
    { name: 'Simulation', groupName: 'genre' },
    { name: 'Windows', groupName: 'platform' },
    { name: 'Achievements', groupName: 'epicfeature' },
    { name: 'Deck Builder Something', groupName: 'genre' },
  ];
  const offer = parseEpicSearch(fixture).offers[0];
  assert.deepEqual(offer.screenshots, [
    'https://cdn1.epicgames.com/spt-assets/a/1.jpg?resize=1&w=640&h=360&quality=medium',
    'https://cdn2.epicgames.com/spt-assets/a/2.png?resize=1&w=640&h=360&quality=medium',
  ]);
  assert.deepEqual(offer.tags, ['Стратегия', 'Симулятор', 'Deck Builder Something', 'Для одного игрока']);
});
test('store excludes Epic news, software and bundles but keeps games and DLC', () => {
  const fixture = structuredClone(epic),
    base = fixture.data.Catalog.searchStore.elements[0];
  fixture.data.Catalog.searchStore.elements = [
    base,
    { ...base, id: 'news', title: 'Новости', categories: [{ path: 'news' }] },
    { ...base, id: 'software', categories: [{ path: 'software' }] },
    { ...base, id: 'bundle', categories: [{ path: 'bundles' }] },
    { ...base, id: 'dlc', title: 'Дополнение', categories: [{ path: 'addons' }] },
  ];
  assert.deepEqual(
    parseEpicSearch(fixture).offers.map(x => x.appId),
    ['epic-cp', 'dlc']
  );
});

test('Epic lists use the filters of the Epic store; "date not announced" (2099) and DLC are left out', async () => {
  const { epicBrowseVariables, browseEpic } = require('../src/providers.cjs');
  const now = Date.UTC(2026, 9, 16);
  assert.deepEqual(epicBrowseVariables('new', 'KZ', now), {
    country: 'KZ',
    count: 40,
    sortBy: 'releaseDate',
    sortDir: 'DESC',
    releaseDate: '[,2026-10-16T00:00:00.000Z]',
  });
  assert.equal(epicBrowseVariables('coming', 'KZ', now).sortDir, 'ASC');
  assert.equal(
    epicBrowseVariables('coming', 'KZ', now).releaseDate,
    '[2026-10-16T00:00:00.000Z,2098-01-01T00:00:00.000Z]'
  );
  assert.equal(epicBrowseVariables('sales', 'KZ', now).onSale, true);
  assert.equal(epicBrowseVariables('free', 'KZ', now).freeGame, true);
  assert.throws(() => epicBrowseVariables('top', 'KZ', now), /подборка/);
  const fixture = structuredClone(epic);
  const base = fixture.data.Catalog.searchStore.elements[0];
  fixture.data.Catalog.searchStore.elements = [
    { ...base, id: 'released', title: 'Released', releaseDate: '2026-10-10T00:00:00.000Z' },
    { ...base, id: 'tba', title: 'No Date', releaseDate: '2099-12-29T00:00:00.000Z' },
    {
      ...base,
      id: 'dlc',
      title: 'Some DLC',
      categories: [{ path: 'addons' }],
      releaseDate: '2026-10-01T00:00:00.000Z',
    },
  ];
  let asked;
  const r = await browseEpic(
    async url => {
      asked = new URL(url);
      return { ok: true, text: async () => JSON.stringify(fixture), json: async () => fixture };
    },
    'new',
    'KZ'
  );
  assert.deepEqual(
    r.offers.map(o => o.appId),
    ['released']
  );
  assert.equal(r.offers[0].releaseDate, '10 окт. 2026 г.');
  assert.equal(JSON.parse(asked.searchParams.get('variables')).sortBy, 'releaseDate');
  // In a search the placeholder year is shown as "not announced", never as 2099.
  const parsed = parseEpicSearch(fixture).offers.find(o => o.appId === 'tba');
  assert.equal(parsed.releaseDate, 'Дата не объявлена');
  assert.equal(parsed.released, undefined);
});
