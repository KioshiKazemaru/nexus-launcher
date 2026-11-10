// Steam Families: parsing the two family methods, the library source of every
// game, and what the profile counts.
const test = require('node:test');
const assert = require('node:assert/strict');
const family = require('../src/family.cjs');
const pr = require('../src/profile.cjs');
const { mergeGames } = require('../src/core.cjs');
const { scopedGames } = require('../src/owned.cjs');

const ME = '76561198000000001',
  MOM = '76561198000000009',
  KID = '76561198000000010';

// 30 installed Steam games, 16 of them launched in the last 30 days (LastPlayed in the manifest).
function manifests(now = Date.now()) {
  return Array.from({ length: 30 }, (_, i) => ({
    provider: 'steam',
    appId: String(1000 + i),
    name: 'Game ' + i,
    installed: true,
    source: 'local',
    licenseUnknown: true,
    lastPlayed: i < 26 ? Math.floor(now / 1000) - (i < 16 ? 3600 : 90 * 86400) : 0,
  }));
}
// As LibraryService.rebuild(): the game's time and last launch are the largest of its offers.
const games = offers =>
  mergeGames(offers, { links: [], splits: new Set() }).map(g => ({
    ...g,
    playtime: Math.max(0, ...g.offers.map(o => Number(o.playtime) || 0)),
    lastPlayed: Math.max(0, ...g.offers.map(o => Number(o.lastPlayed) || 0)),
  }));

test('GetFamilyGroupForUser: family id, members; "no family" and bad answers', () => {
  const g = family.parseFamilyGroup({
    response: {
      family_groupid: '4242',
      is_not_member_of_any_group: false,
      family_group: { name: 'Дом', members: [{ steamid: ME }, { steamid: MOM }, { steamid: 765611 }] },
    },
  });
  assert.deepEqual(g, { groupId: '4242', name: 'Дом', members: [ME, MOM] });
  assert.equal(family.parseFamilyGroup({ response: { is_not_member_of_any_group: true } }).groupId, '');
  assert.equal(family.parseFamilyGroup({ response: { family_groupid: '0' } }).groupId, '');
  assert.equal(family.parseFamilyGroup({ response: {} }).groupId, '');
  assert.throws(() => family.parseFamilyGroup({}), /семье/);
  assert.throws(() => family.parseFamilyGroup(null), /семье/);
});

test('GetSharedLibraryApps: owners per app; unshareable apps and number ids are dropped', () => {
  const apps = family.parseSharedApps({
    response: {
      apps: [
        { appid: 10, owner_steamids: [MOM, MOM], name: 'Counter-Strike' },
        { appid: 20, owner_steamids: [MOM, KID] },
        { appid: 30, owner_steamids: [MOM], exclude_reason: 2 },
        { appid: 40, owner_steamids: [76561198000000009] },
        { appid: 'x', owner_steamids: [MOM] },
      ],
      owner_steamid: ME,
    },
  });
  assert.deepEqual(apps, {
    10: { owners: [MOM], name: 'Counter-Strike' },
    20: { owners: [MOM, KID], name: '' },
    40: { owners: [], name: '' },
  });
  assert.deepEqual(family.parseSharedApps({ response: {} }), {});
  assert.throws(() => family.parseSharedApps({ response: { apps: 'no' } }), /семьи/);
  assert.throws(() => family.parseSharedApps({}), /семьи/);
});

test('fetchFamily: the session token on both methods; no family asks no apps; HTTP errors carry the status', async () => {
  const urls = [];
  const fetcher = route => async url => {
    urls.push(url);
    const r = route(new URL(url));
    return { ok: r.status === undefined, status: r.status || 200, json: async () => r };
  };
  const full = await family.fetchFamily(
    fetcher(u =>
      u.pathname.includes('GetFamilyGroupForUser')
        ? { response: { family_groupid: '77', family_group: { members: [{ steamid: MOM }] } } }
        : { response: { apps: [{ appid: 570, owner_steamids: [MOM] }] } }
    ),
    'TOKEN',
    ME
  );
  assert.equal(full.groupId, '77');
  assert.deepEqual(full.apps, { 570: { owners: [MOM], name: '' } });
  assert.equal(urls.length, 2);
  for (const u of urls.map(x => new URL(x))) {
    assert.equal(u.origin, 'https://api.steampowered.com');
    assert.equal(u.searchParams.get('access_token'), 'TOKEN');
  }
  assert.equal(new URL(urls[1]).searchParams.get('family_groupid'), '77');

  urls.length = 0;
  const none = await family.fetchFamily(
    fetcher(() => ({ response: { is_not_member_of_any_group: true } })),
    'TOKEN',
    ME
  );
  assert.deepEqual(none, { groupId: '', name: '', members: [], apps: {} });
  assert.equal(urls.length, 1, 'no family: the shared library is not asked');

  await assert.rejects(
    family.fetchFamily(
      fetcher(() => ({ status: 500 })),
      'TOKEN',
      ME
    ),
    e => e.status === 500 && /GetFamilyGroupForUser: HTTP 500/.test(e.message)
  );
});

test('no Steam account + 30 manifests: every game is "local"; the profile counts nothing', () => {
  const list = family.classifyLibrary(games(manifests()), { active: new Set() });
  assert.equal(list.length, 30);
  assert.ok(list.every(g => g.librarySource === 'local'));
  const s = pr.libraryStats(list);
  assert.equal(s.games, 0);
  assert.equal(s.family, 0);
  assert.equal(s.installed, 0);
  assert.equal(s.played, 0);
  assert.equal(s.playedThisMonth, 0);
  assert.equal(s.minutes, 0);
  assert.deepEqual(s.byProvider.steam, { games: 0, family: 0, minutes: 0 });
  assert.deepEqual(s.top, []);
  assert.equal(s.foundOnPc, 30);
  for (const kind of ['owned', 'installed', 'played', 'family'])
    assert.deepEqual(pr.libraryList(list, kind), [], kind);
});

