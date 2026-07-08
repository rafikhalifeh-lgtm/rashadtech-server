const PRICE_CATALOG_KEY = 'priceCatalog';
const RETAIL_PRICE_CATALOG_KEY = 'retailPriceCatalog';
const RETAIL_MARKUP = 1.4;

const DURATIONS_NF_1U = [
  { key: '1m', price: 1.5 },
  { key: '3m', price: 5.4 },
  { key: '6m', price: 10 },
  { key: '1y', price: 18 }
];
const DURATIONS_SH_1U = [
  { key: '1m', price: 1.5 },
  { key: '3m', price: 2.4 },
  { key: '1y', price: 10 }
];
const DURATIONS_SH_FULL = [
  { key: '1m', price: 5 },
  { key: '3m', price: 11.5 },
  { key: '1y', price: 33 }
];
const DURATIONS_DISNEY_1U = [
  { key: '1m', price: 2 },
  { key: '3m', price: 5 },
  { key: '1y', price: 15 }
];
const DURATIONS_DISNEY_FULL = [
  { key: '1m', price: 9.5 },
  { key: '3m', price: 27 },
  { key: '1y', price: 90 }
];
const DURATIONS_AMAZON_1U = [{ key: '1m', price: 2 }];
const DURATIONS_AMAZON_FULL = [{ key: '1m', price: 6 }];
const DURATIONS_CANVA = [
  { key: '1m', price: 2 },
  { key: '3m', price: 5 }
];

const SIMPLE_PLAN_PRODUCTS = [
  { id: 'anghami', plans: [4, 8, 15, 2] },
  { id: 'spotify', plans: [4, 10, 18] },
  { id: 'appletv', plans: [3, 8, 25] },
  { id: 'hbomax', plans: [4, 11, 35] },
  { id: 'paramount', plans: [3, 8, 25] },
  { id: 'crunchyroll', plans: [3, 8, 25] },
  { id: 'bein', plans: [8, 22, 75] },
  { id: 'starzplay', plans: [3, 8, 25] },
  { id: 'jawwytv', plans: [4, 11, 35] },
  { id: 'weyyak', plans: [3, 8, 25] },
  { id: 'rotana', plans: [3, 8, 25] },
  { id: 'deezer', plans: [3, 8, 25] },
  { id: 'tidal', plans: [4, 11, 35] },
  { id: 'ytmusic', plans: [4, 10, 30] },
  { id: 'pubg', plans: [1, 5, 10, 25, 50] },
  { id: 'xbox', plans: [5, 13, 24] },
  { id: 'psplus', plans: [4, 11, 35] },
  { id: 'ytpremium', plans: [4, 10, 35] },
  { id: 'chatgpt', plans: [5, 13, 45] },
  { id: 'linkedin', plans: [6, 16, 55] },
  { id: 'watchit', plans: [3, 8, 25] },
  { id: 'roblox', plans: [5, 10, 20, 50, 100] },
  { id: 'freefire', plans: [1, 3, 5, 10, 20, 50] }
];

const GIFT_CARD_REGION_AMOUNTS = {
  us: [{ key: '10', price: 10.5 }, { key: '25', price: 26 }, { key: '50', price: 52 }, { key: '100', price: 104 }],
  uae: [{ key: '50', price: 14 }, { key: '100', price: 28 }, { key: '200', price: 55 }, { key: '500', price: 135 }],
  ksa: [{ key: '50', price: 14 }, { key: '100', price: 27 }, { key: '200', price: 54 }, { key: '500', price: 133 }],
  eg: [{ key: '200', price: 4 }, { key: '500', price: 10 }, { key: '1000', price: 20 }],
  uk: [{ key: '10', price: 13 }, { key: '25', price: 32 }, { key: '50', price: 63 }],
  eu: [{ key: '10', price: 11 }, { key: '25', price: 27 }, { key: '50', price: 54 }]
};

const GIFT_CARD_PRODUCTS = ['itunes', 'googleplay'];

