const test = require('node:test'),
  assert = require('node:assert/strict');
const r = require('../src/recommend.cjs');
const steamLib = require('../src/steam-library.cjs');

// A player who loves roguelikes (Steam) and card roguelikes (Epic).
const owned = [
  {
    id: 'steam:1',
    name: 'Hades',
    provider: 'steam',
    minutes: 45 * 60,
    steamIds: ['1145360'],
    tags: ['Экшен-рогалик', 'Рогалик', 'Для одного игрока', 'Слэшер'],
  },
  {
    id: 'epic:Salt',
    name: 'Slay the Spire',
    provider: 'epic',
    minutes: 25 * 60,
    steamIds: [],
    altNames: [],
    tags: ['Карточный рогалик', 'Рогалик', 'Колодостроение'],
  },
  {
    id: 'steam:2',
    name: 'Forza Horizon',
    provider: 'steam',
    minutes: 0,
    steamIds: ['1551360'],
    tags: ['Гонки', 'Открытый мир'],
  },
];
const candidate = (appId, name, tags, extra = {}) => ({
  appId,
  name,
  tags,
  type: 0,
  reviews: { score: 8 },
  ...extra,
});

test('taste profile: playtime matters, generic tags do not, both stores count', () => {
  const p = r.buildProfile(owned);
  assert.equal(p.games, 3);
  assert.equal(p.top[0].tag, 'Рогалик', 'the tag shared by the Steam and the Epic game wins');
  assert.ok(!p.tags.has('Для одного игрока'), 'generic tags are ignored');
  assert.ok(
    p.tags.get('Экшен-рогалик') > p.tags.get('Гонки'),
    'a game played 45 h outweighs an unplayed one'
  );
  assert.ok(r.gameWeight(600) > r.gameWeight(60) && r.gameWeight(60) > r.gameWeight(0));
  assert.equal(r.buildProfile([{ tags: [] }]).games, 0);
});

test('ranking: similar and well reviewed first; owned on either store, hidden and DLC are excluded', () => {
  const p = r.buildProfile(owned);
  const list = r.rankCandidates(
    p,
    owned,
    [
      candidate('10', 'Hades II', ['Экшен-рогалик', 'Рогалик', 'Слэшер']),
      candidate('11', 'Balatro', ['Карточный рогалик', 'Рогалик', 'Колодостроение']),
      candidate('12', 'Bad Roguelike', ['Экшен-рогалик', 'Рогалик'], { reviews: { score: 3 } }),
      candidate('13', 'Farming Sim', ['Симулятор фермы', 'Расслабляющая']),
      candidate('1145360', 'Hades', ['Экшен-рогалик']), // owned on Steam
      candidate('646570', 'Slay the Spire', ['Карточный рогалик']), // owned on Epic (by title)
      candidate('14', 'Hades II Soundtrack', ['Экшен-рогалик', 'Рогалик'], { type: 6 }), // not a game
      candidate('15', 'Hidden One', ['Экшен-рогалик', 'Рогалик']),
      candidate('10', 'Hades II', ['Экшен-рогалик']), // duplicate
    ],
    { hidden: new Set(['steam:15']) }
  );
  assert.deepEqual(
    list.map(x => x.name),
    ['Hades II', 'Balatro', 'Bad Roguelike']
  );
  assert.equal(list[0].reason.name, 'Hades');
  assert.equal(list[1].reason.name, 'Slay the Spire', 'an Epic game explains a recommendation too');
  assert.equal(list[1].reason.provider, 'epic');
  assert.ok(list[0].match > 0.5);
});

test('variety: one owned game explains at most three recommendations', () => {
  const p = r.buildProfile(owned);
  const many = Array.from({ length: 8 }, (_, i) =>
    candidate(String(100 + i), 'Roguelite ' + i, ['Экшен-рогалик', 'Рогалик', 'Слэшер'])
  );
  const cards = candidate('200', 'Card Game', ['Карточный рогалик', 'Колодостроение', 'Рогалик'], {
    reviews: { score: 6 },
  });
  const list = r.rankCandidates(p, owned, [...many, cards], { limit: 5 });
  assert.equal(list.length, 5);
  assert.equal(list.filter(x => x.reason?.name === 'Hades').slice(0, 3).length, 3);
  assert.ok(
    list.slice(0, 4).some(x => x.name === 'Card Game'),
    'another reason gets a place early'
  );
});

test('Steam app of an Epic title: exact title only, editions ignored', async () => {
  const items = [
    { id: 1, type: 'app', name: 'Hades II' },
    { id: 1145360, type: 'app', name: 'Hades' },
  ];
  const fetcher = async url => {
    assert.match(url, /storesearch\/\?term=Hades/);
    return { ok: true, json: async () => ({ items }) };
  };
  assert.equal(await steamLib.findSteamApp(fetcher, 'Hades™'), '1145360');
  assert.equal(await steamLib.findSteamApp(fetcher, 'Hades: Game of the Year Edition'), '1145360');
  assert.equal(
    await steamLib.findSteamApp(async () => ({ ok: true, json: async () => ({ items: [] }) }), 'Hades'),
    null
  );
  await assert.rejects(() => steamLib.findSteamApp(async () => ({ ok: false, status: 429 }), 'Hades'), /429/);
});

test('store details keep tag ids and app type for recommendations', () => {
  const d = steamLib
    .parseStoreDetails(
      { response: { store_items: [{ appid: 5, success: 1, name: 'X', type: 0, tagids: [19, 1716] }] } },
      new Map([[19, 'Экшен']])
    )
    .get('5');
  assert.deepEqual(d.tagIds, [19, 1716]);
  assert.deepEqual(d.tags, ['Экшен']);
  assert.equal(d.type, 0);
  assert.equal(d.name, 'X');
});

test('candidates are searched by tag in the chosen region', async () => {
  const { searchSteamByTags } = require('../src/providers.cjs');
  let asked;
  const fetcher = async url => {
    asked = new URL(url);
    return { ok: true, text: async () => JSON.stringify({ results_html: '', total_count: 0 }) };
  };
  await searchSteamByTags(fetcher, [1716, 19, 3, 4], 'KZ', 99);
  assert.equal(asked.searchParams.get('tags'), '1716,19,3');
  assert.equal(asked.searchParams.get('cc'), 'KZ');
  assert.equal(asked.searchParams.get('count'), '50');
  assert.deepEqual(await searchSteamByTags(fetcher, [], 'US'), { offers: [], total: 0 });
  await assert.rejects(() => searchSteamByTags(fetcher, [1], 'XX'), /регион/);
});
