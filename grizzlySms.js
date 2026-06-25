const GRIZZLY_API_ORIGIN = 'https://api.grizzlysms.com';

async function requestGrizzly(params, apiKey) {
  if (!apiKey) throw new Error('Grizzly SMS API key is not configured');
  const url = new URL('/stubs/handler_api.php', `${GRIZZLY_API_ORIGIN}/`);
  url.searchParams.set('api_key', apiKey);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

function parseAccessNumber(raw) {
  const text = String(raw || '').trim();
  const match = /^ACCESS_NUMBER:(\d+):(\d+)$/.exec(text);
  if (!match) return null;
  return { activationId: Number(match[1]), phoneNumber: match[2] };
}

function parseStatus(raw) {
  const text = String(raw || '').trim();
  if (text === 'STATUS_WAIT_CODE') return { status: 'waiting' };
  if (text === 'STATUS_WAIT_RETRY') return { status: 'waiting_retry' };
  if (text === 'STATUS_CANCEL') return { status: 'cancelled' };
  const ok = /^STATUS_OK:(.+)$/.exec(text);
  if (ok) return { status: 'ok', code: ok[1].trim() };
  return { status: 'unknown', raw: text };
}

function grizzlyErrorMessage(raw) {
  const text = String(raw || '').trim();
  const map = {
    BAD_KEY: 'Invalid Grizzly SMS API key',
    NO_NUMBERS: 'No numbers available for this service/country right now',
    NO_BALANCE: 'Grizzly SMS balance is too low — top up your Grizzly account',
    SERVICE_UNAVAILABLE_REGION: 'Grizzly SMS blocked this server region — contact support',
    ERROR_SQL: 'Grizzly SMS temporary error — try again',
    WRONG_SERVICE: 'Invalid service code',
    WRONG_COUNTRY: 'Invalid country code'
  };
  return map[text] || text || 'Grizzly SMS request failed';
}

async function getBalance(apiKey) {
  const data = await requestGrizzly({ action: 'getBalance' }, apiKey);
  if (typeof data === 'string' && data.startsWith('ACCESS_BALANCE:')) {
    return { success: true, balance: Number(data.split(':')[1]) };
  }
  if (typeof data === 'object' && data.balance !== undefined) {
    return { success: true, balance: Number(data.balance) };
  }
  return { success: false, error: grizzlyErrorMessage(data) };
}

function normalizeListItem(code, value, nameKeys = ['eng', 'rus', 'name']) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = String(value.id ?? value.code ?? code).trim();
    let name = '';
    for (const key of nameKeys) {
      if (value[key]) {
        name = String(value[key]).trim();
        break;
      }
    }
    return { code: id || String(code).trim(), name: name || id || String(code).trim() };
  }
  return {
    code: String(code).trim(),
    name: String(value || code).trim()
  };
}

async function getServices(apiKey) {
  const data = await requestGrizzly({ action: 'getServicesList' }, apiKey);
  if (!data || typeof data !== 'object') {
    return { success: false, error: grizzlyErrorMessage(data) };
  }
  let services = [];
  if (Array.isArray(data.services)) {
    services = data.services.map(item => normalizeListItem(item.code, item));
  } else {
    services = Object.entries(data)
      .filter(([key]) => key !== 'status')
      .map(([code, name]) => normalizeListItem(code, name));
  }
  services = services.filter(item => item.code).sort((a, b) => a.name.localeCompare(b.name));
  return { success: true, services };
}

async function getCountries(apiKey) {
  const data = await requestGrizzly({ action: 'getCountries' }, apiKey);
  if (!data || typeof data !== 'object') {
    return { success: false, error: grizzlyErrorMessage(data) };
  }
  const countries = Object.entries(data)
    .filter(([key]) => key !== 'status')
    .map(([code, value]) => normalizeListItem(code, value))
    .filter(item => item.code)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { success: true, countries };
}

async function getPrices(apiKey, { service, country } = {}) {
  const params = { action: 'getPrices' };
  if (service) params.service = service;
  if (country) params.country = country;
  const data = await requestGrizzly(params, apiKey);
  if (!data || typeof data !== 'object') {
    return { success: false, error: grizzlyErrorMessage(data) };
  }
  return { success: true, prices: data };
}