function stockKey(productId, userTypeKey, durationOrPlanKey) {
  return userTypeKey ? `${productId}__${userTypeKey}__${durationOrPlanKey}` : `${productId}__${durationOrPlanKey}`;
}

function buildDefaultPriceCatalog() {
  const prices = {};
  const customDayRates = { 'netflix__1user': 0.06 };

  DURATIONS_NF_1U.forEach(d => {
    prices[stockKey('netflix', '1user', d.key)] = d.price;
  });
  for (let i = 1; i <= 12; i += 1) {
    prices[stockKey('netflix', 'full', `${i}m`)] = i * 7;
  }

  DURATIONS_SH_1U.forEach(d => {
    prices[stockKey('shahid', '1user', d.key)] = d.price;
  });
  DURATIONS_SH_FULL.forEach(d => {
    prices[stockKey('shahid', 'full', d.key)] = d.price;
  });

  DURATIONS_DISNEY_1U.forEach(d => {
    prices[stockKey('disney', '1user', d.key)] = d.price;
  });
  DURATIONS_DISNEY_FULL.forEach(d => {
    prices[stockKey('disney', 'full', d.key)] = d.price;
  });

  DURATIONS_AMAZON_1U.forEach(d => {
    prices[stockKey('amazon', '1user', d.key)] = d.price;
  });
  DURATIONS_AMAZON_FULL.forEach(d => {
    prices[stockKey('amazon', 'full', d.key)] = d.price;
  });

  DURATIONS_CANVA.forEach(d => {
    prices[stockKey('canva', 'own', d.key)] = d.price;
    prices[stockKey('canva', 'new', d.key)] = d.price;
  });

  prices[stockKey('osn', '1user', '1m')] = 2;
  prices[stockKey('osn', '1user', '1y')] = 20;
  prices[stockKey('osn', 'full', '1m')] = 8;
  prices[stockKey('osn', 'full', '1y')] = 80;

  SIMPLE_PLAN_PRODUCTS.forEach(product => {
    product.plans.forEach((price, index) => {
      prices[stockKey(product.id, null, index)] = price;
    });
  });

  GIFT_CARD_PRODUCTS.forEach(productId => {
    Object.entries(GIFT_CARD_REGION_AMOUNTS).forEach(([regionKey, amounts]) => {
      amounts.forEach(amt => {
        prices[stockKey(productId, regionKey, amt.key)] = amt.price;
      });
    });
  });

  return {
    prices,
    customDayRates,
    jawaker: {
      basePerToken: 1.5 / 12000,
      tiers: [
        { min: 500000, mult: 0.9 },
        { min: 100000, mult: 0.93 },
        { min: 50000, mult: 0.96 }
      ]
    }
  };
}

const DEFAULT_PRICE_CATALOG = buildDefaultPriceCatalog();

function sanitizeNumberMap(input) {
  const out = {};
  Object.entries(input || {}).forEach(([key, value]) => {
    const num = Number(value);
    if (!key || !Number.isFinite(num) || num < 0) return;
    out[String(key)] = Math.round(num * 10000) / 10000;
  });
  return out;
}

function sanitizeJawakerConfig(input) {
  const fallback = DEFAULT_PRICE_CATALOG.jawaker;
  const basePerToken = Number(input && input.basePerToken);
  const tiers = Array.isArray(input && input.tiers) ? input.tiers : fallback.tiers;
  return {
    basePerToken: Number.isFinite(basePerToken) && basePerToken > 0 ? basePerToken : fallback.basePerToken,
    tiers: tiers
      .map(tier => ({ min: Number(tier.min), mult: Number(tier.mult) }))
      .filter(tier => Number.isFinite(tier.min) && tier.min > 0 && Number.isFinite(tier.mult) && tier.mult > 0 && tier.mult <= 1)
      .sort((a, b) => b.min - a.min)
  };
}

