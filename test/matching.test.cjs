const test = require('node:test'),
  assert = require('node:assert/strict');
const m = require('../src/matching.cjs');

test('canonical titles ignore marks, punctuation and edition words, but not sequels or remasters', () => {
  assert.equal(m.canonicalTitle('Hades™'), 'hades');
  assert.equal(
    m.canonicalTitle('The Witcher 3: Wild Hunt – Game of the Year Edition'),
    'the witcher 3 wild hunt'
  );
  assert.equal(m.canonicalTitle("DEATH STRANDING DIRECTOR'S CUT"), 'death stranding');
  assert.equal(m.canonicalTitle('Gold Rush'), 'gold rush');
  assert.equal(m.canonicalTitle('Ultimate Chicken Horse'), 'ultimate chicken horse');
  assert.notEqual(m.canonicalTitle('Mafia II'), m.canonicalTitle('Mafia III'));
  assert.notEqual(m.canonicalTitle('Dark Souls Remastered'), m.canonicalTitle('Dark Souls'));
});

test('similarity is symmetric and only near-identical titles score high', () => {
  assert.equal(m.similarity('A', 'A'), 1);
  assert.equal(m.similarity('Control', 'Controlled'), m.similarity('Controlled', 'Control'));
  assert.ok(m.similarity('Assassins Creed Odyssey', "Assassin's Creed® Odyssey") === 1);
  assert.ok(m.similarity('Far Cry 5', 'Far Cry 6') < 1);
});

test('suggestions list close cross-store titles that were not merged and respect splits', () => {
  const games = [
    { id: 's', name: 'Tom Clancys Rainbow Six Siege', offers: [{ provider: 'steam', appId: '359550' }] },
    {
      id: 'e',
      name: 'Tom Clancys Rainbow Six Siege X',
      offers: [{ provider: 'epic', appId: 'r6', namespace: 'n' }],
    },
    { id: 'z', name: 'Something else', offers: [{ provider: 'epic', appId: 'z', namespace: 'n' }] },
  ];
  const list = m.suggestions(games);
  assert.equal(list.length, 1);
  assert.equal(list[0].a, 'steam:359550');
  assert.equal(list[0].b, 'epic:n:r6');
  assert.equal(m.suggestions(games, new Set([m.pairKey('steam:359550', 'epic:n:r6')])).length, 0);
});

test('a game known under a Russian and an English title merges across stores', () => {
  const { groupOffers: group } = require('../src/matching.cjs');
  const offers = [
    { provider: 'steam', appId: '990080', name: 'Hogwarts Legacy', installed: true },
    { provider: 'epic', appId: 'fa4240e57a3c46b39f169041b7811293', name: 'Хогвартс. Наследие', altName: 'Hogwarts Legacy', owned: true },
  ];
  const groups = group(offers);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'title');
});
