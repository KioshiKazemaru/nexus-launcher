const test = require('node:test'),
  assert = require('node:assert/strict');
const { bestOffer } = require('../src/compare.cjs');

test('cheapest store is chosen only between comparable prices', () => {
  const steam = { provider: 'steam', amount: 999, currency: 'RUB' },
    epic = { provider: 'epic', amount: 799, currency: 'RUB' };
  assert.deepEqual(bestOffer([steam, epic]), { provider: 'epic', amount: 799, currency: 'RUB', saving: 200 });
  assert.equal(bestOffer([steam, { ...epic, currency: 'USD' }]), null);
  assert.equal(bestOffer([steam]), null);
  assert.equal(bestOffer([steam, { ...epic, amount: null }]), null);
  assert.equal(bestOffer([steam, { ...epic, amount: 999 }]).equal, true);
  assert.equal(bestOffer([steam, { ...epic, priceStatus: 'error' }]), null);
});