function mergePriceCatalog(stored) {
  const storedPrices = stored && stored.prices ? stored.prices : {};
  const storedRates = stored && stored.customDayRates ? stored.customDayRates : {};
  return {
    prices: { ...DEFAULT_PRICE_CATALOG.prices, ...storedPrices },
    customDayRates: { ...DEFAULT_PRICE_CATALOG.customDayRates, ...storedRates },
    jawaker: {
      ...DEFAULT_PRICE_CATALOG.jawaker,
      ...(stored && stored.jawaker ? sanitizeJawakerConfig(stored.jawaker) : {})
    },
    updatedAt: stored && stored.updatedAt ? stored.updatedAt : null,
    updatedBy: stored && stored.updatedBy ? stored.updatedBy : null
  };
}

function getMergedCatalog(data) {
  return mergePriceCatalog(data && data[PRICE_CATALOG_KEY]);
}

function getResellerCatalog(data) {
  return getMergedCatalog(data);
}

function roundRetailAmount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return num;
  const marked = num * RETAIL_MARKUP;
  if (marked < 0.01) return Math.round(marked * 1e6) / 1e6;
  return Math.round(marked * 100) / 100;
}

function roundUsd(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return num;
  return Math.round(num * 100) / 100;
}

function scaleFullFromOneUser(productId, durationKey, officialOneUser, resellerPrices) {
  const oneKey = stockKey(productId, '1user', durationKey);
  const fullKey = stockKey(productId, 'full', durationKey);
  const resellerOne = Number(resellerPrices[oneKey]);
  const resellerFull = Number(resellerPrices[fullKey]);
  if (!Number.isFinite(resellerOne) || resellerOne <= 0 || !Number.isFinite(resellerFull) || resellerFull <= 0) {
    return roundUsd(officialOneUser);
  }
  return roundUsd(officialOneUser * (resellerFull / resellerOne));
}

function addSimplePlanPrices(prices, productId, monthlyUsd, durations) {
  durations.forEach((months, index) => {
    prices[stockKey(productId, null, index)] = roundUsd(monthlyUsd * months);
  });
}

