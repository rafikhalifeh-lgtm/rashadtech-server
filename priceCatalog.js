const PRICE_CATALOG_KEY = 'priceCatalog';

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

const SIMPLE_PLAN_PRODUCTS = [
  { id: 'disney', plans: [7, 18, 60] },
  { id: 'amazon', plans: [3, 10] },
  { id: 'anghami', plans: [4, 8, 15] },
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
  { id: 'canva', plans: [3, 8, 25] },
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
  DEFAULT_PRICE_CATALOG,
  buildDefaultPriceCatalog,
  mergePriceCatalog,
  getMergedCatalog,
  resolvePurchasePrice,
  computeJawakerPrice,
  pricesMatch,
  buildCatalogPayload,
  stockKey,
  sanitizeNumberMap,
  countCustomPriceDeltas,
  reconstructCatalogFromChangeLog
};
