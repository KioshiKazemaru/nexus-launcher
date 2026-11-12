const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { webUrl, appUrl, addressInput, siteKind, SEARCH } = require('../src/browser-url.cjs');
const { freePath } = require('../src/main/browser.cjs');

test('Nexus browser: tabs load only web pages, programs get their own links', () => {
  assert.equal(webUrl('https://github.com/x'), 'https://github.com/x');
  assert.equal(webUrl('http://example.com'), 'http://example.com/');
  assert.equal(webUrl('about:blank'), 'about:blank');
  for (const bad of [
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'https://user:pw@example.com',
    'steam://run/10',
    '',
    null,
  ])
    assert.equal(webUrl(bad), null, String(bad));
  assert.equal(appUrl('steam://run/10'), 'steam://run/10');
  assert.equal(appUrl('com.epicgames.launcher://store'), 'com.epicgames.launcher://store');
  assert.equal(appUrl('mailto:a@b.c'), 'mailto:a@b.c');
  for (const bad of ['file:///x', 'ms-settings:privacy', 'https://x.com', 'vbscript:x'])
    assert.equal(appUrl(bad), null, bad);
});

test('address bar: addresses with or without https://, anything else is a search', () => {
  assert.equal(addressInput('store.steampowered.com/app/10'), 'https://store.steampowered.com/app/10');
  assert.equal(addressInput('https://github.com'), 'https://github.com/');
  assert.equal(addressInput('localhost:3000'), 'https://localhost:3000/');
  assert.equal(addressInput('half life 3'), SEARCH + 'half%20life%203');
  assert.equal(addressInput('portal'), SEARCH + 'portal');
  assert.equal(addressInput('javascript:alert(1)'), SEARCH + encodeURIComponent('javascript:alert(1)'));
  assert.equal(addressInput('file:///C:/x'), null);
  assert.equal(addressInput('   '), null);
});

test('only Steam Community pages open with the Steam sign-in', () => {
  assert.equal(siteKind('https://steamcommunity.com/app/10/workshop/'), 'steam');
  assert.equal(siteKind('https://store.steampowered.com/about/'), '');
  assert.equal(siteKind('http://steamcommunity.com/'), '');
  assert.equal(siteKind('https://steamcommunity.com.evil.example/'), '');
  assert.equal(siteKind('https://github.com/'), '');
});

test('downloads get a free, safe file name in the folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dl-'));
  try {
    assert.equal(path.basename(freePath(dir, 'SteamSetup.exe')), 'SteamSetup.exe');
    fs.writeFileSync(path.join(dir, 'SteamSetup.exe'), '');
    assert.equal(path.basename(freePath(dir, 'SteamSetup.exe')), 'SteamSetup (1).exe');
    assert.equal(path.dirname(freePath(dir, '../../evil.exe')), dir);
    assert.equal(path.basename(freePath(dir, 'a:b?.txt')), 'a_b_.txt');
    assert.equal(path.basename(freePath(dir, '')), 'download');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
