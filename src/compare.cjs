'use strict';
// "Где дешевле": the cheapest of several store offers in the same currency.
const usable = o =>
  Number.isFinite(o?.amount) &&
  o.amount >= 0 &&
  /^[A-Z]{3}$/.test(o.currency || '') &&
  o.priceStatus !== 'error';

function bestOffer(offers) {
  const priced = (offers || []).filter(usable);
  if (priced.length < 2 || new Set(priced.map(o => o.currency)).size !== 1) return null;
  const sorted = [...priced].sort((a, b) => a.amount - b.amount);
  if (sorted[0].amount === sorted[1].amount)
    return { provider: null, equal: true, amount: sorted[0].amount, currency: sorted[0].currency };
  return {
    provider: sorted[0].provider,
    amount: sorted[0].amount,
    currency: sorted[0].currency,
    saving: Math.round((sorted[1].amount - sorted[0].amount) * 100) / 100,
  };
}
module.exports = { bestOffer };
