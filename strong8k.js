const DEFAULT_PLANS = [
  { months: 1, name: '1 Month', sellPrice: 8 },
  { months: 3, name: '3 Months', sellPrice: 20 },
  { months: 6, name: '6 Months', sellPrice: 35 },
  { months: 12, name: '12 Months', sellPrice: 60 }
];

const IPTV_REGIONS = {
  me: { id: 'me', name: 'Middle East', packId: 'all' },
  eu: { id: 'eu', name: 'Europe', packId: 'all' },
  us: { id: 'us', name: 'United States', packId: 'all' }
};

const TRIAL_SUB_CODE = 99;
const TRIAL_SUB_CODES = [99, 1, 0];
const TRIAL_MIN_PANEL_CREDITS = 12;
const PANEL_REQUEST_TIMEOUT_MS = 60000;
const PANEL_REQUEST_RETRIES = 2;
const MAX_TRIAL_PACK_ATTEMPTS = 3;
const MAX_TRIAL_PANEL_CALLS = 18;
const OMIT_PANEL_PACK = '__OMIT_PACK__';
const DURATION_MONTHS = [1, 3, 6, 12];

const PACKAGE_PRICE_DEFAULTS = {
  full: { 1: 8, 3: 20, 6: 35, 12: 60 },
  streaming: { 1: 4, 3: 10, 6: 18, 12: 32 },
  bein: { 1: 5, 3: 13, 6: 22, 12: 38 }
};

const DEFAULT_SELL_PACKAGES = [
  {
    id: 'full',
    name: 'Full Package',
    desc: 'All channels for your region — sports, movies, Arabic & more',
    bouquetIds: '',
    bouquetIdsByRegion: { me: '75605', eu: '75604', us: '75606' },
    prices: { ...PACKAGE_PRICE_DEFAULTS.full },
    exclusive: true,
    enabled: true
  },
  { id: 'streaming', name: 'Streaming', desc: 'Netflix · Shahid · Amazon · Disney+ style apps', bouquetIds: '75609', prices: { ...PACKAGE_PRICE_DEFAULTS.streaming }, exclusive: false, enabled: true },
  { id: 'bein', name: 'beIN Sports + World Cup', desc: 'beIN Sports · TOD · World Cup 2026 · live football', bouquetIds: '75610', prices: { ...PACKAGE_PRICE_DEFAULTS.bein }, exclusive: false, enabled: true }
];

const FULL_PACKAGE_REGION_BOUQUETS = { me: '75605', eu: '75604', us: '75606' };
const IPTV_TRIAL_REGIONS = new Set(['me', 'us']);
const TRIAL_REGION_PRIMARY_COUNTRY = { me: 'LB', us: 'US' };
const RETIRED_SELL_PACKAGE_IDS = new Set(['lebanese']);

function isRetiredSellPackage(pkg) {
  const id = String(pkg && pkg.id || '').trim().toLowerCase();
  const name = String(pkg && pkg.name || '').trim();
  if (RETIRED_SELL_PACKAGE_IDS.has(id)) return true;
  return /lebanese/i.test(name);
}

function filterRetiredSellPackages(packages) {
  return (Array.isArray(packages) ? packages : []).filter(pkg => !isRetiredSellPackage(pkg));
}

function defaultBouquetIdsByRegionForPackage(packageId) {
  if (String(packageId || '').toLowerCase() === 'full') return { ...FULL_PACKAGE_REGION_BOUQUETS };
  return {};
}

function defaultStrong8kConfig() {
  return {
    enabled: false,
    storeEnabled: false,
    panelUrl: '',
    apiKey: '',
    packageId: 'all',
    trialEnabled: true,
    regions: { ...IPTV_REGIONS },
    plans: DEFAULT_PLANS.map(p => ({ ...p })),
    sellPackages: DEFAULT_SELL_PACKAGES.map(p => ({ ...p }))
  };
}

function normalizePanelUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  if (/\/api\/api\.php$/i.test(url)) return url;
  if (/\/api\.php$/i.test(url)) return url;
  return `${url}/api/api.php`;
}

function formatPanelUrlForDisplay(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/api\/api\.php$/i, '');
  url = url.replace(/\/api\.php$/i, '');
  return url;
}

function resolveApiKey(config) {
  return String(process.env.STRONG8K_API_KEY || (config && config.apiKey) || '').trim();
}

function sanitizeRegionPackId(raw, fallback) {
  const value = String(raw || fallback || 'all').trim() || 'all';
  if (isWildcardPack(value)) return value;
  return firstBouquetId(value) || value;
}

function sanitizeRegions(raw) {
  const base = defaultStrong8kConfig().regions;
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  Object.keys(IPTV_REGIONS).forEach(key => {
    const row = input[key] && typeof input[key] === 'object' ? input[key] : {};
    out[key] = {
      id: key,
      name: String(row.name || base[key].name).trim().slice(0, 40) || base[key].name,
      packId: sanitizeRegionPackId(row.packId, base[key].packId)
    };
  });
  return out;
}

function sanitizePlans(plans) {
  const list = Array.isArray(plans) ? plans : DEFAULT_PLANS;
  return list
    .map((plan, index) => {
      const months = Number(plan.months);
      const sellPrice = Number(plan.sellPrice);
      return {
        months: [1, 3, 6, 12].includes(months) ? months : DEFAULT_PLANS[index]?.months || 1,
        name: String(plan.name || DEFAULT_PLANS[index]?.name || `${months} Month`).trim().slice(0, 40),
        sellPrice: Number.isFinite(sellPrice) && sellPrice > 0 ? Math.round(sellPrice * 100) / 100 : (DEFAULT_PLANS[index]?.sellPrice || 8)
      };
    })
    .filter(plan => plan.months > 0)
    .slice(0, 4);
}