/** Official Lebanon / MENA retail USD prices (Netflix excluded — uses reseller markup). */
function buildLebanonOfficialRetailPriceMap(resellerCatalog) {
  const resellerPrices = (resellerCatalog || DEFAULT_PRICE_CATALOG).prices || {};
  const prices = {};

  // Shahid VIP — official $13.99/mo (shahid.mbc.net)
  const shahid1m = 13.99;
  prices[stockKey('shahid', '1user', '1m')] = shahid1m;
  prices[stockKey('shahid', '1user', '3m')] = 39.99;
  prices[stockKey('shahid', '1user', '1y')] = 119.99;
  ['1m', '3m', '1y'].forEach(d => {
    prices[stockKey('shahid', 'full', d)] = scaleFullFromOneUser('shahid', d, prices[stockKey('shahid', '1user', d)], resellerPrices);
  });

  // OSN+ Standard — $9.99/mo, $89.99/yr (MENA official)
  const osn1m = 9.99;
  const osn1y = 89.99;
  prices[stockKey('osn', '1user', '1m')] = osn1m;
  prices[stockKey('osn', '1user', '1y')] = osn1y;
  prices[stockKey('osn', 'full', '1m')] = scaleFullFromOneUser('osn', '1m', osn1m, resellerPrices);
  prices[stockKey('osn', 'full', '1y')] = scaleFullFromOneUser('osn', '1y', osn1y, resellerPrices);

  // Disney+ Lebanon — $4.49/mo, $43.99/yr (Disney press)
  const disney1m = 4.49;
  const disney1y = 43.99;
  prices[stockKey('disney', '1user', '1m')] = disney1m;
  prices[stockKey('disney', '1user', '3m')] = roundUsd(disney1m * 3);
  prices[stockKey('disney', '1user', '1y')] = disney1y;
  ['1m', '3m', '1y'].forEach(d => {
    prices[stockKey('disney', 'full', d)] = scaleFullFromOneUser('disney', d, prices[stockKey('disney', '1user', d)], resellerPrices);
  });

  // Amazon Prime Video — ~$5.99/mo MENA standalone
  const amazon1m = 5.99;
  prices[stockKey('amazon', '1user', '1m')] = amazon1m;
  prices[stockKey('amazon', 'full', '1m')] = scaleFullFromOneUser('amazon', '1m', amazon1m, resellerPrices);

  // Canva Pro — $15/mo, $120/yr global official
  const canva1m = 15;
  const canva3m = 45;
  ['own', 'new'].forEach(type => {
    prices[stockKey('canva', type, '1m')] = canva1m;
    prices[stockKey('canva', type, '3m')] = canva3m;
  });

  // Anghami+ Lebanon — support.anghami.com
  prices[stockKey('anghami', null, 3)] = 4.99;
  prices[stockKey('anghami', null, 0)] = 14.99;
  prices[stockKey('anghami', null, 1)] = 24.99;
  prices[stockKey('anghami', null, 2)] = 49.9;

  // Spotify Lebanon — $5.49/mo
  addSimplePlanPrices(prices, 'spotify', 5.49, [1, 3, 6]);

  // Apple TV+ Lebanon — $6.99/mo
  addSimplePlanPrices(prices, 'appletv', 6.99, [1, 3, 12]);

  // YouTube Premium Lebanon — $6/mo individual
  addSimplePlanPrices(prices, 'ytpremium', 6, [1, 3, 12]);

  // YouTube Music Lebanon — $5/mo
  addSimplePlanPrices(prices, 'ytmusic', 5, [1, 3, 12]);

  // Global official USD for services without Lebanon-specific tiers
  addSimplePlanPrices(prices, 'hbomax', 16.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'paramount', 7.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'crunchyroll', 7.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'bein', 14.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'starzplay', 7.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'jawwytv', 7.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'weyyak', 4.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'rotana', 4.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'deezer', 10.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'tidal', 10.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'watchit', 3.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'chatgpt', 20, [1, 3, 12]);
  addSimplePlanPrices(prices, 'linkedin', 29.99, [1, 3, 12]);
  addSimplePlanPrices(prices, 'xbox', 19.99, [1, 3, 6]);
  addSimplePlanPrices(prices, 'psplus', 9.99, [1, 3, 12]);

  // In-game currency — App Store / Play official USD pack prices
  prices[stockKey('pubg', null, 0)] = 0.99;
  prices[stockKey('pubg', null, 1)] = 4.99;
  prices[stockKey('pubg', null, 2)] = 9.99;
  prices[stockKey('pubg', null, 3)] = 24.99;
  prices[stockKey('pubg', null, 4)] = 49.99;
  prices[stockKey('roblox', null, 0)] = 4.99;
  prices[stockKey('roblox', null, 1)] = 9.99;
  prices[stockKey('roblox', null, 2)] = 19.99;
  prices[stockKey('roblox', null, 3)] = 49.99;
  prices[stockKey('roblox', null, 4)] = 99.99;
  prices[stockKey('freefire', null, 0)] = 0.99;
  prices[stockKey('freefire', null, 1)] = 2.99;
  prices[stockKey('freefire', null, 2)] = 4.99;
  prices[stockKey('freefire', null, 3)] = 9.99;
  prices[stockKey('freefire', null, 4)] = 19.99;
  prices[stockKey('freefire', null, 5)] = 49.99;

  // Gift cards — face-value retail (USD regions) or local denomination equivalent
  const giftFaceUsd = {
    us: { 10: 10, 25: 25, 50: 50, 100: 100 },
    uae: { 50: 13.61, 100: 27.23, 200: 54.46, 500: 136.15 },
    ksa: { 50: 13.33, 100: 26.67, 200: 53.33, 500: 133.33 },
    eg: { 200: 4.08, 500: 10.2, 1000: 20.41 },
    uk: { 10: 12.66, 25: 31.65, 50: 63.29 },
    eu: { 10: 10.87, 25: 27.17, 50: 54.35 }
  };
  GIFT_CARD_PRODUCTS.forEach(productId => {
    Object.entries(giftFaceUsd).forEach(([regionKey, amounts]) => {
      Object.entries(amounts).forEach(([denom, faceUsd]) => {
        prices[stockKey(productId, regionKey, denom)] = roundUsd(faceUsd);
      });
    });
  });

  return prices;
}

