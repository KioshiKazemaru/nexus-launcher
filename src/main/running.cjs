'use strict';
// Games that are running now, found by their processes: a process whose
// program lies in the install folder of a library game (Steam, Epic Games,
// a manually added .exe) means the game runs — no matter who started it.
//
// "Закрыть" asks the game to close like the window's close button (so it can
// save), waits, and only after the user agrees ends it by force. Cloud saves
// follow: Steam Cloud and the Epic launcher upload by themselves; for Epic
// games started by Nexus, epic-play.cjs uploads the saves when the game ends.

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { dialog } = require('electron');

const run = promisify(execFile);
const POLL_MS = 15000;
const CLOSE_WAIT_MS = 25000;

// Processes with their program path: [{ pid, path }].
async function listProcesses() {
  if (process.platform !== 'win32') return [];
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

// Where each installed library game lives: [{ gameId, name, provider, dir, exe }].
function installTargets(games) {
  const out = [];
  for (const g of games)
    for (const o of g.offers || []) {
      if (!o.installed) continue;
      const dir = o.provider === 'steam' ? o.installDir : o.provider === 'epic' ? o.installLocation : null;
      if (dir) out.push({ gameId: g.id, name: g.name, provider: o.provider, dir: path.resolve(dir) });
      else if (o.provider === 'custom' && o.exe)
        out.push({
          gameId: g.id,
          name: g.name,
          provider: 'custom',
          exe: path.resolve(o.exe),
          trackProcess: o.trackProcess,
        });
    }
  return out;
}
// processes × targets → { gameId: { name, provider, pids } }
function matchRunning(processes, targets) {
  const running = {};
  for (const p of processes) {
    const file = path.resolve(p.path).toLowerCase();
    const t = targets.find(t =>
      t.dir
        ? file.startsWith(t.dir.toLowerCase() + path.sep)
        : file === t.exe.toLowerCase() ||
          (t.trackProcess && path.basename(file) === t.trackProcess.toLowerCase())
    );
    if (!t) continue;
    running[t.gameId] ||= { name: t.name, provider: t.provider, pids: [] };
    running[t.gameId].pids.push(p.pid);
  }
  return running;
}

class RunningGames {
  constructor(ctx) {
    this.ctx = ctx;
    this.running = {}; // gameId → { name, provider, pids, since }
    this.timer = null;
    this.closing = new Set();
  }
  start() {
    if (this.timer || process.platform !== 'win32') return;
    const tick = () =>
      this.refresh()
        .catch(e => this.ctx.log.debug?.('running', e.message))
        .finally(() => {
          this.timer = setTimeout(tick, POLL_MS);
          this.timer.unref?.();
        });
    tick();
  }
  // Checks again soon (after a start or a close).
  soon(ms = 3000) {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.refresh().catch(() => {}), ms);
    this.soonTimer.unref?.();
  }
  async refresh() {
    const games = this.ctx.library.games || [];
    const next = matchRunning(await listProcesses(), installTargets(games));
    for (const [id, r] of Object.entries(next)) r.since = this.running[id]?.since || Date.now();
    const changed =
      JSON.stringify(Object.keys(next).sort()) !== JSON.stringify(Object.keys(this.running).sort());
    this.running = next;
    if (changed) this.ctx.hub.publish();
    return next;
  }
  // For the window: { gameId: { name, provider, since } }.
  snapshot() {
    return Object.fromEntries(
      Object.entries(this.running).map(([id, r]) => [
        id,
        { name: r.name, provider: r.provider, since: r.since },
      ])
    );
  }
  isRunning(gameId) {
    return !!this.running[gameId];
  }
  async alive(pids) {
    const now = await listProcesses();
    return pids.filter(pid => now.some(p => p.pid === pid));
  }
  async kill(pids, force) {
    for (const pid of pids)
      await run('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        windowsHide: true,
        timeout: 15000,
      }).catch(() => {});
  }
  // Closes the game; returns 'closed', 'kept' (user did not force) or 'not-running'.
  async close(gameId) {
    await this.refresh();
    const r = this.running[gameId];
    if (!r) return 'not-running';
    if (this.closing.has(gameId)) return 'closing';
    this.closing.add(gameId);
    try {
      // 1. Like the close button of the window: the game can save and quit.
      await this.kill(r.pids, false);
      const deadline = Date.now() + CLOSE_WAIT_MS;
      let left = await this.alive(r.pids);
      while (left.length && Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 1500));
        left = await this.alive(r.pids);
      }
      // 2. Still running (a game may ask "Save before quitting?"): ask the user.
      if (left.length) {
        const { response } = await dialog.showMessageBox(this.ctx.mainWindow?.() || null, {
          type: 'warning',
          buttons: ['Подождать', 'Закрыть принудительно'],
          defaultId: 0,
          cancelId: 0,
          title: 'Игра не закрылась',
          message: `«${r.name}» не закрылась сама`,
          detail:
            'Возможно, игра ждёт ответа в своём окне (например, «Сохранить перед выходом?»). Принудительное закрытие может потерять несохранённый прогресс.',
        });
        if (response !== 1) return 'kept';
        await this.kill(left, true);
      }
      this.ctx.log.info('running', `closed ${gameId}`);
      this.ctx.toast?.(
        r.provider === 'steam'
          ? `«${r.name}» закрыта. Steam синхронизирует сохранения со Steam Cloud.`
          : r.provider === 'epic'
            ? `«${r.name}» закрыта. Сохранения загружаются в облако Epic.`
            : `«${r.name}» закрыта.`
      );
      return 'closed';
    } finally {
      this.closing.delete(gameId);
      await this.refresh().catch(() => {});
    }
  }
}

module.exports = { RunningGames, installTargets, matchRunning, listProcesses };