function slugifySellPackageId(raw, fallback) {
  const base = String(raw || fallback || 'package').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'package';
}

function sanitizeBouquetIdsByRegion(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  ['me', 'eu', 'us'].forEach(key => {
    const value = String(input[key] || '').trim();
    if (!value) return;
    out[key] = isWildcardPack(value) ? value : (firstBouquetId(value) || value);
  });
  return out;
}

function sanitizePackagePrices(row, fallbackId, fallbackMonthly) {
  const defaults = PACKAGE_PRICE_DEFAULTS[fallbackId] || {};
  const input = row && (row.prices || row.durationPrices);
  const monthly = Number(row && row.monthlyPrice);
  const out = {};
  DURATION_MONTHS.forEach(m => {
    const raw = input && (input[m] ?? input[String(m)]);
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) {
      out[m] = Math.round(v * 100) / 100;
    } else if (defaults[m] != null) {
      out[m] = defaults[m];
    } else if (Number.isFinite(monthly) && monthly > 0) {
      out[m] = Math.round(monthly * m * 100) / 100;
    } else if (Number.isFinite(fallbackMonthly) && fallbackMonthly > 0) {
      out[m] = Math.round(fallbackMonthly * m * 100) / 100;
    } else {
      out[m] = 0;
    }
  });
  return out;
}

function sanitizeSellPackageRow(row, index, seen) {
  const fallback = DEFAULT_SELL_PACKAGES[index] || DEFAULT_SELL_PACKAGES[0];
  const id = slugifySellPackageId(row && row.id, fallback.id + '-' + (index + 1));
  const uniqueId = seen.has(id) ? `${id}-${index + 1}` : id;
  seen.add(uniqueId);
  const prices = sanitizePackagePrices(row, fallback.id, fallback.prices && fallback.prices[1]);
  const defaultByRegion = defaultBouquetIdsByRegionForPackage(fallback.id);
  const byRegion = sanitizeBouquetIdsByRegion(row && row.bouquetIdsByRegion);
  return {
    id: uniqueId,
    name: String(row && row.name || fallback.name).trim().slice(0, 48) || fallback.name,
    desc: String(row && row.desc || fallback.desc || '').trim().slice(0, 160),
    bouquetIds: String(row && row.bouquetIds || fallback.bouquetIds || '').trim(),
    bouquetIdsByRegion: { ...defaultByRegion, ...byRegion },
    prices,
    monthlyPrice: prices[1] || 0,
    exclusive: Boolean(row && row.exclusive),
    enabled: row && row.enabled === false ? false : true
  };
}

function mergeMissingDefaultSellPackages(packages) {
  const out = Array.isArray(packages) ? packages.map(pkg => ({ ...pkg })) : [];
  const seen = new Set(out.map(pkg => String(pkg.id || '').toLowerCase()));
  DEFAULT_SELL_PACKAGES.forEach((defaultPkg, index) => {
    if (seen.has(defaultPkg.id)) return;
    const seenForRow = new Set(out.map(pkg => pkg.id));
    out.push(sanitizeSellPackageRow(defaultPkg, index, seenForRow));
    seen.add(defaultPkg.id);
  });
  const order = new Map(DEFAULT_SELL_PACKAGES.map((pkg, index) => [pkg.id, index]));
  out.sort((a, b) => {
    const ai = order.has(a.id) ? order.get(a.id) : 99;
    const bi = order.has(b.id) ? order.get(b.id) : 99;
    return ai - bi;
  });
  return out.slice(0, 12);
}

function sanitizeSellPackages(raw) {
  const input = Array.isArray(raw) && raw.length ? raw : DEFAULT_SELL_PACKAGES;
  const list = filterRetiredSellPackages(input);
  const seen = new Set();
  const sanitized = list.map((row, index) => sanitizeSellPackageRow(row, index, seen))
    .filter(pkg => pkg.name);
  return mergeMissingDefaultSellPackages(sanitized);
}

function getEnabledSellPackages(config) {
  return sanitizeSellPackages(config && config.sellPackages).filter(pkg => pkg.enabled);
}

function normalizeSellPackageIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  raw.forEach(item => {
    const id = String(item || '').trim().toLowerCase();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

function resolveSelectedSellPackages(packageIds, config) {
  const ids = normalizeSellPackageIds(packageIds);
  const packages = getEnabledSellPackages(config);
  if (!ids.length) return [];
  return packages.filter(pkg => ids.includes(pkg.id));
}

function getSellPackagePriceForMonths(pkg, months) {
  const m = Number(months);
  if (!DURATION_MONTHS.includes(m)) return 0;
  const prices = pkg && pkg.prices ? pkg.prices : {};
  const direct = Number(prices[m]);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const monthly = Number(pkg && pkg.monthlyPrice);
  if (Number.isFinite(monthly) && monthly > 0) return Math.round(monthly * m * 100) / 100;
  return 0;
}

function computeSellPackageMonthlyTotal(packageIds, config) {
  return computeSellPackagePrice(packageIds, 1, config);
}

function computeSellPackagePrice(packageIds, months, config) {
  const m = Number(months);
  if (!DURATION_MONTHS.includes(m)) return 0;
  const selected = resolveSelectedSellPackages(packageIds, config);
  if (!selected.length) return 0;
  const exclusive = selected.find(pkg => pkg.exclusive);
  const list = exclusive ? [exclusive] : selected;
  const total = list.reduce((sum, pkg) => sum + getSellPackagePriceForMonths(pkg, m), 0);
  return Math.round(total * 100) / 100;
}

function resolveSellPackageBouquetIds(pkg, region, config) {
  const regionKey = String(region || 'me').toLowerCase();
  const byRegion = pkg.bouquetIdsByRegion && typeof pkg.bouquetIdsByRegion === 'object' ? pkg.bouquetIdsByRegion : {};
  const fromRegion = String(byRegion[regionKey] || '').trim();
  if (fromRegion) return fromRegion;
  const global = String(pkg.bouquetIds || '').trim();
  if (global) return global;
  if (pkg.exclusive && config) {
    const regionPack = resolveRegionPack(config, regionKey);
    if (!isWildcardPack(regionPack)) return regionPack;
  }
  return '';
}

function addBouquetIdsToSet(target, raw) {
  String(raw || '').split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .forEach(id => target.add(id));
}

function resolvePackFromSellPackages(packageIds, config, region) {
  const selected = resolveSelectedSellPackages(packageIds, config);
  if (!selected.length) return null;
  const regionKey = String(region || 'me').toLowerCase();
  const bouquetSet = new Set();
  selected.forEach(pkg => addBouquetIdsToSet(bouquetSet, resolveSellPackageBouquetIds(pkg, regionKey, config)));
  const joined = [...bouquetSet].join(',');
  return joined || null;
}

function firstBouquetId(raw) {
  const id = String(raw || '').split(',').map(part => part.trim()).filter(Boolean)[0];
  return id || '';
}

function matchBouquetNameForRegion(name, regionKey) {
  const n = String(name || '');
  const regionPatterns = {
    me: [/middle\s*east/i, /\bme\b/i, /\barab/i, /\bmena\b/i, /\blevant/i],
    eu: [/europe/i, /\beu\b/i, /\beuro/i, /\buk\b/i],
    us: [/united\s*states/i, /\busa\b/i, /\bus\b/i, /america/i]
  };
  return (regionPatterns[regionKey] || []).some(re => re.test(n));
}

function findBouquetForRegion(bouquets, regionKey, config, { preferFull = true } = {}) {
  const list = formatBouquetRows(bouquets);
  if (!list.length) return '';

  if (preferFull) {
    const fullRegional = list.find(b => /full/i.test(b.name) && matchBouquetNameForRegion(b.name, regionKey));
    if (fullRegional) return firstBouquetId(fullRegional.id);
  }

  const regional = list.find(b => matchBouquetNameForRegion(b.name, regionKey));
  if (regional) return firstBouquetId(regional.id);

  if (preferFull) {
    const full = list.find(b => /full/i.test(b.name));
    if (full) return firstBouquetId(full.id);
  }

  if (config) {
    const exclusive = getEnabledSellPackages(config).find(pkg => pkg.exclusive);
    const fromPkg = firstBouquetId(exclusive && exclusive.bouquetIdsByRegion && exclusive.bouquetIdsByRegion[regionKey]);
    if (fromPkg && list.some(b => b.id === fromPkg)) return fromPkg;
    const saved = firstBouquetId(resolveRegionPack(config, regionKey));
    if (saved && !isWildcardPack(saved) && list.some(b => b.id === saved)) return saved;
  }

  return '';
}

function findBouquetByNamePattern(bouquets, pattern) {
  const list = formatBouquetRows(bouquets);
  const hit = list.find(b => pattern.test(b.name || ''));
  return hit ? firstBouquetId(hit.id) : '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fixRegionBouquetSwap(meId, usId) {
  const me = String(meId || '').trim();
  const us = String(usId || '').trim();
  if (me === FULL_PACKAGE_REGION_BOUQUETS.us && us === FULL_PACKAGE_REGION_BOUQUETS.me) {
    return { meId: us, usId: me };
  }
  return { meId: me, usId: us };
}

function savedRegionBouquetId(cfg, regionKey) {
  const key = String(regionKey || 'me').toLowerCase();
  const exclusive = getEnabledSellPackages(cfg).find(pkg => pkg.exclusive);
  const fromPkg = firstBouquetId(exclusive && exclusive.bouquetIdsByRegion && exclusive.bouquetIdsByRegion[key]);
  if (fromPkg) return fromPkg;
  const fromRegion = firstBouquetId(resolveRegionPack(cfg, key));
  if (fromRegion && !isWildcardPack(fromRegion)) return fromRegion;
  return FULL_PACKAGE_REGION_BOUQUETS[key] || '';
}

function resolveRegionalBouquetIds(list, cfg) {
  const rows = formatBouquetRows(list);
  const ids = { me: '', eu: '', us: '' };
  ['me', 'eu', 'us'].forEach(key => {
    const saved = savedRegionBouquetId(cfg, key);
    if (saved && rows.some(b => b.id === saved)) {
      ids[key] = saved;
      return;
    }
    ids[key] = findBouquetForRegion(rows, key, cfg);
  });
  const fixed = fixRegionBouquetSwap(ids.me, ids.us);
  ids.me = fixed.meId;
  ids.us = fixed.usId;
  return ids;
}

function applyPanelBouquetsToConfig(config, bouquets) {
  const cfg = sanitizeStrong8kConfig(config);
  const list = formatBouquetRows(bouquets);
  if (!list.length) return cfg;

  const regional = resolveRegionalBouquetIds(list, cfg);
  const meId = regional.me;
  const euId = regional.eu;
  const usId = regional.us;
  const streamingId = findBouquetByNamePattern(list, /stream/i);
  const beinId = findBouquetByNamePattern(list, /bein|world\s*cup|tod/i);

  const regions = { ...cfg.regions };
  if (meId) regions.me = { ...regions.me, id: 'me', packId: meId };
  if (euId) regions.eu = { ...regions.eu, id: 'eu', packId: euId };
  if (usId) regions.us = { ...regions.us, id: 'us', packId: usId };

  const sellPackages = getEnabledSellPackages(cfg).map(pkg => {
    if (pkg.exclusive || /full/i.test(pkg.name)) {
      const byRegion = { ...(pkg.bouquetIdsByRegion || {}) };
      if (meId) byRegion.me = meId;
      if (euId) byRegion.eu = euId;
      if (usId) byRegion.us = usId;
      return { ...pkg, bouquetIdsByRegion: byRegion };
    }
    if (/stream/i.test(pkg.name) && streamingId) return { ...pkg, bouquetIds: streamingId };
    if (/bein|world\s*cup/i.test(pkg.name) && beinId) return { ...pkg, bouquetIds: beinId };
    return pkg;
  });

  const packageId = meId || euId || usId || cfg.packageId;
  return { ...cfg, regions, sellPackages, packageId };
}

async function syncStrong8kBouquetsFromPanel(config) {
  const { bouquets } = await getBouquets(config);
  return applyPanelBouquetsToConfig(config, bouquets);
}

function isPanelPackRejection(payload) {
  return isPanelRetryableError(payload);
}

function isPanelHardError(payload) {
  const row = unwrapApiPayload(payload);
  const msg = String(row.message || row.messasge || row.result || row.error || '').trim();
  if (isPanelDemoLimitError(payload)) return true;
  return /api key|unauthorized|invalid key|reseller.*disabled|not enabled|permission/i.test(msg);
}

function isPanelRetryableError(payload) {
  if (isPanelHardError(payload)) return false;
  const row = unwrapApiPayload(payload);
  const msg = String(row.message || row.messasge || row.result || row.error || '').trim();
  if (!msg) return true;
  return /subscription package not found|subscription time|bouquet|package.*not found|invalid.*pack|something is missing|missing|required|not found/i.test(msg);
}

function normalizeTrialPackForPanel(pack) {
  if (pack === OMIT_PANEL_PACK) return pack;
  const value = String(pack || '').trim();
  if (!value || isWildcardPack(value)) return value;
  if (value.includes(',')) return firstBouquetId(value);
  return value;
}

function trialCountryOptions(regionKey) {
  const key = String(regionKey || 'me').toLowerCase();
  const primary = TRIAL_REGION_PRIMARY_COUNTRY[key] || 'LB';
  return [primary, 'ALL', ''];
}

function buildTrialLineRequestVariants(regionKey, panelPack) {
  const pack = normalizeTrialPackForPanel(panelPack);
  const variants = [];
  const seen = new Set();
  const push = (variant) => {
    const key = JSON.stringify(variant);
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(variant);
  };
  const primaryCountry = TRIAL_REGION_PRIMARY_COUNTRY[regionKey] || 'LB';

  for (const sub of TRIAL_SUB_CODES) {
    if (pack === OMIT_PANEL_PACK) {
      push({ type: 'm3u', sub, pack, httpMethod: 'GET', packParam: 'pack' });
      continue;
    }
    // Activation-panel style: simple GET with sub + pack (demo sub=99, fallback 1/0)
    push({ type: 'm3u', sub, pack, httpMethod: 'GET', packParam: 'pack' });
    push({ type: 'm3u', sub, pack, httpMethod: 'GET', packParam: 'pack', country: primaryCountry, countryParam: 'country' });
    push({ type: 'm3u', sub, pack, httpMethod: 'POST', packParam: 'pack', country: primaryCountry, countryParam: 'country' });
  }
  return variants;
}

function isPanelDemoLimitError(payload) {
  const row = unwrapApiPayload(payload);
  const msg = String(row.message || row.messasge || row.result || row.error || '').trim();
  return /demo|trial.*limit|no.*ticket|ticket/i.test(msg);
}

function resolveTrialPackBouquetSync(config, region) {
  const regionKey = String(region || 'me').toLowerCase();
  if (!IPTV_TRIAL_REGIONS.has(regionKey)) return '';

  const sellPackages = getEnabledSellPackages(config);
  const exclusive = sellPackages.find(pkg => pkg.exclusive) || sellPackages[0];

  if (exclusive) {
    const byRegion = exclusive.bouquetIdsByRegion && exclusive.bouquetIdsByRegion[regionKey];
    const fromRegion = firstBouquetId(byRegion);
    if (fromRegion) return fromRegion;
    const fromGlobal = firstBouquetId(exclusive.bouquetIds);
    if (fromGlobal) return fromGlobal;
  }

  const regionPack = resolveRegionPack(config, regionKey);
  if (!isWildcardPack(regionPack)) {
    const fromRegionPack = firstBouquetId(regionPack);
    if (fromRegionPack) return fromRegionPack;
  }

  const fallback = FULL_PACKAGE_REGION_BOUQUETS[regionKey];
  return fallback ? String(fallback).trim() : '';
}

function assertTrialPanelPack(pack, regionKey) {
  const single = firstBouquetId(pack);
  if (!single || isWildcardPack(single)) {
    throw new Error(
      `Could not activate IPTV free trial for ${regionKey === 'us' ? 'United States' : 'Middle East'}. Bouquets could not be loaded from your panel — try again shortly.`
    );
  }
  return single;
}

function panelListHasBouquetId(list, bouquetId) {
  const id = firstBouquetId(bouquetId);
  if (!id) return false;
  return list.some(b => b.id === id);
}

function buildTrialPackAttemptsFromList(bouquets, config, region) {
  const regionKey = String(region || 'me').toLowerCase();
  const list = formatBouquetRows(bouquets);
  const attempts = [];
  const seen = new Set();
  const push = (value) => {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    attempts.push(id);
  };

  const regional = findBouquetForRegion(list, regionKey, config);
  if (regional) push(regional);

  const fromConfig = resolveTrialPackBouquetSync(config, regionKey);
  if (fromConfig && !isWildcardPack(fromConfig)) {
    if (!list.length || panelListHasBouquetId(list, fromConfig)) push(fromConfig);
  }

  if (!list.length) {
    if (!attempts.length && fromConfig && !isWildcardPack(fromConfig)) push(fromConfig);
    if (!attempts.length) push('all');
    return attempts;
  }

  list.filter(b => /full/i.test(b.name || '') && matchBouquetNameForRegion(b.name, regionKey))
    .forEach(b => push(firstBouquetId(b.id)));
  push('all');
  return attempts;
}

async function buildTrialPackAttempts(config, region) {
  const regionKey = String(region || 'me').toLowerCase();
  let bouquets = [];
  let panelError = null;
  try {
    bouquets = (await getBouquets(config)).bouquets || [];
  } catch (e) {
    panelError = e;
  }
  const list = formatBouquetRows(bouquets);
  if (!list.length) {
    const fromConfig = resolveTrialPackBouquetSync(config, regionKey);
    if (fromConfig && !isWildcardPack(fromConfig)) {
      bouquets = [{ id: fromConfig, name: 'Saved bouquet' }];
    } else if (panelError) {
      throw new Error(
        `Could not load bouquets from Strong8K panel: ${panelError.message}. In Admin → Strong8K IPTV, click Load bouquets (wait up to 60s), then Save settings and retry Test ME trial.`
      );
    } else {
      throw new Error('No bouquets found on your Strong8K panel. In Admin → Strong8K IPTV, click Test connection then Load bouquets.');
    }
  }
  let attempts = buildTrialPackAttemptsFromList(bouquets, config, regionKey);
  if (!attempts.length) {
    throw new Error('Could not resolve a bouquet for free trial on your panel.');
  }
  attempts = attempts.slice(0, MAX_TRIAL_PACK_ATTEMPTS);
  return { attempts, bouquets: formatBouquetRows(bouquets) };
}

async function requestNewPanelLine(config, { sub, pack, note, type = 'm3u', country, countryParam = 'country', packParam = 'pack', httpMethod = 'GET' }) {
  const params = {
    action: 'new',
    type: String(type || 'm3u').trim() || 'm3u',
    sub,
    note: String(note || 'rashadtech.tv trial').slice(0, 200)
  };
  if (pack !== OMIT_PANEL_PACK && pack != null && String(pack).trim() !== '') {
    const packValue = normalizeTrialPackForPanel(String(pack).trim());
    if (packParam === 'both') {
      params.pack = packValue;
      params.bouquet = packValue;
    } else {
      const field = packParam === 'bouquet' ? 'bouquet' : 'pack';
      params[field] = packValue;
    }
  }
  if (country) {
    const field = String(countryParam || 'country').trim() || 'country';
    params[field] = String(country).trim();
  }
  return requestPanel(config, params, { method: httpMethod });
}

async function requestNewM3uLine(config, opts) {
  return requestNewPanelLine(config, { ...opts, type: 'm3u', packParam: 'pack' });
}

function formatPackAttemptLabel(pack) {
  return pack === OMIT_PANEL_PACK ? '(no pack param)' : String(pack);
}

function formatTrialAttemptLabel(variant) {
  const parts = [
    String(variant.httpMethod || 'GET').toUpperCase(),
    `type=${variant.type || 'm3u'}`,
    `sub=${variant.sub}`,
    `pack=${formatPackAttemptLabel(variant.pack)}`
  ];
  if (variant.country) parts.push(`${variant.countryParam || 'country'}=${variant.country}`);
  if (variant.packParam && variant.packParam !== 'pack') parts.push(`field=${variant.packParam}`);
  return parts.join(' · ');
}

async function assertTrialPanelCredits(config) {
  try {
    const info = await getResellerInfo(config);
    const credits = Number(info.credits || 0);
    if (credits < TRIAL_MIN_PANEL_CREDITS) {
      throw new Error(
        `Strong8K panel needs at least ${TRIAL_MIN_PANEL_CREDITS} credits for free trials (current balance: ${credits}). Add credits on your panel, then try again.`
      );
    }
    return info;
  } catch (e) {
    if (/at least \d+ credits/i.test(e.message || '')) throw e;
    return null;
  }
}

async function createTrialLine(config, { note, region, lineType, pack, packAttempts, bouquetsCache } = {}) {
  const regionKey = String(region || 'me').toLowerCase();
  const attemptLog = [];
  let bouquets = Array.isArray(bouquetsCache) ? bouquetsCache : [];

  await assertTrialPanelCredits(config);

  const presetPack = pack ? String(pack).trim() : '';
  const attemptList = presetPack
    ? [presetPack]
    : (Array.isArray(packAttempts) && packAttempts.length
      ? packAttempts
      : (await buildTrialPackAttempts(config, regionKey)).attempts);

  if (!bouquets.length && !presetPack) {
    try {
      bouquets = formatBouquetRows((await getBouquets(config)).bouquets || []);
    } catch {
      bouquets = [];
    }
  }

  let row = null;
  let successPack = null;
  let successAttempt = null;
  const noteText = String(note || 'rashadtech.tv trial').slice(0, 200);
  let panelCalls = 0;

  outer:
  for (let packIndex = 0; packIndex < attemptList.length; packIndex++) {
    const panelPack = attemptList[packIndex];
    const variants = buildTrialLineRequestVariants(regionKey, panelPack);
    for (const variant of variants) {
      if (panelCalls >= MAX_TRIAL_PANEL_CALLS) break outer;
      panelCalls += 1;
      const data = await requestNewPanelLine(config, { ...variant, note: noteText });
      row = unwrapApiPayload(data);
      const ok = String(row.status || '').toLowerCase() === 'true';
      const panelMsg = String(row.message || row.messasge || row.result || row.error || '').trim();
      const attemptLabel = formatTrialAttemptLabel(variant);
      attemptLog.push({
        pack: attemptLabel,
        sub: variant.sub,
        ok,
        message: panelMsg || (ok ? 'OK' : 'Failed')
      });
      if (ok) {
        successPack = panelPack;
        successAttempt = attemptLabel;
        break outer;
      }
      if (isPanelDemoLimitError(data)) {
        throw new Error(panelMsg || 'Strong8K demo/trial limit reached on your panel. Try again tomorrow or add demo credits.');
      }
      if (isPanelHardError(data)) {
        throw new Error(panelMsg || panelErrorMessage(data, 'Could not create IPTV trial line'));
      }
      if (!isPanelRetryableError(data)) {
        throw new Error(panelMsg || panelErrorMessage(data, 'Could not create IPTV trial line'));
      }
    }
  }

  if (!row || String(row.status || '').toLowerCase() !== 'true') {
    const detail = attemptLog.map(a => `${a.pack}: ${a.message}`).join(' | ');
    const hint = /something is missing|subscription package not found|subscription time/i.test(detail)
      ? ' Click Load bouquets → Save settings → retry. Need ≥12 panel credits.'
      : '';
    const err = new Error((detail || 'Could not create IPTV trial line on Strong8K panel') + hint);
    err.attemptLog = attemptLog;
    throw err;
  }

  const creds = parseLineCredentials(row, row.url);
  return {
    success: true,
    userId: String(row.user_id || row.userId || '').trim(),
    username: creds.username,
    password: creds.password,
    url: creds.url,
    host: creds.host,
    lineType: lineType === 'm3u' ? 'm3u' : 'stable',
    isTrial: true,
    region: regionKey,
    message: String(row.message || '').trim(),
    successPack: successAttempt || formatPackAttemptLabel(successPack),
    attemptLog,
    bouquetCount: bouquets.length
  };
}

async function resolveTrialPackBouquet(config, region) {
  const regionKey = String(region || 'me').toLowerCase();
  const { attempts } = await buildTrialPackAttempts(config, regionKey);
  const first = attempts.find(p => p !== OMIT_PANEL_PACK && !isWildcardPack(p));
  return first || attempts[0] || '';
}

async function resolvePanelPack(config, { region, packageIds, isTrial } = {}) {
  const regionKey = String(region || 'me').toLowerCase();

  if (isTrial) {
    if (!IPTV_TRIAL_REGIONS.has(regionKey)) {
      throw new Error('Free trial is only available for Middle East or United States');
    }
    const { attempts } = await buildTrialPackAttempts(config, regionKey);
    const first = attempts.find(p => p !== OMIT_PANEL_PACK && !isWildcardPack(p));
    return first || attempts[0] || '';
  }

  const ids = normalizeSellPackageIds(packageIds);
  const sellPackages = getEnabledSellPackages(config);

  if (ids.length) {
    const fromPackages = resolvePackFromSellPackages(ids, config, regionKey);
    if (fromPackages) return fromPackages;
  }

  const regionPack = resolveRegionPack(config, regionKey);
  if (!isWildcardPack(regionPack)) return regionPack;

  return resolvePackForPanel(config, regionKey);
}

function describeSellPackageSelection(packageIds, config) {
  const selected = resolveSelectedSellPackages(packageIds, config);
  if (!selected.length) return '';
  return selected.map(pkg => pkg.name).join(' + ');
}

function sanitizeStrong8kConfig(raw) {
  const base = defaultStrong8kConfig();
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    ...base,
    ...input,
    panelUrl: normalizePanelUrl(input.panelUrl || base.panelUrl),
    apiKey: String(input.apiKey || base.apiKey || '').trim(),
    packageId: String(input.packageId || base.packageId || 'all').trim() || 'all',
    enabled: Boolean(input.enabled),
    storeEnabled: Boolean(input.storeEnabled),
    trialEnabled: input.trialEnabled !== undefined ? Boolean(input.trialEnabled) : base.trialEnabled,
    regions: sanitizeRegions(input.regions),
    plans: sanitizePlans(input.plans),
    sellPackages: sanitizeSellPackages(input.sellPackages)
  };
}

function sanitizeStrong8kConfigForClient(config, isAdmin) {
  const cfg = sanitizeStrong8kConfig(config);
  const hasApiKey = Boolean(resolveApiKey(cfg));
  const regions = Object.values(cfg.regions || {}).map(r => ({
    id: r.id,
    name: r.name
  }));
  if (!isAdmin) {
    if (!cfg.storeEnabled || !hasApiKey || !cfg.panelUrl) {
      return { enabled: false, plans: [], regions: [], trialEnabled: false, lineTypes: [], sellPackages: [] };
    }
    const sellPackages = getEnabledSellPackages(cfg).map(pkg => ({
      id: pkg.id,
      name: pkg.name,
      desc: pkg.desc,
      prices: pkg.prices,
      monthlyPrice: pkg.prices[1] || pkg.monthlyPrice || 0,
      exclusive: pkg.exclusive
    }));
    return {
      enabled: true,
      trialEnabled: Boolean(cfg.trialEnabled),
      regions,
      sellPackages,
      lineTypes: [
        { id: 'stable', name: 'Stable (Xtream)', desc: 'Server host + username + password — best for TiviMate & Smarters' },
        { id: 'm3u', name: 'M3U Playlist', desc: 'Single playlist URL for simple players' }
      ],
      features: {
        channels: '60,000+',
        vod: '100,000+',
        quality: 'HD · FHD · 4K',
        sports: 'beIN · live football · PPV',
        devices: 'Smart TV · Firestick · Android · iOS'
      },
      plans: cfg.plans.map(plan => ({
        months: plan.months,
        name: plan.name,
        sellPrice: plan.sellPrice
      }))
    };
  }
  return {
    enabled: Boolean(cfg.enabled),
    storeEnabled: Boolean(cfg.storeEnabled),
    trialEnabled: Boolean(cfg.trialEnabled),
    hasApiKey,
    hasEnvApiKey: Boolean(String(process.env.STRONG8K_API_KEY || '').trim()),
    panelUrl: formatPanelUrlForDisplay(cfg.panelUrl),
    packageId: cfg.packageId,
    regions: cfg.regions,
    sellPackages: cfg.sellPackages,
    plans: cfg.plans
  };
}

function unwrapApiPayload(data) {
  if (Array.isArray(data)) return data[0] || {};
  if (data && typeof data === 'object') return data;
  return {};
}

function panelErrorMessage(payload, fallback) {
  const row = unwrapApiPayload(payload);
  const msg = String(row.message || row.messasge || row.result || row.error || '').trim();
  if (msg) {
    if (/subscription package not found/i.test(msg)) {
      return msg;
    }
    return msg;
  }
  if (String(row.status || '').toLowerCase() === 'true') return '';
  return fallback || 'Strong8K panel request failed';
}

function extractHostFromUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function resolveRegionPack(config, regionId) {
  const regions = sanitizeRegions(config && config.regions);
  const key = String(regionId || 'me').toLowerCase();
  if (regions[key] && regions[key].packId) return regions[key].packId;
  return String(config && config.packageId || 'all').trim() || 'all';
}

function isWildcardPack(pack) {
  const value = String(pack || '').trim().toLowerCase();
  return !value || value === 'all' || value === '*' || value === 'default';
}

function joinBouquetIds(bouquets) {
  return (Array.isArray(bouquets) ? bouquets : [])
    .map(item => String(item && item.id || '').trim())
    .filter(Boolean)
    .join(',');
}

async function resolvePackForPanel(config, regionId) {
  const configured = resolveRegionPack(config, regionId);
  if (!isWildcardPack(configured)) return configured;

  const { bouquets } = await getBouquets(config);
  const joined = joinBouquetIds(bouquets);
  if (!joined) {
    throw new Error(
      'IPTV bouquet not configured. In Admin → Strong8K IPTV, click Load bouquets and set a valid package/bouquet ID for your region.'
    );
  }
  return joined;
}

async function requestPanelOnce(config, params, { method = 'GET' } = {}) {
  const panelUrl = normalizePanelUrl(config && config.panelUrl);
  const apiKey = resolveApiKey(config);
  if (!panelUrl) throw new Error('Strong8K panel URL is not configured');
  if (!apiKey) throw new Error('Strong8K API key is not configured');

  const url = new URL(panelUrl);
  const bodyParams = new URLSearchParams();
  bodyParams.set('api_key', apiKey);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      bodyParams.set(key, String(value));
    }
  }

  const httpMethod = String(method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const fetchUrl = httpMethod === 'GET' ? `${url.origin}${url.pathname}?${bodyParams.toString()}` : `${url.origin}${url.pathname}`;
  const res = await fetch(fetchUrl, {
    method: httpMethod,
    headers: {
      Accept: 'application/json',
      ...(httpMethod === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
    },
    body: httpMethod === 'POST' ? bodyParams.toString() : undefined,
    signal: AbortSignal.timeout(PANEL_REQUEST_TIMEOUT_MS)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Strong8K panel returned an invalid response');
  }
  if (!res.ok) {
    throw new Error(panelErrorMessage(data, `Strong8K panel HTTP ${res.status}`));
  }
  return data;
}

async function requestPanel(config, params, { method = 'GET', retries = PANEL_REQUEST_RETRIES } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await requestPanelOnce(config, params, { method });
    } catch (e) {
      lastError = e;
      const msg = String(e && e.message || '');
      const retryable = /timeout|aborted|network|fetch failed|econnreset|etimedout|socket/i.test(msg);
      if (!retryable || attempt >= retries) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError || new Error('Strong8K panel request failed');
}

async function getResellerInfo(config) {
  const data = await requestPanel(config, { action: 'reseller_info' });
  const row = unwrapApiPayload(data);
  if (String(row.status || '').toLowerCase() !== 'true') {
    throw new Error(panelErrorMessage(data, 'Could not verify Strong8K API key'));
  }
  return {
    success: true,
    username: row.username || '',
    credits: Number(row.credits || 0),
    enabled: String(row.enabled || '1') === '1'
  };
}

function formatBouquetRows(list) {
  return (Array.isArray(list) ? list : [])
    .map(item => ({
      id: String(item.id || item.bouquet_id || item.package_id || item.packageId || '').trim(),
      name: String(item.name || item.bouquet_name || item.package_name || item.title || item.id || '').trim()
    }))
    .filter(item => item.id);
}

function normalizeBouquetList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;

  if (typeof data === 'object') {
    const candidates = [data.bouquets, data.packages, data.package, data.data, data.list];
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length) return candidate;
      if (typeof candidate === 'string') {
        try {
          const parsed = JSON.parse(candidate);
          if (Array.isArray(parsed) && parsed.length) return parsed;
        } catch {
          // ignore malformed JSON
        }
      }
    }

    if (typeof data.result === 'string') {
      try {
        const parsed = JSON.parse(data.result);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      } catch {
        // result is plain text, not a bouquet list
      }
    } else if (Array.isArray(data.result) && data.result.length) {
      return data.result;
    }

    const objects = Object.entries(data)
      .filter(([key]) => !['status', 'message', 'error', 'result', 'messasge'].includes(key))
      .map(([, value]) => value)
      .filter(value => value && typeof value === 'object' && (value.id || value.bouquet_id || value.name || value.bouquet_name));
    if (objects.length) return objects;

    if (data.id || data.bouquet_id) return [data];
  }

  return [];
}

