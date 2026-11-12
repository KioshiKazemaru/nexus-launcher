const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { releaseNotes, releaseFiles, prepare } = require('../scripts/release.cjs');
const pkg = require('../package.json');

test('release notes: the README section of the version', () => {
  const readme = '# N 1.2.0\n\n## Что нового в 1.2.0\n\n- a\n- b\n\n## Что нового в 1.1.0\n\n- old\n';
  const notes = releaseNotes(readme, '1.2.0');
  assert.equal(notes, '## Что нового в 1.2.0\n\n- a\n- b\n');
  assert.throws(() => releaseNotes(readme, '9.9.9'), /9\.9\.9/);
  // The real README has notes for the current version.
  const real = releaseNotes(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8'), pkg.version);
  assert.match(real, new RegExp(`^## Что нового в ${pkg.version.replace(/\./g, '\.')}`));
});

test('release: 11 files are picked from the artifact folders, a wrong tag or a missing file stops it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-'));
  try {
    const files = releaseFiles(pkg.version);
    assert.equal(files.length, 11);
    files.forEach((f, i) => {
      const sub = path.join(
        dir,
        'a',
        ['nexus-windows-latest', 'nexus-macos-latest', 'nexus-ubuntu-latest'][i % 3]
      );
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, f), f);
    });
    assert.throws(() => prepare(path.join(dir, 'a'), path.join(dir, 'o'), 'v0.0.1'), /does not match/);
    const r = prepare(path.join(dir, 'a'), path.join(dir, 'o'), `v${pkg.version}`);
    assert.equal(r.files.length, 11);
    assert.equal(fs.readdirSync(path.join(dir, 'o')).length, 12);
    fs.rmSync(path.join(dir, 'a', 'nexus-macos-latest'), { recursive: true });
    assert.throws(() => prepare(path.join(dir, 'a'), path.join(dir, 'p'), ''), /missing files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
