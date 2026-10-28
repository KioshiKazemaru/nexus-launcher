const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const s = require('../src/steam-library.cjs');
const { parseVdf } = require('../src/core.cjs');
const id = '76561198012345678';
const jwt = sub => ['x', Buffer.from(JSON.stringify({ sub })).toString('base64url'), 'sig'].join('.');

test('webapi_token: accepted only from a successful config; its owner is checked', () => {
  const token = jwt(id);
  assert.equal(s.parseAsyncConfig({ success: 1, data: { webapi_token: token } }), token);
  assert.equal(s.parseAsyncConfig({ success: 2, data: { webapi_token: token } }), '');
  assert.equal(s.parseAsyncConfig({ success: 1, data: { webapi_token: 'bad token' } }), '');
  assert.equal(s.tokenSteamId(token), id);
  assert.equal(s.tokenSteamId('garbage'), '');
});

test('GetOwnedGames gives games with names, playtime and last played; empty is explicit', () => {
  const offers = s.parseOwnedGames(
    {
      response: {
        game_count: 2,
        games: [
          { appid: 570, name: 'Dota 2', playtime_forever: 90, rtime_last_played: 1700000000 },
          { appid: 'x' },
        ],
      },
    },
    id
  );
  assert.equal(offers.length, 1);
  assert.deepEqual(
    [offers[0].name, offers[0].playtime, offers[0].lastPlayed, offers[0].owned, offers[0].installed],
    ['Dota 2', 90, 1700000000, true, false]
  );
  assert.deepEqual(s.parseOwnedGames({ response: { game_count: 0 } }, id), []);
  assert.throws(() => s.parseOwnedGames({ response: {} }, id));
});

test('fetchOwnedWithToken refuses a token issued for another account', async () => {
  const fetcher = async url => ({
    ok: true,
    json: async () =>
      url.includes('ajaxgetasyncconfig')
        ? { success: 1, data: { webapi_token: jwt('76561198000000001') } }
        : { response: { games: [] } },
  });
  await assert.rejects(() => s.fetchOwnedWithToken(fetcher, id), /другому аккаунту/);
});

test('licences are filtered to games: DLC, soundtracks and tools are dropped', () => {
  const items = s.parseStoreItems({
    response: {
      store_items: [
        { appid: 10, success: 1, type: 0, name: 'Game' },
        { appid: 11, success: 1, type: 4, name: 'DLC' },
        { appid: 12, success: 1, type: 6, name: 'Soundtrack' },
        { appid: 13, success: 2 },
      ],
    },
  });
  const licences = [10, 11, 12, 13].map(a => s.ownedOffer(a, id));
  const games = s.filterGames(licences, items);
  assert.deepEqual(
    games.map(o => o.appId),
    ['10', '13']
  );
  assert.equal(games[0].name, 'Game');
});

test('community page: current React format, legacy rgGames and another profile', () => {
  const data = {
    strSteamId: id,
    rgGames: [{ appid: 292030, name: 'The Witcher 3 & Co', playtime_forever: 600 }],
  };
  const attr = JSON.stringify(data).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const modern = s.parseCommunityGamesList(
    `<template id="gameslist_config" data-profile-gameslist="${attr}"></template>`,
    id
  );
  assert.equal(modern[0].name, 'The Witcher 3 & Co');
  assert.equal(modern[0].playtime, 600);
  assert.equal(
    s.parseCommunityGamesList('<script>var rgGames = [{"appid":1,"name":"Old"}];</script>', id)[0].name,
    'Old'
  );
  assert.equal(s.parseCommunityGamesList('<p>nothing</p>', id), null);
  const other = JSON.stringify({ ...data, strSteamId: '76561198000000001' }).replace(/"/g, '&quot;');
  assert.throws(
    () => s.parseCommunityGamesList(`<x data-profile-gameslist="${other}">`, id),
    /другого профиля/
  );
});

test('localconfig.vdf: last played and playtime regardless of key case', () => {
  const vdf = parseVdf(
    '"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "570" { "LastPlayed" "1700000000" "Playtime" "42" } "10" { "cloud" { } } } } } } }'
  );
  assert.deepEqual(s.parseLocalConfig(vdf), { 570: { lastPlayed: 1700000000, playtime: 42 } });
  assert.equal(s.toAccountId32(id), String(BigInt(id) - 76561197960265728n));
  assert.equal(s.toAccountId32('123'), '');
});

test('library cache covers: flat and per-app folder layouts, only numeric ids', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cache-'));
  try {
    fs.writeFileSync(path.join(root, '10_library_600x900.jpg'), 'x');
    fs.mkdirSync(path.join(root, '20', 'abcdef0123456789'), { recursive: true });
    fs.writeFileSync(path.join(root, '20', 'abcdef0123456789', 'library_600x900.jpg'), 'x');
    assert.equal(
      await s.findLibraryCover(fs.promises, path, root, '10', 'portrait'),
      path.join(root, '10_library_600x900.jpg')
    );
    assert.equal(
      await s.findLibraryCover(fs.promises, path, root, '20', 'portrait'),
      path.join(root, '20', 'abcdef0123456789', 'library_600x900.jpg')
    );
    assert.equal(await s.findLibraryCover(fs.promises, path, root, '../10', 'portrait'), '');
    assert.equal(await s.findLibraryCover(fs.promises, path, root, '30', 'portrait'), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installed tools and software are not games; delisted apps stay', async () => {
  const { LibraryService } = require('../src/main/library.cjs');
  const urls = [];
  const lib = new LibraryService({
    settings: { storeCountry: 'KZ' },
    storage: { loadOwned: () => ({}) },
    log: { debug() {}, warn() {}, info() {} },
    publicFetch: async url => {
      urls.push(url);
      const ids = JSON.parse(new URL(url).searchParams.get('input_json')).ids.map(x => String(x.appid));
      const types = { 892970: 0, 1905180: 6, 2420510: 4 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            store_items: ids
              .filter(i => i !== '999')
              .map(i => ({ appid: Number(i), success: 1, type: types[i], name: 'x' })),
          },
        }),
      };
    },
  });
  const offer = appId => ({ provider: 'steam', appId });
  assert.equal(lib.isGameOffer(offer('228980')), false, 'redistributables are a known tool');
  const local = {
    offers: ['892970', '1905180', '2420510', '999'].map(offer),
    steamAll: ['892970', '1905180', '2420510', '999', '228980'],
  };
  assert.equal(await lib.classifyLocalSteam(local), true);
  assert.deepEqual(
    local.offers.filter(o => lib.isGameOffer(o)).map(o => o.appId),
    ['892970', '999']
  );
  assert.equal(urls.length, 1);
  assert.equal(await lib.classifyLocalSteam(local), false, 'classified apps are not asked again');
  assert.equal(urls.length, 1);
});

