const cheerio = require('cheerio');
const { catalog } = require('./catalog.cjs');
// ™/®/© are removed before NFKC, otherwise NFKC turns "™" into "TM".
const normalize = s =>
  String(s || '')
    .replace(/[™®©]/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
function imageUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (/(^|\.)steamstatic\.com$/.test(u.hostname) ||
        [
          'steamcdn-a.akamaihd.net',
          'cdn.akamai.steamstatic.com',
          'cdn1.epicgames.com',
          'cdn2.epicgames.com',
          'cdn2.unrealengine.com',
          'images.igdb.com',
          'cdn2.steamgriddb.com',
        ].includes(u.hostname))
      ? u.href
      : '';
  } catch {
    return '';
  }
}
function steamImage(id) {
  return /^\d+$/.test(String(id))
    ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`
    : '';
}
const regionCurrency = {
  US: 'USD',
  RU: 'RUB',
  KZ: 'KZT',
  TR: 'USD',
  DE: 'EUR',
  FI: 'EUR',
  UA: 'UAH',
  PL: 'PLN',
  GB: 'GBP',
  FR: 'EUR',
};
function detectedCurrency(text) {
  const rules = [
    ['USD', /US\$|\$/],
    ['EUR', /€/],
    ['RUB', /руб|₽/i],
    ['KZT', /₸|тенге/i],
    ['UAH', /₴|грн/i],
    ['PLN', /zł/i],
    ['GBP', /£/],
  ];
  return rules.find(([, r]) => r.test(text || ''))?.[0] || null;
}
function parseSteamSearch(data, country = 'US') {
  if (!data || typeof data.results_html !== 'string') throw Error('Неизвестный формат поиска Steam');
  const $ = cheerio.load(data.results_html),
    out = [];
  $('.search_result_row').each((_i, row) => {
    const el = $(row),
      m = (el.attr('href') || '').match(/^https:\/\/store\.steampowered\.com\/app\/(\d+)\//),
      id = m?.[1];
    if (!id) return;
    const name = el.find('.title').text().trim();
    if (!name) return;
    const img = imageUrl(el.find('.search_capsule img').attr('src'));
    const amount =
      el.find('.discount_final_price').text().trim() ||
      el.find('.search_price').clone().children().remove().end().text().trim();
    const original = el.find('.discount_original_price').text().trim();
    const raw = el.find('[data-price-final]').first().attr('data-price-final');
    const numeric = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) / 100 : null;
    const free = /^(free|free to play|бесплатно|бесплатная игра)$/i.test(amount || '');
    const currency = detectedCurrency(amount) || (free ? regionCurrency[country] : null);
    const amountValue = free ? 0 : numeric;
    const discount = Number(el.find('[data-discount]').first().attr('data-discount')) || 0;
    out.push({
      provider: 'steam',
      appId: id,
      name,
      image: img || steamImage(id),
      releaseDate: el.find('.search_released').text().trim().slice(0, 60),
      price: amount || null,
      amount: amountValue,
      currency,
      discount,
      country,
      originalPrice: original || null,
      url: `https://store.steampowered.com/app/${id}/`,
    });
  });
  return { offers: out, total: Number(data.total_count) || out.length };
}
function parseSteamSuggestions(data) {
  if (!Array.isArray(data?.items)) throw Error('Неизвестный формат поиска Steam');
  return {
    offers: data.items
      .filter(x => x.type === 'app' && /^\d+$/.test(String(x.id)))
      .map(x => ({
        provider: 'steam',
        appId: String(x.id),
        name: x.name,
        image: imageUrl(x.tiny_image) || steamImage(x.id),
        amount: typeof x.price?.final === 'number' ? x.price.final / 100 : null,
        currency: x.price?.currency || null,
        discount: x.price?.initial > 0 ? Math.round(100 * (1 - x.price.final / x.price.initial)) : 0,
        price:
          typeof x.price?.final === 'number'
            ? new Intl.NumberFormat('ru-RU', { style: 'currency', currency: x.price.currency }).format(
                x.price.final / 100
              )
            : null,
        url: `https://store.steampowered.com/app/${x.id}/`,
      })),
    total: data.total || data.items.length,
  };
}
// Epic tags come in English: the common genres and modes in Russian, as Steam shows them.
const EPIC_TAGS = {
  Action: 'Экшен',
  'Action-Adventure': 'Приключенческий экшен',
  Adventure: 'Приключение',
  RPG: 'Ролевая игра',
  Strategy: 'Стратегия',
  Simulation: 'Симулятор',
  Shooter: 'Шутер',
  Puzzle: 'Головоломка',
  Racing: 'Гонки',
  Sports: 'Спорт',
  Indie: 'Инди',
  Horror: 'Хоррор',
  Survival: 'Выживание',
  'Open World': 'Открытый мир',
  Platformer: 'Платформер',
  Roguelike: 'Рогалик',
  'Rogue-Lite': 'Рогалик',
  Casual: 'Казуальная игра',
  Fighting: 'Файтинг',
  Narration: 'Сюжетная',
  Exploration: 'Исследование',
  'Card Game': 'Карточная игра',
  'Turn-Based': 'Пошаговая',
  'Turn-Based Strategy': 'Пошаговая стратегия',
  'City Builder': 'Градостроительство',
  Comedy: 'Комедия',
  Party: 'Для вечеринок',
  Music: 'Музыка',
  Stealth: 'Стелс',
  'Tower Defense': 'Башенная защита',
  Space: 'Космос',
  Fantasy: 'Фэнтези',
  'Sci-Fi': 'Научная фантастика',
  Building: 'Строительство',
  MMO: 'MMO',
  Retro: 'Ретро',
  'First Person': 'От первого лица',
  'Battle Royale': 'Королевская битва',
  Arcade: 'Аркада',
  Trivia: 'Викторина',
  'Hack and Slash': 'Слэшер',
  Metroidvania: 'Метроидвания',
  Deckbuilding: 'Колодостроение',
  'Real Time Strategy': 'Стратегия в реальном времени',
  'Real-Time Strategy': 'Стратегия в реальном времени',
  'Life Sim': 'Симулятор жизни',
  Rhythm: 'Ритм-игра',
  Multiplayer: 'Для нескольких игроков',
  'Co-op': 'Кооператив',
  'Online Multiplayer': 'Сетевая игра',
  Competitive: 'Соревновательная',
  'Single Player': 'Для одного игрока',
  'Cross Platform': 'Кроссплатформенная',
  'Controller Support': 'Поддержка контроллера',
  'Local Multiplayer': 'Локальный мультиплеер',
  'Online Co-op': 'Сетевой кооператив',
  'Local Co-op': 'Локальный кооператив',
  'Co-op Campaign': 'Кооперативная кампания',
  'Massively Multiplayer': 'Массовая многопользовательская',
};
// Gallery images are 1920 px originals; the Epic CDN resizes them like the Epic store does.
function epicThumb(url) {
  try {
    const u = new URL(url);
    if (!/^cdn[12]\.epicgames\.com$/.test(u.hostname) || u.search) return url;
    u.search = 'resize=1&w=640&h=360&quality=medium';
    return u.href;
  } catch {
    return url;
  }
}
// Epic marks games without an announced date with a placeholder year (2099).
const EPIC_TBA_YEAR = 2098;
function epicRelease(x) {
  const t = Date.parse(x?.releaseDate || x?.effectiveDate || '');
  if (!Number.isFinite(t)) return {};
  if (new Date(t).getUTCFullYear() >= EPIC_TBA_YEAR) return { releaseDate: 'Дата не объявлена', tba: true };
  return {
    released: t,
    releaseDate: new Date(t).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }),
  };
}
// Genres first, then play modes; platforms and store features are not tags.
function epicTags(tags) {
  if (!Array.isArray(tags)) return [];
  const pick = group =>
    tags
      .filter(t => t?.groupName === group && typeof t.name === 'string' && t.name)
      .map(t => EPIC_TAGS[t.name] || t.name.slice(0, 50));
  return [...new Set([...pick('genre'), ...pick('feature')])].slice(0, 6);
}
function parseEpicSearch(data) {
  const result = data?.data?.Catalog?.searchStore;
  // GraphQL may return usable elements together with errors for single fields.
  if (data?.errors?.length && !Array.isArray(result?.elements)) {
    const e = Error('Epic изменил формат каталога');
    e.detail = String(data.errors[0]?.message || '').slice(0, 200);
    throw e;
  }
  if (!Array.isArray(result?.elements)) throw Error('Неизвестный формат поиска Epic');
  const offers = [];
  for (const x of result.elements) {
    if (!x.id || !x.namespace || !x.title) continue;
    const categories = x.categories?.map(c => c.path || c).filter(c => typeof c === 'string') || [];
    if (categories.some(c => /^(news|editorial|articles|events|software|mods|bundles)(\/|$)/i.test(c)))
      continue;
    if (!categories.some(c => /^(games|addons|dlc)(\/|$)/i.test(c))) continue;
    const images = x.keyImages || [],
      image = imageUrl(
        ['OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail', 'OfferImageTall', 'DieselStoreFrontTall']
          .map(t => images.find(i => i.type === t)?.url)
          .find(Boolean) || images[0]?.url
      );
    const mapping = [...(x.offerMappings || []), ...(x.catalogNs?.mappings || [])].find(
      m => m.pageType === 'productHome' && m.pageSlug
    );
    const slug = (mapping?.pageSlug || x.productSlug || '').replace(/\/home$/, '');
    const price = x.price?.totalPrice;
    const divisor = 10 ** (price?.currencyInfo?.decimals ?? 2);
    offers.push({
      provider: 'epic',
      appId: x.id,
      namespace: x.namespace,
      name: x.title,
      type: categories.some(c => /^(addons|dlc)(\/|$)/i.test(c)) ? 'dlc' : 'game',
      desc: String(x.description || '')
        .replace(/<[^>]*>/g, ' ')
        .slice(0, 500),
      items: (x.items || []).map(i => ({ id: i.id, namespace: i.namespace })),
      image,
      // "featuredMedia" is the gallery of the store page (Epic's screenshots).
      screenshots: [
        ...new Set(
          images
            .filter(i => /screenshot|gallery|featuredmedia/i.test(i.type || ''))
            .map(i => imageUrl(epicThumb(i.url)))
            .filter(Boolean)
        ),
      ].slice(0, 6),
      tags: epicTags(x.tags),
      ...epicRelease(x),
      amount: typeof price?.discountPrice === 'number' ? price.discountPrice / divisor : null,
      discount:
        price?.originalPrice > 0 ? Math.round(100 * (1 - price.discountPrice / price.originalPrice)) : 0,
      price: price?.fmtPrice?.discountPrice || null,
      originalPrice: price?.fmtPrice?.originalPrice || null,
      currency: price?.currencyCode || null,
      url: /^[a-z0-9][a-z0-9-]{0,180}$/i.test(slug) ? `https://store.epicgames.com/p/${slug}` : null,
    });
  }
  return { offers, total: result.paging?.total || offers.length };
}
const EPIC_QUERY = `query NexusSearch($keywords:String,$country:String!,$start:Int!,$count:Int!){Catalog{searchStore(keywords:$keywords,country:$country,locale:"ru",start:$start,count:$count){elements{id namespace title description productSlug effectiveDate releaseDate keyImages{type url} tags{id name groupName} categories{path} items{id namespace} offerMappings{pageSlug pageType} catalogNs{mappings(pageType:"productHome"){pageSlug pageType}} price(country:$country){totalPrice{currencyCode originalPrice discountPrice currencyInfo{decimals} fmtPrice(locale:"ru"){originalPrice discountPrice}}}} paging{count total}}}}`;
function combineOffers(offers) {
  const groups = new Map();
  for (const offer of offers) {
    const known =
      offer.provider === 'steam'
        ? catalog.find(c => c.steam === offer.appId)
        : catalog.find(c => !c.noAutoMerge && normalize(c.name) === normalize(offer.name));
    let key = normalize(offer.name);
    if (groups.get(key)?.storeOffers.some(o => o.provider === offer.provider && o.appId !== offer.appId))
      key += `:${offer.provider}:${offer.appId}`;
    // Same full title only. Edition suffixes are retained; no fuzzy matching.
    const group = groups.get(key) || {
      ...(known || {}),
      id: offer.provider === 'steam' ? known?.id || `steam:${offer.appId}` : `epic:${offer.appId}`,
      name: offer.name,
      desc: known?.desc || offer.desc || '',
      tags: known?.tags || (offer.type === 'dlc' ? ['Дополнение'] : offer.tags || []),
      color: known?.color || '#a6ccec',
      storeOffers: [],
    };
    if (!group.storeOffers.some(o => o.provider === offer.provider && o.appId === offer.appId))
      group.storeOffers.push(offer);
    if (offer.provider === 'steam') {
      group.steam = offer.appId;
      group.id = known?.id || `steam:${offer.appId}`;
      group.name = offer.name;
    }
    group.image =
      group.storeOffers.find(o => o.provider === 'steam' && o.image)?.image ||
      group.storeOffers.find(o => o.image)?.image ||
      '';
    groups.set(key, group);
  }
  return [...groups.values()].map(g => ({
    ...g,
    storeOffers: g.storeOffers.sort(
      (a, b) => (a.provider === 'steam' ? -1 : 1) - (b.provider === 'steam' ? -1 : 1)
    ),
  }));
}
async function responseJSON(fetcher, url, options = {}) {
  const r = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (text.length > 5_000_000) throw Error('Слишком большой ответ');
  try {
    return JSON.parse(text);
  } catch {
    throw Error('Сервис вернул страницу вместо данных');
  }
}
async function searchSteam(fetcher, query, country, start = 0) {
  const u = new URL('https://store.steampowered.com/search/results/');
  u.search = new URLSearchParams({
    term: query,
    start: String(start),
    count: '24',
    json: '1',
    cc: country,
    l: 'russian',
    infinite: '1',
    category1: '998',
  });
  try {
    const result = parseSteamSearch(await responseJSON(fetcher, u.href), country);
    if (result.offers.length || start > 0) return result;
  } catch (e) {
    if (start > 0) throw e;
  }
  // The HTML search endpoint changes often; the JSON storesearch API is the fallback.
  return storeSearch(fetcher, query, country);
}
async function storeSearch(fetcher, query, country) {
  const u = new URL('https://store.steampowered.com/api/storesearch/');
  u.search = new URLSearchParams({ term: query, cc: country, l: 'russian' });
  const result = parseSteamSuggestions(await responseJSON(fetcher, u.href));
  return { ...result, offers: result.offers.map(o => ({ ...o, country })) };
}
const browseFilters = {
  // "Популярные новинки" of the Steam store: new releases that sell, newest first.
  new: { filter: 'popularnew', sort_by: 'Released_DESC' },
  top: { filter: 'topsellers' },
  coming: { filter: 'comingsoon' },
  sales: { specials: '1' },
  free: { maxprice: 'free' },
};
async function browseSteam(fetcher, kind, country) {
  if (!Object.hasOwn(browseFilters, kind) || !Object.hasOwn(regionCurrency, country))
    throw Error('Некорректная подборка магазина');
  const u = new URL('https://store.steampowered.com/search/results/');
  u.search = new URLSearchParams({
    start: '0',
    count: '12',
    json: '1',
    cc: country,
    l: 'russian',
    infinite: '1',
    category1: '998',
    ...browseFilters[kind],
  });
  return parseSteamSearch(await responseJSON(fetcher, u.href), country);
}
// Popular store games with all of the given Steam tags (recommendation candidates).
async function searchSteamByTags(fetcher, tagIds, country, count = 30) {
  if (!Object.hasOwn(regionCurrency, country)) throw Error('Некорректный регион магазина');
  const ids = (tagIds || []).filter(Number.isInteger).slice(0, 3);
  if (!ids.length) return { offers: [], total: 0 };
  const u = new URL('https://store.steampowered.com/search/results/');
  u.search = new URLSearchParams({
    start: '0',
    count: String(Math.min(50, count)),
    json: '1',
    cc: country,
    l: 'russian',
    infinite: '1',
    category1: '998',
    tags: ids.join(','),
  });
  return parseSteamSearch(await responseJSON(fetcher, u.href), country);
}
// Epic store lists like the filters of the Epic store itself:
//   new     released games, newest first ("Новинки")
//   coming  announced games, soonest first ("Скоро появится"; no "date not announced")
//   sales   discounted games ("Скидки")
//   free    free-to-play games that are out
const EPIC_BROWSE_QUERY = `query NexusBrowse($country:String!,$count:Int!,$sortBy:String,$sortDir:String,$releaseDate:String,$onSale:Boolean,$freeGame:Boolean){Catalog{searchStore(country:$country,locale:"ru",start:0,count:$count,category:"games/edition/base",sortBy:$sortBy,sortDir:$sortDir,releaseDate:$releaseDate,onSale:$onSale,freeGame:$freeGame){elements{id namespace title description productSlug effectiveDate releaseDate keyImages{type url} tags{id name groupName} categories{path} items{id namespace} offerMappings{pageSlug pageType} catalogNs{mappings(pageType:"productHome"){pageSlug pageType}} price(country:$country){totalPrice{currencyCode originalPrice discountPrice currencyInfo{decimals} fmtPrice(locale:"ru"){originalPrice discountPrice}}}} paging{count total}}}}`;
function epicBrowseVariables(kind, country, now = Date.now()) {
  const iso = t => new Date(t).toISOString();
  const tba = `${EPIC_TBA_YEAR}-01-01T00:00:00.000Z`;
  const base = { country, count: 40 };
  if (kind === 'new')
    return { ...base, sortBy: 'releaseDate', sortDir: 'DESC', releaseDate: `[,${iso(now)}]` };
  if (kind === 'coming')
    return { ...base, sortBy: 'releaseDate', sortDir: 'ASC', releaseDate: `[${iso(now)},${tba}]` };
  if (kind === 'sales')
    return { ...base, sortBy: 'releaseDate', sortDir: 'DESC', onSale: true, releaseDate: `[,${iso(now)}]` };
  if (kind === 'free')
    return { ...base, sortBy: 'releaseDate', sortDir: 'DESC', freeGame: true, releaseDate: `[,${iso(now)}]` };
  throw Error('Некорректная подборка Epic');
}
async function browseEpic(fetcher, kind, country) {
  if (!Object.hasOwn(regionCurrency, country)) throw Error('Некорректный регион магазина');
  const u = new URL('https://store.epicgames.com/graphql');
  u.search = new URLSearchParams({
    query: EPIC_BROWSE_QUERY,
    variables: JSON.stringify(epicBrowseVariables(kind, country)),
  });
  const result = parseEpicSearch(await responseJSON(fetcher, u.href));
  // Epic lists also DLC under "games" now and then: the lists show games only.
  return { ...result, offers: result.offers.filter(o => o.type === 'game' && !o.tba) };
}
async function searchEpic(fetcher, query, country, start = 0) {
  const u = new URL('https://store.epicgames.com/graphql');
  u.search = new URLSearchParams({
    query: EPIC_QUERY,
    variables: JSON.stringify({ keywords: query, country, start, count: 24 }),
  });
  return parseEpicSearch(await responseJSON(fetcher, u.href));
}
async function searchStores(fetchers, query, country, start = 0) {
  const result = await Promise.allSettled([
    searchSteam(fetchers.steam, query, country, start),
    searchEpic(fetchers.epic, query, country, start),
  ]);
  const providers = {},
    offers = [];
  result.forEach((r, i) => {
    const p = i ? 'epic' : 'steam';
    if (r.status === 'fulfilled') {
      providers[p] = { ok: true, total: r.value.total, count: r.value.offers.length };
      offers.push(...r.value.offers.map(o => ({ ...o, country })));
    } else
      providers[p] = {
        ok: false,
        error: `${i ? 'Epic Games' : 'Steam'}: ${/HTTP \d+/.exec(r.reason?.message)?.[0] || 'не удалось загрузить каталог'}`,
      };
  });
  return { items: combineOffers(offers), providers, country, query, start, checkedAt: Date.now() };
}
module.exports = {
  regionCurrency,
  epicTags,
  responseJSON,
  normalize,
  imageUrl,
  steamImage,
  parseSteamSearch,
  parseSteamSuggestions,
  parseEpicSearch,
  combineOffers,
  searchSteam,
  storeSearch,
  browseSteam,
  searchSteamByTags,
  browseEpic,
  epicBrowseVariables,
  searchEpic,
  searchStores,
};
