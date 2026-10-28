const test = require('node:test'),
  assert = require('node:assert/strict');
const i = require('../src/integrations.cjs');
const uuid = '018d937f-11f5-7058-9d4b-e4e3a7f5e1aa';
const ok = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('IsThereAnyDeal: shop lookup, title lookup and prices are validated', async () => {
  assert.deepEqual(
    i.parseItadShopLookup({ 'app/570': uuid, 'app/1': null, 'sub/2': uuid, 'app/3': 'not-uuid' }),
    { 570: uuid }
  );
  assert.deepEqual(
    i.parseItadTitleLookup({ found: true, game: { id: uuid, title: 'Hades', slug: 'hades' } }).id,
    uuid
  );
  assert.equal(i.parseItadTitleLookup({ found: false }), null);
  const prices = i.parseItadPrices([
    {
      id: uuid,
      historyLow: { all: { amount: 4.99, currency: 'USD' } },
      deals: [
        {
          shop: { id: 61, name: 'Steam' },
          price: { amount: 24.99, currency: 'USD' },
          regular: { amount: 24.99, currency: 'USD' },
          cut: 0,
          url: 'https://itad.link/x',
        },
        {
          shop: { id: 35, name: 'GOG' },
          price: { amount: 9.99, currency: 'USD' },
          cut: 60,
          url: 'javascript:alert(1)',
        },
      ],
    },
  ]);
  assert.deepEqual(
    prices[uuid].deals.map(d => d.shop),
    ['GOG', 'Steam']
  );
  assert.equal(prices[uuid].deals[0].url, '');
  assert.equal(prices[uuid].historyLow.amount, 4.99);
  let sent;
  const found = await i.itadLookupSteam(
    async (url, options) => {
      sent = { url, body: JSON.parse(options.body) };
      return ok({ 'app/570': uuid });
    },
    'k'.repeat(40),
    ['570']
  );
  assert.match(sent.url, /\/lookup\/id\/shop\/61\/v1\?key=/);
  assert.deepEqual(sent.body, ['app/570']);
  assert.deepEqual(found, { 570: uuid });
  await assert.rejects(
    () => i.itadLookupSteam(async () => ({ ok: false, status: 403 }), 'k'.repeat(40), ['1']),
    /Ключ API/
  );
  await assert.rejects(() => i.itadLookupSteam(async () => ok({}), 'bad key!', ['1']), /ключ/);
});

test('IGDB: games are parsed with cover url; steam external ids accept old and new source fields', async () => {
  const [g] = i.parseIgdbGames([
    {
      id: 7,
      name: 'Hades',
      summary: 'Rogue-like',
      genres: [{ name: 'RPG' }],
      cover: { image_id: 'co1abc' },
      external_games: [{ category: 1, uid: '1145360' }],
    },
  ]);
  assert.equal(g.cover, 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1abc.jpg');
  assert.deepEqual(g.external, [{ source: 1, uid: '1145360' }]);
  const map = await i.igdbBySteam(
    async (_url, options) => {
      assert.match(options.body, /where uid = \("1145360","570"\)/);
      return ok([
        { game: 7, uid: '1145360', category: 1 },
        { game: 8, uid: '570', external_game_source: 1 },
        { game: 9, uid: '570', category: 26 },
      ]);
    },
    { clientId: 'c', token: 't' },
    ['1145360', '570', 'x"); drop']
  );
  assert.deepEqual(map, { 1145360: 7, 570: 8 });
});

test('SteamGridDB: only safe, SFW CDN images, best score first; search fallback by title', async () => {
  assert.deepEqual(
    i.parseSgdbGrids({
      success: true,
      data: [
        { url: 'https://cdn2.steamgriddb.com/grid/a.png', score: 1 },
        { url: 'https://cdn2.steamgriddb.com/grid/b.png', score: 5 },
        { url: 'https://cdn2.steamgriddb.com/grid/c.png', score: 9, nsfw: true },
        { url: 'https://evil.test/x.png', score: 10 },
      ],
    }),
    ['https://cdn2.steamgriddb.com/grid/b.png', 'https://cdn2.steamgriddb.com/grid/a.png']
  );
  const urls = [];
  const cover = await i.sgdbPortrait(
    async url => {
      urls.push(url);
      if (url.includes('/search/autocomplete/')) return ok({ success: true, data: [{ id: 42 }] });
      return ok({ success: true, data: [{ url: 'https://cdn2.steamgriddb.com/grid/z.png' }] });
    },
    'a'.repeat(32),
    { title: 'My Game' }
  );
  assert.equal(cover, 'https://cdn2.steamgriddb.com/grid/z.png');
  assert.match(urls[1], /grids\/game\/42\?dimensions=600x900/);
});
