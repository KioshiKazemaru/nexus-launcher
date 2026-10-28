const { responseJSON, searchEpic } = require('./providers.cjs');
function usablePrice(p) {
  return Number.isFinite(p?.amount) && p.amount >= 0 && /^[A-Z]{3}$/.test(p.currency || '');
}
function observe(w, price, now = Date.now()) {
  if (!usablePrice(price)) throw Error('Магазин не вернул цену для выбранного региона');
  const previous = w.current,
    same = previous?.currency === price.currency;
  const below = Number.isFinite(w.target) && w.targetCurrency === price.currency && price.amount <= w.target;
  const crossed = below && (!same || previous.amount > w.target);
  const dropped = same && price.amount < previous.amount;
  const saleStarted = same && price.discount > 0 && !(previous.discount > 0);
  const reason = crossed
    ? 'Достигнута желаемая цена'
    : dropped
      ? 'Цена снизилась'
      : saleStarted
        ? 'Началась скидка'
        : null;
  w.checkedAt = now;
  w.error = '';
  w.current = {
    amount: price.amount,
    currency: price.currency,
    price: price.price,
    discount: price.discount || 0,
    at: now,
  };
  w.history ||= [];
  if (!same || previous.amount !== price.amount || previous.discount !== price.discount)
    w.history.push({ ...w.current });
  w.history = w.history.slice(-180);
  if (reason)
    w.alert = { reason, at: now, price: price.price, amount: price.amount, currency: price.currency };
  return reason;
}
async function fetchPrice(fetcher, w) {
  if (w.provider === 'steam') {
    if (!/^\d+$/.test(w.appId)) throw Error('Некорректная игра Steam');
    const u = new URL('https://store.steampowered.com/api/appdetails');
    u.search = new URLSearchParams({ appids: w.appId, cc: w.country, l: 'russian' });
    const data = (await responseJSON(fetcher, u.href))[w.appId];
    if (!data?.success) throw Error('Игра недоступна в выбранном регионе');
    const p = data.data?.price_overview;
    if (p && typeof p.final === 'number')
      return {
        amount: p.final / 100,
        currency: p.currency,
        price: p.final_formatted,
        discount: p.discount_percent || 0,
      };
    // Free status has no verified currency. Do not silently convert an unavailable price to zero.
    if (data.data?.is_free && w.current?.currency)
      return { amount: 0, currency: w.current.currency, price: 'Бесплатно', discount: 0 };
    throw Error(
      data.data?.is_free
        ? 'Бесплатная игра: цена для отслеживания не требуется'
        : 'Цена недоступна в выбранном регионе'
    );
  }
  const result = await searchEpic(fetcher, w.name, w.country);
  const offer = result.offers.find(o => o.appId === w.appId && o.namespace === w.namespace);
  if (!offer) throw Error('Точное предложение Epic не найдено; предыдущая цена сохранена');
  return offer;
}
class PriceWatcher {
  constructor(entries, fetchPrice, save, notify = () => {}) {
    this.entries = entries;
    this.fetchPrice = fetchPrice;
    this.save = save;
    this.notify = notify;
    this.inFlight = null;
  }
  async check() {
    if (this.inFlight) return this.inFlight;
    const work = (async () => {
      for (const w of [...this.entries]) {
        if (!this.entries.includes(w)) continue;
        try {
          const price = await this.fetchPrice(w);
          if (!this.entries.includes(w)) continue;
          const reason = observe(w, price);
          if (reason) {
            try {
              this.notify(w, reason);
            } catch {}
          }
        } catch (e) {
          if (this.entries.includes(w)) {
            w.checkedAt = Date.now();
            w.error = e.message || 'Проверка недоступна';
          }
        }
        this.save();
      }
    })();
    this.inFlight = work;
    try {
      await work;
    } finally {
      this.inFlight = null;
    }
  }
}
module.exports = { usablePrice, observe, fetchPrice, PriceWatcher };
