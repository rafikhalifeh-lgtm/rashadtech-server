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
  assert.equal(pub.sellPackages.length, 4);
});

test('computeSellPackagePrice sums add-ons and respects exclusive full package', () => {
  const config = {
    regions: {
      me: { id: 'me', name: 'Middle East', packId: '75605' },
      eu: { id: 'eu', name: 'Europe', packId: '75604' },
      us: { id: 'us', name: 'United States', packId: '75606' }
    },
    sellPackages: [
      { id: 'full', name: 'Full', bouquetIds: '', bouquetIdsByRegion: { me: '75605', eu: '75604', us: '75606' }, prices: { 1: 8, 3: 20, 6: 35, 12: 60 }, monthlyPrice: 8, exclusive: true, enabled: true },
      { id: 'lebanese', name: 'Lebanese', bouquetIds: '4', bouquetIdsByRegion: {}, prices: { 1: 3, 3: 8, 6: 14, 12: 25 }, monthlyPrice: 3, exclusive: false, enabled: true },
      { id: 'bein', name: 'beIN', bouquetIds: '75610', bouquetIdsByRegion: {}, prices: { 1: 5, 3: 13, 6: 22, 12: 38 }, monthlyPrice: 5, exclusive: false, enabled: true }
    ]
  };
  assert.equal(strong8k.computeSellPackagePrice(['lebanese', 'bein'], 1, config), 8);
  assert.equal(strong8k.computeSellPackagePrice(['lebanese', 'bein'], 3, config), 21);
  assert.equal(strong8k.computeSellPackagePrice(['full', 'bein'], 1, config), 8);
  assert.equal(strong8k.computeSellPackagePrice(['full'], 3, config), 20);
  assert.equal(strong8k.resolvePackFromSellPackages(['lebanese', 'bein'], config, 'me'), '4,75610');
  assert.equal(strong8k.resolvePackFromSellPackages(['full'], config, 'me'), '75605');
  assert.equal(strong8k.resolveSellPackageBouquetIds(config.sellPackages[0], 'eu', config), '75604');
  assert.equal(strong8k.describeSellPackageSelection(['lebanese', 'bein'], config), 'Lebanese + beIN');
});

test('buildTrialPackAttemptsFromList uses only live panel bouquet ids', () => {
  const bouquets = [
    { id: '100', name: 'Full Middle East' },
    { id: '200', name: 'Full United States' },
    { id: '300', name: 'Streaming' }
  ];
  const attempts = strong8k.buildTrialPackAttemptsFromList(bouquets, {}, 'me');
  assert.equal(attempts[0], 'all');
  assert.equal(attempts[1], '100');
  assert.ok(attempts.includes('200'));
  assert.ok(attempts.includes('300'));
  assert.ok(attempts.includes(strong8k.OMIT_PANEL_PACK));
  assert.ok(!attempts.includes('75605'));
});

test('sanitizeSellPackages restores missing default packages like Lebanese', () => {
  const saved = [
    { id: 'full', name: 'Full Package', bouquetIds: '', bouquetIdsByRegion: { me: '100' }, prices: { 1: 8, 3: 20, 6: 35, 12: 60 }, exclusive: true, enabled: true },
    { id: 'streaming', name: 'Streaming', bouquetIds: '300', bouquetIdsByRegion: {}, prices: { 1: 4, 3: 10, 6: 18, 12: 32 }, exclusive: false, enabled: true },
    { id: 'bein', name: 'beIN', bouquetIds: '400', bouquetIdsByRegion: {}, prices: { 1: 5, 3: 13, 6: 22, 12: 38 }, exclusive: false, enabled: true }
  ];
  const merged = strong8k.sanitizeSellPackages(saved);
  assert.equal(merged.length, 4);
  assert.ok(merged.some(pkg => pkg.id === 'lebanese'));
});

test('resolvePanelPack uses single region full bouquet for free trial', async () => {
  const config = {
    panelUrl: 'https://panel.example.com',
    apiKey: 'secret',
    packageId: 'all',
    regions: {
      me: { id: 'me', name: 'Middle East', packId: '75605,75609,75610' },
      eu: { id: 'eu', name: 'Europe', packId: '75604' },
      us: { id: 'us', name: 'United States', packId: '75606' }
    },
    sellPackages: [
      {
        id: 'full',
        name: 'Full',
        bouquetIds: '',
        bouquetIdsByRegion: { me: '75605', eu: '75604', us: '75606' },
        prices: { 1: 8, 3: 20, 6: 35, 12: 60 },
        monthlyPrice: 8,
        exclusive: true,
        enabled: true
      },
      { id: 'streaming', name: 'Streaming', bouquetIds: '75609', bouquetIdsByRegion: {}, prices: { 1: 4, 3: 10, 6: 18, 12: 32 }, monthlyPrice: 4, exclusive: false, enabled: true }
    ]
  };
  const paidPack = await strong8k.resolvePanelPack(config, { region: 'me', packageIds: ['streaming'], isTrial: false });
  assert.equal(paidPack, '75609');
  await assert.rejects(
    () => strong8k.resolvePanelPack(config, { region: 'eu', packageIds: [], isTrial: true }),
    /only available for Middle East or United States/i
  );
});

