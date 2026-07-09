const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.RT_SERVER || 'https://rashadtech-server.onrender.com';

async function getJson(path, maxMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maxMs);
  try {
    const started = Date.now();
    const r = await fetch(`${BASE}${path}`, { signal: controller.signal, cache: 'no-store' });
    const ms = Date.now() - started;
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j, ms };
  } finally {
    clearTimeout(timer);
  }
}

test('ping responds quickly', async () => {
  const res = await getJson('/ping', 8000);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.ms < 5000, `ping too slow: ${res.ms}ms`);
});

test('health returns checks', async () => {
  const res = await getJson('/health', 15000);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.checks);
});

test('storefront catalog loads', async () => {
  const res = await getJson('/catalog/storefront', 20000);
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.ok(res.json.catalog && res.json.catalog.prices);
});

test('site contact loads', async () => {
  const res = await getJson('/site/contact', 10000);
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.ok(res.json.contact && res.json.contact.whatsappE164);
});

test('legacy sublink returns 404 for missing order', async () => {
  const res = await getJson('/links/legacy/missing-order-xyz', 15000);
  assert.equal(res.status, 404);
});

test('invalid token link returns 404', async () => {
  const res = await getJson('/links/not-a-valid-token', 15000);
  assert.equal(res.status, 404);
});
