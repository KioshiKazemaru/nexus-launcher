const test = require('node:test'),
  assert = require('node:assert/strict');
const { observe, fetchPrice, PriceWatcher } = require('../src/prices.cjs');
const { parseSteamSearch, parseEpicSearch } = require('../src/providers.cjs');
const p = (amount, currency = 'USD', discount = 0) => ({ amount, currency, discount, price: String(amount) });
test('first observation is baseline; actual drops alert once, zero is valid', () => {
  const w = {};
  assert.equal(observe(w, p(20), 1), null);
  assert.equal(observe(w, p(10, 'USD', 50), 2), 'Цена снизилась');
  assert.equal(observe(w, p(10, 'USD', 50), 3), null);
  assert.equal(observe(w, p(0, 'USD', 100), 4), 'Цена снизилась');
  assert.equal(w.history.length, 3);
});
test('missing price and changed currency cannot create a false drop', () => {
  const w = {};
  observe(w, p(20));
  assert.throws(() => observe(w, p(null)));
  assert.equal(w.current.amount, 20);
  assert.equal(observe(w, p(10, 'EUR')), null);
});
test('target compares only its currency and notifies on crossing', () => {
  const w = { target: 10, targetCurrency: 'USD' };
  observe(w, p(20));
  assert.equal(observe(w, p(10)), 'Достигнута желаемая цена');
  assert.equal(observe(w, p(10)), null);
  assert.equal(observe(w, p(5, 'EUR')), null);
});
test('Steam HTML numeric minor units, discount and unknown price', () => {
  const r = parseSteamSearch({
    results_html:
      '<a class="search_result_row" href="https://store.steampowered.com/app/1/"><span class="title">Game</span><div data-price-final="2499" data-discount="50"><span class="discount_final_price">$24.99</span></div></a><a class="search_result_row" href="https://store.steampowered.com/app/2/"><span class="title">Unavailable</span></a>',
  });
  assert.equal(r.offers[0].amount, 24.99);
  assert.equal(r.offers[0].discount, 50);
  assert.equal(r.offers[0].currency, 'USD');
  assert.equal(r.offers[1].amount, null);
});
test('Epic uses numeric totals and explicit decimal scale, preserving free sale', () => {
  const r = parseEpicSearch({
    data: {
      Catalog: {
        searchStore: {
          elements: [
            {
              id: 'offer',
              namespace: 'ns',
              title: 'Title',
              categories: [{ path: 'games' }],
              price: {
                totalPrice: {
                  currencyCode: 'JPY',
                  currencyInfo: { decimals: 0 },
                  originalPrice: 1000,
                  discountPrice: 0,
                  fmtPrice: { discountPrice: '0' },
                },
              },
            },
          ],
        },
      },
    },
  });
  assert.equal(r.offers[0].amount, 0);
  assert.equal(r.offers[0].discount, 100);
});
test('exact Steam app price and region requested; region unavailable is not zero', async () => {
  let url;
  const w = { provider: 'steam', appId: '42', country: 'KZ' };
  const price = await fetchPrice(async u => {
    url = u;
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          42: {
            success: true,
            data: {
              price_overview: {
                currency: 'KZT',
                final: 149900,
                final_formatted: '1499 ₸',
                discount_percent: 25,
              },
            },
          },
        }),
    };
  }, w);
  assert.equal(new URL(url).searchParams.get('cc'), 'KZ');
  assert.equal(price.amount, 1499);
  await assert.rejects(() =>
    fetchPrice(async () => ({ ok: true, text: async () => ' {"42":{"success":false}}' }), w)
  );
});
test('watcher coalesces checks, persists failures and keeps last valid price', async () => {
  let calls = 0,
    saves = 0,
    resolve;
  const entries = [{ current: p(25) }],
    watcher = new PriceWatcher(
      entries,
      async () => {
        calls++;
        await new Promise(r => (resolve = r));
        throw Error('HTTP 403');
      },
      () => saves++
    );
  const a = watcher.check(),
    b = watcher.check();
  resolve();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(saves, 1);
  assert.equal(entries[0].current.amount, 25);
  assert.equal(entries[0].error, 'HTTP 403');
});
test('removing a watch while request is pending cannot resurrect it or notify', async () => {
  let resolve,
    notifications = 0;
  const entries = [{ current: p(20) }],
    watcher = new PriceWatcher(
      entries,
      () => new Promise(r => (resolve = r)),
      () => {},
      () => notifications++
    );
  const task = watcher.check();
  entries.splice(0, 1);
  resolve(p(10));
  await task;
  assert.equal(entries.length, 0);
  assert.equal(notifications, 0);
});
