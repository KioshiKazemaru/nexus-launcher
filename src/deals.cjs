'use strict';
// "Скидки": the games on sale in the Steam and Epic Games stores, page by page, with
// the date each discount ends.
//   Steam: the store search with "Специальные предложения" (specials=1), most popular
//          first; prices and the end of each discount from IStoreBrowseService/GetItems.
//   Epic:  the store catalogue with onSale, the end of the discount from the price
//          rules Epic applied (lineOffers.appliedRules.endDate).

const {
  responseJSON,
  parseSteamSearch,
  parseEpicSearch,
  regionCurrency,
  EPIC_BROWSE_QUERY,
} = require('./providers.cjs');
const { saleInfo } = require('./steam-library.cjs');

const STEAM_PAGE = 50;
const EPIC_PAGE = 40;

// The store's own order of a sale list: Steam's relevance is "popular first"; Epic
// sorts its sale list by release date (newest first) or by price.
const STEAM_SORT = { popular: null, price: 'Price_ASC', new: 'Released_DESC' };
const EPIC_SORT = {
  popular: ['releaseDate', 'DESC'],
  price: ['currentPrice', 'ASC'],
  new: ['releaseDate', 'DESC'],
};

function checkPage(country, start, sort) {
  if (!Object.hasOwn(regionCurrency, country)) throw Error('Некорректный регион магазина');
  if (!Number.isInteger(start) || start < 0 || start > 10000) throw Error('Некорректная страница скидок');
  if (!Object.hasOwn(STEAM_SORT, sort)) throw Error('Некорректный порядок');
}

async function steamDeals(fetcher, country, start = 0, sort = 'popular') {
  checkPage(country, start, sort);
  const u = new URL('https://store.steampowered.com/search/results/');
  u.search = new URLSearchParams({
    start: String(start),
    count: String(STEAM_PAGE),
    json: '1',
    cc: country,
    l: 'russian',
    infinite: '1',
    category1: '998',
    specials: '1',
    ...(STEAM_SORT[sort] ? { sort_by: STEAM_SORT[sort] } : {}),
  });
  const result = parseSteamSearch(await responseJSON(fetcher, u.href), country);
  let offers = result.offers.filter(o => o.discount > 0);
  // The end of each discount (and the exact price) in one request for the whole page;
  // without it the list still shows the discounts, only without the date.
  try {
    const sales = await saleInfo(
      fetcher,
      offers.map(o => o.appId),
      country
    );
    offers = offers.map(o => {
      const s = sales.get(o.appId);
      if (!s?.discount) return o;
      return {
        ...o,
        discount: s.discount,
        ...(Number.isFinite(s.amount) ? { amount: s.amount } : {}),
        ...(s.price ? { price: s.price } : {}),
        ...(s.originalPrice ? { originalPrice: s.originalPrice } : {}),
        ...(s.saleEnd ? { saleEnd: s.saleEnd } : {}),
        ...(s.image ? { image: s.image } : {}),
      };
    });
  } catch {}
  return {
    offers: offers.map(o => ({ ...o, country, priceStatus: 'ready' })),
    total: result.total,
    next: result.offers.length ? start + STEAM_PAGE : null,
  };
}

async function epicDeals(fetcher, country, start = 0, sort = 'popular', now = Date.now()) {
  checkPage(country, start, sort);
  const [sortBy, sortDir] = EPIC_SORT[sort];
  const u = new URL('https://store.epicgames.com/graphql');
  u.search = new URLSearchParams({
    query: EPIC_BROWSE_QUERY,
    variables: JSON.stringify({
      country,
      start,
      count: EPIC_PAGE,
      sortBy,
      sortDir,
      onSale: true,
      releaseDate: `[,${new Date(now).toISOString()}]`,
    }),
  });
  const result = parseEpicSearch(await responseJSON(fetcher, u.href));
  const offers = result.offers.filter(o => o.type === 'game' && !o.tba && o.discount > 0);
  return {
    offers: offers.map(o => ({ ...o, country, priceStatus: o.price ? 'ready' : 'unavailable' })),
    total: result.total,
    next: start + EPIC_PAGE < result.total && result.offers.length ? start + EPIC_PAGE : null,
  };
}

module.exports = { steamDeals, epicDeals, STEAM_PAGE, EPIC_PAGE };
