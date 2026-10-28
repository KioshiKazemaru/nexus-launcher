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
  const list = f.parseSteamSummaries({
    response: {
      players: [
        {
          steamid: A,
          personaname: 'Alpha',
          personastate: 1,
          gameid: '570',
          gameextrainfo: 'Dota 2',
          avatarmedium: 'https://avatars.steamstatic.com/a.jpg',
        },
        { steamid: B, personaname: 'Beta', personastate: 3 },
        { steamid: C, personaname: 'Gamma', personastate: 0, lastlogoff: 1700000000 },
      ],
    },
  });
  assert.deepEqual(
    list.map(x => [x.name, x.status, x.game]),
    [
      ['Alpha', 'ingame', 'Dota 2'],
      ['Beta', 'away', ''],
      ['Gamma', 'offline', ''],
    ]
  );
  assert.equal(list[0].avatar, 'https://avatars.steamstatic.com/a.jpg');
  assert.equal(list[2].lastOnline, 1700000000000);
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
  assert.equal(f.parseEpicAccounts([{ id, displayName: 'Kioshi' }]).get(id), 'Kioshi');
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
