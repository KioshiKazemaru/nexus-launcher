'use strict';
// The top menus (like the Steam client): every item leads somewhere real.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');

const ui = f => fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8');
const html = ui('index.html');
const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));

test('top menus: Steam client menus and tabs are all there', () => {
  for (const name of ['Nexus', 'Вид', 'Друзья', 'Игры', 'Справка', 'МАГАЗИН', 'БИБЛИОТЕКА', 'СООБЩЕСТВО'])
    assert.ok(header.includes(`>${name}<`) || header.includes(`">${name}</button>`) || header.includes(name), name);
  assert.match(header, /id="nav-persona"/, 'the account name tab');
  assert.equal((header.match(/data-set-status="/g) || []).length, 4, 'four statuses');
  assert.match(header, /data-page="review">Итоги Nexus</, 'Итоги Nexus instead of Итоги Steam');
  assert.doesNotMatch(header, /Итоги Steam|Трансляции|>ЖЕЛАЕМОЕ/, 'removed items');
  for (const s of ['discussions', 'workshop', 'market']) assert.match(header, new RegExp('data-section="' + s + '"'), s);
});

test('top menus: every action is handled and every page exists', () => {
  const events = ui('app-events.js');
  const actions = [...header.matchAll(/data-menu-action="([\w-]+)"/g)].map(m => m[1]);
  assert.ok(actions.length > 10);
  for (const a of new Set(actions))
    assert.ok(new RegExp(`\n  '?${a}'?: `).test(events), `MENU_ACTIONS has ${a}`);
  const pages = new Set(['store', 'library', 'recent', 'favorites', 'downloads', 'storage', 'activity', 'news', 'profile', 'wishlist', 'tracking', 'accounts', 'review', 'community']);
  for (const [, p] of header.matchAll(/data-page="(\w+)"/g)) assert.ok(pages.has(p), p);
  const statuses = [...header.matchAll(/data-set-status="(\w+)"/g)].map(m => m[1]);
  const { STATUSES } = require('../src/presence.cjs');
  if (STATUSES) for (const s of statuses) assert.ok(STATUSES.includes(s), s);
});

test('top menus: every link passes the openLink rule of the main process', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'app.cjs'), 'utf8');
  assert.match(source, /register\('quitApp'/);
  // The same rule as register('openLink').
  const allowed = u =>
    u.protocol === 'https:' &&
    (/(^|\.)(steampowered\.com|steamcommunity\.com|steamstatic\.com|epicgames\.com)$/.test(u.hostname) ||
      (u.hostname === 'github.com' && /^\/KioshiKazemaru\/nexus-launcher(\/|$)/.test(u.pathname)));
  const links = [...header.matchAll(/data-open-link="([^"]+)"/g)].map(m => m[1]);
  assert.ok(links.length >= 10);
  for (const l of links) assert.ok(allowed(new URL(l)), l);
  assert.ok(!allowed(new URL('https://github.com/someone/else')));
  assert.ok(!allowed(new URL('http://store.steampowered.com/')));
});

test('СООБЩЕСТВО in the window: only Steam https pages, no Nexus preload, the Steam session', () => {
  const { EventEmitter } = require('node:events');
  const { guardCommunityViews, steamUrl } = require('../src/main/community-view.cjs');
  assert.ok(steamUrl('https://steamcommunity.com/market/'));
  assert.ok(steamUrl('https://store.steampowered.com/app/10/'));
  for (const bad of ['http://steamcommunity.com/', 'https://evil.com/', 'https://steamcommunity.com.evil.com/', 'https://a:b@steamcommunity.com/', 'javascript:alert(1)'])
    assert.equal(steamUrl(bad), null, bad);
  const main = new EventEmitter();
  guardCommunityViews(main, { partition: () => 'nexus-steam' });
  const attach = src => {
    const prefs = { preload: '/nexus/preload.cjs', nodeIntegration: true, contextIsolation: false, sandbox: false };
    let refused = false;
    main.emit('will-attach-webview', { preventDefault: () => (refused = true) }, prefs, { src });
    return { prefs, refused };
  };
  const ok = attach('https://steamcommunity.com/workshop/');
  assert.equal(ok.refused, false);
  assert.equal(ok.prefs.preload, undefined, 'never the Nexus preload');
  assert.equal(ok.prefs.nodeIntegration, false);
  assert.equal(ok.prefs.contextIsolation, true);
  assert.equal(ok.prefs.sandbox, true);
  assert.equal(ok.prefs.partition, 'nexus-steam', 'the Steam account session, set by Nexus');
  assert.equal(attach('https://evil.com/').refused, true);
  // The guest: Steam links stay, other sites are refused on the page.
  const guest = new EventEmitter();
  let openHandler;
  const loaded = [];
  guest.setWindowOpenHandler = fn => (openHandler = fn);
  guest.loadURL = async u => loaded.push(u);
  main.emit('did-attach-webview', {}, guest);
  assert.deepEqual(openHandler({ url: 'https://steamcommunity.com/id/x' }), { action: 'deny' });
  assert.deepEqual(loaded, ['https://steamcommunity.com/id/x'], 'a Steam popup opens on the page');
  assert.deepEqual(openHandler({ url: 'https://evil.com/' }), { action: 'deny' });
  let stopped = false;
  guest.emit('will-navigate', { preventDefault: () => (stopped = true) }, 'https://evil.com/');
  assert.equal(stopped, true);
  stopped = false;
  guest.emit('will-navigate', { preventDefault: () => (stopped = true) }, 'https://steamcommunity.com/market/');
  assert.equal(stopped, false);
});