function readCostNode(node) {
  if (node == null) return null;
  if (typeof node === 'object') {
    const cost = Number(node.cost ?? node.price ?? node.rate ?? node.physicalPrice);
    return Number.isFinite(cost) && cost >= 0 ? cost : null;
  }
  const cost = Number(node);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function flattenGrizzlyPrices(prices, options = {}) {
  const rows = [];
  if (!prices || typeof prices !== 'object') return rows;
  const countryHint = options.countryHint != null ? String(options.countryHint) : '';

  const pushRow = (country, service, node) => {
    const cost = readCostNode(node);
    if (cost == null || cost <= 0) return;
    const c = String(country || '').trim();
    const s = String(service || '').trim();
    if (!c || !s) return;
    rows.push({ country: c, service: s, cost });
  };

  for (const [keyA, nodeA] of Object.entries(prices)) {
    if (keyA === 'status' || nodeA == null || typeof nodeA !== 'object') continue;

    if (countryHint && !/^\d+$/.test(keyA)) {
      pushRow(countryHint, keyA, nodeA);
      continue;
    }

    if (/^\d+$/.test(keyA)) {
      for (const [serviceKey, nodeB] of Object.entries(nodeA)) {
        pushRow(keyA, serviceKey, nodeB);
      }
      continue;
    }

    for (const [keyB, nodeB] of Object.entries(nodeA)) {
      if (/^\d+$/.test(keyB)) pushRow(keyB, keyA, nodeB);
    }
  }

  return rows;
}

function extractGrizzlyCost(prices, service, country) {
  if (!prices || typeof prices !== 'object') return null;
  const serviceKey = String(service || '').trim();
  const countryKey = String(country || '').trim();

  if (prices.cost != null || prices.price != null) {
    return readCostNode(prices);
  }

  const countryNode = prices[countryKey] || prices[Number(countryKey)];
  const fromCountryFirst = readCostNode(
    countryNode && typeof countryNode === 'object'
      ? (countryNode[serviceKey] || countryNode[serviceKey.toLowerCase()])
      : null
  );
  if (fromCountryFirst != null) return fromCountryFirst;

  const serviceNode = prices[serviceKey] || prices[serviceKey.toLowerCase()];
  const fromServiceFirst = readCostNode(
    serviceNode && typeof serviceNode === 'object'
      ? (serviceNode[countryKey] || serviceNode[Number(countryKey)])
      : null
  );
  if (fromServiceFirst != null) return fromServiceFirst;

  const flat = flattenGrizzlyPrices(prices);
  const match = flat.find(row => row.service === serviceKey && row.country === countryKey)
    || flat.find(row => row.service.toLowerCase() === serviceKey.toLowerCase() && row.country === countryKey);
  return match ? match.cost : null;
}

async function requestNumber(apiKey, { service, country, maxPrice } = {}) {
  const params = { action: 'getNumberV2', service, country };
  if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') {
    params.maxPrice = maxPrice;
  }
  const data = await requestGrizzly(params, apiKey);
  if (typeof data === 'string') {
    const legacy = parseAccessNumber(data);
    if (legacy) {
      return {
        success: true,
        activationId: legacy.activationId,
        phoneNumber: legacy.phoneNumber,
        activationCost: null,
        countryCode: String(country || ''),
        raw: data
      };
    }
    return { success: false, error: grizzlyErrorMessage(data) };
  }
  if (!data || typeof data !== 'object' || !data.activationId) {
    return { success: false, error: grizzlyErrorMessage(data && data.error ? data.error : data) };
  }
  return {
    success: true,
    activationId: Number(data.activationId),
    phoneNumber: String(data.phoneNumber || ''),
    activationCost: Number(data.activationCost || 0),
    countryCode: String(data.countryCode || country || ''),
    canGetAnotherSms: String(data.canGetAnotherSms || '0') === '1',
    activationTime: data.activationTime || null,
    raw: data
  };
}

async function getStatus(apiKey, activationId) {
  const data = await requestGrizzly({ action: 'getStatus', id: activationId }, apiKey);
  if (typeof data === 'string') {
    const parsed = parseStatus(data);
    if (parsed.status === 'ok') return { success: true, ...parsed };
    if (parsed.status === 'waiting' || parsed.status === 'waiting_retry') {
      return { success: true, ...parsed };
    }
    if (parsed.status === 'cancelled') return { success: false, cancelled: true, ...parsed };
    return { success: false, error: grizzlyErrorMessage(data), ...parsed };
  }
  return { success: false, error: 'Unexpected Grizzly status response' };
}

async function setStatus(apiKey, activationId, status) {
  const data = await requestGrizzly({ action: 'setStatus', id: activationId, status }, apiKey);
  if (typeof data === 'string' && data.startsWith('ACCESS')) {
    return { success: true, raw: data };
  }
  if (data === 'OK' || (data && data.status === 'OK')) return { success: true };
  return { success: false, error: grizzlyErrorMessage(data) };
}

function defaultSmsConfig() {
  return {
    enabled: false,
    storeEnabled: false,
    apiKey: '',
    markupPercent: 35,
    usdPerCredit: 1,
    catalog: []
  };
}

function sanitizeSmsConfigForClient(config, isAdmin) {
  const base = { ...(config || defaultSmsConfig()) };
  if (!isAdmin) {
    return {
      enabled: Boolean(base.storeEnabled),
      catalog: (base.catalog || []).filter(item => item.enabled).map(item => ({
        service: item.service,
        serviceName: item.serviceName,
        country: item.country,
        countryName: item.countryName,
        sellPrice: Number(item.sellPrice || 0)
      }))
    };
  }
  return {
    enabled: Boolean(base.enabled),
    storeEnabled: Boolean(base.storeEnabled),
    hasApiKey: Boolean(String(base.apiKey || '').trim()),
    markupPercent: Number(base.markupPercent || 0),
    usdPerCredit: Number(base.usdPerCredit || 1),
    catalog: Array.isArray(base.catalog) ? base.catalog : []
  };
}

function computeSellPrice(cost, markupPercent, usdPerCredit) {
  const base = Number(cost || 0) * Number(usdPerCredit || 1);
  const markup = Number(markupPercent || 0);
  const sell = base * (1 + markup / 100);
  return Math.max(0.5, Math.ceil(sell * 100) / 100);
}

module.exports = {
  defaultSmsConfig,
  sanitizeSmsConfigForClient,
  computeSellPrice,
  getBalance,
  getServices,
  getCountries,
  getPrices,
  extractGrizzlyCost,
  flattenGrizzlyPrices,
  readCostNode,
  requestNumber,
  getStatus,
  setStatus,
  grizzlyErrorMessage
};
