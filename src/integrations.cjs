'use strict';
// Optional third-party services. Each one needs a free personal key that the
// user enters in "Аккаунты"; without a key the feature is simply off.
//
//  - IsThereAnyDeal: one game id for Steam and Epic offers (matching), prices
//    in other shops and the historical low.
//  - IGDB (via Twitch client credentials): description, genres, cover and a
//    shared game id used for matching.
//  - SteamGridDB: vertical covers for any game, including manually added .exe.
//
// All functions take an injected fetcher; responses are validated and trimmed.
// Endpoints follow the public documentation of each service.

const ITAD = 'https://api.isthereanydeal.com';
const ITAD_SHOP = { steam: 61, epic: 16 };
const IGDB = 'https://api.igdb.com/v4';
const SGDB = 'https://www.steamgriddb.com/api/v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function json(fetcher, url, options = {}) {
  const r = await fetcher(url, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    ...options,
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 401 || r.status === 403) {
    const e = Error('Ключ API отклонён сервисом');
    e.status = r.status;
    throw e;
  }
  if (r.status === 429) throw Error('Сервис ограничил частоту запросов, повторите позже');
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (text.length > 5_000_000) throw Error('Слишком большой ответ');
  return JSON.parse(text);
}

function validKey(key, re = /^[A-Za-z0-9_-]{16,128}$/) {
  return typeof key === 'string' && re.test(key.trim());
}

// ---------------- IsThereAnyDeal ----------------

function parseItadShopLookup(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const [k, v] of Object.entries(data)) {
    const m = /^app\/(\d+)$/.exec(k);
    if (m && typeof v === 'string' && UUID.test(v)) out[m[1]] = v;
  }
  return out;
}

async function itadLookupSteam(fetcher, key, appIds) {
  if (!validKey(key)) throw Error('Укажите ключ IsThereAnyDeal');
  const out = {};
  for (let i = 0; i < appIds.length; i += 200) {
    const body = appIds.slice(i, i + 200).map(id => `app/${id}`);
    const data = await json(
      fetcher,
      `${ITAD}/lookup/id/shop/${ITAD_SHOP.steam}/v1?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    Object.assign(out, parseItadShopLookup(data));
  }
  return out;
}

function parseItadTitleLookup(data) {
  return data?.found === true && UUID.test(data.game?.id || '')
    ? {
        id: data.game.id,
        title: String(data.game.title || '').slice(0, 200),
        slug: String(data.game.slug || ''),
      }
    : null;
}

async function itadLookupTitle(fetcher, key, title) {
  if (!validKey(key)) throw Error('Укажите ключ IsThereAnyDeal');
  const u = new URL(`${ITAD}/games/lookup/v1`);
  u.search = new URLSearchParams({ key, title: String(title).slice(0, 200) });
  return parseItadTitleLookup(await json(fetcher, u.href));
}

const money = p =>
  p && Number.isFinite(p.amount) && /^[A-Z]{3}$/.test(p.currency || '')
    ? { amount: p.amount, currency: p.currency }
    : null;

function parseItadPrices(data) {
  if (!Array.isArray(data)) throw Error('IsThereAnyDeal вернул неизвестный формат цен');
  const out = {};
  for (const g of data) {
    if (!UUID.test(g?.id || '')) continue;
    const deals = (Array.isArray(g.deals) ? g.deals : [])
      .map(d => ({
        shop: String(d.shop?.name || '').slice(0, 60),
        shopId: Number(d.shop?.id) || 0,
        price: money(d.price),
        regular: money(d.regular),
        cut: Math.max(0, Math.min(100, Number(d.cut) || 0)),
        url: /^https:\/\//.test(d.url || '') ? d.url : '',
        storeLow: money(d.storeLow),
      }))
      .filter(d => d.price && d.shop)
      .sort((a, b) => a.price.amount - b.price.amount);
    const low = g.historyLow?.all || g.historyLow;
    out[g.id] = { deals, historyLow: money(low) || null };
  }
  return out;
}

async function itadPrices(fetcher, key, ids, country) {
  if (!validKey(key)) throw Error('Укажите ключ IsThereAnyDeal');
  const valid = ids.filter(id => UUID.test(id)).slice(0, 200);
  if (!valid.length) return {};
  const u = new URL(`${ITAD}/games/prices/v3`);
  u.search = new URLSearchParams({ key, country, nondeals: 'true' });
  return parseItadPrices(
    await json(fetcher, u.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valid),
    })
  );
}

// ---------------- IGDB ----------------

const IGDB_SOURCE = { steam: 1, epic: 26 };

async function twitchToken(fetcher, clientId, clientSecret) {
  if (!validKey(clientId, /^[a-z0-9]{20,64}$/i) || !validKey(clientSecret, /^[a-z0-9]{20,64}$/i))
    throw Error('Укажите Client ID и Client Secret приложения Twitch для IGDB');
  const u = new URL('https://id.twitch.tv/oauth2/token');
  u.search = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });
  const data = await json(fetcher, u.href, { method: 'POST' });
  if (typeof data.access_token !== 'string') throw Error('Twitch не выдал токен для IGDB');
  return { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
}

const apicalypseString = s => '"' + String(s).replace(/["\\]/g, '').slice(0, 120) + '"';

async function igdbQuery(fetcher, auth, endpoint, body) {
  return json(fetcher, `${IGDB}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Client-ID': auth.clientId,
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/json',
    },
    body,
  });
}