function assertPanelSuccess(data, fallback) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const status = String(data.status || '').toLowerCase();
  if (status === 'error' || status === 'false') {
    throw new Error(panelErrorMessage(data, fallback));
  }
}

async function getBouquets(config) {
  const actions = ['bouquet', 'bouquets'];
  let lastData = null;
  let lastError = null;
  for (const action of actions) {
    try {
      const data = await requestPanel(config, { action });
      lastData = data;
      assertPanelSuccess(data, 'Could not load bouquets from panel');
      const list = normalizeBouquetList(data);
      const bouquets = formatBouquetRows(list);
      if (bouquets.length) return { success: true, bouquets };
    } catch (e) {
      lastError = e;
    }
  }

  if (lastData) assertPanelSuccess(lastData, 'Could not load bouquets from panel');
  if (lastError) throw lastError;
  return { success: true, bouquets: [] };
}

function parseLineCredentials(row, url) {
  const playlistUrl = String(url || row.url || row.m3u || '').trim();
  let username = String(row.username || row.user || '').trim();
  let password = String(row.password || row.pass || '').trim();
  if (playlistUrl) {
    try {
      const parsed = new URL(playlistUrl);
      if (!username) username = parsed.searchParams.get('username') || '';
      if (!password) password = parsed.searchParams.get('password') || '';
    } catch {
      // keep raw url only
    }
  }
  const host = String(row.host || row.dns || row.server || row.portal || row.portal_url || '').trim()
    || extractHostFromUrl(playlistUrl);
  return { username, password, url: playlistUrl, host };
}

