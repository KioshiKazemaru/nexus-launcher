'use strict';
// Starts the packaged Nexus (dist/*-unpacked or the macOS .app) with an empty profile
// and checks that it really runs: the main window loads ui/index.html, the log says
// "start <version>" and has no ERROR. Used by .github/workflows/build.yml after the
// installers are built; locally: node scripts/smoke-launch.cjs
//
// The fuses (package.json → build.electronFuses) forbid --inspect, so the window is
// looked up through Chromium's own DevTools port.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9555;
const TIMEOUT = 90_000;

function findApp(dist = path.join(ROOT, 'dist'), platform = process.platform) {
  const pkg = require(path.join(ROOT, 'package.json'));
  const name = pkg.build.productName || pkg.productName;
  if (platform === 'win32') return path.join(dist, 'win-unpacked', `${name}.exe`);
  if (platform === 'darwin') {
    for (const dir of ['mac-arm64', 'mac', 'mac-universal', 'mac-x64']) {
      const exe = path.join(dist, dir, `${name}.app`, 'Contents', 'MacOS', name);
      if (fs.existsSync(exe)) return exe;
    }
    return null;
  }
  // Linux: the executable is named after package.json "name" (electron-builder default).
  const dir = path.join(dist, 'linux-unpacked');
  for (const exe of [pkg.build.linux?.executableName, pkg.name, name.toLowerCase().replace(/\s+/g, '-')])
    if (exe && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mainWindowUrl() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
    const list = await r.json();
    return (
      list.find(t => t.type === 'page' && /\/ui\/index\.html$/.test(new URL(t.url).pathname))?.url || null
    );
  } catch {
    return null;
  }
}

async function run() {
  const exe = findApp();
  if (!exe || !fs.existsSync(exe)) throw Error(`packaged app not found (${exe || 'dist'})`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-smoke-'));
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`];
  // CI Linux runners have no user namespaces for Chromium's sandbox.
  if (process.platform === 'linux') args.push('--no-sandbox');
  console.log(`smoke: ${path.relative(ROOT, exe)}`);
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  let output = '';
  child.stdout.on('data', d => (output += d));
  child.stderr.on('data', d => (output += d));
  let exited = null;
  child.on('exit', code => (exited = code));
  const log = path.join(profile, 'logs', 'nexus.log');
  const started = Date.now();
  let url = null;
  try {
    while (Date.now() - started < TIMEOUT) {
      if (exited !== null) throw Error(`Nexus exited with ${exited}\n${output.slice(-2000)}`);
      url = url || (await mainWindowUrl());
      const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      if (url && /\[app\] start \d+\.\d+\.\d+/.test(text)) {
        // A few seconds more: errors right after the start count too.
        await sleep(5000);
        const after = fs.readFileSync(log, 'utf8');
        const errors = after.split('\n').filter(l => / ERROR /.test(l));
        if (errors.length) throw Error('errors in the log:\n' + errors.join('\n'));
        if (exited !== null) throw Error(`Nexus exited with ${exited} after the start`);
        console.log(
          `smoke: ok in ${Math.round((Date.now() - started) / 1000)} s — ${after.match(/\[app\] (start [^\n]+)/)[1]}`
        );
        return;
      }
      await sleep(1000);
    }
    throw Error(
      `no main window within ${TIMEOUT / 1000} s (window: ${!!url}, log: ${fs.existsSync(log)})\n${output.slice(-2000)}`
    );
  } finally {
    child.kill();
    await sleep(1500);
    if (exited === null) child.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

if (require.main === module)
  run().then(
    () => process.exit(0),
    e => {
      console.error('smoke: FAILED — ' + e.message);
      process.exit(1);
    }
  );

module.exports = { findApp };
