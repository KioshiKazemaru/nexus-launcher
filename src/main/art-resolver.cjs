'use strict';
// Steam covers that are not in the local Steam cache (friends' games, the
// store): since 2024 new images live under hashed folders, so the address
// comes from IStoreBrowseService/GetItems. Requests made within a moment are
// asked in one call (up to 100 apps); answers are kept for the session.

const steamLib = require('../steam-library.cjs');

class ArtResolver {
  constructor({ fetch, country = () => 'US', items = steamLib.storeItems, delay = 40 } = {}) {
    this.fetch = fetch;
    this.country = country;
    this.items = items;
    this.delay = delay;
    this.known = new Map(); // app id → { image, portrait } (empty when Steam has none)
    this.waiting = new Map(); // app id → [resolve]
    this.timer = null;
  }
  // → https URL of a header ('header'/'hero') or portrait ('portrait') image, or ''.
  async url(appId, kind = 'header') {
    appId = String(appId);
    if (!/^\d{1,10}$/.test(appId)) return '';
    const v = this.known.get(appId) || (await this.ask(appId));
    return (kind === 'portrait' ? v.portrait || v.image : v.image || v.portrait) || '';
  }
  ask(appId) {
    return new Promise(resolve => {
      const list = this.waiting.get(appId) || [];
      list.push(resolve);
      this.waiting.set(appId, list);
      if (this.waiting.size >= 100) this.flush();
      else this.timer ||= setTimeout(() => this.flush(), this.delay);
    });
  }
  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const batch = new Map(this.waiting);
    this.waiting.clear();
    if (!batch.size) return;
    let found = new Map();
    try {
      found = await this.items(this.fetch, [...batch.keys()], this.country());
    } catch {}
    for (const [id, resolvers] of batch) {
      const x = found.get(id) || found.get(Number(id)) || {};
      const v = { image: x.image || '', portrait: x.portrait || '' };
      // A failed request is asked again next time; a game without images is not.
      if (found.size) this.known.set(id, v);
      for (const r of resolvers) r(v);
    }
  }
}

module.exports = { ArtResolver };
