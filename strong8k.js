const DEFAULT_PLANS = [
  { months: 1, name: '1 Month', sellPrice: 8 },
  { months: 3, name: '3 Months', sellPrice: 20 },
  { months: 6, name: '6 Months', sellPrice: 35 },
  { months: 12, name: '12 Months', sellPrice: 60 }
];

function defaultStrong8kConfig() {
  return {
    enabled: false,
    storeEnabled: false,
    panelUrl: '',
    apiKey: '',
    packageId: 'all',
    plans: DEFAULT_PLANS.map(p => ({ ...p }))
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

function resolveApiKey(config) {
  return String(process.env.STRONG8K_API_KEY || (config && config.apiKey) || '').trim();
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
    plans: sanitizePlans(input.plans)
  };
}

function sanitizeStrong8kConfigForClient(config, isAdmin) {
  const cfg = sanitizeStrong8kConfig(config);
  const hasApiKey = Boolean(resolveApiKey(cfg));
  if (!isAdmin) {
    if (!cfg.storeEnabled || !hasApiKey || !cfg.panelUrl) {
      return { enabled: false, plans: [] };
    }
    return {
      enabled: true,
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
    hasApiKey,
    hasEnvApiKey: Boolean(String(process.env.STRONG8K_API_KEY || '').trim()),
    panelUrl: cfg.panelUrl,
    packageId: cfg.packageId,
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
  if (msg) return msg;
  if (String(row.status || '').toLowerCase() === 'true') return '';
  return fallback || 'Strong8K panel request failed';
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

async function getBouquets(config) {
  const data = await requestPanel(config, { action: 'bouquet' });
  if (!Array.isArray(data)) return { success: true, bouquets: [] };
  return {
    success: true,
    bouquets: data
      .map(item => ({
        id: String(item.id || '').trim(),
        name: String(item.name || item.id || '').trim()
      }))
      .filter(item => item.id)
  };
}

async function createM3uLine(config, { months, note }) {
  const sub = Number(months);
  if (![1, 3, 6, 12].includes(sub)) {
    throw new Error('Invalid subscription length');
  }
  const pack = String(config.packageId || 'all').trim() || 'all';
  const data = await requestPanel(config, {
    action: 'new',
    type: 'm3u',
    sub,
    pack,
    note: String(note || '').slice(0, 200)
  });
  const row = unwrapApiPayload(data);
  if (String(row.status || '').toLowerCase() !== 'true') {
    throw new Error(panelErrorMessage(data, 'Could not create Strong8K line'));
  }
  const url = String(row.url || '').trim();
  let username = String(row.username || '').trim();
  let password = String(row.password || '').trim();
  if (url) {
    try {
      const parsed = new URL(url);
      if (!username) username = parsed.searchParams.get('username') || '';
      if (!password) password = parsed.searchParams.get('password') || '';
    } catch {
      // keep raw url only
    }
  }
  return {
    success: true,
    userId: String(row.user_id || row.userId || '').trim(),
    username,
    password,
    url,
    message: String(row.message || '').trim()
  };
}

function findPlan(config, months) {
  const plans = sanitizePlans(config && config.plans);
  return plans.find(plan => Number(plan.months) === Number(months)) || null;
}

module.exports = {
  DEFAULT_PLANS,
  defaultStrong8kConfig,
  normalizePanelUrl,
  resolveApiKey,
  sanitizeStrong8kConfig,
  sanitizeStrong8kConfigForClient,
  getResellerInfo,
  getBouquets,
  createM3uLine,
  findPlan
};
