'use strict';
// Release from CI (.github/workflows/build.yml, job "release"): checks that the tag
// matches package.json, writes the notes (README "## Что нового в X") and lists
// the files of a release.
//   node scripts/release.cjs <artifacts dir> <out dir> [tag]
// Without a tag (a dry run on a branch) the version from package.json is used.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function releaseNotes(readme, version) {
  const lines = readme.split('\n');
  const start = lines.findIndex(l => l.trim() === `## Что нового в ${version}`);
  if (start < 0) throw Error(`README has no "## Что нового в ${version}"`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start, end).join('\n').trim();
  return `${body}\n`;
}

// The files a release carries, named by version: installers, the update block map
// and the latest*.yml the installed Nexus reads to find an update.
// A beta (1.2.3-beta.4) also carries the beta*.yml that installed betas read.
function releaseFiles(version) {
  const beta = version.includes('-') ? ['beta.yml', 'beta-mac.yml', 'beta-linux.yml'] : [];
  return [
    ...beta,
    `Nexus-Setup-${version}.exe`,
    `Nexus-Setup-${version}.exe.blockmap`,
    'latest.yml',
    `Nexus-${version}-mac-arm64.dmg`,
    `Nexus-${version}-mac-arm64.zip`,
    `Nexus-${version}-mac-x64.dmg`,
    `Nexus-${version}-mac-x64.zip`,
    'latest-mac.yml',
    `Nexus-${version}-linux-x86_64.AppImage`,
    `Nexus-${version}-linux-amd64.deb`,
    'latest-linux.yml',
  ];
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

function prepare(artifacts, out, tag) {
  const version = require(path.join(ROOT, 'package.json')).version;
  if (tag && tag !== `v${version}`) throw Error(`tag ${tag} does not match package.json ${version}`);
  const notes = releaseNotes(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), version);
  const found = new Map(walk(artifacts).map(p => [path.basename(p), p]));
  const want = releaseFiles(version);
  const missing = want.filter(f => !found.has(f));
  if (missing.length) throw Error('missing files: ' + missing.join(', '));
  fs.mkdirSync(out, { recursive: true });
  for (const f of want) fs.copyFileSync(found.get(f), path.join(out, f));
  fs.writeFileSync(path.join(out, 'notes.md'), notes);
  return { version, files: want };
}

if (require.main === module) {
  const [artifacts, out, tag] = process.argv.slice(2);
  try {
    const r = prepare(artifacts, out, tag || '');
    console.log(`release ${r.version}: ${r.files.length} files + notes.md in ${out}`);
  } catch (e) {
    console.error('release: ' + e.message);
    process.exit(1);
  }
}

module.exports = { releaseNotes, releaseFiles, prepare };
