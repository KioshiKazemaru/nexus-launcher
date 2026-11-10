'use strict';
// Running processes on Windows, macOS and Linux: the list with program paths
// (to find running games), "is this program running" and closing a process.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

// A Wine / Proton path in a command line: Z:\home\me\Game\game.exe → /home/me/Game/game.exe.
function winePath(arg) {
  const m = /^[Zz]:[\\/](.*)$/.exec(String(arg || ''));
  return m ? '/' + m[1].replace(/\\/g, '/') : '';
}

// /proc/<pid>: the program itself and, for games under Wine or Proton (where the
// program is wine), the Windows program named first in the command line.
async function linuxProcesses(proc = '/proc') {
  const out = [];
  let pids;
  try {
    pids = (await fsp.readdir(proc)).filter(x => /^\d+$/.test(x));
  } catch {
    return out;
  }
  await Promise.all(
    pids.map(async name => {
      const pid = Number(name);
      const paths = new Set();
      try {
        // Updated programs read as "/path/game (deleted)".
        paths.add((await fsp.readlink(path.join(proc, name, 'exe'))).replace(/ \(deleted\)$/, ''));
      } catch {}
      try {
        const first = (await fsp.readFile(path.join(proc, name, 'cmdline'), 'utf8')).split('\0')[0];
        const unix = winePath(first) || (first.startsWith('/') ? first : '');
        if (unix) paths.add(unix);
      } catch {}
      for (const p of paths) if (p) out.push({ pid, path: p });
    })
  );
  return out;
}

// `ps -axww -o pid=,comm=`: on macOS comm is the full path of the program.
function parsePs(stdout) {
  const out = [];
  for (const line of String(stdout).split('\n')) {
    const m = /^\s*(\d+)\s+(\/.*\S)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), path: m[2] });
  }
  return out;
}

async function windowsProcesses() {
  const script =
    'Get-Process | Where-Object { $_.Path } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; path = $_.Path } } | ConvertTo-Json -Compress';
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const list = JSON.parse(stdout || '[]');
  return (Array.isArray(list) ? list : [list]).filter(
    p => Number.isInteger(p?.pid) && typeof p.path === 'string'
  );
}

// Processes with their program path: [{ pid, path }] (a pid may come twice on Linux).
async function listProcesses() {
  if (process.platform === 'win32') return windowsProcesses();
  if (process.platform === 'linux') return linuxProcesses();
  const { stdout } = await run('ps', ['-axww', '-o', 'pid=,comm='], {
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return parsePs(stdout);
}

// Is a program with this file name running ("steam.exe", "steam_osx", "game.x86_64")?
async function processRunning(image) {
  const want = String(image || '').toLowerCase();
  if (!want) return false;
  if (process.platform === 'win32') {
    try {
      const { stdout } = await run('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
        timeout: 8000,
      });
      return stdout.toLowerCase().includes(`"${want}"`);
    } catch {
      return false;
    }
  }
  try {
    return (await listProcesses()).some(p => path.basename(p.path).toLowerCase() === want);
  } catch {
    return false;
  }
}
async function anyRunning(images) {
  for (const image of images) if (await processRunning(image)) return true;
  return false;
}

// Asks a process to close (like the window's close button) or ends it by force.
async function endProcess(pid, force) {
  if (process.platform === 'win32')
    return run('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
      windowsHide: true,
      timeout: 15000,
    }).catch(() => {});
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {}
}

module.exports = { listProcesses, linuxProcesses, parsePs, winePath, processRunning, anyRunning, endProcess };
