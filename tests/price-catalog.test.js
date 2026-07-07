const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getResellerCatalog,
  mergeRetailPriceCatalog,
  getCatalogForUser,
  userIsReseller,
  resolvePurchasePrice,
  computeJawakerPrice,
  pricesMatch,
  RETAIL_MARKUP
} = require('../priceCatalog');

test('legacy users without isReseller are treated as resellers', () => {
  assert.equal(userIsReseller({ email: 'a@b.com' }), true);
  assert.equal(userIsReseller({ email: 'a@b.com', isReseller: false }), false);
  assert.equal(userIsReseller({ email: 'a@b.com', isReseller: true }), true);
});

test('retail catalog defaults to markup over reseller prices', () => {
  const data = {};
  const reseller = getResellerCatalog(data);
  const retail = mergeRetailPriceCatalog(data);
  const sampleKey = 'netflix__1user__1m';
  assert.equal(reseller.prices[sampleKey], 1.5);
  assert.equal(retail.prices[sampleKey], Math.round(1.5 * RETAIL_MARKUP * 100) / 100);
});

test('purchase price resolves per user tier', () => {
  const data = {};
  const skey = 'spotify__0';
  const resellerUser = { isReseller: true };
  const retailUser = { isReseller: false };
  const resellerCatalog = getCatalogForUser(data, resellerUser);
  const retailCatalog = getCatalogForUser(data, retailUser);
  const resellerPrice = resolvePurchasePrice(resellerCatalog, { skey });
  const retailPrice = resolvePurchasePrice(retailCatalog, { skey });
  assert.ok(retailPrice > resellerPrice);
  assert.ok(pricesMatch(resellerPrice, resellerPrice));
});

test('jawaker retail price uses marked-up base rate', () => {
  const data = {};
  const resellerCatalog = getCatalogForUser(data, { isReseller: true });
  const retailCatalog = getCatalogForUser(data, { isReseller: false });
  const tokens = 12000;
  const resellerPrice = computeJawakerPrice(resellerCatalog, tokens);
  const retailPrice = computeJawakerPrice(retailCatalog, tokens);
  assert.ok(retailPrice > resellerPrice);
});
