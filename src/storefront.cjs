const {
  responseJSON,
  browseEpic,
  browseSteam,
  combineOffers,
  imageUrl,
  steamImage,
  regionCurrency,
} = require('./providers.cjs');
const { storeDetails } = require('./steam-library.cjs');
function featuredOffers(data, section, country) {
  const items = data?.[section]?.items;
  if (!Array.isArray(items)) throw Error('Steam не вернул подборку ' + section);
  return items
    .filter(x => /^\d+$/.test(String(x.id)) && x.name && x.windows_available !== false)
    .slice(0, 24)
    .map(x => {
      const currency = x.currency || regionCurrency[country],
        amount = Number.isFinite(x.final_price) ? x.final_price / 100 : null,
        original = Number.isFinite(x.original_price) ? x.original_price / 100 : null;
      const format = n => new Intl.NumberFormat('ru-RU', { style: 'currency', currency }).format(n);
      const discount = Number.isFinite(x.discount_percent)
        ? Math.max(0, Math.min(100, x.discount_percent))
        : 0;
      return {
        provider: 'steam',
        appId: String(x.id),
        name: String(x.name).slice(0, 180),
        image: imageUrl(x.header_image) || steamImage(x.id),
        country,
        currency,
        amount,
        price: amount === 0 ? 'Бесплатно' : amount !== null ? format(amount) : null,
        originalPrice: discount && original !== null ? format(original) : null,
        discount,
        priceStatus: amount === null ? 'unavailable' : 'ready',
        url: `https://store.steampowered.com/app/${x.id}/`,
      };
    });
}
// featuredcategories is a stable JSON API; used when the HTML search fails.
const featuredSections = {
  top: 'top_sellers',
  new: 'new_releases',
  coming: 'coming_soon',
  sales: 'specials',
};
async function browseSteamSafe(fetcher, kind, country) {
  try {
    const result = await browseSteam(fetcher, kind, country);
    if (result.offers.length) return result;
  } catch (e) {
    if (!featuredSections[kind]) throw e;
  }
  if (!featuredSections[kind]) return { offers: [], total: 0 };
  const u = new URL('https://store.steampowered.com/api/featuredcategories/');
  u.search = new URLSearchParams({ cc: country, l: 'russian' });
  const offers = featuredOffers(await responseJSON(fetcher, u.href), featuredSections[kind], country);
  return { offers, total: offers.length, fallback: 'featuredcategories' };
}
// Description, tags, user reviews, screenshots and the large capsule for the
// Steam games of the store front, as the Steam store shows them. Optional:
// without it the store front still works with names and prices.
async function withSteamDetails(fetcher, games, country) {
  const ids = [
    ...new Set(games.flatMap(g => g.storeOffers.filter(o => o.provider === 'steam').map(o => o.appId))),
  ];
  if (!ids.length) return games;
  const details = await storeDetails(fetcher, ids, country);
  return games.map(g => {
    const steam = g.storeOffers.find(o => o.provider === 'steam');
    const d = steam && details.get(String(steam.appId));
    if (!d) return g;
    return {
      ...g,
      desc: g.desc || d.description,
      tags: g.tags?.length && g.tags[0] !== 'Дополнение' ? g.tags : d.tags.length ? d.tags : g.tags,
      reviews: d.reviews,
      capsule: d.capsule || g.capsule || '',
      released: d.releaseDate,
      storeOffers: g.storeOffers.map(o =>
        o === steam
          ? {
              ...o,
              description: o.description || d.description,
              tags: d.tags,
              screenshots: o.screenshots?.length ? o.screenshots : d.screenshots,
            }
          : o
      ),
    };
  });
}
async function fetchHome(fetchers, country) {
  if (!Object.hasOwn(regionCurrency, country)) throw Error('Некорректный регион магазина');
  // Steam search's game category excludes news/software; DLCs use the separate shelf.
  const results = await Promise.allSettled([
    browseSteamSafe(fetchers.steam, 'top', country),
    browseSteamSafe(fetchers.steam, 'sales', country),
    browseEpic(fetchers.epic, 'sales', country),
    browseSteamSafe(fetchers.steam, 'new', country),
  ]);
  const providers = {},
    steam = [],
    epic = [];
  let specials = [];
  if (results[0].status === 'fulfilled') {
    steam.push(...results[0].value.offers.map(o => ({ ...o, country })));
    providers.steam = { ok: true, count: steam.length };
  } else
    providers.steam = {
      ok: false,
      error: `Steam: ${/HTTP \d+/.exec(results[0].reason?.message)?.[0] || 'витрина недоступна'}`,
    };
  if (results[1].status === 'fulfilled') specials = results[1].value.offers.map(o => ({ ...o, country }));
  if (results[2].status === 'fulfilled') {
    epic.push(...results[2].value.offers.map(o => ({ ...o, country })));
    providers.epic = { ok: true, count: epic.length };
  } else
    providers.epic = {
      ok: false,
      error: `Epic Games: ${/HTTP \d+/.exec(results[2].reason?.message)?.[0] || 'витрина недоступна'}`,
    };
  const ordered = [];
  for (let i = 0; i < Math.max(steam.length, epic.length); i++) {
    if (steam[i]) ordered.push(steam[i]);
    if (epic[i]) ordered.push(epic[i]);
  }
  let detailsError = '';
  let items = combineOffers(ordered),
    promotions = combineOffers([...specials, ...epic.filter(o => o.discount > 0)]),
    // Popular new releases for the featured carousel (optional: the store front works without them).
    newReleases =
      results[3].status === 'fulfilled'
        ? combineOffers(results[3].value.offers.map(o => ({ ...o, country })))
        : [];
  try {
    const all = await withSteamDetails(fetchers.steam, [...items, ...promotions, ...newReleases], country);
    items = all.slice(0, items.length);
    promotions = all.slice(items.length, items.length + promotions.length);
    newReleases = all.slice(items.length + promotions.length);
  } catch (e) {
    detailsError = e.message;
  }
  return {
    detailsError,
    items,
    promotions,
    newReleases,
    providers,
    country,
    checkedAt: Date.now(),
  };
}
module.exports = { featuredOffers, browseSteamSafe, fetchHome, withSteamDetails };
