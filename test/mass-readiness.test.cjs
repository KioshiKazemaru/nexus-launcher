const test = require('node:test'),
  assert = require('node:assert/strict');
const { hideUserPaths } = require('../src/main/log.cjs');
const { issueFormUrl } = require('../src/main/actions.cjs');
const { releaseFiles } = require('../scripts/release.cjs');
const { Updater } = require('../src/main/updater.cjs');

test('a report hides the user folder on every system, other paths stay', () => {
  const home = 'C:\\Users\\Иван';
  const text = [
    'scan C:\\Users\\Иван\\Games\\x.exe',
    'json "C:\\\\Users\\\\Иван\\\\AppData"',
    'other C:\\Users\\bob\\Steam',
    'D:/Users/alice/steam',
    'mac /Users/jo/Library/Application Support',
    'linux /home/kai/.steam',
    'C:\\Program Files (x86)\\Steam',
    'exit code: 1',
  ].join('\n');
  const out = hideUserPaths(text, home);
  assert.doesNotMatch(out, /Иван|bob|alice|jo\/|kai/);
  assert.match(out, /^scan ~\\Games\\x\.exe$/m);
  assert.match(out, /C:\\Users\\~\\Steam/);
  assert.match(out, /\/home\/~\/\.steam/);
  assert.match(out, /C:\\Program Files \(x86\)\\Steam/);
  assert.match(out, /exit code: 1/);
});

test('«Сообщить о проблеме» opens the bug form with version and system only', () => {
  const u = new URL(issueFormUrl('0.16.0', 'win32', '10.0.19045'));
  assert.equal(u.origin + u.pathname, 'https://github.com/KioshiKazemaru/nexus-launcher/issues/new');
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    template: 'bug.yml',
    version: '0.16.0',
    os: 'Windows 10.0.19045',
  });
});

test('beta channel: pre-release versions are accepted, the switch reaches the updater', () => {
  const ctx = { hub: { publish() {} }, log: { warn() {} }, settings: { betaUpdates: false } };
  const u = new Updater(ctx, 'win32');
  u.found('0.16.0-beta.1');
  assert.equal(u.state.version, '0.16.0-beta.1');
  assert.equal(
    u.releaseUrl(),
    'https://github.com/KioshiKazemaru/nexus-launcher/releases/tag/v0.16.0-beta.1'
  );
  u.found('0.16.0-beta/../x');
  assert.equal(u.state.version, null);
  u.updater = { allowPrerelease: false };
  u.setBeta(true);
  assert.equal(u.updater.allowPrerelease, true);
  u.setBeta(false);
  assert.equal(u.updater.allowPrerelease, false);
});

test('a beta release also carries the beta channel files', () => {
  assert.equal(releaseFiles('0.16.0').length, 11);
  const beta = releaseFiles('0.16.0-beta.1');
  assert.equal(beta.length, 14);
  for (const f of [
    'beta.yml',
    'beta-mac.yml',
    'beta-linux.yml',
    'latest.yml',
    'Nexus-Setup-0.16.0-beta.1.exe',
  ])
    assert.ok(beta.includes(f), f);
});