function isNetflixPriceKey(key) {
  return String(key).startsWith('netflix');
}

function buildRetailDefaultsFromReseller(resellerCatalog) {
  const base = resellerCatalog || DEFAULT_PRICE_CATALOG;
  const officialLb = buildLebanonOfficialRetailPriceMap(base);
  const prices = {};
  Object.entries(base.prices || {}).forEach(([key, value]) => {
    if (isNetflixPriceKey(key)) {
      prices[key] = roundRetailAmount(value);
    } else if (officialLb[key] != null) {
      prices[key] = officialLb[key];
    } else {
      prices[key] = roundRetailAmount(value);
    }
  });
  const customDayRates = {};
  Object.entries(base.customDayRates || {}).forEach(([key, value]) => {
    customDayRates[key] = roundRetailAmount(value);
  });
  const jawaker = base.jawaker || DEFAULT_PRICE_CATALOG.jawaker;
  return {
    prices,
    customDayRates,
    jawaker: {
      ...jawaker,
      basePerToken: roundRetailAmount(jawaker.basePerToken)
    }
  };
}

function mergeRetailPriceCatalog(data) {
  const reseller = getResellerCatalog(data);
  const defaults = buildRetailDefaultsFromReseller(reseller);
  const stored = data && data[RETAIL_PRICE_CATALOG_KEY] ? data[RETAIL_PRICE_CATALOG_KEY] : {};
  const storedPrices = stored.prices || {};
  const storedRates = stored.customDayRates || {};
  return {
    prices: { ...defaults.prices, ...sanitizeNumberMap(storedPrices) },
    customDayRates: { ...defaults.customDayRates, ...sanitizeNumberMap(storedRates) },
    jawaker: {
      ...defaults.jawaker,
      ...(stored.jawaker ? sanitizeJawakerConfig(stored.jawaker) : {})
    },
    updatedAt: stored.updatedAt || null,
    updatedBy: stored.updatedBy || null,
    tier: 'retail'
  };
}

function getCatalogForUser(data, user) {
  if (userIsReseller(user)) {
    const catalog = getResellerCatalog(data);
    return { ...catalog, tier: 'reseller' };
  }
  return mergeRetailPriceCatalog(data);
}

function userIsReseller(user) {
  if (!user) return false;
  if (user.isReseller === true) return true;
  if (user.isReseller === false) return false;
  return true;
}

function computeJawakerPrice(catalog, tokens) {
  const amount = Number(tokens);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const jawaker = (catalog && catalog.jawaker) || DEFAULT_PRICE_CATALOG.jawaker;
  let price = amount * jawaker.basePerToken;
  for (const tier of jawaker.tiers || []) {
    if (amount >= tier.min) {
      price *= tier.mult;
      break;
    }
  }
  return Math.round(price * 100) / 100;
}

function resolvePurchasePrice(catalog, { skey, customDays }) {
  const days = Number(customDays || 0);
  if (days > 0 && skey) {
    const parts = String(skey).split('__');
    if (parts.length >= 3) {
      const rateKey = `${parts[0]}__${parts[1]}`;
      const rate = catalog.customDayRates[rateKey];
      if (Number.isFinite(rate) && rate > 0) {
        return Math.round(days * rate * 100) / 100;
      }
    }
  }
  if (skey && catalog.prices[skey] != null) {
    return Number(catalog.prices[skey]);
  }
  return null;
}

function pricesMatch(expected, actual) {
  return Math.abs(Number(expected) - Number(actual)) < 0.02;
}

function buildCatalogPayload(input) {
  const prices = sanitizeNumberMap(input && input.prices);
  const customDayRates = sanitizeNumberMap(input && input.customDayRates);
  const jawaker = sanitizeJawakerConfig(input && input.jawaker);
  return { prices, customDayRates, jawaker };
}

