'use strict';
// Recommendations "like Steam": a taste profile from the games of every
// connected Steam and Epic Games account, then store games that share the
// profile's tags, minus everything already owned on either store.
//
// Pure functions; the main process (main/store.cjs) supplies the data.

const { canonicalTitle } = require('./matching.cjs');

// Tags that describe almost every game say nothing about taste.
const GENERIC_TAGS = new Set([
  'Для одного игрока',
  'Для нескольких игроков',
  'Отличный саундтрек',
  'Бесплатная игра',
  'Ранний доступ',
  'Поддержка контроллера',
  'Полная поддержка контроллера',
  'Достижения Steam',
  'Карточки обмена Steam',
  'Мастерская Steam',
  'Облачные сохранения Steam',
]);
// Broad tags stay in the profile but are poor search queries (thousands of games).
const BROAD_TAGS = new Set([
  'Инди',
  'Экшен',
  'Приключение',
  'Казуальная игра',
  'Стратегия',
  'Симулятор',
  'Ролевая игра',
]);
// Earlier tags of a game describe it better (Steam orders them by votes).
const positionWeight = i => Math.max(0.3, 1 - i * 0.12);

// How much a game says about the player: hours played count, with diminishing returns.
function gameWeight(minutes, installed = false) {
  const hours = Math.max(0, Number(minutes) || 0) / 60;
  if (hours <= 0) return installed ? 0.6 : 0.35;
  return 1 + Math.log2(1 + hours);
}

// owned: [{ id, name, provider: 'steam'|'epic'|'both', minutes, installed, tags: [names] }]
// → { tags: Map(tag → 0..1), top: [{ tag, share }], games: count used }
function buildProfile(owned) {
  const sum = new Map();
  let used = 0;
  for (const g of owned) {
    const tags = (g.tags || []).filter(t => !GENERIC_TAGS.has(t));
    if (!tags.length) continue;
    used++;
    const w = gameWeight(g.minutes, g.installed);
    tags.slice(0, 8).forEach((t, i) => sum.set(t, (sum.get(t) || 0) + w * positionWeight(i)));
  }
  const max = Math.max(0, ...sum.values());
  const tags = new Map([...sum].map(([t, v]) => [t, max ? v / max : 0]));
  const total = [...sum.values()].reduce((a, b) => a + b, 0) || 1;
  const top = [...sum]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, v]) => ({ tag, share: Math.round((v / total) * 100) }));
  return { tags, top, games: used };
}

// Similarity of a candidate's tags to the profile, 0..1.
function similarity(profile, tags) {
  const list = (tags || []).filter(t => !GENERIC_TAGS.has(t)).slice(0, 8);
  if (!list.length) return 0;
  let hit = 0,
    norm = 0;
  list.forEach((t, i) => {
    const w = positionWeight(i);
    norm += w;
    hit += w * (profile.tags.get(t) || 0);
  });
  return hit / norm;
}

// Well reviewed games come first, as in the Steam store.
function reviewFactor(reviews) {
  const score = Number(reviews?.score) || 0;
  if (!score) return 0.85;
  if (score >= 8) return 1.15;
  if (score >= 7) return 1.05;
  if (score >= 5) return 0.9;
  return 0.6;
}

// The owned game that explains a recommendation best ("потому что вы играли в …").
function reasonFor(candidateTags, owned) {
  const tags = new Set((candidateTags || []).filter(t => !GENERIC_TAGS.has(t)));
  let best = null,
    bestScore = 0;
  for (const g of owned) {
    const shared = (g.tags || []).filter(t => tags.has(t));
    if (shared.length < 2) continue;
    const score = shared.length * gameWeight(g.minutes, g.installed);
    if (score > bestScore) {
      best = { game: g, shared: shared.slice(0, 3) };
      bestScore = score;
    }
  }
  if (!best) return null;
  const g = best.game;
  return {
    id: g.id,
    name: g.name,
    provider: g.provider,
    minutes: Math.max(0, Number(g.minutes) || 0),
    tags: best.shared,
  };
}

// Is a candidate already in a library? Steam by app id; Epic (and Steam games
// bought on Epic) by title, editions ignored.
function ownedIndex(owned) {
  return {
    steam: new Set(owned.flatMap(g => g.steamIds || [])),
    titles: new Set(
      owned
        .flatMap(g => [g.name, ...(g.altNames || [])])
        .map(canonicalTitle)
        .filter(Boolean)
    ),
  };
}
function isOwned(index, candidate) {
  return (
    (candidate.appId && index.steam.has(String(candidate.appId))) ||
    index.titles.has(canonicalTitle(candidate.name))
  );
}

// candidates: [{ appId, name, tags, reviews, type, ... }] → sorted recommendations.
function rankCandidates(
  profile,
  owned,
  candidates,
  { limit = 12, perTag = 4, perReason = 3, hidden = new Set() } = {}
) {
  const index = ownedIndex(owned);
  const seen = new Set();
  const scored = [];
  for (const c of candidates) {
    if (!c?.appId || seen.has(c.appId)) continue;
    seen.add(c.appId);
    if (c.type !== null && c.type !== undefined && c.type !== 0) continue; // DLC, software, video
    if (hidden.has('steam:' + c.appId) || isOwned(index, c)) continue;
    const match = similarity(profile, c.tags);
    if (match < 0.15) continue;
    scored.push({ ...c, match, score: match * reviewFactor(c.reviews), reason: reasonFor(c.tags, owned) });
  }
  scored.sort((a, b) => b.score - a.score);
  // Variety, as in Steam: at most `perTag` games with the same main tag and
  // `perReason` games explained by the same owned game. Skipped games fill
  // the list only when there are not enough others.
  const out = [],
    rest = [],
    byTag = new Map(),
    byReason = new Map();
  for (const c of scored) {
    const main = (c.tags || []).find(t => !GENERIC_TAGS.has(t)) || '';
    const why = c.reason?.id || '';
    if ((byTag.get(main) || 0) >= perTag || (why && (byReason.get(why) || 0) >= perReason)) {
      rest.push(c);
      continue;
    }
    byTag.set(main, (byTag.get(main) || 0) + 1);
    if (why) byReason.set(why, (byReason.get(why) || 0) + 1);
    out.push(c);
    if (out.length >= limit) break;
  }
  return [...out, ...rest.slice(0, Math.max(0, limit - out.length))];
}

module.exports = {
  GENERIC_TAGS,
  BROAD_TAGS,
  gameWeight,
  buildProfile,
  similarity,
  reviewFactor,
  reasonFor,
  ownedIndex,
  isOwned,
  rankCandidates,
};
