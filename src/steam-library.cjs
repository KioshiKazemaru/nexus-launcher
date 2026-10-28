'use strict';
// Steam account library without a personal Web API key.
//
// Order of sources (first that works wins):
//  1. IPlayerService/GetOwnedGames with the session's own webapi_token
//     (games only, names, playtime, last played).
//  2. dynamicstore/userdata (all licences) filtered to games through
//     IStoreBrowseService/GetItems, because rgOwnedApps also contains DLC,
//     soundtracks, tools and dedicated servers.
//  3. Community "games" page (only games, needs a public game list).
// No cookies or tokens are returned to the UI.

const { imageUrl } = require('./providers.cjs');
const { canonicalTitle } = require('./matching.cjs');

const STEAM_ID = /^7656119\d{10}$/;
const STEAM_ID_BASE = 76561197960265728n;

function steamImage(id) {
  return /^\d+$/.test(String(id))
    ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`
    : '';
}

function toAccountId32(steamId64) {
  if (!STEAM_ID.test(String(steamId64))) return '';
  return String(BigInt(steamId64) - STEAM_ID_BASE);
}

function ownedOffer(appId, accountId, extra = {}) {
  return {
    provider: 'steam',
    appId: String(appId),
    accountId,
    name: extra.name || `Steam #${appId}`,
    installed: false,
    owned: true,
    licenseUnknown: false,
    source: extra.source || 'account',
    image: steamImage(appId),
    playtime: Number(extra.playtime) || 0,
    lastPlayed: Number(extra.lastPlayed) || 0,
  };
}

// --- 1. webapi_token + GetOwnedGames -------------------------------------

function parseAsyncConfig(json) {
  const token = json?.data?.webapi_token;
  if (json?.success !== 1 && json?.success !== true) return '';
  return typeof token === 'string' && /^[A-Za-z0-9._-]{20,4096}$/.test(token) ? token : '';
}

