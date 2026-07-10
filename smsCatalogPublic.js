const grizzlySms = require('./grizzlySms');

const SMS_CONFIG_KEY = 'smsConfig';

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
  const catalog = (config.catalog || [])
    .filter(item => item.enabled !== false && grizzlySms.isPopularSmsService(item.service))
    .map(item => ({
      id: item.id,
      service: item.service,
      serviceName: item.serviceName,
      country: item.country,
      countryName: item.countryName,
      sellPrice: Number(item.sellPrice || 0)
    }));
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
