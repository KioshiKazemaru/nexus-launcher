'use strict';
// The bell in the top strip: what Nexus has to tell, newest first (settings.notices).
//   sale   — a wishlist game went on sale (one notice per sale: game, store, end date);
//   giveaway — a new free game in Epic Games;
//   update — a new version of Nexus to download.
// settings.noticeKeys remembers what was already announced, so a sale or a version is
// announced once even after the notice is cleared. Old keys are forgotten after 90 days.

const MAX = 50;
const KEEP_KEYS = 90 * 24 * 3600 * 1000;
const KINDS = new Set(['sale', 'giveaway', 'update']);

class Notices {
  // notify(title, body, notice): the system notification (main/store.cjs).
  constructor(ctx, notify = null) {
    this.ctx = ctx;
    this.systemNotify = notify;
  }
  get settings() {
    return this.ctx.settings;
  }
  // Adds the notices whose key is new; returns the added ones.
  add(list, { system = true } = {}) {
    const s = this.settings;
    const now = Date.now();
    for (const [key, at] of Object.entries(s.noticeKeys))
      if (!(now - at < KEEP_KEYS)) delete s.noticeKeys[key];
    const added = [];
    for (const n of list) {
      if (!n || !KINDS.has(n.kind) || typeof n.key !== 'string' || s.noticeKeys[n.key]) continue;
      s.noticeKeys[n.key] = now;
      added.push({
        id: `${now.toString(36)}-${added.length}`,
        key: n.key,
        kind: n.kind,
        title: String(n.title || '').slice(0, 200),
        body: String(n.body || '').slice(0, 300),
        gameId: typeof n.gameId === 'string' ? n.gameId : '',
        image: typeof n.image === 'string' ? n.image : '',
        at: now,
        read: false,
      });
    }
    if (!added.length) return added;
    s.notices = [...added, ...s.notices].slice(0, MAX);
    this.ctx.storage.saveSettings();
    this.ctx.hub.publish();
    if (system && this.systemNotify) {
      if (added.length === 1) this.systemNotify(added[0].title, added[0].body, added[0]);
      else
        this.systemNotify(
          `Nexus: ${added.length} ${plural(added.length, 'новое уведомление', 'новых уведомления', 'новых уведомлений')}`,
          added
            .slice(0, 3)
            .map(n => n.title)
            .join(' · '),
          added[0]
        );
    }
    return added;
  }
  readAll() {
    let changed = false;
    for (const n of this.settings.notices)
      if (!n.read) {
        n.read = true;
        changed = true;
      }
    if (changed) this.ctx.storage.saveSettings();
  }
  remove(id) {
    const s = this.settings;
    s.notices = s.notices.filter(n => n.id !== id);
    this.ctx.storage.saveSettings();
  }
  clear() {
    this.settings.notices = [];
    this.ctx.storage.saveSettings();
  }
}

function plural(n, one, few, many) {
  const a = n % 10,
    b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

// The sales of wishlist games, as notices: the best discount of each game.
//   games:   [{ id, name, image, storeOffers }]
//   country: the store region (offers of other regions are old).
function saleNotices(games, country, names, dateText) {
  const out = [];
  for (const g of games) {
    const best = (g?.storeOffers || [])
      .filter(o => o.country === country && o.discount > 0 && (o.price || Number.isFinite(o.amount)))
      .sort((a, b) => b.discount - a.discount)[0];
    if (!best) continue;
    const until = best.saleEnd ? ` до ${dateText(best.saleEnd)}` : '';
    out.push({
      kind: 'sale',
      // A new sale (other end date or discount) is announced again.
      key: `sale:${g.id}:${best.provider}:${best.saleEnd || best.discount}`,
      title: `${g.name}: −${best.discount}%`,
      body: `${names[best.provider] || best.provider} · ${best.price || best.amount}${until}`,
      gameId: g.id,
      image: g.image || '',
    });
  }
  return out;
}

module.exports = { Notices, saleNotices, plural };
