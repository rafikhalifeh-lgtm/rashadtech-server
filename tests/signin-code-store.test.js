const assert = require('assert');

function scopedSignInCodeKey(key, service) {
  const normalized = String(key || '').trim().toLowerCase();
  if (!normalized) return '';
  return `${normalized}::${service}`;
}

function createStore(CODE_TTL_MS) {
  const latestCodes = {};
  function isSignInCodeFresh(timestamp) {
    return Date.now() - Number(timestamp || 0) <= CODE_TTL_MS;
  }
  function storeSignInCode(recipientKeys, code, service, receivedAt) {
    const ts = Number(receivedAt || Date.now());
    if (!isSignInCodeFresh(ts)) return false;
    const entry = { code, timestamp: ts, service };
    let stored = false;
    (recipientKeys || []).forEach((key) => {
      const scoped = scopedSignInCodeKey(key, service);
      const prev = latestCodes[scoped];
      if (prev && prev.timestamp >= ts) return;
      latestCodes[scoped] = entry;
      stored = true;
    });
    return stored;
  }
  return { latestCodes, storeSignInCode };
}

const CODE_TTL_MS = 15 * 60 * 1000;
const { latestCodes, storeSignInCode } = createStore(CODE_TTL_MS);

assert.strictEqual(storeSignInCode(['a@b.com'], '1234', 'osn', Date.now() - 20 * 60 * 1000), false);
assert.strictEqual(storeSignInCode(['a@b.com'], '1234', 'osn', Date.now() - 60 * 1000), true);
assert.strictEqual(latestCodes['a@b.com::osn'].code, '1234');

const fiveMinAgo = Date.now() - 5 * 60 * 1000;
const oneMinAgo = Date.now() - 60 * 1000;
storeSignInCode(['b@b.com'], '9999', 'osn', fiveMinAgo);
storeSignInCode(['b@b.com'], '1111', 'osn', oneMinAgo);
assert.strictEqual(latestCodes['b@b.com::osn'].code, '1111');

console.log('✓ sign-in code store tests passed');
