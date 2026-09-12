#!/usr/bin/env node
/**
 * Export rashadtech.tv database to a local JSON file.
 *
 * Option A — from production API (needs admin password):
 *   ADMIN2_PASSWORD=rashadtech2 node scripts/export-database.js --api
 *
 * Option B — direct from Netlify Blobs (needs env vars on this machine):
 *   NETLIFY_SITE_ID=... NETLIFY_BLOBS_TOKEN=... node scripts/export-database.js
 */
const fs = require('fs');
const path = require('path');

const SERVER = process.env.RT_SERVER || 'https://rashadtech-server.onrender.com';
const OUT_DIR = process.env.EXPORT_DIR || path.join(process.cwd(), 'exports');
const ADMIN2_PASSWORD = process.env.ADMIN2_PASSWORD || 'rashadtech2';

async function exportViaApi() {
  const loginRes = await fetch(`${SERVER}/auth/admin2-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN2_PASSWORD })
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.token) {
    throw new Error(login.error || 'Admin login failed');
  }

  const exportRes = await fetch(`${SERVER}/admin/export-database`, {
    headers: { Authorization: `Bearer ${login.token}` }
  });
  if (!exportRes.ok) {
    const err = await exportRes.json().catch(() => ({}));
    throw new Error(err.error || `Export failed (${exportRes.status})`);
  }

  const text = await exportRes.text();
  const source = exportRes.headers.get('X-Export-Source') || 'api';
  const statsHeader = exportRes.headers.get('X-Export-Stats');
  let stats = {};
  try { stats = JSON.parse(statsHeader || '{}'); } catch (e) {}

  return { text, source, stats };
}

async function exportViaNetlify() {
  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  const storeName = process.env.NETLIFY_DB_STORE || 'rashadtech-db';
  const dbKey = process.env.NETLIFY_DB_KEY || 'database';
  if (!siteId || !token) {
    throw new Error('Set NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN (or NETLIFY_TOKEN)');
  }

  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name: storeName, siteID: siteId, token });
  const raw = await store.get(dbKey, { type: 'text', consistency: 'strong' });
  if (!raw) throw new Error(`Blob not found: ${storeName}/${dbKey}`);
  return { text: raw, source: 'netlify-blobs-local', stats: {} };
}

async function main() {
  const useApi = process.argv.includes('--api') || !process.env.NETLIFY_SITE_ID;
  const result = useApi ? await exportViaApi() : await exportViaNetlify();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outfile = path.join(OUT_DIR, `rashadtech-database-${result.source}-${stamp}.json`);
  fs.writeFileSync(outfile, result.text, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch (e) {
    parsed = null;
  }

  const users = parsed && Array.isArray(parsed.users) ? parsed.users.length : result.stats.users;
  const stock = parsed && parsed.stock
    ? Object.values(parsed.stock).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0)
    : result.stats.stockAccounts;

  console.log(`Saved: ${outfile}`);
  console.log(`Source: ${result.source}`);
  console.log(`Users: ${users ?? '?'} · Stock accounts: ${stock ?? '?'}`);
  if (parsed && parsed.exportMeta) {
    console.log('Export meta:', JSON.stringify(parsed.exportMeta, null, 2));
  }
}

main().catch((e) => {
  console.error('Export failed:', e.message);
  process.exit(1);
});
