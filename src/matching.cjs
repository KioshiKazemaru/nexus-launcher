'use strict';
// Deciding when a Steam offer and an Epic offer are the same game.
//
// Merge rules, strongest first:
//  1. Manual split by the user always wins.
//  2. Manual link by the user.
//  3. Explicit catalog entry (src/catalog.cjs).
//  4. Same external id (IsThereAnyDeal or IGDB) for both offers.
//  5. Same canonical title: case, ™/®, punctuation and edition words such as
//     "Game of the Year Edition" are ignored.
// Close but not equal titles are never merged automatically; they are returned
// as suggestions for the user to confirm.

const EDITION_WORDS = [
  'game of the year',
  'goty',
  'definitive',
  'ultimate',
  'complete',
  'deluxe',
  'gold',
  'standard',
  'enhanced',
  'digital',
  'premium',
  'special',
  'anniversary',
  "director's cut",
  'directors cut',
  'collectors',
  "collector's",
];
const EDITION_RE = new RegExp(
  `(?:[\\s:\\-–—]+(?:${EDITION_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\']/g, m => (m === "'" ? "'?" : '\\' + m))).join('|')}))+(?:\\s+edition)?$|[\\s:\\-–—]+edition$`,
  'i'
);

function plainTitle(name) {
  return String(name || '')
    .replace(/[™®©]/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalTitle(name) {
  let s = plainTitle(name).replace(/[’`]/g, "'").replace(/&/g, ' and ');
  for (let i = 0; i < 3; i++) {
    const next = s.replace(EDITION_RE, '').trim();
    if (next === s || !next) break;
    s = next;
  }
  return s
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s) {
  const t = ` ${s} `;
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

// Sørensen–Dice coefficient on character bigrams, 0..1.
function similarity(a, b) {
  const x = canonicalTitle(a),
    y = canonicalTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x),
    B = bigrams(y);
  let overlap = 0,
    total = 0;
  for (const [g, n] of A) {
    overlap += Math.min(n, B.get(g) || 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return total ? (2 * overlap) / total : 0;
}

function offerKey(o) {
  if (o.provider === 'epic') return `epic:${o.namespace ? o.namespace + ':' : ''}${o.appId}`;
  return `${o.provider}:${o.appId}`;
}

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let p = this.parent.get(x);
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a, b) {
    const x = this.find(a),
      y = this.find(b);
    if (x !== y) this.parent.set(y, x);
  }
}

// offers: flat list of provider offers.
// options.catalogId(offer) → explicit catalog id or undefined.
// options.externalId(offer) → canonical external id or undefined.
// options.links: [[keyA, keyB]], options.splits: Set of pairKey strings.
// Returns groups of offer keys and how each group was formed.
function groupOffers(offers, options = {}) {
  const {
    catalogId = () => undefined,
    externalId = () => undefined,
    noTitleMerge = () => false,
    links = [],
    splits = new Set(),
  } = options;
  const byKey = new Map(offers.map(o => [offerKey(o), o]));
  const keys = [...byKey.keys()];
  const uf = new UnionFind();
  const members = new Map(keys.map(k => [k, [k]]));
  const reason = new Map();
  keys.forEach(k => uf.find(k));
  const blocked = (ra, rb) => {
    if (!splits.size) return false;
    for (const x of members.get(ra))
      for (const y of members.get(rb)) if (splits.has(pairKey(x, y))) return true;
    return false;
  };
  const join = (a, b, why) => {
    if (!byKey.has(a) || !byKey.has(b)) return;
    const ra = uf.find(a),
      rb = uf.find(b);
    if (ra === rb || blocked(ra, rb)) return;
    // Two different offers of one store are different products (editions);
    // only the user can join them.
    if (why !== 'manual') {
      const pa = new Set(members.get(ra).map(k => byKey.get(k).provider));
      if (members.get(rb).some(k => pa.has(byKey.get(k).provider) && byKey.get(k).provider !== 'custom'))
        return;
    }
    uf.union(ra, rb);
    members.set(ra, [...members.get(ra), ...members.get(rb)]);
    members.delete(rb);
    reason.set(ra, why === 'manual' || !reason.has(rb) ? why : reason.get(rb));
  };
  for (const [a, b] of links) join(a, b, 'manual');
  const index = (fn, why) => {
    const seen = new Map();
    for (const k of keys) {
      const value = fn(byKey.get(k));
      for (const v of Array.isArray(value) ? value : [value]) {
        if (!v) continue;
        if (seen.has(v)) join(seen.get(v), k, why);
        else seen.set(v, k);
      }
    }
  };
  index(catalogId, 'catalog');
  index(o => {
    const ids = externalId(o);
    return (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(id => 'x:' + id);
  }, 'external');
  // A game may be known under two titles (store language vs library language).
  index(
    o =>
      o.provider === 'custom' || noTitleMerge(o)
        ? ''
        : [...new Set([o.name, o.altName].filter(Boolean).map(canonicalTitle))],
    'title'
  );
  return [...members.entries()].map(([root, list]) => ({ keys: list, reason: reason.get(root) || 'single' }));
}

// Pairs of games from different stores whose titles are close but were not
// merged. Used for the "possibly the same game" prompt.
const STOP = new Set(['the', 'and', 'of', 'edition', 'game', 'for', 'with']);
function dice(A, B) {
  let overlap = 0,
    total = 0;
  for (const [g, n] of A) {
    overlap += Math.min(n, B.get(g) || 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return total ? (2 * overlap) / total : 0;
}
// Close cross-store titles that were not merged. Each title is normalised
// once and only titles sharing a meaningful word are compared, so a library
// of thousands of games is processed in milliseconds instead of seconds.
function suggestions(games, splits = new Set(), threshold = 0.82, limit = 50) {
  const prepare = g => {
    const title = canonicalTitle(g.name);
    return {
      g,
      title,
      grams: bigrams(title),
      words: title.split(' ').filter(w => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w)),
    };
  };
  const steam = games
    .filter(g => g.offers.some(o => o.provider === 'steam') && !g.offers.some(o => o.provider === 'epic'))
    .map(prepare);
  const epic = games
    .filter(g => g.offers.some(o => o.provider === 'epic') && !g.offers.some(o => o.provider === 'steam'))
    .map(prepare);
  const index = new Map();
  for (const s of steam)
    for (const w of new Set(s.words)) {
      if (!index.has(w)) index.set(w, []);
      index.get(w).push(s);
    }
  const out = [];
  for (const e of epic) {
    if (!e.title) continue;
    const candidates = new Set();
    for (const w of e.words) {
      const list = index.get(w);
      // Very common words carry no signal and would make this quadratic again.
      if (list && list.length <= 300) list.forEach(x => candidates.add(x));
    }
    let best = null;
    for (const s of candidates) {
      if (s.title === e.title) continue;
      const score = dice(e.grams, s.grams);
      if (score >= threshold && (!best || score > best.score)) best = { steam: s.g, score };
    }
    if (!best) continue;
    const a = offerKey(best.steam.offers.find(o => o.provider === 'steam'));
    const b = offerKey(e.g.offers.find(o => o.provider === 'epic'));
    if (splits.has(pairKey(a, b))) continue;
    out.push({ a, b, aName: best.steam.name, bName: e.g.name, score: Math.round(best.score * 100) / 100 });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

module.exports = { plainTitle, canonicalTitle, similarity, offerKey, pairKey, groupOffers, suggestions };
