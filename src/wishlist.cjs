'use strict';
// Import of store wishlists into the Nexus "Желаемое" list.

const { STEAM_ID, steamImage } = require('./steam-library.cjs');

// IWishlistService/GetWishlist works without an API key for public wishlists
// and with the session token for private ones.
function parseSteamWishlist(json) {
  const items = json?.response?.items;
  if (!Array.isArray(items)) {
    if (json?.response && Object.keys(json.response).length === 0) return [];
    throw Error('Steam не вернул список желаемого');
  }
  return items
    .filter(x => /^\d+$/.test(String(x?.appid)))
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))
    .map(x => String(x.appid));
}

async function fetchSteamWishlist(fetcher, steamId, accessToken = '') {
  if (!STEAM_ID.test(String(steamId))) throw Error('Некорректный SteamID');
  const u = new URL('https://api.steampowered.com/IWishlistService/GetWishlist/v1/');
  u.search = new URLSearchParams({ steamid: steamId, ...(accessToken ? { access_token: accessToken } : {}) });
  const r = await fetcher(u.href, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`Steam wishlist: HTTP ${r.status}`);
  return parseSteamWishlist(await r.json());
}

function steamWishlistGames(appIds, names = new Map()) {
  return appIds.map(appId => ({
    id: `steam:${appId}`,
    steam: appId,
    name: names.get(appId)?.name || `Steam #${appId}`,
    image: steamImage(appId),
    tags: [],
    desc: '',
  }));
}

// Executed inside a store.epicgames.com page of the signed-in Epic session.
// Returns only titles/ids/images, never cookies.
const EPIC_WISHLIST_PROBE = `(async()=>{
 if(location.origin!=='https://store.epicgames.com')return {error:'origin'};
 const query='query{Wishlist{wishlistItems{elements{offerId namespace offer{title productSlug keyImages{type url} catalogNs{mappings(pageType:"productHome"){pageSlug}}}}}}}';
 const r=await fetch('/graphql',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)return {error:'HTTP '+r.status};
 const j=await r.json();
 const list=j?.data?.Wishlist?.wishlistItems?.elements;
 if(!Array.isArray(list))return {error:j?.errors?.[0]?.message||'format'};
 return {items:list.map(x=>({offerId:x.offerId,namespace:x.namespace,title:x.offer?.title,slug:x.offer?.catalogNs?.mappings?.[0]?.pageSlug||x.offer?.productSlug,images:(x.offer?.keyImages||[]).map(i=>({type:i.type,url:i.url}))}))};
})()`;

function parseEpicWishlist(result, imageUrl) {
  if (!result || result.error)
    throw Error('Epic не открыл список желаемого: ' + (result?.error || 'нет ответа'));
  return (Array.isArray(result.items) ? result.items : [])
    .filter(
      x => typeof x.offerId === 'string' && /^[a-f0-9]{32}$/i.test(x.offerId) && typeof x.title === 'string'
    )
    .map(x => {
      const slug = String(x.slug || '').replace(/\/home$/, '');
      const img = types =>
        types.map(t => imageUrl(x.images?.find(i => i.type === t)?.url)).find(Boolean) || '';
      return {
        id: `epic:${x.offerId}`,
        name: x.title.slice(0, 180),
        image: img(['OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail']),
        tags: [],
        desc: '',
        storeOffers: [
          {
            provider: 'epic',
            appId: x.offerId,
            namespace: String(x.namespace || ''),
            name: x.title.slice(0, 180),
            url: /^[a-z0-9][a-z0-9-]{0,180}$/i.test(slug) ? `https://store.epicgames.com/p/${slug}` : null,
          },
        ],
      };
    });
}

module.exports = {
  parseSteamWishlist,
  fetchSteamWishlist,
  steamWishlistGames,
  EPIC_WISHLIST_PROBE,
  parseEpicWishlist,
};