test('store asset paths become safe image URLs; foreign formats are refused', () => {
  const a = s.storeAssets({
    asset_url_format: 'steam/apps/3241660/abc123/${FILENAME}?t=1',
    header: 'header.jpg',
    library_capsule: 'library_600x900.jpg',
  });
  assert.equal(
    a.image,
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3241660/abc123/header.jpg?t=1'
  );
  assert.match(a.portrait, /abc123\/library_600x900\.jpg/);
  assert.deepEqual(s.storeAssets({ asset_url_format: 'https://evil.example/${FILENAME}', header: 'h.jpg' }), {});
  assert.deepEqual(s.storeAssets({ asset_url_format: 'steam/apps/1/${FILENAME}', header: '../x.jpg' }), {});
  assert.deepEqual(s.storeAssets(null), {});
});

test('store front details: description, named tags, reviews, screenshot thumbnails, large capsule', () => {
  const names = new Map([
    [19, 'Экшен'],
    [1662, 'Выживание'],
  ]);
  const details = s.parseStoreDetails(
    {
      response: {
        store_items: [
          {
            appid: 10,
            success: 1,
            basic_info: { short_description: '  Коротко об игре.  ' },
            tags: [{ tagid: 19 }, { tagid: 999 }, { tagid: 1662 }],
            reviews: {
              summary_filtered: {
                review_count: 96920,
                percent_positive: 92,
                review_score: 8,
                review_score_label: 'Очень положительные',
              },
            },
            screenshots: {
              all_ages_screenshots: [
                { filename: 'steam/apps/10/abc/ss_abc.jpg?t=1' },
                { filename: '../../evil.jpg' },
                { filename: 'steam/apps/10/ss_x.png' },
              ],
            },
            assets: {
              asset_url_format: 'steam/apps/10/${FILENAME}?t=1',
              main_capsule: 'h/capsule_616x353.jpg',
              main_capsule_2x: 'h/capsule_616x353_2x.jpg',
            },
            release: { steam_release_date: 1700000000 },
          },
          { appid: 11, success: 2 },
          { appid: 'x', success: 1 },
        ],
      },
    },
    names
  );
  assert.deepEqual([...details.keys()], ['10']);
  const d = details.get('10');
  assert.equal(d.description, 'Коротко об игре.');
  assert.deepEqual(d.tags, ['Экшен', 'Выживание'], 'unknown tag ids are skipped');
  assert.deepEqual(d.reviews, { label: 'Очень положительные', score: 8, percent: 92, count: 96920 });
  assert.deepEqual(d.screenshots, [
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/abc/ss_abc.600x338.jpg?t=1',
  ]);
  assert.equal(
    d.capsule,
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/h/capsule_616x353_2x.jpg?t=1'
  );
  assert.equal(d.releaseDate, 1700000000 * 1000);
  // A game without reviews has none, not "0 reviews".
  const empty = s.parseStoreDetails({ response: { store_items: [{ appid: 12, success: 1 }] } });
  assert.equal(empty.get('12').reviews, null);
  assert.deepEqual(empty.get('12').screenshots, []);
  assert.throws(() => s.parseStoreDetails({}), /не вернул/);
});
