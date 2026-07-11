const grizzlySms = require('./grizzlySms');

const SMS_CONFIG_KEY = 'smsConfig';
const MAX_PUBLIC_SMS_PER_SERVICE = 20;

function readSmsConfig(data) {
  const raw = (data && data[SMS_CONFIG_KEY]) || grizzlySms.defaultSmsConfig();
  return {
    ...grizzlySms.defaultSmsConfig(),
    ...raw,
    catalog: Array.isArray(raw.catalog) ? raw.catalog : []
  };
}

function buildPublicSmsCatalogResponse(config) {
  if (!config.storeEnabled) return { success: true, enabled: false, catalog: [] };
  const byService = {};
  for (const item of config.catalog || []) {
    if (item.enabled === false || !grizzlySms.isPopularSmsService(item.service)) continue;
    const key = String(item.service || '').toLowerCase();
    if (!byService[key]) byService[key] = [];
    if (byService[key].length >= MAX_PUBLIC_SMS_PER_SERVICE) continue;
    byService[key].push({
      id: item.id,
      service: item.service,
      serviceName: item.serviceName,
      country: item.country,
      countryName: item.countryName,
      sellPrice: Number(item.sellPrice || 0)
    });
  }
  const catalog = Object.values(byService).flat();
  return { success: true, enabled: true, catalog };
}

function getPublicSmsCatalogFromData(data) {
  return buildPublicSmsCatalogResponse(readSmsConfig(data));
}

module.exports = {
  SMS_CONFIG_KEY,
  readSmsConfig,
  buildPublicSmsCatalogResponse,
  getPublicSmsCatalogFromData
};
