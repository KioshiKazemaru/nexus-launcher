'use strict';
// «Итоги Nexus»: the year in games, like Steam's year in review, from two sources:
//   - the session log Nexus keeps itself (settings.playLog): every game that ran, for
//     how long, whoever started it (Nexus, Steam, Epic, a shortcut) — months, the
//     longest session, the games of the year;
//   - the libraries: the play time Steam and Epic count for every game (all years) and
//     the date each game was last played.

const LOG_MAX = 5000; // ≈ 10 sessions a day for more than a year
const LOG_DAYS = 800; // two years and a bit: the previous year stays complete
const MIN_SESSION = 60 * 1000; // shorter runs are a crash or a launcher window, not play

// A finished session added to the log (newest last). entry: { id, name, provider, since }.
function recordSession(log, entry, now = Date.now()) {
  const list = Array.isArray(log) ? log : [];
  const start = Number(entry?.since);
  if (!entry?.id || !Number.isFinite(start) || now - start < MIN_SESSION || start > now) return list;
  const minutes = Math.round((now - start) / 60000);
  const next = [
    ...list,
    {
      id: String(entry.id).slice(0, 200),
      name: String(entry.name || '').slice(0, 200),
      provider: ['steam', 'epic', 'custom'].includes(entry.provider) ? entry.provider : 'custom',
      start,
      minutes,
    },
  ];
  const oldest = now - LOG_DAYS * 86400000;
  return next.filter(s => s.start >= oldest).slice(-LOG_MAX);
}

// Steam counts seconds, Nexus milliseconds.
const ms = t => (Number(t) > 1e12 ? Number(t) : Number(t) * 1000);
const yearOf = t => new Date(t).getFullYear();

function yearReview({ year, log = [], games = [], wishlist = 0, now = Date.now() } = {}) {
  const thisYear = yearOf(now);
  const y = Number.isInteger(year) ? year : thisYear;
  const sessions = (Array.isArray(log) ? log : []).filter(s => s && yearOf(s.start) === y);
  const byGame = new Map();
  const months = Array(12).fill(0);
  const days = new Set();
  const stores = { steam: 0, epic: 0, custom: 0 };
  let longest = null;
  for (const s of sessions) {
    const d = new Date(s.start);
    months[d.getMonth()] += s.minutes;
    days.add(d.toDateString());
    stores[s.provider in stores ? s.provider : 'custom'] += s.minutes;
    const g = byGame.get(s.id) || { id: s.id, name: s.name, minutes: 0, sessions: 0, first: s.start };
    g.minutes += s.minutes;
    g.sessions++;
    g.first = Math.min(g.first, s.start);
    if (s.name) g.name = s.name;
    byGame.set(s.id, g);
    if (!longest || s.minutes > longest.minutes) longest = { id: s.id, name: s.name, minutes: s.minutes, start: s.start };
  }
  const minutes = sessions.reduce((n, s) => n + s.minutes, 0);
  const top = [...byGame.values()].sort((a, b) => b.minutes - a.minutes);
  // Games the log saw for the first time this year (the log may be younger than the year).
  const before = new Set((log || []).filter(s => s && yearOf(s.start) < y).map(s => s.id));
  const logStart = (log || []).reduce((m, s) => (s?.start && s.start < m ? s.start : m), Infinity);

  // The libraries: all-time play time and the games last played in this year.
  const owned = (Array.isArray(games) ? games : []).filter(
    g => g && Array.isArray(g.offers) && g.offers.some(o => o.owned || o.installed)
  );
  const library = { steam: 0, epic: 0, custom: 0 };
  let allTime = 0;
  const allTop = [];
  let playedThisYear = 0;
  for (const g of owned) {
    let gm = 0;
    let last = 0;
    for (const o of g.offers) {
      if (o.provider in library) library[o.provider]++;
      gm += Number(o.playtime) || 0;
      if (Number(o.lastPlayed) > 0) last = Math.max(last, ms(o.lastPlayed));
    }
    allTime += gm;
    if (gm > 0) allTop.push({ id: g.id, name: g.name, minutes: gm });
    if (last && yearOf(last) === y) playedThisYear++;
  }
  allTop.sort((a, b) => b.minutes - a.minutes);
  return {
    year: y,
    years: [...new Set([thisYear, ...(log || []).filter(Boolean).map(s => yearOf(s.start))])].sort((a, b) => b - a),
    // The log starts later than the year: its numbers cover only part of it.
    logSince: Number.isFinite(logStart) && yearOf(logStart) === y ? logStart : null,
    sessions: sessions.length,
    minutes,
    days: days.size,
    games: byGame.size,
    newGames: top.filter(g => !before.has(g.id)).length,
    months,
    stores,
    longest,
    top: top.slice(0, 5),
    library: {
      games: owned.length,
      stores: library,
      minutes: allTime,
      top: allTop.slice(0, 5),
      playedThisYear,
    },
    wishlist: Number(wishlist) || 0,
  };
}

module.exports = { recordSession, yearReview, LOG_MAX, MIN_SESSION };