function countCustomPriceDeltas(catalog) {
  const merged = mergePriceCatalog(catalog);
  let score = 0;
  Object.entries(merged.prices || {}).forEach(([key, value]) => {
    if (DEFAULT_PRICE_CATALOG.prices[key] !== value) score += 1;
  });
  Object.entries(merged.customDayRates || {}).forEach(([key, value]) => {
    if (DEFAULT_PRICE_CATALOG.customDayRates[key] !== value) score += 1;
  });
  const mergedJaw = merged.jawaker || {};
  const defaultJaw = DEFAULT_PRICE_CATALOG.jawaker || {};
  if (Number(mergedJaw.basePerToken) !== Number(defaultJaw.basePerToken)) score += 1;
  (mergedJaw.tiers || []).forEach((tier, index) => {
    const base = (defaultJaw.tiers || [])[index];
    if (!base || Number(base.mult) !== Number(tier.mult)) score += 1;
  });
  return score;
}

function sparseCatalogFromMerged(merged) {
  const prices = {};
  Object.entries(merged.prices || {}).forEach(([key, value]) => {
    if (DEFAULT_PRICE_CATALOG.prices[key] !== value) prices[key] = value;
  });
  const customDayRates = {};
  Object.entries(merged.customDayRates || {}).forEach(([key, value]) => {
    if (DEFAULT_PRICE_CATALOG.customDayRates[key] !== value) customDayRates[key] = value;
  });
  const jawaker = sanitizeJawakerConfig(merged.jawaker);
  const hasJawakerDelta = Number(jawaker.basePerToken) !== Number(DEFAULT_PRICE_CATALOG.jawaker.basePerToken)
    || JSON.stringify(jawaker.tiers) !== JSON.stringify(DEFAULT_PRICE_CATALOG.jawaker.tiers);
  return {
    prices,
    customDayRates,
    jawaker: hasJawakerDelta ? jawaker : DEFAULT_PRICE_CATALOG.jawaker
  };
}

function reconstructCatalogFromChangeLog(data) {
  const log = Array.isArray(data && data.priceChangeLog) ? data.priceChangeLog : [];
  if (!log.length) return null;

  const merged = mergePriceCatalog(null);
  const entries = [...log].reverse();
  entries.forEach(entry => {
    (entry.changes || []).forEach(change => {
      if (!change || change.new == null || !change.key) return;
      const key = String(change.key);
      const value = Number(change.new);
      if (!Number.isFinite(value)) return;
      if (key.endsWith(' (per day)')) {
        merged.customDayRates[key.replace(' (per day)', '')] = value;
      } else if (key === 'jawaker (per 12k tokens)') {
        merged.jawaker = { ...merged.jawaker, basePerToken: value / 12000 };
      } else {
        merged.prices[key] = value;
      }
    });
  });

  const sparse = sparseCatalogFromMerged(merged);
  if (!Object.keys(sparse.prices).length
    && !Object.keys(sparse.customDayRates).length
    && Number(sparse.jawaker.basePerToken) === Number(DEFAULT_PRICE_CATALOG.jawaker.basePerToken)
    && JSON.stringify(sparse.jawaker.tiers) === JSON.stringify(DEFAULT_PRICE_CATALOG.jawaker.tiers)) {
    return null;
  }

  return {
    ...sparse,
    updatedAt: Number(log[0] && log[0].ts) || Date.now(),
    updatedBy: 'recovered-from-log'
  };
}

module.exports = {
  PRICE_CATALOG_KEY,
  RETAIL_PRICE_CATALOG_KEY,
  RETAIL_MARKUP,
  DEFAULT_PRICE_CATALOG,
  buildDefaultPriceCatalog,
  mergePriceCatalog,
  getMergedCatalog,
  getResellerCatalog,
  mergeRetailPriceCatalog,
  getCatalogForUser,
  userIsReseller,
  roundRetailAmount,
  buildRetailDefaultsFromReseller,
  buildLebanonOfficialRetailPriceMap,
  resolvePurchasePrice,
  computeJawakerPrice,
  pricesMatch,
  buildCatalogPayload,
  stockKey,
  sanitizeNumberMap,
  countCustomPriceDeltas,
  reconstructCatalogFromChangeLog
};
