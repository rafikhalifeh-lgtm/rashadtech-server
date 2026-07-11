const test = require('node:test');
const assert = require('node:assert/strict');
const strong8k = require('../strong8k');

test('sanitizeStrong8kConfigForClient hides secrets from customers', () => {
  const pub = strong8k.sanitizeStrong8kConfigForClient({
    storeEnabled: true,
    panelUrl: 'https://panel.example.com',
    apiKey: 'secret-key',
    plans: [{ months: 1, name: '1 Month', sellPrice: 8 }]
  }, false);
  assert.equal(pub.enabled, true);
  assert.equal(pub.plans.length, 1);
  assert.equal(pub.panelUrl, undefined);
  assert.equal(pub.apiKey, undefined);
});

test('sanitizeStrong8kConfigForClient shows hasApiKey to admin only', () => {
  const admin = strong8k.sanitizeStrong8kConfigForClient({
    storeEnabled: true,
    panelUrl: 'https://panel.example.com',
    apiKey: 'secret-key',
    plans: []
  }, true);
  assert.equal(admin.hasApiKey, true);
  assert.equal(admin.panelUrl, 'https://panel.example.com/api/api.php');
  assert.equal(admin.apiKey, undefined);
});

test('normalizePanelUrl appends activation api path', () => {
  assert.equal(
    strong8k.normalizePanelUrl('https://panel.example.com'),
    'https://panel.example.com/api/api.php'
  );
});
