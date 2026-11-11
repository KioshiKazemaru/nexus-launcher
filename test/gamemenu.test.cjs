'use strict';
// Right click on a library game: Steam's context menu, every item handled.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');

const ui = f => fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8');

test('game menu: loaded after the click handlers it reuses', () => {
  const html = ui('index.html');
  assert.ok(html.indexOf('app-gamemenu.js') > html.indexOf('app-events.js'));
});

test('game menu: every item has an action, the reused handlers exist', () => {
  const src = ui('app-gamemenu.js');
  const events = ui('app-events.js');
  const items = [...src.matchAll(/item\(\s*'([\w-]+)'/g)].map(m => m[1]);
  for (const a of [
    'play',
    'stop',
    'favorite',
    'collection',
    'folder',
    'verify',
    'hide',
    'uninstall',
    'store',
    'properties',
  ])
    assert.ok(items.includes(a), `menu item ${a}`);
  const actions = src.slice(src.indexOf('const GAME_MENU_ACTIONS'));
  for (const a of new Set(items)) assert.match(actions, new RegExp(`\n  '?${a}'?: `), `action ${a}`);
  for (const [, id] of src.matchAll(/CLICK_BY_ID\['([\w-]+)'\]/g))
    assert.ok(events.includes(`CLICK_BY_ID['${id}']`) || events.includes(`'${id}'`), id);
});

test('community: no Steam header and no toolbar of our own', () => {
  const html = ui('index.html');
  const section = html.slice(
    html.indexOf('<section id="community"'),
    html.indexOf('</section>', html.indexOf('<section id="community"'))
  );
  assert.doesNotMatch(section, /<button/, 'no buttons over the page');
  const src = ui('app-community.js');
  assert.match(src, /#global_header/, 'Steam header hidden');
  assert.match(ui('app-events.js'), /communityStep\(step\)/, 'Nexus ← → step through Steam pages');
});
