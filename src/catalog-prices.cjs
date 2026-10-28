const { responseJSON, searchEpic, normalize, regionCurrency, imageUrl } = require('./providers.cjs');
// Search results may omit items. A product namespace with exactly one base game
// is still an exact match (DLC share the namespace but are not games).
function onlyGameIn(offers, namespace) {
  if (!namespace) return null;
  const games = offers.filter(o => o.namespace === namespace && o.type !== 'dlc');
  return games.length === 1 ? games[0] : null;
}
function steamOffer(data, game, country) {
  const base = {
    provider: 'steam',
    appId: String(game.steam),
    name: game.name,
    country,
    url: `https://store.steampowered.com/app/${game.steam}/`,
    checkedAt: Date.now(),
  };
  if (data?.success) {
    base.name = data.data.name || game.name;
    base.image = imageUrl(data.data.header_image);
    base.screenshots = (data.data.screenshots || [])
      .slice(0, 4)
      .map(x => imageUrl(x.path_thumbnail))
      .filter(Boolean);
    base.description = String(data.data.short_description || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    base.tags = (data.data.genres || []).map(x => String(x.description || '').slice(0, 50)).slice(0, 6);
    base.releaseDate = data.data.release_date?.date || '';
    base.comingSoon = data.data.release_date?.coming_soon === true;
    base.type = data.data.type || 'game';
  }
  if (!data?.success)
    return {
      ...base,
      price: null,
      amount: null,
      priceStatus: 'unavailable',
      priceError: 'Недоступно в регионе',
    };
  const p = data.data?.price_overview;
  if (p && Number.isFinite(p.final))
    return {
      ...base,
      amount: p.final / 100,
      currency: p.currency,
      price:
        p.final_formatted ||
        new Intl.NumberFormat('ru-RU', { style: 'currency', currency: p.currency }).format(p.final / 100),
      originalPrice: p.initial_formatted || null,
      discount: p.discount_percent || 0,
      priceStatus: 'ready',
    };
  if (data.data?.is_free)
    return {
      ...base,
      amount: 0,
      currency: regionCurrency[country] || null,
      price: 'Бесплатно',
      discount: 0,
      priceStatus: 'ready',
    };
  return {
    ...base,
    price: null,
    amount: null,
    priceStatus: 'unavailable',
    priceError: data.data?.release_date?.coming_soon ? 'Скоро в продаже' : 'Нет цены в регионе',
  };
}
async function fetchGameOffers(fetcher, game, country, onOffer) {
  const steam =
    game.steam ||
    game.storeOffers?.find(o => o.provider === 'steam')?.appId ||
    game.offers?.find(o => o.provider === 'steam')?.appId;
  const epic = game.storeOffers?.find(o => o.provider === 'epic' && o.appId),
    localEpic = game.offers?.find(o => o.provider === 'epic');
  const jobs = [];
  if (steam)
    jobs.push(
      (async () => {
        const u = new URL('https://store.steampowered.com/api/appdetails');
        u.search = new URLSearchParams({ appids: String(steam), cc: country, l: 'russian' });
        try {
          return steamOffer((await responseJSON(fetcher, u.href))[steam], { ...game, steam }, country);
        } catch (e) {
          return {
            provider: 'steam',
            appId: String(steam),
            name: game.name,
            country,
            url: `https://store.steampowered.com/app/${steam}/`,
            price: null,
            amount: null,
            priceStatus: 'error',
            priceError: /HTTP \d+/.exec(e.message)?.[0] || 'Не удалось загрузить цену',
            checkedAt: Date.now(),
          };
        }
      })()
    );
  if (epic || game.epic || localEpic)
    jobs.push(
      (async () => {
        try {
          const { offers } = await searchEpic(fetcher, game.name, country);
          const match = epic
            ? offers.find(o => o.appId === epic.appId && o.namespace === epic.namespace)
            : localEpic
              ? offers.find(
                  o => o.namespace === localEpic.namespace && o.items?.some(i => i.id === localEpic.itemId)
                ) || onlyGameIn(offers, localEpic.namespace)
              : offers.find(
                  o =>
                    o.url?.endsWith('/p/' + game.epic) &&
                    (!game.noAutoMerge || normalize(o.name) === normalize(game.name))
                );
          if (!match)
            return {
              ...epic,
              provider: 'epic',
              country,
              price: null,
              amount: null,
              priceStatus: 'unavailable',
              priceError: 'Точное издание не найдено',
              checkedAt: Date.now(),
            };
          return {
            ...match,
            country,
            priceStatus: match.price ? 'ready' : 'unavailable',
            checkedAt: Date.now(),
          };
        } catch (e) {
          return {
            ...epic,
            provider: 'epic',
            country,
            price: null,
            amount: null,
            priceStatus: 'error',
            priceError: /HTTP \d+/.exec(e.message)?.[0] || 'Не удалось загрузить цену',
            checkedAt: Date.now(),
          };
        }
      })()
    );
  return Promise.all(
    jobs.map(job =>
      job.then(offer => {
        onOffer?.(offer);
        return offer;
      })
    )
  );
}
class CatalogPrices {
  constructor(fetcher) {
    this.fetcher = fetcher;
    this.cache = new Map();
    this.pending = new Map();
  }
  async get(game, country, force = false, onOffer) {
    const key = game.id + ':' + country,
      cached = this.cache.get(key);
    if (!force && cached && Date.now() - cached.at < 300000) return cached.offers;
    if (this.pending.has(key)) return this.pending.get(key);
    const task = fetchGameOffers(this.fetcher, game, country, onOffer)
      .then(offers => {
        this.cache.set(key, { at: Date.now(), offers });
        if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
        return offers;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
}
module.exports = { steamOffer, fetchGameOffers, CatalogPrices };
