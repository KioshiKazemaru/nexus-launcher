'use strict';
// Steam Workshop of a game: the items Steam installed for it (its local
// appworkshop_<appid>.acf) with titles and pictures from Steam's public
// item details. Epic Games has no common workshop.

const { parseVdf } = require('./core.cjs');

const ID = /^\d{1,20}$/;

// appworkshop_<appid>.acf → { items: [{ id, size, updated (ms) }], size, needsUpdate }.
function parseAppWorkshop(text) {
  const w = parseVdf(String(text || '')).AppWorkshop || {};
  const installed = w.WorkshopItemsInstalled || {};
  const items = Object.entries(installed)
    .filter(([id, x]) => ID.test(id) && x && typeof x === 'object')
    .map(([id, x]) => ({
      id,
      size: Number(x.size) || 0,
      updated: (Number(x.timeupdated) || 0) * 1000,
    }));
  return {
    items,
    size: Number(w.SizeOnDisk) || items.reduce((n, x) => n + x.size, 0),
    needsUpdate: w.NeedsUpdate === '1' || w.NeedsDownload === '1',
  };
}

// Form body of ISteamRemoteStorage/GetPublishedFileDetails for these ids.
function detailsBody(ids) {
  const body = new URLSearchParams({ itemcount: String(ids.length) });
  ids.forEach((id, i) => body.append(`publishedfileids[${i}]`, id));
  return body;
}

const imageHost = url => {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:' &&
      (u.hostname === 'images.steamusercontent.com' || /(^|\.)steamstatic\.com$/.test(u.hostname))
      ? u.href
      : '';
  } catch {
    return '';
  }
};

// GetPublishedFileDetails → Map(id → { title, preview, subscriptions, tags, updated }).
function parseDetails(json) {
  const list = json?.response?.publishedfiledetails;
  const out = new Map();
  if (!Array.isArray(list)) return out;
  for (const x of list) {
    if (!x || Number(x.result) !== 1 || !ID.test(String(x.publishedfileid))) continue;
    out.set(String(x.publishedfileid), {
      title: String(x.title || '').slice(0, 200),
      preview: imageHost(x.preview_url),
      subscriptions: Number(x.subscriptions) || 0,
      tags: (Array.isArray(x.tags) ? x.tags : [])
        .map(t => String(t?.tag || '').slice(0, 40))
        .filter(Boolean)
        .slice(0, 5),
      updated: (Number(x.time_updated) || 0) * 1000,
    });
  }
  return out;
}

module.exports = { parseAppWorkshop, detailsBody, parseDetails, imageHost };
