// Friends of Steam / Epic and running games. Run via `npm test`.
const test = require('node:test'),
  assert = require('node:assert/strict');
const f = require('../src/friends.cjs');
const { installTargets, matchRunning } = require('../src/main/running.cjs');

const A = '76561198000000001',
  B = '76561198000000002',
  C = '76561198000000003';

test('Steam friends: only accepted friends, status like Steam (in game wins)', () => {
  assert.deepEqual(
    f.parseSteamFriendIds({
      response: {
        friendslist: {
          friends: [
            { ulfriendid: A, efriendrelationship: 3 },
            { ulfriendid: B, efriendrelationship: 2 }, // invitation
            { ulfriendid: 'x', efriendrelationship: 3 },
          ],
        },
      },
    }),
    [A]
  );
  // IPlayerService/GetPlayerLinkDetails (the session token works; GetPlayerSummaries needs a key).
  const digest = Buffer.from('0123456789abcdef0123456789abcdef01234567', 'hex').toString('base64');
  const list = f.parseSteamLinkDetails({
    response: {
      accounts: [
        {
          public_data: { steamid: A, persona_name: 'Alpha', sha_digest_avatar: digest },
          private_data: { persona_state: 1, game_id: '570' },
        },
        {
          public_data: {
            steamid: B,
            persona_name: 'Beta',
            sha_digest_avatar: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          },
          private_data: { persona_state: 3, game_id: '0' },
        },
        {
          public_data: { steamid: C, persona_name: 'Gamma' },
          private_data: { persona_state: 0, last_logoff_time: 1700000000 },
        },
        { public_data: { steamid: 'x', persona_name: 'Bad' } },
      ],
    },
  });
  assert.deepEqual(
    list.map(x => [x.name, x.status, x.gameId]),
    [
      ['Alpha', 'ingame', '570'],
      ['Beta', 'away', ''],
      ['Gamma', 'offline', ''],
    ]
  );
  assert.equal(
    list[0].avatar,
    'https://avatars.steamstatic.com/0123456789abcdef0123456789abcdef01234567_medium.jpg'
  );
  assert.equal(list[1].avatar, ''); // the default "no avatar" digest
  assert.equal(list[2].lastOnline, 1700000000000);
  assert.throws(() => f.parseSteamLinkDetails({}), /профили друзей/);
  assert.deepEqual(
    f.sortFriends([list[2], list[1], list[0]]).map(x => x.name),
    ['Alpha', 'Beta', 'Gamma']
  );
  assert.throws(() => f.parseSteamFriendIds({}), /список друзей/);
});

test('Steam friends from the Steam Community page (fallback)', () => {
  const html = `
    <div class="friend_block_v2 persona in-game" data-steamid="${A}"><div class="player_avatar"><img src="https://avatars.steamstatic.com/a.jpg"></div>
      <div class="friend_block_content">Alpha<br><span class="friend_small_text">В игре<br>Hades</span></div></div>
    <div class="friend_block_v2 persona online" data-steamid="${B}"><div class="friend_block_content">Beta<br><span class="friend_small_text">В сети</span></div></div>
    <div class="friend_block_v2 persona offline" data-steamid="${C}"><div class="friend_block_content">Gamma</div></div>
    <div class="friend_block_v2 persona online" data-steamid="bad"></div>`;
  assert.deepEqual(
    f.parseSteamFriendsPage(html).map(x => [x.id, x.name, x.status, x.game]),
    [
      [A, 'Alpha', 'ingame', 'Hades'],
      [B, 'Beta', 'online', ''],
      [C, 'Gamma', 'offline', ''],
    ]
  );
});

test('Epic friends: ids and names only (no status for other programs)', () => {
  const id = 'a'.repeat(32);
  assert.deepEqual(f.parseEpicFriendIds({ friends: [{ accountId: id }, { accountId: 'nope' }] }), [id]);
  assert.equal(f.parseEpicAccounts([{ id, displayName: 'SteamPlayer' }]).get(id), 'SteamPlayer');
  assert.throws(() => f.parseEpicFriendIds({}), /Epic/);
});

