'use strict';
// «Активность друзей» → «⚙ Настройки»: what is recorded and how long it is kept.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const p = require('../src/presence.cjs');

const DAY = 24 * 3600 * 1000;

test('activity settings: event types, recording off, how many days', () => {
  assert.equal(p.activityWanted({}, 'game'), true, 'everything by default');
  assert.equal(p.activityWanted({ activityGame: false }, 'game'), false);
  assert.equal(p.activityWanted({ activityGame: false }, 'stop'), true);
  assert.equal(p.activityWanted({ activityOnline: false }, 'online'), false);
  assert.equal(p.activityWanted({ activityRecord: false }, 'stop'), false, 'recording off: nothing');
  assert.equal(p.activityKeep({}), 7 * DAY);
  assert.equal(p.activityKeep({ activityDays: 30 }), 30 * DAY);
  assert.equal(p.activityKeep({ activityDays: 1 }), DAY);
  assert.equal(p.activityKeep({ activityDays: 1000 }), 7 * DAY, 'unknown: a week');
  const now = 100 * DAY;
  const old = { at: now - 10 * DAY, friendId: '1', type: 'game', game: 'A' };
  const entry = { at: now, friendId: '2', type: 'game', game: 'B' };
  assert.equal(p.addActivity([old], entry, now).length, 1, 'a week drops a 10 days old entry');
  assert.equal(p.addActivity([old], entry, now, 1000, 30 * DAY).length, 2, '30 days keep it');
});

test('activity settings: the page, its switches and the main process accept them', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app-social.js'), 'utf8');
  for (const k of [
    'activityRecord',
    'activityOnline',
    'activityGame',
    'activityStop',
    'activity-days',
    'activity-clear',
  ])
    assert.ok(ui.includes(k), k);
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'social.cjs'), 'utf8');
  for (const k of [
    'activityRecord',
    'activityOnline',
    'activityGame',
    'activityStop',
    'activityDays',
    'clearActivity',
  ])
    assert.ok(ipc.includes(k), k);
  assert.ok(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.cjs'), 'utf8').includes("'clearActivity'")
  );
});
