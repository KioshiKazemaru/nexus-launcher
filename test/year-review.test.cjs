'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { recordSession, yearReview, LOG_MAX } = require('../src/year-review.cjs');

const at = s => new Date(s).getTime();

test('session log: finished games are recorded, short runs and bad entries are not', () => {
  const now = at('2026-03-10T20:00:00');
  let log = recordSession([], { id: 'steam:1', name: 'A', provider: 'steam', since: now - 90 * 60000 }, now);
  assert.deepEqual(log, [{ id: 'steam:1', name: 'A', provider: 'steam', start: now - 90 * 60000, minutes: 90 }]);
  assert.equal(recordSession(log, { id: 'x', since: now - 30000 }, now), log, 'under a minute');
  assert.equal(recordSession(log, { id: 'x', since: now + 60000 }, now), log, 'in the future');
  assert.equal(recordSession(log, { since: now - 600000 }, now), log, 'no id');
  log = recordSession(log, { id: 'x', provider: 'weird', since: now - 600000 }, now);
  assert.equal(log[1].provider, 'custom');
  // Old entries go, the size is limited.
  const old = [{ id: 'o', start: now - 900 * 86400000, minutes: 5, provider: 'steam' }];
  assert.equal(recordSession(old, { id: 'n', since: now - 120000 }, now).length, 1);
  const big = Array.from({ length: LOG_MAX }, (_, i) => ({ id: 'g' + i, start: now - 1000, minutes: 1, provider: 'steam' }));
  assert.equal(recordSession(big, { id: 'n', since: now - 120000 }, now).length, LOG_MAX);
});

test('year review: totals, months, top games, longest session and the libraries', () => {
  const log = [
    { id: 'steam:1', name: 'A', provider: 'steam', start: at('2025-12-30T10:00'), minutes: 60 },
    { id: 'steam:1', name: 'A', provider: 'steam', start: at('2026-01-05T10:00'), minutes: 120 },
    { id: 'steam:1', name: 'A', provider: 'steam', start: at('2026-01-05T18:00'), minutes: 30 },
    { id: 'epic:b', name: 'B', provider: 'epic', start: at('2026-03-01T10:00'), minutes: 300 },
    { id: 'custom:c', name: 'C', provider: 'custom', start: at('2026-03-02T10:00'), minutes: 10 },
  ];
  const games = [
    { id: 'steam:1', name: 'A', offers: [{ provider: 'steam', owned: true, playtime: 6000, lastPlayed: at('2026-01-05') / 1000 }] },
    { id: 'epic:b', name: 'B', offers: [{ provider: 'epic', owned: true, playtime: 900, lastPlayed: at('2025-05-01') }] },
    { id: 'steam:9', name: 'Not owned', offers: [{ provider: 'steam', playtime: 99999 }] },
  ];
  const r = yearReview({ year: 2026, log, games, wishlist: 7, now: at('2026-11-11T12:00') });
  assert.equal(r.year, 2026);
  assert.deepEqual(r.years, [2026, 2025]);
  assert.equal(r.sessions, 4);
  assert.equal(r.minutes, 460);
  assert.equal(r.days, 3);
  assert.equal(r.games, 3);
  assert.equal(r.newGames, 2, 'A was played in 2025 already');
  assert.equal(r.months[0], 150);
  assert.equal(r.months[2], 310);
  assert.deepEqual(r.stores, { steam: 150, epic: 300, custom: 10 });
  assert.deepEqual(r.longest, { id: 'epic:b', name: 'B', minutes: 300, start: at('2026-03-01T10:00') });
  assert.deepEqual(r.top.map(x => [x.id, x.minutes, x.sessions]), [['epic:b', 300, 1], ['steam:1', 150, 2], ['custom:c', 10, 1]]);
  assert.equal(r.logSince, null, 'the log started before 2026');
  assert.equal(r.library.games, 2);
  assert.equal(r.library.minutes, 6900);
  assert.deepEqual(r.library.stores, { steam: 1, epic: 1, custom: 0 });
  assert.equal(r.library.playedThisYear, 1, 'seconds and milliseconds both read');
  assert.equal(r.library.top[0].id, 'steam:1');
  assert.equal(r.wishlist, 7);
  // 2025: the log started in it.
  const r25 = yearReview({ year: 2025, log, games, now: at('2026-11-11T12:00') });
  assert.equal(r25.logSince, at('2025-12-30T10:00'));
  assert.equal(r25.sessions, 1);
  // Nothing recorded yet.
  const empty = yearReview({ now: at('2026-11-11T12:00') });
  assert.equal(empty.year, 2026);
  assert.equal(empty.sessions, 0);
  assert.deepEqual(empty.years, [2026]);
});
