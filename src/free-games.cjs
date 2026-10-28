'use strict';
// Epic Games weekly giveaways ("Бесплатно на этой неделе").
// Public endpoint used by the Epic store front page; no account needed.

const FREE_GAMES_URL = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions';
const IMAGE_HOSTS = ['cdn1.epicgames.com', 'cdn2.epicgames.com', 'cdn2.unrealengine.com'];

function safeImage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && IMAGE_HOSTS.includes(u.hostname) ? u.href : '';
  } catch {
    return '';
  }
}

function window(list) {
  return (Array.isArray(list) ? list : [])
    .flatMap(x => (Array.isArray(x?.promotionalOffers) ? x.promotionalOffers : []))
    .map(x => ({
      start: Date.parse(x.startDate),
      end: Date.parse(x.endDate),
      percent: Number(x.discountSetting?.discountPercentage),
    }))
    .filter(x => Number.isFinite(x.start) && Number.isFinite(x.end) && x.percent === 0);
}

function slugOf(e) {
  const mapping = [...(e.offerMappings || []), ...(e.catalogNs?.mappings || [])].find(
    m => m?.pageType === 'productHome' && m.pageSlug
  );
  const slug = String(mapping?.pageSlug || e.productSlug || '').replace(/\/home$/, '');
  return /^[a-z0-9][a-z0-9-]{0,180}$/i.test(slug) ? slug : '';
}

// Returns { current: [...], upcoming: [...] } sorted by end/start date.
function parseFreeGames(json, now = Date.now()) {
  const elements = json?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) throw Error('Epic не вернул список бесплатных игр');
  const current = [],
    upcoming = [];
  for (const e of elements) {
    if (!e?.id || !e.namespace || !e.title) continue;
    const images = Array.isArray(e.keyImages) ? e.keyImages : [];
    const pick = types => types.map(t => safeImage(images.find(i => i.type === t)?.url)).find(Boolean) || '';
    const slug = slugOf(e);
    const base = {
      provider: 'epic',
      appId: e.id,
      namespace: e.namespace,
      name: String(e.title).slice(0, 180),
      image: pick(['OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail']),
      portrait: pick(['OfferImageTall', 'DieselStoreFrontTall']),
      url: slug ? `https://store.epicgames.com/p/${slug}` : null,
      originalPrice: e.price?.totalPrice?.fmtPrice?.originalPrice || null,
    };
    const now0 = window(e.promotions?.promotionalOffers).find(w => w.start <= now && w.end > now);
    if (now0) {
      current.push({ ...base, start: now0.start, end: now0.end });
      continue;
    }
    const next = window(e.promotions?.upcomingPromotionalOffers).find(w => w.start > now);
    if (next) upcoming.push({ ...base, start: next.start, end: next.end });
  }
  return {
    current: current.sort((a, b) => a.end - b.end),
    upcoming: upcoming.sort((a, b) => a.start - b.start),
  };
}

async function fetchFreeGames(fetcher, country = 'US') {
  const u = new URL(FREE_GAMES_URL);
  u.search = new URLSearchParams({ locale: 'ru', country, allowCountries: country });
  const r = await fetcher(u.href, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`Epic: HTTP ${r.status}`);
  return { ...parseFreeGames(await r.json()), country, checkedAt: Date.now() };
}

// Games that became free since the last check (by namespace:id + window start).
function newGiveaways(current, seen) {
  const known = new Set(seen || []);
  return current.filter(g => !known.has(`${g.namespace}:${g.appId}:${g.start}`));
}
const giveawayKey = g => `${g.namespace}:${g.appId}:${g.start}`;

module.exports = { FREE_GAMES_URL, parseFreeGames, fetchFreeGames, newGiveaways, giveawayKey };
