const test = require('node:test');
const assert = require('node:assert/strict');
const strong8k = require('../strong8k');
const { trialBlockReason, trialEligibilityDetails, readIptvTrials } = require('../strong8kRoutes');

test('sanitizeStrong8kConfigForClient exposes regions and line types', () => {
  const pub = strong8k.sanitizeStrong8kConfigForClient({
    storeEnabled: true,
    panelUrl: 'https://panel.example.com',
    apiKey: 'secret-key',
    trialEnabled: true,
    plans: [{ months: 1, name: '1 Month', sellPrice: 8 }]
  }, false);
  assert.equal(pub.enabled, true);
  assert.equal(pub.regions.length, 3);
  assert.equal(pub.lineTypes.length, 2);
  assert.equal(pub.trialEnabled, true);
  assert.equal(pub.features.channels, '60,000+');
});

test('extractHostFromUrl parses server host', () => {
  assert.equal(
    strong8k.extractHostFromUrl('http://cdn.example.com:8080/get.php?username=u&password=p'),
    'http://cdn.example.com:8080'
  );
});

test('retail trial blocked when email or phone already used', () => {
  const trials = readIptvTrials({
    iptvTrials: {
      emails: { 'a@test.com': { ts: 1 } },
      phones: {},
      resellerSubPhones: {}
    }
  });
  assert.match(trialBlockReason(trials, {
    email: 'a@test.com',
    phone: '+96179123456',
    isReseller: false,
    subCustomerPhone: ''
  }), /email/i);

  const trials2 = readIptvTrials({
    iptvTrials: {
      emails: {},
      phones: { '96179123456': { ts: 1 } },
      resellerSubPhones: {}
    }
  });
  assert.match(trialBlockReason(trials2, {
    email: 'b@test.com',
    phone: '+961 79 123 456',
    isReseller: false,
    subCustomerPhone: ''
  }), /phone/i);
});

test('reseller trial requires unique sub-customer phone', () => {
  const trials = readIptvTrials({
    iptvTrials: {
      emails: {},
      phones: {},
      resellerSubPhones: { '96170123456': { ts: 1 } }
    }
  });
  assert.match(trialBlockReason(trials, {
    email: 'reseller@test.com',
    phone: '+96179111111',
    isReseller: true,
    subCustomerPhone: '96170123456'
  }), /sub-customer phone/i);
  assert.equal(trialBlockReason(trials, {
    email: 'reseller@test.com',
    phone: '+96179111111',
    isReseller: true,
    subCustomerPhone: '96170999999'
  }), null);
});

test('reseller can select trial before sub-customer phone is entered', () => {
  const trials = readIptvTrials({ iptvTrials: { emails: {}, phones: {}, resellerSubPhones: {} } });
  const pending = trialEligibilityDetails(trials, {
    email: 'reseller@test.com',
    phone: '+96179111111',
    isReseller: true,
    subCustomerPhone: ''
  });
  assert.equal(pending.hardBlocked, false);
  assert.equal(pending.needsSubPhone, true);
  assert.equal(pending.eligible, false);

  const ready = trialEligibilityDetails(trials, {
    email: 'reseller@test.com',
    phone: '+96179111111',
    isReseller: true,
    subCustomerPhone: '+961 70 999 999'
  });
  assert.equal(ready.hardBlocked, false);
  assert.equal(ready.needsSubPhone, false);
  assert.equal(ready.eligible, true);
});

test('purchase handler does not redeclare isTrial when unpacking outcome', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../strong8kRoutes.js'), 'utf8');
  const start = src.indexOf("app.post('/purchase/strong8k'");
  assert.ok(start > -1);
  const end = src.indexOf("activeStrong8kPurchases.delete(lockKey);", start);
  assert.ok(end > start);
  const block = src.slice(start, end);
  assert.match(block, /const isTrial = Boolean\(req\.body\?\.trial\)/);
  assert.doesNotMatch(block, /const \{[^}]*\bisTrial\b[^}]*\} = outcome/);
});
