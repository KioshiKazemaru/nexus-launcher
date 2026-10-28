const cheerio = require('cheerio');
const { imageUrl, steamImage } = require('./providers.cjs');
const { parseCommunityGamesList } = require('./steam-library.cjs');
function steamOwned(apps, accountId) {
  if (!Array.isArray(apps)) throw Error('Steam не вернул список игр');
  return [
    ...new Map(
      apps
        .filter(g => /^\d+$/.test(String(g.appid ?? g.appID ?? g)))
        .map(g => {
          const appId = String(g.appid ?? g.appID ?? g);
          return [
            appId,
            {
              provider: 'steam',
              appId,
              accountId,
              name: g.name || `Steam #${appId}`,
              installed: false,
              owned: true,
              licenseUnknown: false,
              source: 'account',
              image: steamImage(appId),
              playtime: Number(g.playtime_forever) || 0,
            },
          ];
        })
    ).values(),
  ];
}
function parseSteamGames(html, accountId) {
  // Current React page (data-profile-gameslist) and the legacy rgGames page.
  const modern = parseCommunityGamesList(html, accountId);
  if (modern) return modern;
  const $ = cheerio.load(html);
  if ($('.profile_private_info').length) throw Error('Steam: закрытые сведения об играх');
  const xml = cheerio.load(html, { xml: true });
  if (xml('gamesList > steamID64').text() === accountId && xml('gamesList > games').length)
    return steamOwned(
      xml('games > game')
        .toArray()
        .map(el => ({ appid: xml(el).find('appID').text(), name: xml(el).find('name').text() })),
      accountId
    );
  throw Error('Steam не открыл список игр сообщества');
}
function parseEpicLibraryPage(json, accountId) {
  if (!Array.isArray(json?.records)) throw Error('Epic не вернул библиотеку');
  const offers = [];
  for (const r of json.records) {
    if (!r.appName || !r.namespace || r.namespace === 'ue' || r.sandboxType === 'PRIVATE') continue;
    const meta = r.metadata || {},
      categories = meta.categories || r.categories || [];
    if (meta.mainGameItem || categories.some(c => /^(dlc|addons|mods|software)(\/|$)/.test(c.path || c)))
      continue;
    const images = meta.keyImages || r.keyImages || [];
    const pic = type => imageUrl(images.find(i => i.type === type)?.url);
    offers.push({
      provider: 'epic',
      appId: r.appName,
      namespace: r.namespace,
      itemId: r.catalogItemId,
      accountId,
      name: meta.title || r.title || r.name || r.appName,
      // Catalog items use DieselGameBox for the wide cover; offers use the StoreFront names.
      image: pic('DieselGameBox') || pic('DieselStoreFrontWide') || pic('OfferImageWide') || pic('Thumbnail'),
      portrait: pic('DieselGameBoxTall') || pic('OfferImageTall'),
      installed: false,
      owned: true,
      licenseUnknown: false,
      source: 'account',
    });
  }
  return { offers, cursor: json.responseMetadata?.nextCursor || null };
}
async function epicOwned(fetcher, token, accountId) {
  const all = [],
    seen = new Set();
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const u = new URL('https://library-service.live.use1a.on.epicgames.com/library/api/public/items');
    u.search = new URLSearchParams({ includeMetadata: 'true', ...(cursor ? { cursor } : {}) });
    const r = await fetcher(u.href, {
      credentials: 'omit',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw Error(`Epic: HTTP ${r.status}. Библиотека аккаунта недоступна.`);
    const parsed = parseEpicLibraryPage(await r.json(), accountId);
    all.push(...parsed.offers);
    cursor = parsed.cursor;
    if (!cursor) return [...new Map(all.map(o => [o.appId, o])).values()];
    if (seen.has(cursor)) throw Error('Epic повторил страницу библиотеки');
    seen.add(cursor);
  }
  throw Error('Epic вернул слишком много страниц библиотеки');
}
const STEAM_OWNED_PROBE = `(async()=>{
 if(location.origin!=='https://store.steampowered.com'||!document.querySelector('#account_pulldown')?.textContent.trim())return null;
 const r=await fetch('/dynamicstore/userdata/',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(12000)});
 if(!r.ok)return null;const data=await r.json();return Array.isArray(data.rgOwnedApps)?data.rgOwnedApps:null;
})()`;
function parseSteamStoreLibrary(data, accountId) {
  const apps = data?.rgOwnedApps || data?.data?.rgOwnedApps;
  if (!Array.isArray(apps)) throw Error('Steam Store не вернул список игр аккаунта');
  return steamOwned(apps, accountId);
}
function filterLibrary(games, mode) {
  // "Owned" also lists installed games: Steam installs them only with a licence
  // (own or Family Sharing), even when the account list does not include them.
  return games.filter(g =>
    g.offers?.some(o => (mode === 'owned' ? o.owned === true || o.installed === true : o.installed === true))
  );
}
module.exports = {
  steamOwned,
  parseSteamGames,
  parseSteamStoreLibrary,
  parseEpicLibraryPage,
  epicOwned,
  STEAM_OWNED_PROBE,
  filterLibrary,
};
async function epicMetadata(fetcher, token, offer, country) {
  if (!offer.itemId || !offer.namespace) return offer;
  const u = new URL(
    `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${encodeURIComponent(offer.namespace)}/bulk/items`
  );
  u.search = new URLSearchParams({
    id: offer.itemId,
    includeDLCDetails: 'true',
    includeMainGameDetails: 'true',
    country,
    // English titles match Steam names; the library's own title is kept as altName.
    locale: 'en-US',
  });
  const r = await fetcher(u.href, {
    credentials: 'omit',
    redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) {
    const error = Error('Метаданные Epic: HTTP ' + r.status);
    error.status = r.status;
    throw error;
  }
  const meta = (await r.json())[offer.itemId];
  if (!meta) return offer;
  return (
    parseEpicLibraryPage(
      {
        records: [
          { appName: offer.appId, namespace: offer.namespace, catalogItemId: offer.itemId, metadata: meta },
        ],
      },
      offer.accountId
    ).offers[0] || null
  );
}
module.exports.epicMetadata = epicMetadata;
// profiles: { steam: {id,status} | [{id,status}, ...], epic: ... }.
// An offer counts as owned only if one of its accounts is currently signed in.
function scopedGames(games, profiles) {
  const active = {};
  for (const [provider, value] of Object.entries(profiles || {}))
    active[provider] = new Set(
      (Array.isArray(value) ? value : [value]).filter(p => p?.id && p.status !== 'signedOut').map(p => p.id)
    );
  return games
    .map(g => ({
      ...g,
      offers: g.offers
        .map(o => {
          const ids = o.accountIds?.length ? o.accountIds : o.accountId ? [o.accountId] : [];
          const owners = ids.filter(id => active[o.provider]?.has(id));
          return { ...o, owned: o.owned === true && owners.length > 0, accountIds: owners };
        })
        .filter(o => o.installed || o.owned || o.provider === 'custom'),
    }))
    .filter(g => g.offers.length);
}
module.exports.scopedGames = scopedGames;
