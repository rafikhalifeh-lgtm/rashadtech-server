const test = require('node:test');
const assert = require('node:assert/strict');
const { getPublicSmsCatalogFromData } = require('../smsRoutes');

test('public SMS catalog hidden when store disabled', () => {
  const res = getPublicSmsCatalogFromData({
    smsConfig: {
      storeEnabled: false,
      catalog: [{ id: '1', service: 'wa', enabled: true, sellPrice: 1 }]
    }
  });
  assert.equal(res.enabled, false);
  assert.deepEqual(res.catalog, []);
});

test('public SMS catalog filters to popular services only', () => {
  const res = getPublicSmsCatalogFromData({
    smsConfig: {
      storeEnabled: true,
      catalog: [
        { id: '1', service: 'wa', serviceName: 'WhatsApp', country: '73', countryName: 'Brazil', enabled: true, sellPrice: 2.5 },
        { id: '2', service: 'zz', serviceName: 'Unknown', country: '73', countryName: 'Brazil', enabled: true, sellPrice: 1 }
      ]
    }
  });
  assert.equal(res.enabled, true);
  assert.equal(res.catalog.length, 1);
  assert.equal(res.catalog[0].service, 'wa');
  assert.equal(res.catalog[0].sellPrice, 2.5);
});