test('a game runs when a process runs from its install folder (Steam, Epic, a manual .exe)', () => {
  const games = [
    {
      id: 'steam:1',
      name: 'Hades',
      offers: [
        { provider: 'steam', installed: true, installDir: String.raw`D:\Steam\steamapps\common\Hades` },
      ],
    },
    {
      id: 'epic:c',
      name: 'Control',
      offers: [{ provider: 'epic', installed: true, installLocation: String.raw`E:\Epic Games\Control` }],
    },
    {
      id: 'custom:x',
      name: 'Own',
      offers: [
        {
          provider: 'custom',
          installed: true,
          exe: String.raw`C:\Games\Own\launcher.exe`,
          trackProcess: 'own.exe',
        },
      ],
    },
    {
      id: 'steam:2',
      name: 'Not installed',
      offers: [{ provider: 'steam', installed: false, installDir: 'D:\\X' }],
    },
  ];
  const targets = installTargets(games);
  assert.equal(targets.length, 3);
  const running = matchRunning(
    [
      { pid: 10, path: String.raw`D:\Steam\steamapps\common\Hades\x64\Hades.exe` },
      { pid: 11, path: String.raw`D:\Steam\steamapps\common\Hades\UnityCrashHandler64.exe` },
      { pid: 20, path: String.raw`e:\epic games\control\Control_DX12.exe` }, // case does not matter
      { pid: 30, path: String.raw`C:\Somewhere\own.exe` }, // the "game process" of a launcher
      { pid: 40, path: String.raw`D:\Steam\steam.exe` }, // Steam itself is not a game
      { pid: 50, path: String.raw`D:\Steam\steamapps\common\HadesII\Hades2.exe` }, // same prefix, other folder
    ],
    targets
  );
  assert.deepEqual(Object.keys(running).sort(), ['custom:x', 'epic:c', 'steam:1']);
  assert.deepEqual(running['steam:1'].pids, [10, 11]);
  assert.equal(running['epic:c'].provider, 'epic');
});

test('"Закрыть" closes like the window close button; force only after the user agrees', async () => {
  const electron = require('electron');
  const { RunningGames } = require('../src/main/running.cjs');
  const toasts = [];
  const r = new RunningGames({
    log: { info() {}, debug() {} },
    hub: { publish() {} },
    toast: m => toasts.push(m),
    library: { games: [] },
  });
  const killed = [];
  let alive = [10, 11];
  r.refresh = async () => r.running;
  r.running = { 'steam:1': { name: 'Hades', provider: 'steam', pids: [10, 11], since: 1 } };
  r.kill = async (pids, force) => {
    killed.push([pids, force]);
    alive = [];
  };
  r.alive = async () => alive;
  assert.equal(await r.close('steam:1'), 'closed');
  assert.deepEqual(killed, [[[10, 11], false]], 'closed gently, not by force');
  assert.match(toasts[0], /Steam синхронизирует сохранения/);
  // A game that does not close: the user decides.
  alive = [10];
  r.kill = async (pids, force) => killed.push([pids, force]);
  const original = electron.dialog.showMessageBox;
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => (t += 30000); // the wait is over at once
  try {
    electron.dialog.showMessageBox = async () => ({ response: 0 }); // "Подождать"
    assert.equal(await r.close('steam:1'), 'kept');
    assert.equal(killed.at(-1)[1], false, 'never forced without the user');
    electron.dialog.showMessageBox = async () => ({ response: 1 }); // "Закрыть принудительно"
    assert.equal(await r.close('steam:1'), 'closed');
    assert.deepEqual(killed.at(-1), [[10], true]);
  } finally {
    Date.now = realNow;
    electron.dialog.showMessageBox = original;
  }
  r.running = {};
  assert.equal(await r.close('steam:1'), 'not-running');
});

test('"Играть" is refused while the game runs', async () => {
  const { ActionsService } = require('../src/main/actions.cjs');
  const actions = new ActionsService({
    settings: {},
    running: { isRunning: id => id === 'steam:1' },
    library: { games: [{ id: 'steam:1', offers: [{ provider: 'steam', appId: '1', installed: true }] }] },
  });
  await assert.rejects(() => actions.play({ id: 'steam:1', provider: 'steam' }), /уже запущена/);
});

test("a friend's games: hidden profile, playtime, recent games", () => {
  const f = require('../src/friends.cjs');
  assert.deepEqual(f.parseOwnedGames({ response: {} }), { hidden: true, count: 0, minutes: 0, games: [] });
  assert.throws(() => f.parseOwnedGames({}), /не отдал игры/);
  const owned = f.parseOwnedGames({
    response: {
      game_count: 2,
      games: [
        { appid: 10, name: 'Game A', playtime_forever: 120, rtime_last_played: 1700000000 },
        { appid: 20, name: 'Game B', playtime_forever: 0, rtime_last_played: 0 },
        { appid: 0, name: 'broken' },
      ],
    },
  });
  assert.equal(owned.hidden, false);
  assert.equal(owned.count, 2);
  assert.equal(owned.minutes, 120);
  assert.deepEqual(owned.games[0], { appId: '10', name: 'Game A', minutes: 120, lastPlayed: 1700000000000 });
  assert.equal(owned.games[1].lastPlayed, null);
  assert.deepEqual(f.parseRecentGames({ response: { total_count: 0 } }), []);
  assert.deepEqual(
    f.parseRecentGames({
      response: { games: [{ appid: 10, name: 'Game A', playtime_2weeks: 30, playtime_forever: 120 }] },
    }),
    [{ appId: '10', name: 'Game A', minutes2w: 30, minutes: 120 }]
  );
});

