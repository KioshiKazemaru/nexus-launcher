'use strict';
// The "Хранилище" page: every drive with installed games — how much the games
// take, how much is free — and the games by size. Sizes come from the
// launchers' records (Steam SizeOnDisk, Epic InstallSize); a folder without a
// size is measured once and cached.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { folderBytes } = require('../core.cjs');

const MEASURE_MS = 30 * 60000;

function gameFolder(o) {
  if (o.provider === 'steam') return o.installDir || '';
  if (o.provider === 'epic') return o.installLocation || '';
  if (o.provider === 'custom' && o.exe) return path.dirname(o.exe);
  return '';
}

class DiskInfo {
  constructor(ctx, { statfs = p => fsp.statfs(p), measure = folderBytes } = {}) {
    this.ctx = ctx;
    this.statfs = statfs;
    this.measure = measure;
    this.cache = new Map(); // folder → { size, at }
  }
  async sizeOf(o, dir) {
    const known = Number(o.sizeOnDisk) || Number(o.installSize) || 0;
    if (known) return known;
    const c = this.cache.get(dir.toLowerCase());
    if (c && Date.now() - c.at < MEASURE_MS) return c.size;
    const size = await this.measure(dir).catch(() => 0);
    this.cache.set(dir.toLowerCase(), { size, at: Date.now() });
    return size;
  }
  // Installed folders of the library (also used to allow "Открыть папку").
  folders() {
    const out = [];
    for (const g of this.ctx.library.games || [])
      for (const o of g.offers || []) {
        if (!o.installed) continue;
        const dir = gameFolder(o);
        if (dir && path.isAbsolute(dir)) out.push({ g, o, dir: path.resolve(dir) });
      }
    return out;
  }
  async info() {
    const drives = new Map();
    const progress = {
      ...(this.ctx.library.progressByGame?.() || {}),
      ...(this.ctx.epicInstall?.progress?.() || {}),
    };
    for (const { g, o, dir } of this.folders()) {
      const root = path.parse(dir).root.toUpperCase();
      if (!drives.has(root)) drives.set(root, { root, games: [] });
      drives.get(root).games.push({
        id: g.id,
        name: g.name,
        provider: o.provider,
        dir,
        size: await this.sizeOf(o, dir),
        busy: !!progress[g.id],
      });
    }
    // Steam libraries without games are shown too (a place for new games).
    for (const lib of this.ctx.library.local?.steamRoots || []) {
      const root = path.parse(path.resolve(lib)).root.toUpperCase();
      if (!drives.has(root)) drives.set(root, { root, games: [] });
    }
    const out = [];
    for (const dr of drives.values()) {
      let total = 0,
        free = 0;
      try {
        const st = await this.statfs(dr.root);
        total = st.blocks * st.bsize;
        free = st.bavail * st.bsize;
      } catch {}
      dr.games.sort((a, b) => b.size - a.size);
      const games = dr.games.reduce((n, x) => n + x.size, 0);
      out.push({ ...dr, total, free, gamesSize: games, other: Math.max(0, total - free - games) });
    }
    return { drives: out.sort((a, b) => a.root.localeCompare(b.root)), checkedAt: Date.now() };
  }
  // Only the folder of an installed game can be opened from the page.
  allowed(dir) {
    const d = path.resolve(String(dir || '')).toLowerCase();
    return this.folders().some(x => x.dir.toLowerCase() === d);
  }
}

module.exports = { DiskInfo, gameFolder };
