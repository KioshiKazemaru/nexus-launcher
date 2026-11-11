'use strict';
// After the Windows installer is code-signed (SignPath, .github/workflows/build.yml) its
// bytes change: latest.yml must name the new SHA-512 and size, or the installed Nexus
// refuses the download. Usage: node scripts/rehash-latest.cjs dist/latest.yml
// The installers are looked up next to latest.yml by the names it lists.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function rehash(yml, readFile) {
  const lines = yml.split(/\r?\n/);
  const sums = new Map();
  const sum = name => {
    if (!sums.has(name)) {
      const body = readFile(name);
      sums.set(name, {
        sha512: crypto.createHash('sha512').update(body).digest('base64'),
        size: body.length,
      });
    }
    return sums.get(name);
  };
  // The file a sha512/size line belongs to: the last `url:` above it in `files`,
  // or `path:` for the top-level `sha512:` (electron-builder writes path first).
  let current = null;
  const top = (yml.match(/^path: (.+)$/m) || [])[1]?.trim();
  return lines
    .map(line => {
      const url = line.match(/^\s+- url: (.+)$/);
      if (url) current = url[1].trim();
      if (/^\S/.test(line) && !/^files:/.test(line)) current = null;
      const sha = line.match(/^(\s*)sha512: /);
      if (sha) {
        const name = sha[1] ? current : top;
        if (name) return `${sha[1]}sha512: ${sum(name).sha512}`;
      }
      const size = line.match(/^(\s+)size: \d+$/);
      if (size && current) return `${size[1]}size: ${sum(current).size}`;
      return line;
    })
    .join('\n');
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) throw Error('usage: node scripts/rehash-latest.cjs dist/latest.yml');
  const dir = path.dirname(file);
  const out = rehash(fs.readFileSync(file, 'utf8'), name => {
    if (path.basename(name) !== name) throw Error('unexpected file name in latest.yml: ' + name);
    return fs.readFileSync(path.join(dir, name));
  });
  fs.writeFileSync(file, out);
  console.log(out);
}

module.exports = { rehash };
