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

test('netflix retail keeps +40% markup over reseller', () => {
  const data = {};
  const reseller = getResellerCatalog(data);
  const retail = mergeRetailPriceCatalog(data);
  const sampleKey = 'netflix__1user__1m';
  assert.equal(reseller.prices[sampleKey], 1.5);
  assert.equal(retail.prices[sampleKey], Math.round(1.5 * RETAIL_MARKUP * 100) / 100);
});

test('non-netflix retail uses Lebanon official prices', () => {
  const data = {};
  const retail = mergeRetailPriceCatalog(data);
  assert.equal(retail.prices['spotify__0'], 5.49);
  assert.equal(retail.prices['anghami__3'], 4.99);
  assert.equal(retail.prices['disney__1user__1m'], 4.49);
  assert.equal(retail.prices['shahid__1user__1m'], 13.99);
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
  assert.equal(retailPrice, 5.49);
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

test('stale retailPriceCatalog overrides are ignored until migrated', () => {
  const {
    mergeRetailPriceCatalog,
    clearStaleRetailPriceCatalog,
    RETAIL_PRICE_CATALOG_KEY
  } = require('../priceCatalog');
  const data = {
    [RETAIL_PRICE_CATALOG_KEY]: {
      prices: { 'spotify__0': 99.99 },
      updatedAt: Date.now()
    }
  };
  assert.equal(mergeRetailPriceCatalog(data).prices['spotify__0'], 5.49);
  assert.equal(clearStaleRetailPriceCatalog(data), true);
  assert.equal(data[RETAIL_PRICE_CATALOG_KEY], undefined);
});

test('versioned retail overrides still apply', () => {
  const { mergeRetailPriceCatalog, RETAIL_PRICE_CATALOG_KEY, RETAIL_DEFAULTS_VERSION } = require('../priceCatalog');
  const data = {
    [RETAIL_PRICE_CATALOG_KEY]: {
      defaultsVersion: RETAIL_DEFAULTS_VERSION,
      prices: { 'spotify__0': 6.99 }
    }
  };
  assert.equal(mergeRetailPriceCatalog(data).prices['spotify__0'], 6.99);
});