test("a friend's profile in Nexus: status, level, games in common, chat key", async () => {
  const { FriendsService } = require('../src/main/friends.cjs');
  const me = { key: 'steam:76561198000000001', id: '76561198000000001', name: 'me' };
  const friendId = '76561198000000002';
  const xml =
    '<?xml version="1.0"?><profile><steamID64>76561198000000002</steamID64><realname>Test Person</realname>' +
    '<location>Test City</location><summary><![CDATA[Line one<br>Line two<script>bad()</script>]]></summary>' +
    '<memberSince>May 1, 2015</memberSince></profile>';
  const svc = new FriendsService({
    accounts: {
      connected: p => (p === 'steam' ? [me] : []),
      session: () => ({ fetch: async () => ({ ok: true, text: async () => xml }) }),
    },
    // IStoreBrowseService/GetItems: names and images of the shown games.
    publicFetch: async url => ({
      ok: true,
      json: async () => {
        const ids = JSON.parse(new URL(url).searchParams.get('input_json')).ids.map(x => x.appid);
        return {
          response: {
            store_items: ids.map(appid => ({
              appid,
              id: appid,
              success: 1,
              type: 0,
              name: 'Store ' + appid,
              assets: { asset_url_format: 'steam/apps/' + appid + '/abc/${FILENAME}', header: 'header.jpg' },
            })),
          },
        };
      },
    }),
    log: {},
    library: {
      games: [
        {
          id: 'steam:10',
          name: 'Game A',
          offers: [{ provider: 'steam', appId: '10', owned: true, playtime: 300 }],
        },
        { id: 'steam:30', name: 'Game C', offers: [{ provider: 'steam', appId: '30', owned: true }] },
      ],
    },
    presence: { steamStatus: id => (id === friendId ? { status: 'online', game: '' } : null) },
  });
  svc.cache = {
    checkedAt: Date.now(),
    steam: [{ account: me, friends: [{ id: friendId, name: 'friend', status: 'offline' }] }],
    epic: [],
    errors: [],
  };
  const calls = [];
  svc.steamApi = async () => async (method, params) => {
    calls.push(method);
    if (method.includes('GetPlayerLinkDetails'))
      return {
        response: {
          accounts: [
            {
              public_data: {
                steamid: params['steamids[0]'],
                persona_name: 'friend',
                sha_digest_avatar: 'ASNFZ4mrze8BI0VniavN7wEjRWc=',
              },
              private_data: { persona_state: 0, last_logoff_time: 1700000000 },
            },
          ],
        },
      };
    if (method.includes('GetBadges')) return { response: { player_level: 12, badges: [{}, {}] } };
    if (method.includes('GetOwnedGames'))
      return {
        response: {
          game_count: 2,
          games: [
            { appid: 10, name: 'Game A', playtime_forever: 600 },
            { appid: 20, name: 'Game B', playtime_forever: 60 },
          ],
        },
      };
    if (method.includes('GetRecentlyPlayedGames'))
      return {
        response: { games: [{ appid: 20, name: 'Game B', playtime_2weeks: 60, playtime_forever: 60 }] },
      };
    throw Error('unexpected ' + method);
  };
  await assert.rejects(() => svc.profile('not-an-id'), /недоступен/);
  const p = await svc.profile(friendId);
  assert.equal(p.status, 'online', 'the live status wins over the Web API one');
  assert.equal(p.level, 12);
  assert.equal(p.badges, 2);
  assert.match(p.avatar, /_full\.jpg$/);
  assert.deepEqual(p.games, { hidden: false, count: 2, minutes: 660, played: 2 });
  assert.equal(p.commonCount, 1);
  assert.deepEqual(
    p.common.map(x => [x.appId, x.gameId, x.minutes, x.mine]),
    [['10', 'steam:10', 600, 300]]
  );
  assert.deepEqual(
    p.top.map(x => [x.appId, x.gameId]),
    [
      ['10', 'steam:10'],
      ['20', ''],
    ]
  );
  assert.equal(p.recent[0].gameId, '');
  assert.ok(p.conv, 'a friend can be messaged from the profile');
  // The parts of the Steam profile page: text only, no markup from the person.
  assert.equal(p.realName, 'Test Person');
  assert.equal(p.location, 'Test City');
  assert.equal(p.summary, 'Line one\nLine two');
  assert.equal(p.memberSince, 'May 1, 2015');
  // Store images for games without library art (hashed paths of new games).
  assert.match(
    p.recent[0].image,
    /^https:\/\/shared\.akamai\.steamstatic\.com\/store_item_assets\/steam\/apps\/20\/abc\/header\.jpg$/
  );
  // Cached for a while: no second round of requests.
  const n = calls.length;
  await svc.profile(friendId);
  assert.equal(calls.length, n);
});