async function createLine(config, { months, note, region, isTrial, lineType, pack, packageIds }) {
  const sub = isTrial ? TRIAL_SUB_CODE : Number(months);
  if (!isTrial && ![1, 3, 6, 12].includes(sub)) {
    throw new Error('Invalid subscription length');
  }
  const noteText = String(note || '').slice(0, 200);
  const regionKey = String(region || 'me').toLowerCase();

  if (isTrial) {
    return createTrialLine(config, { note: noteText, region: regionKey, lineType, pack });
  }

  const resolvedPack = pack || await resolvePanelPack(config, {
    region,
    packageIds,
    isTrial: false
  });
  const panelPack = String(resolvedPack || '').trim();
  const data = await requestPanel(config, {
    action: 'new',
    type: 'm3u',
    sub,
    pack: panelPack,
    note: noteText
  });
  const row = unwrapApiPayload(data);
  if (String(row.status || '').toLowerCase() !== 'true') {
    throw new Error(panelErrorMessage(data, 'Could not create IPTV line'));
  }
  const creds = parseLineCredentials(row, row.url);
  return {
    success: true,
    userId: String(row.user_id || row.userId || '').trim(),
    username: creds.username,
    password: creds.password,
    url: creds.url,
    host: creds.host,
    lineType: lineType === 'm3u' ? 'm3u' : 'stable',
    isTrial: Boolean(isTrial),
    region: String(region || 'me').toLowerCase(),
    message: String(row.message || '').trim()
  };
}