// The token is a JWT; its "sub" must be the account we verified. We only read
// the payload, signature validation is done by Steam on every call.
function tokenSteamId(token) {
  try {
    const part = token.split('.')[1];
    const json = JSON.parse(
      Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
    return STEAM_ID.test(String(json.sub)) ? String(json.sub) : '';
  } catch {
    return '';
  }
}

function parseOwnedGames(json, accountId) {
  const games = json?.response?.games;
  if (!Array.isArray(games)) {
    if (json?.response && json.response.game_count === 0) return [];
    throw Error('Steam не вернул список игр (GetOwnedGames)');
  }
  const out = new Map();
  for (const g of games) {
    if (!/^\d+$/.test(String(g?.appid))) continue;
    out.set(
      String(g.appid),
      ownedOffer(g.appid, accountId, {
        name: typeof g.name === 'string' ? g.name.slice(0, 200) : '',
        playtime: g.playtime_forever,
        lastPlayed: g.rtime_last_played,
      })
    );
  }
  return [...out.values()];
}

// Session Web API token of the signed-in store account (checked against accountId).
async function sessionToken(fetcher, accountId) {
  const config = await fetcher('https://store.steampowered.com/pointssummary/ajaxgetasyncconfig', {
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(9000),
  });
  if (!config.ok) throw Error(`Steam: HTTP ${config.status} при получении токена сессии`);
  const token = parseAsyncConfig(await config.json());
  if (!token) throw Error('Steam не выдал токен сессии');
  const sub = tokenSteamId(token);
  if (sub && sub !== accountId) throw Error('Токен Steam относится к другому аккаунту');
  return token;
}

async function fetchOwnedWithToken(fetcher, accountId) {
  const token = await sessionToken(fetcher, accountId);
  const u = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
  u.search = new URLSearchParams({
    access_token: token,
    steamid: accountId,
    include_appinfo: '1',
    include_played_free_games: '1',
    include_free_sub: '0',
    skip_unvetted_apps: '0',
    language: 'russian',
  });
  const r = await fetcher(u.href, {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error(`Steam GetOwnedGames: HTTP ${r.status}`);
  return parseOwnedGames(await r.json(), accountId);
}

// --- 2. userdata + type filter -------------------------------------------

// EStoreAppType: 0 = game. Everything else (DLC, software, music, video,
// demo, hardware, beta) is not a library game.
function parseStoreItems(json) {
  const items = json?.response?.store_items;
  if (!Array.isArray(items)) throw Error('Steam не вернул сведения о приложениях');
  const out = new Map();
  for (const item of items) {
    if (!/^\d+$/.test(String(item?.appid))) continue;
    out.set(String(item.appid), {
      appId: String(item.appid),
      ok: item.success === 1 || item.success === true,
      type: Number.isInteger(item.type) ? item.type : null,
      name: typeof item.name === 'string' ? item.name.slice(0, 200) : '',
      ...storeAssets(item.assets),
    });
  }
  return out;
}

// Since 2024 new Steam images live under a hashed folder, so the plain
// /apps/<id>/header.jpg is missing for them. The store lists the real paths.
const ASSET_BASE = 'https://shared.akamai.steamstatic.com/store_item_assets/';
function storeAssets(assets) {
  const format = assets?.asset_url_format;
  if (typeof format !== 'string' || !format.includes('${FILENAME}') || /^[a-z]+:|\.\./i.test(format)) return {};
  const url = file => {
    if (typeof file !== 'string' || !/^[\w./-]+$/.test(file) || file.includes('..')) return '';
    return imageUrl(ASSET_BASE + format.replace('${FILENAME}', file));
  };
  const out = {};
  const image = url(assets.header) || url(assets.main_capsule);
  const portrait = url(assets.library_capsule);
  if (image) out.image = image;
  if (portrait) out.portrait = portrait;
  return out;
}

async function storeItems(fetcher, appIds, country = 'US') {
  const result = new Map();
  for (let i = 0; i < appIds.length; i += 100) {
    const chunk = appIds.slice(i, i + 100);
    const u = new URL('https://api.steampowered.com/IStoreBrowseService/GetItems/v1/');
    u.search = new URLSearchParams({
      input_json: JSON.stringify({
        ids: chunk.map(appid => ({ appid: Number(appid) })),
        context: { language: 'russian', country_code: country },
        data_request: { include_basic_info: true, include_assets: true },
      }),
    });
    const r = await fetcher(u.href, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw Error(`Steam GetItems: HTTP ${r.status}`);
    for (const [k, v] of parseStoreItems(await r.json())) result.set(k, v);
  }
  return result;
}

// --- store front details (description, tags, reviews, screenshots) -------

// What the Steam store shows next to a featured game. One GetItems request
// covers up to 100 apps; tag ids are named through GetTagList.
function parseStoreDetails(json, tagNames = new Map()) {
  const items = json?.response?.store_items;
  if (!Array.isArray(items)) throw Error('Steam не вернул сведения о приложениях');
  const out = new Map();
  for (const item of items) {
    if (!/^\d+$/.test(String(item?.appid)) || !(item.success === 1 || item.success === true)) continue;
    const format = item.assets?.asset_url_format;
    const asset = file =>
      typeof format === 'string' &&
      format.includes('${FILENAME}') &&
      !/^[a-z]+:|\.\./i.test(format) &&
      typeof file === 'string' &&
      /^[\w./-]+$/.test(file) &&
      !file.includes('..')
        ? imageUrl(ASSET_BASE + format.replace('${FILENAME}', file))
        : '';
    const shot = file => {
      if (typeof file !== 'string' || !/^[\w./-]+\.jpg(\?t=\d+)?$/.test(file) || file.includes('..')) return '';
      const [name, query] = file.split('?');
      return imageUrl(ASSET_BASE + name.replace(/\.jpg$/, '.600x338.jpg') + (query ? '?' + query : ''));
    };
    const summary = item.reviews?.summary_filtered;
    const tagIds = (Array.isArray(item.tags) ? item.tags : (item.tagids || []).map(tagid => ({ tagid })))
      .map(t => Number(t?.tagid))
      .filter(Number.isInteger)
      .slice(0, 8);
    const tags = tagIds
      .map(id => tagNames.get(id))
      .filter(t => typeof t === 'string' && t)
      .slice(0, 6);
    const released = Number(item.release?.steam_release_date);
    out.set(String(item.appid), {
      appId: String(item.appid),
      name: typeof item.name === 'string' ? item.name.slice(0, 200) : '',
      type: Number.isInteger(item.type) ? item.type : null,
      tagIds,
      description:
        typeof item.basic_info?.short_description === 'string'
          ? item.basic_info.short_description.trim().slice(0, 500)
          : '',
      tags,
      reviews:
        summary && Number.isFinite(summary.review_count) && summary.review_count > 0
          ? {
              label: String(summary.review_score_label || '').slice(0, 60),
              score: Number(summary.review_score) || 0,
              percent: Math.max(0, Math.min(100, Number(summary.percent_positive) || 0)),
              count: summary.review_count,
            }
          : null,
      screenshots: (item.screenshots?.all_ages_screenshots || [])
        .map(s => shot(s?.filename))
        .filter(Boolean)
        .slice(0, 6),
      capsule: asset(item.assets?.main_capsule_2x) || asset(item.assets?.main_capsule) || '',
      releaseDate: Number.isFinite(released) && released > 0 ? released * 1000 : null,
    });
  }
  return out;
}

let tagListCache = null;
// Russian tag names, fetched once per session (≈450 tags).
async function steamTagNames(fetcher) {
  if (tagListCache) return tagListCache;
  const r = await fetcher('https://api.steampowered.com/IStoreService/GetTagList/v1/?language=russian', {
    credentials: 'omit',
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error(`Steam GetTagList: HTTP ${r.status}`);
  const tags = (await r.json())?.response?.tags;
  if (!Array.isArray(tags)) throw Error('Steam не вернул список меток');
  tagListCache = new Map(
    tags
      .filter(t => Number.isInteger(t?.tagid) && typeof t.name === 'string')
      .map(t => [t.tagid, t.name.slice(0, 50)])
  );
  return tagListCache;
}

// Steam app of a title (an Epic game has no Steam tags of its own).
// Only an exact title match counts; editions are ignored on both sides.
async function findSteamApp(fetcher, title, country = 'US') {
  const u = new URL('https://store.steampowered.com/api/storesearch/');
  u.search = new URLSearchParams({ term: String(title).slice(0, 120), l: 'english', cc: country });
  const r = await fetcher(u.href, { credentials: 'omit', signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw Error(`Steam storesearch: HTTP ${r.status}`);
  const items = (await r.json())?.items;
  if (!Array.isArray(items)) return null;
  const want = canonicalTitle(title);
  const hit = items.find(x => x?.type === 'app' && /^\d+$/.test(String(x.id)) && canonicalTitle(x.name) === want);
  return hit ? String(hit.id) : null;
}

async function storeDetails(fetcher, appIds, country = 'US') {
  const names = await steamTagNames(fetcher).catch(() => new Map());
  const result = new Map();
  for (let i = 0; i < appIds.length; i += 100) {
    const chunk = appIds.slice(i, i + 100);
    const u = new URL('https://api.steampowered.com/IStoreBrowseService/GetItems/v1/');
    u.search = new URLSearchParams({
      input_json: JSON.stringify({
        ids: chunk.map(appid => ({ appid: Number(appid) })),
        context: { language: 'russian', country_code: country },
        data_request: {
          include_basic_info: true,
          include_assets: true,
          include_screenshots: true,
          include_reviews: true,
          include_release: true,
          include_tag_count: 6,
        },
      }),
    });
    const r = await fetcher(u.href, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw Error(`Steam GetItems: HTTP ${r.status}`);
    for (const [k, v] of parseStoreDetails(await r.json(), names)) result.set(k, v);
  }
  return result;
}

// Steam client tools that install like games: redistributables, SteamVR,
// Linux runtimes and Proton builds.
const STEAM_TOOL_IDS = new Set([
  '228980', '250820', '1007', '1070560', '1391110', '1628350', '4183110', '858280', '930400',
  '961940', '996510', '1054830', '1113280', '1245040', '1420170', '1493710', '1580130', '1887720',
  '2180100', '2230260', '2348590', '2805730', '3658110', '1826330', '1161040',
]);

function filterGames(offers, items) {
  return offers
    .filter(o => {
      const info = items.get(o.appId);
      // Unknown to the store (delisted) apps are kept: they are usually old games.
      return !info || !info.ok || info.type === 0;
    })
    .map(o => {
      const info = items.get(o.appId);
      return info?.name && /^Steam #/.test(o.name) ? { ...o, name: info.name } : o;
    });
}

// --- 3. community games page ---------------------------------------------

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

// Since 2023 the page renders with React and keeps its data in
// <template data-profile-gameslist="{...rgGames...}">. The legacy page had
// "var rgGames = [...]". Returns null when the page has neither.
function parseCommunityGamesList(html, accountId) {
  if (typeof html !== 'string') return null;
  if (/profile_private_info|gameslist_private/i.test(html) && !/data-profile-gameslist|rgGames/.test(html))
    throw Error('Steam: закрытые сведения об играх');
  let games = null;
  const attr = /data-profile-gameslist="([^"]*)"/.exec(html);
  if (attr) {
    try {
      const data = JSON.parse(decodeEntities(attr[1]));
      if (Array.isArray(data?.rgGames)) games = data.rgGames;
      if (data?.strSteamId && String(data.strSteamId) !== accountId)
        throw Error('Список игр другого профиля');
    } catch (e) {
      if (/другого профиля/.test(e.message)) throw e;
    }
  }
  if (!games) {
    const legacy = /\brgGames\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
    if (legacy) {
      try {
        games = JSON.parse(legacy[1]);
      } catch {}
    }
  }
  if (!Array.isArray(games)) return null;
  return games
    .filter(g => /^\d+$/.test(String(g?.appid)))
    .map(g =>
      ownedOffer(g.appid, accountId, {
        name: typeof g.name === 'string' ? g.name : '',
        playtime: g.playtime_forever,
        lastPlayed: g.rtime_last_played,
      })
    );
}

// --- local Steam data ------------------------------------------------------

// localconfig.vdf keeps last played time and playtime per app for a user.
function parseLocalConfig(vdf) {
  const find = (obj, key) => {
    if (!obj || typeof obj !== 'object') return undefined;
    const k = Object.keys(obj).find(x => x.toLowerCase() === key);
    return k === undefined ? undefined : obj[k];
  };
  let node = find(vdf, 'userlocalconfigstore');
  for (const key of ['software', 'valve', 'steam', 'apps']) node = find(node, key);
  const out = {};
  if (!node || typeof node !== 'object') return out;
  for (const [appId, v] of Object.entries(node)) {
    if (!/^\d+$/.test(appId) || !v || typeof v !== 'object') continue;
    const lastPlayed = Number(find(v, 'lastplayed')) || 0;
    const playtime = Number(find(v, 'playtime')) || 0;
    if (lastPlayed || playtime) out[appId] = { lastPlayed, playtime };
  }
  return out;
}

const COVER_FILES = {
  portrait: ['library_600x900.jpg', 'library_600x900_2x.jpg'],
  header: ['header.jpg', 'library_header.jpg'],
  hero: ['library_hero.jpg'],
};

// Steam stores covers either flat (<appid>_library_600x900.jpg) or, since 2024,
// in a per-app folder (<appid>/[hash/]library_600x900.jpg).
async function findLibraryCover(fsp, path, cacheDir, appId, kind) {
  if (!/^\d+$/.test(String(appId)) || !Object.hasOwn(COVER_FILES, kind)) return '';
  for (const name of COVER_FILES[kind]) {
    const flat = path.join(cacheDir, `${appId}_${name}`);
    try {
      if ((await fsp.stat(flat)).isFile()) return flat;
    } catch {}
  }
  const dir = path.join(cacheDir, String(appId));
  const walk = async (folder, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(folder, { withFileTypes: true });
    } catch {
      return '';
    }
    for (const name of COVER_FILES[kind]) {
      if (entries.some(e => e.isFile() && e.name === name)) return path.join(folder, name);
    }
    if (depth > 0) {
      for (const e of entries) {
        if (e.isDirectory() && /^[a-f0-9]{8,64}$/i.test(e.name)) {
          const found = await walk(path.join(folder, e.name), depth - 1);
          if (found) return found;
        }
      }
    }
    return '';
  };
  return walk(dir, 1);
}

module.exports = {
  STEAM_ID,
  steamImage,
  toAccountId32,
  ownedOffer,
  parseAsyncConfig,
  tokenSteamId,
  parseOwnedGames,
  sessionToken,
  fetchOwnedWithToken,
  parseStoreItems,
  storeItems,
  parseStoreDetails,
  storeDetails,
  findSteamApp,
  steamTagNames,
  filterGames,
  STEAM_TOOL_IDS,
  storeAssets,
  decodeEntities,
  parseCommunityGamesList,
  parseLocalConfig,
  findLibraryCover,
};
