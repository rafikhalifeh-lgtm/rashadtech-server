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
const DURATION_MONTHS = [1, 3, 6, 12];

const PACKAGE_PRICE_DEFAULTS = {
  full: { 1: 8, 3: 20, 6: 35, 12: 60 },
  lebanese: { 1: 3, 3: 8, 6: 14, 12: 25 },
  streaming: { 1: 4, 3: 10, 6: 18, 12: 32 },
  bein: { 1: 5, 3: 13, 6: 22, 12: 38 }
};

const DEFAULT_SELL_PACKAGES = [
  {
    id: 'full',
    name: 'Full Package',
    desc: 'All bouquets — sports, movies, Arabic, streaming & more',
    bouquetIds: '',
    bouquetIdsByRegion: { me: '75605', eu: '75604', us: '75606' },
    prices: { ...PACKAGE_PRICE_DEFAULTS.full },
    exclusive: true,
    enabled: true
  },
  { id: 'lebanese', name: 'Lebanese Channels', desc: 'MBC · LBC · Tele Liban · local Lebanese TV', bouquetIds: '', prices: { ...PACKAGE_PRICE_DEFAULTS.lebanese }, exclusive: false, enabled: true },
  { id: 'streaming', name: 'Streaming Apps', desc: 'Netflix · Shahid · Amazon · Disney+ style channels', bouquetIds: '75609', prices: { ...PACKAGE_PRICE_DEFAULTS.streaming }, exclusive: false, enabled: true },
  { id: 'bein', name: 'beIN + World Cup', desc: 'beIN Sports · World Cup 2026 · live football', bouquetIds: '75610', prices: { ...PACKAGE_PRICE_DEFAULTS.bein }, exclusive: false, enabled: true }
];

const FULL_PACKAGE_REGION_BOUQUETS = { me: '75605', eu: '75604', us: '75606' };
const IPTV_TRIAL_REGIONS = new Set(['me', 'us']);

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

function sanitizeRegions(raw) {
  const base = defaultStrong8kConfig().regions;
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  Object.keys(IPTV_REGIONS).forEach(key => {
    const row = input[key] && typeof input[key] === 'object' ? input[key] : {};
    out[key] = {
      id: key,
      name: String(row.name || base[key].name).trim().slice(0, 40) || base[key].name,
      packId: String(row.packId || base[key].packId || 'all').trim() || 'all'
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
    if (value) out[key] = value;
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

function sanitizeSellPackages(raw) {
  const list = Array.isArray(raw) && raw.length ? raw : DEFAULT_SELL_PACKAGES;
  const seen = new Set();
  return list.map((row, index) => {
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
  }).filter(pkg => pkg.name).slice(0, 12);
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
    const hint = regionKey === 'us' ? 'US bouquet 75606' : 'ME bouquet 75605';
    throw new Error(
      `IPTV trial needs one Full Package bouquet ID for ${regionKey === 'us' ? 'United States' : 'Middle East'}. In Admin → Strong8K IPTV, set ${hint} on Full Package (one ID only, not a comma list).`
    );
  }
  return single;
}

async function resolveTrialPackBouquet(config, region) {
  const regionKey = String(region || 'me').toLowerCase();
  const sync = resolveTrialPackBouquetSync(config, regionKey);
  if (sync) return sync;

  const { bouquets } = await getBouquets(config);
  const regionMatchers = {
    me: /middle|arab|\bme\b/i,
    us: /\bus\b|united states/i
  };
  const regionRe = regionMatchers[regionKey] || null;
  const fullMatch = bouquets.find(b => /full/i.test(b.name || '') && (!regionRe || regionRe.test(b.name || '')))
    || bouquets.find(b => /full/i.test(b.name || ''))
    || bouquets[0];
  return fullMatch && fullMatch.id ? firstBouquetId(fullMatch.id) : '';
}

async function resolvePanelPack(config, { region, packageIds, isTrial } = {}) {
  const regionKey = String(region || 'me').toLowerCase();

  if (isTrial) {
    if (!IPTV_TRIAL_REGIONS.has(regionKey)) {
      throw new Error('Free trial is only available for Middle East or United States');
    }
    const trialPack = await resolveTrialPackBouquet(config, regionKey);
    return assertTrialPanelPack(trialPack, regionKey);
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
      return 'IPTV bouquet ID is invalid for this line. In Admin → Strong8K IPTV, set the Full Package bouquet ID for your region (e.g. ME 75605) — use one bouquet ID, not a comma list.';
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

async function requestPanel(config, params) {
  const panelUrl = normalizePanelUrl(config && config.panelUrl);
  const apiKey = resolveApiKey(config);
  if (!panelUrl) throw new Error('Strong8K panel URL is not configured');
  if (!apiKey) throw new Error('Strong8K API key is not configured');

  const url = new URL(panelUrl);
  url.searchParams.set('api_key', apiKey);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(45000)
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
  const actions = ['bouquet', 'bouquets', 'package', 'packages'];
  let lastData = null;
  for (const action of actions) {
    const data = await requestPanel(config, { action });
    lastData = data;
    assertPanelSuccess(data, 'Could not load bouquets from panel');
    const list = normalizeBouquetList(data);
    const bouquets = formatBouquetRows(list);
    if (bouquets.length) return { success: true, bouquets };
  }

  if (lastData) assertPanelSuccess(lastData, 'Could not load bouquets from panel');
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
  const resolvedPack = pack || await resolvePanelPack(config, {
    region,
    packageIds,
    isTrial: Boolean(isTrial)
  });
  const panelPack = isTrial
    ? assertTrialPanelPack(resolvedPack, String(region || 'me').toLowerCase())
    : String(resolvedPack || '').trim();
  const data = await requestPanel(config, {
    action: 'new',
    type: 'm3u',
    sub,
    pack: panelPack,
    note: String(note || '').slice(0, 200)
  });
  const row = unwrapApiPayload(data);
  if (String(row.status || '').toLowerCase() !== 'true') {
    throw new Error(panelErrorMessage(data, isTrial ? 'Could not create IPTV trial line' : 'Could not create IPTV line'));
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
  firstBouquetId,
  IPTV_TRIAL_REGIONS,
  FULL_PACKAGE_REGION_BOUQUETS,
  resolvePanelPack,
  resolveSelectedSellPackages,
  describeSellPackageSelection,
  normalizeSellPackageIds,
  IPTV_REGIONS,
  TRIAL_SUB_CODE,
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
