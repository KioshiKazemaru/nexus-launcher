'use strict';
// FPS of the running game for the overlay. Windows counts the frames of
// every program (ETW); PresentMon reads them. Nexus does not ship it: it uses
// a copy that is already on the PC (AMD Software, Intel PresentMon, NVIDIA
// FrameView) and reads its CSV output.

const path = require('node:path');

// Where PresentMon comes with software that is often installed.
function presentMonCandidates(env = process.env) {
  const pf = env.ProgramFiles || 'C:\\Program Files';
  return [
    path.join(pf, 'AMD', 'CNext', 'CNext', 'PresentMon-x64.exe'),
    path.join(pf, 'Intel', 'PresentMon', 'PresentMonCli', 'PresentMon.exe'),
    path.join(pf, 'Intel', 'PresentMon', 'PresentMon.exe'),
    path.join(pf, 'NVIDIA Corporation', 'FrameViewSDK', 'bin', 'PresentMon_x64.exe'),
  ];
}

// CSV header → the columns Nexus needs (PresentMon 1.x and 2.x name them differently).
function columns(header) {
  const cols = String(header || '')
    .trim()
    .split(',')
    .map(s => s.trim());
  const at = (...names) => names.map(n => cols.indexOf(n)).find(i => i >= 0) ?? -1;
  const pid = at('ProcessID');
  const frame = at('MsBetweenPresents', 'FrameTime', 'msBetweenPresents');
  return pid >= 0 && frame >= 0 ? { pid, frame } : null;
}

// One CSV line → { pid, ms } or null.
function frameOf(line, cols) {
  if (!cols) return null;
  const parts = String(line || '').split(',');
  const pid = Number(parts[cols.pid]);
  const ms = Number(parts[cols.frame]);
  return Number.isInteger(pid) && Number.isFinite(ms) && ms > 0 && ms < 2000 ? { pid, ms } : null;
}

// Frames of the last `windowMs` → frames per second (of the busiest swap chain's process set).
class FpsMeter {
  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
    this.frames = []; // { at, ms }
  }
  add(ms, at = Date.now()) {
    this.frames.push({ at, ms });
    const from = at - this.windowMs * 2;
    while (this.frames.length && this.frames[0].at < from) this.frames.shift();
  }
  fps(now = Date.now()) {
    const recent = this.frames.filter(f => f.at >= now - this.windowMs);
    if (!recent.length) return 0;
    const avg = recent.reduce((n, f) => n + f.ms, 0) / recent.length;
    return Math.round(1000 / avg);
  }
}

module.exports = { presentMonCandidates, columns, frameOf, FpsMeter };
