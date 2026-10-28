// The "Хранилище" page: drives with installed games and their sizes. Run via `npm test`.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { DiskInfo, gameFolder } = require('../src/main/disk.cjs');

const GB = 1024 ** 3;

test('drives with games: sizes from the launchers, measured otherwise, sorted by size', async () => {
  const games = [
    {
      id: 'steam:570',
      name: 'Dota 2',
      offers: [
        {
          provider: 'steam',
          installed: true,
          installDir: 'E:\\SteamLibrary\\steamapps\\common\\dota 2 beta',
          sizeOnDisk: 77 * GB,
        },
      ],
    },
    {
      id: 'epic:a',
      name: 'Control',
      offers: [
        { provider: 'epic', installed: true, installLocation: 'D:\\Games\\Control', installSize: 42 * GB },
      ],
    },
    {
      id: 'custom:x',
      name: 'My Game',
      offers: [{ provider: 'custom', installed: true, exe: 'D:\\Indie\\Game\\game.exe' }],
    },
    {
      id: 'steam:1',
      name: 'Not installed',
      offers: [{ provider: 'steam', installed: false, installDir: 'D:\\x' }],
    },
  ];
  const measured = [];
  const disk = new DiskInfo(
    {
      library: {
        games,
        local: { steamRoots: ['C:\\Program Files (x86)\\Steam'] },
        progressByGame: () => ({ 'epic:a': {} }),
      },
    },
    {
      statfs: async root => ({
        bsize: 1,
        blocks: { 'C:\\': 500 * GB, 'D:\\': 1000 * GB, 'E:\\': 2000 * GB }[root],
        bavail: 100 * GB,
      }),
      measure: async dir => (measured.push(dir), 3 * GB),
    }
  );
  const info = await disk.info();
  assert.deepEqual(
    info.drives.map(d => [d.root, d.games.map(g => [g.name, g.size / GB])]),
    [
      ['C:\\', []],
      [
        'D:\\',
        [
          ['Control', 42],
          ['My Game', 3],
        ],
      ],
      ['E:\\', [['Dota 2', 77]]],
    ]
  );
  const d = info.drives[1];
  assert.equal(d.free, 100 * GB);
  assert.equal(d.gamesSize, 45 * GB);
  assert.equal(d.other, 1000 * GB - 100 * GB - 45 * GB);
  assert.equal(d.games[0].busy, true, 'a game with a download in progress is marked');
  // A folder is measured once.
  await disk.info();
  assert.deepEqual(measured, [path.resolve('D:\\Indie\\Game')]);
  // Only folders of installed games may be opened.
  assert.equal(disk.allowed('d:\\games\\control'), true);
  assert.equal(disk.allowed('C:\\Windows'), false);
  assert.equal(disk.allowed('D:\\x'), false);
  assert.equal(gameFolder({ provider: 'custom', exe: 'C:\\a\\b.exe' }), 'C:\\a');
});