test('account without own games + 30 family manifests: 0 own, 30 family, each with its owner', () => {
  const shared = new Map(manifests().map((o, i) => [o.appId, { owners: [i % 2 ? MOM : KID] }]));
  const names = new Map([
    [MOM, 'Мама'],
    [KID, 'Петя'],
  ]);
  const list = family.classifyLibrary(games(manifests()), { active: new Set([ME]), family: shared, names });
  assert.ok(list.every(g => g.librarySource === 'family'));
  for (const g of list) {
    const o = g.offers[0];
    assert.equal(o.familyOwners.length, 1);
    assert.equal(o.familyOwners[0].name, Number(o.appId) % 2 ? 'Мама' : 'Петя');
  }
  const s = pr.libraryStats(list);
  assert.equal(s.games, 0);
  assert.equal(s.family, 30);
  assert.deepEqual(s.byProvider.steam, { games: 0, family: 30, minutes: 0 });
  assert.equal(s.installed, 30);
  assert.equal(s.played, 26);
  assert.equal(s.playedThisMonth, 16);
  assert.equal(pr.libraryList(list, 'owned').length, 0);
  assert.equal(pr.libraryList(list, 'family').length, 30);
  assert.equal(pr.libraryList(list, 'family', 'steam').length, 30);
});

test('own games win over family; the rest is "unconfirmed" when the family list has no answer', () => {
  const own = [
    { provider: 'steam', appId: '1000', accountId: ME, name: 'Game 0', owned: true, source: 'account' },
    { provider: 'steam', appId: '1001', accountId: ME, name: 'Game 1', owned: true, source: 'account' },
  ];
  const shared = new Map([
    ['1001', { owners: [MOM] }],
    ['1002', { owners: [MOM] }],
    // Only the account itself owns it in the family: the account list decides.
    ['1003', { owners: [ME] }],
  ]);
  const list = family.classifyLibrary(games([...own, ...manifests()]), {
    active: new Set([ME]),
    family: shared,
  });
  const by = id => list.find(g => g.offers.some(o => o.appId === id));
  assert.equal(by('1000').librarySource, 'own');
  assert.equal(by('1001').librarySource, 'own');
  assert.equal(by('1002').librarySource, 'family');
  assert.deepEqual(by('1002').offers[0].familyOwners, [{ id: MOM, name: '' }]);
  assert.equal(by('1003').librarySource, 'unconfirmed');
  assert.equal(by('1010').librarySource, 'unconfirmed');
  const s = pr.libraryStats(list);
  assert.equal(s.games, 2);
  assert.equal(s.family, 1);
  assert.equal(s.unconfirmed, 27);
  assert.equal(s.byProvider.steam.games, 2);

  // The family endpoint failed: nothing is lost, nothing is called "own".
  const failed = family.classifyLibrary(games([...own, ...manifests()]), { active: new Set([ME]) });
  assert.equal(failed.length, 30);
  assert.equal(failed.filter(g => g.librarySource === 'own').length, 2);
  assert.equal(failed.filter(g => g.librarySource === 'unconfirmed').length, 28);
});

test('family and unconfirmed games keep install state, merging with Epic and the account scope', () => {
  const offers = [
    ...manifests().slice(0, 2),
    {
      provider: 'epic',
      appId: 'Epic0',
      accountId: 'e'.repeat(32),
      name: 'Game 0',
      owned: true,
      source: 'account',
    },
  ];
  const list = family.classifyLibrary(games(offers), {
    active: new Set([ME]),
    family: new Map([['1000', { owners: [MOM] }]]),
  });
  const merged = list.find(g => g.offers.length === 2);
  assert.ok(merged, 'Steam family copy and Epic copy are one game');
  assert.equal(merged.librarySource, 'own', 'the Epic copy is the account’s');
  assert.equal(merged.offers.find(o => o.provider === 'steam').librarySource, 'family');
  // The window list (scopedGames) keeps installed family games and their source.
  const visible = scopedGames(list, { steam: [{ id: ME, status: 'connected' }], epic: [] });
  const steam = visible.flatMap(g => g.offers).filter(o => o.provider === 'steam');
  assert.equal(steam.length, 2);
  assert.ok(steam.every(o => o.installed && o.librarySource));
});

test('gameSource ranks own > family > unconfirmed > local', () => {
  const g = sources => ({ offers: sources.map(librarySource => ({ librarySource })) });
  assert.equal(family.gameSource(g(['local', 'family'])), 'family');
  assert.equal(family.gameSource(g(['unconfirmed', 'local'])), 'unconfirmed');
  assert.equal(family.gameSource(g(['family', 'own'])), 'own');
  assert.equal(family.gameSource(g([])), 'own');
});

test('filterLibrary: games found without an account are only "installed"', () => {
  const { filterLibrary } = require('../src/owned.cjs');
  const list = [
    { id: 'local', offers: [{ provider: 'steam', installed: true, librarySource: 'local' }] },
    { id: 'family', offers: [{ provider: 'steam', installed: true, librarySource: 'family' }] },
    { id: 'own', offers: [{ provider: 'steam', owned: true, librarySource: 'own' }] },
  ];
  assert.deepEqual(
    filterLibrary(list, 'owned').map(g => g.id),
    ['family', 'own']
  );
  assert.deepEqual(
    filterLibrary(list, 'installed').map(g => g.id),
    ['local', 'family']
  );
});
