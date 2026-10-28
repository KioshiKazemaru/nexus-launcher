// Flat config without plugins so it runs with a plain `eslint` install.
const node = {
  require: 'readonly',
  module: 'writable',
  process: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortSignal: 'readonly',
  Response: 'readonly',
  fetch: 'readonly',
  structuredClone: 'readonly',
};
const browser = {
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  fetch: 'readonly',
  DOMParser: 'readonly',
  innerHeight: 'readonly',
  innerWidth: 'readonly',
  requestAnimationFrame: 'readonly',
  IntersectionObserver: 'readonly',
  MutationObserver: 'readonly',
  navigator: 'readonly',
  CSS: 'readonly',
  Intl: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  URL: 'readonly',
  AbortSignal: 'readonly',
  structuredClone: 'readonly',
};
// The window's scripts (ui/app-*.js, ui/bigpicture.js) are classic scripts that
// share one global scope: every part sees the top-level names of the others.
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');
const WINDOW_PARTS = [
  'app-base.js',
  'app-store.js',
  'app-library.js',
  'app-events.js',
  'app-boot.js',
  'bigpicture.js',
];
function sharedGlobals() {
  const out = {};
  for (const name of WINDOW_PARTS) {
    const file = path.join(__dirname, 'ui', name);
    if (!fs.existsSync(file)) continue;
    const ast = espree.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 2024, sourceType: 'script' });
    for (const n of ast.body) {
      if (n.type === 'FunctionDeclaration') out[n.id.name] = 'readonly';
      if (n.type === 'VariableDeclaration')
        for (const d of n.declarations)
          if (d.id.type === 'Identifier') out[d.id.name] = n.kind === 'let' ? 'writable' : 'readonly';
    }
  }
  return out;
}
module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'ui/demo.js'] },
  {
    files: ['src/**/*.cjs', 'test/**/*.cjs', 'eslint.config.cjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: node },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['ui/friends.js', 'ui/chat.js', 'ui/social-common.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: browser },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: WINDOW_PARTS.map(n => 'ui/' + n),
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...browser, ...sharedGlobals() } },
    rules: {
      // Top-level names are used by the other parts: only local ones must be used.
      'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-redeclare': 'off',
    },
  },
];
