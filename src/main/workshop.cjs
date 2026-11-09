'use strict';
// "Мастерская" on the game page (see ../workshop.cjs): what Steam installed
// from the Workshop for an installed Steam game.

const fsp = require('node:fs/promises');
const path = require('node:path');
const w = require('../workshop.cjs');

const DETAILS_MS = 6 * 3600 * 1000;
const MAX_ITEMS = 200;

class WorkshopService {
  constructor(ctx) {
    this.ctx = ctx;
    this.details = new Map(); // item id → { at, value }
  }
  offer(gameId) {
    const g = (this.ctx.library.games || []).find(x => x.id === gameId);
    return g?.offers?.find(o => o.provider === 'steam' && o.installed && o.installDir) || null;
  }
  // <library>\steamapps\common\<game> → <library>\steamapps\workshop
  folder(o) {
    return path.join(path.resolve(o.installDir), '..', '..', 'workshop');
  }
  async items(gameId) {
    const o = this.offer(gameId);
    if (!o) {
      const g = (this.ctx.library.games || []).find(x => x.id === gameId);
      return {
        available: false,
        reason: g?.offers?.some(x => x.provider === 'steam')
          ? 'Мастерская видна, когда игра Steam установлена.'
          : 'У Epic Games нет общей Мастерской: моды таких игр ставятся с сайтов модов или из самой игры.',
      };
    }
    const dir = this.folder(o);
    let local;
    try {
      local = w.parseAppWorkshop(await fsp.readFile(path.join(dir, `appworkshop_${o.appId}.acf`), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') this.ctx.log.debug?.('workshop', e.message);
      return { available: true, appId: o.appId, items: [], size: 0, total: 0 };
    }
    const list = local.items.sort((a, b) => b.updated - a.updated).slice(0, MAX_ITEMS);
    const info = await this.lookup(list.map(x => x.id)).catch(e => {
      this.ctx.log.debug?.('workshop', e.message);
      return new Map();
    });
    return {
      available: true,
      appId: o.appId,
      size: local.size,
      total: local.items.length,
      needsUpdate: local.needsUpdate,
      folder: path.join(dir, 'content', String(o.appId)),
      items: list.map(x => ({ ...x, ...(info.get(x.id) || { title: '', preview: '' }), updated: x.updated })),
    };
  }
  async lookup(ids) {
    const want = ids.filter(id => {
      const hit = this.details.get(id);
      return !hit || Date.now() - hit.at > DETAILS_MS;
    });
    for (let i = 0; i < want.length; i += 100) {
      const part = want.slice(i, i + 100);
      const r = await this.ctx.publicFetch(
        'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
        {
          method: 'POST',
          body: w.detailsBody(part),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(20000),
        }
      );
      if (!r.ok) throw Error(`Steam: HTTP ${r.status}`);
      for (const [id, value] of w.parseDetails(await r.json()))
        this.details.set(id, { at: Date.now(), value });
    }
    return new Map(ids.filter(id => this.details.has(id)).map(id => [id, this.details.get(id).value]));
  }
}

module.exports = { WorkshopService };