function igdbCover(imageId) {
  return /^[a-z0-9]{4,40}$/i.test(imageId || '')
    ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg`
    : '';
}

function parseIgdbGames(data) {
  if (!Array.isArray(data)) throw Error('IGDB вернул неизвестный формат');
  return data
    .filter(g => Number.isInteger(g?.id))
    .map(g => ({
      id: g.id,
      name: String(g.name || '').slice(0, 200),
      summary: String(g.summary || '').slice(0, 800),
      genres: (g.genres || [])
        .map(x => String(x?.name || ''))
        .filter(Boolean)
        .slice(0, 6),
      cover: igdbCover(g.cover?.image_id),
      external: (g.external_games || [])
        .map(x => ({ source: x.external_game_source ?? x.category, uid: String(x.uid || '') }))
        .filter(x => x.uid),
    }));
}

const IGDB_FIELDS =
  'fields id,name,summary,genres.name,cover.image_id,external_games.uid,external_games.category,external_games.external_game_source;';

// Steam app ids → IGDB game id. Both the legacy "category" and the newer
// "external_game_source" fields are accepted.
async function igdbBySteam(fetcher, auth, appIds) {
  const out = {};
  for (let i = 0; i < appIds.length; i += 200) {
    const ids = appIds.slice(i, i + 200).filter(x => /^\d+$/.test(x));
    if (!ids.length) continue;
    const data = await igdbQuery(
      fetcher,
      auth,
      'external_games',
      `fields game,uid,category,external_game_source; where uid = (${ids.map(apicalypseString).join(',')}); limit 500;`
    );
    for (const x of Array.isArray(data) ? data : []) {
      const source = x.external_game_source ?? x.category;
      if (source === IGDB_SOURCE.steam && Number.isInteger(x.game) && /^\d+$/.test(x.uid))
        out[x.uid] = x.game;
    }
  }
  return out;
}

async function igdbGames(fetcher, auth, ids) {
  const valid = ids.filter(Number.isInteger).slice(0, 500);
  if (!valid.length) return [];
  return parseIgdbGames(
    await igdbQuery(fetcher, auth, 'games', `${IGDB_FIELDS} where id = (${valid.join(',')}); limit 500;`)
  );
}

async function igdbSearch(fetcher, auth, title) {
  return parseIgdbGames(
    await igdbQuery(fetcher, auth, 'games', `search ${apicalypseString(title)}; ${IGDB_FIELDS} limit 5;`)
  );
}

// ---------------- SteamGridDB ----------------

function parseSgdbGrids(data) {
  if (data?.success !== true || !Array.isArray(data.data)) return [];
  return data.data
    .filter(x => typeof x?.url === 'string' && /^https:\/\/cdn\d*\.steamgriddb\.com\//.test(x.url))
    .filter(x => !x.nsfw && !x.humor)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map(x => x.url);
}

async function sgdbPortrait(fetcher, key, { steamAppId, title }) {
  if (!validKey(key, /^[a-f0-9]{32}$/i)) throw Error('Укажите ключ SteamGridDB');
  const headers = { Authorization: `Bearer ${key}` };
  const grids = async path =>
    parseSgdbGrids(
      await json(fetcher, `${SGDB}/${path}?dimensions=600x900&types=static&nsfw=false`, { headers })
    );
  if (/^\d+$/.test(steamAppId || '')) {
    try {
      const found = await grids(`grids/steam/${steamAppId}`);
      if (found.length) return found[0];
    } catch (e) {
      if (e.status) throw e;
    }
  }
  if (!title) return '';
  const search = await json(
    fetcher,
    `${SGDB}/search/autocomplete/${encodeURIComponent(String(title).slice(0, 120))}`,
    {
      headers,
    }
  );
  const gameId = search?.success && Array.isArray(search.data) ? search.data[0]?.id : null;
  if (!Number.isInteger(gameId)) return '';
  return (await grids(`grids/game/${gameId}`))[0] || '';
}

module.exports = {
  ITAD_SHOP,
  IGDB_SOURCE,
  validKey,
  parseItadShopLookup,
  itadLookupSteam,
  parseItadTitleLookup,
  itadLookupTitle,
  parseItadPrices,
  itadPrices,
  twitchToken,
  igdbBySteam,
  igdbGames,
  igdbSearch,
  parseIgdbGames,
  igdbCover,
  parseSgdbGrids,
  sgdbPortrait,
};