test('trial bouquet falls back to built-in ME/US defaults when admin bouquets unset', async () => {
  const config = {
    panelUrl: 'https://panel.example.com',
    apiKey: 'secret',
    packageId: 'all',
    regions: {
      me: { id: 'me', name: 'Middle East', packId: 'all' },
      us: { id: 'us', name: 'United States', packId: 'all' }
    },
    sellPackages: [
      { id: 'full', name: 'Full Package', bouquetIds: '', bouquetIdsByRegion: {}, prices: { 1: 8, 3: 20, 6: 35, 12: 60 }, exclusive: true, enabled: true }
    ]
  };
  const sanitized = strong8k.sanitizeSellPackages(config.sellPackages);
  assert.equal(sanitized[0].bouquetIdsByRegion.me, '75605');
  assert.equal(sanitized[0].bouquetIdsByRegion.us, '75606');
  assert.equal(strong8k.resolveTrialPackBouquetSync(config, 'me'), '75605');
  assert.equal(strong8k.resolveTrialPackBouquetSync(config, 'us'), '75606');
  assert.equal(strong8k.resolveTrialPackBouquetSync(config, 'eu'), '');
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

test('formatPanelUrlForDisplay shows clean panel domain in admin', () => {
  assert.equal(
    strong8k.formatPanelUrlForDisplay('https://8k.cms-only.ru/api/api.php'),
    'https://8k.cms-only.ru'
  );
  assert.equal(
    strong8k.normalizePanelUrl('https://8k.cms-only.ru'),
    'https://8k.cms-only.ru/api/api.php'
  );
});

test('normalizeBouquetList parses wrapped and keyed bouquet responses', () => {
  assert.deepEqual(strong8k.normalizeBouquetList([
    { id: '1', name: 'Full' }
  ]).map(b => b.id), ['1']);

  assert.deepEqual(strong8k.normalizeBouquetList({
    status: 'true',
    bouquets: [{ id: '2', bouquet_name: 'Sports' }]
  }).map(b => b.id), ['2']);

  assert.deepEqual(strong8k.normalizeBouquetList({
    '0': { id: '3', name: 'Arabic' },
    '1': { id: '4', name: 'Europe' },
    status: 'true'
  }).map(b => b.id), ['3', '4']);
});

test('formatBouquetRows keeps bouquet id and display name', () => {
  const rows = strong8k.formatBouquetRows([
    { bouquet_id: '7', bouquet_name: 'World Cup' }
  ]);
  assert.equal(rows[0].id, '7');
  assert.equal(rows[0].name, 'World Cup');
});
test('joinBouquetIds builds comma-separated bouquet list for panel API', () => {
  assert.equal(strong8k.joinBouquetIds([
    { id: '12', name: 'Full' },
    { id: '34', name: 'Sports' }
  ]), '12,34');
  assert.equal(strong8k.joinBouquetIds([]), '');
});

test('isWildcardPack detects unset or all package ids', () => {
  assert.equal(strong8k.isWildcardPack('all'), true);
  assert.equal(strong8k.isWildcardPack('ALL'), true);
  assert.equal(strong8k.isWildcardPack(''), true);
  assert.equal(strong8k.isWildcardPack('12,34'), false);
  assert.equal(strong8k.isWildcardPack('99'), false);
});

test('findBouquetForRegion matches panel bouquet names and saved config ids', () => {
  const bouquets = [
    { id: '75605', name: 'Full Middle East' },
    { id: '75604', name: 'Full Europe' },
    { id: '75606', name: 'Full United States' },
    { id: '75609', name: 'Streaming Apps' }
  ];
  assert.equal(strong8k.findBouquetForRegion(bouquets, 'me'), '75605');
  assert.equal(strong8k.findBouquetForRegion(bouquets, 'us'), '75606');
  const config = {
    regions: { me: { id: 'me', packId: 'all' } },
    sellPackages: [{ id: 'full', exclusive: true, bouquetIdsByRegion: { me: '75605' }, enabled: true, name: 'Full' }]
  };
  assert.equal(strong8k.findBouquetForRegion([{ id: '75605', name: 'Package A' }], 'me', config), '75605');
});

test('applyPanelBouquetsToConfig writes region and full package ids from panel', () => {
  const config = { regions: {}, sellPackages: [{ id: 'full', name: 'Full Package', exclusive: true, enabled: true, bouquetIdsByRegion: {} }] };
  const bouquets = [
    { id: '100', name: 'Full Middle East' },
    { id: '200', name: 'Full United States' }
  ];
  const next = strong8k.applyPanelBouquetsToConfig(config, bouquets);
  assert.equal(next.regions.me.packId, '100');
  assert.equal(next.regions.us.packId, '200');
  assert.equal(next.sellPackages[0].bouquetIdsByRegion.me, '100');
  assert.equal(next.sellPackages[0].bouquetIdsByRegion.us, '200');
});

test('panelErrorMessage passes through panel subscription errors', () => {
  const msg = strong8k.panelErrorMessage({ status: 'false', message: 'Subscription package not found' }, 'fallback');
  assert.equal(msg, 'Subscription package not found');
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