async function createM3uLine(config, opts) {
  return createLine(config, { ...opts, lineType: 'm3u' });
}

function findPlan(config, months) {
  const plans = sanitizePlans(config && config.plans);
  return plans.find(plan => Number(plan.months) === Number(months)) || null;
}

function normalizePhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

module.exports = {
  DEFAULT_PLANS,
  DEFAULT_SELL_PACKAGES,
  sanitizeSellPackages,
  getEnabledSellPackages,
  computeSellPackagePrice,
  computeSellPackageMonthlyTotal,
  getSellPackagePriceForMonths,
  DURATION_MONTHS,
  resolvePackFromSellPackages,
  resolveSellPackageBouquetIds,
  resolveTrialPackBouquetSync,
  resolveTrialPackBouquet,
  assertTrialPanelPack,
  buildTrialPackAttempts,
  buildTrialPackAttemptsFromList,
  createTrialLine,
  requestNewM3uLine,
  requestNewPanelLine,
  formatPackAttemptLabel,
  formatTrialAttemptLabel,
  buildTrialLineRequestVariants,
  normalizeTrialPackForPanel,
  isPanelRetryableError,
  isPanelHardError,
  TRIAL_REGION_PRIMARY_COUNTRY,
  OMIT_PANEL_PACK,
  mergeMissingDefaultSellPackages,
  assertTrialPanelCredits,
  panelListHasBouquetId,
  TRIAL_MIN_PANEL_CREDITS,
  firstBouquetId,
  findBouquetForRegion,
  findBouquetByNamePattern,
  applyPanelBouquetsToConfig,
  resolveRegionalBouquetIds,
  fixRegionBouquetSwap,
  syncStrong8kBouquetsFromPanel,
  matchBouquetNameForRegion,
  IPTV_TRIAL_REGIONS,
  RETIRED_SELL_PACKAGE_IDS,
  isRetiredSellPackage,
  filterRetiredSellPackages,
  FULL_PACKAGE_REGION_BOUQUETS,
  resolvePanelPack,
  resolveSelectedSellPackages,
  describeSellPackageSelection,
  normalizeSellPackageIds,
  IPTV_REGIONS,
  TRIAL_SUB_CODE,
  TRIAL_SUB_CODES,
  TRIAL_MIN_PANEL_CREDITS,
  defaultStrong8kConfig,
  normalizePanelUrl,
  formatPanelUrlForDisplay,
  resolveApiKey,
  sanitizeStrong8kConfig,
  sanitizeStrong8kConfigForClient,
  sanitizeRegions,
  getResellerInfo,
  getBouquets,
  createLine,
  createM3uLine,
  findPlan,
  normalizePhoneDigits,
  joinBouquetIds,
  isWildcardPack,
  resolveRegionPack,
  resolvePackForPanel,
  normalizeBouquetList,
  formatBouquetRows,
  extractHostFromUrl,
  parseLineCredentials,
  panelErrorMessage
};
