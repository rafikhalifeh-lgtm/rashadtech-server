#!/usr/bin/env node
/**
 * Convert rashadtech.tv JSON database export to MySQL-compatible SQL.
 *
 * Usage:
 *   node scripts/json-to-sql.js exports/rashadtech-database.json
 *   node scripts/json-to-sql.js --api
 */
const fs = require('fs');
const path = require('path');

const SERVER = process.env.RT_SERVER || 'https://rashadtech-server.onrender.com';
const ADMIN2_PASSWORD = process.env.ADMIN2_PASSWORD || 'rashadtech2';
const OUT_DIR = process.env.EXPORT_DIR || path.join(process.cwd(), 'exports');

function sqlEscape(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function sqlJson(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${JSON.stringify(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function lines() {
  return [];
}

function addSchema(out) {
  out.push('-- rashadtech.tv database SQL export');
  out.push('-- Generated from JSON document store (Netlify Blobs / Render)');
  out.push('-- Compatible with MySQL 8+ / MariaDB 10+');
  out.push('');
  out.push('SET NAMES utf8mb4;');
  out.push('SET FOREIGN_KEY_CHECKS = 0;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS users (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  email VARCHAR(255) NOT NULL,');
  out.push('  name VARCHAR(255) DEFAULT NULL,');
  out.push('  pass TEXT,');
  out.push('  balance DECIMAL(12,2) DEFAULT 0,');
  out.push('  verified TINYINT(1) DEFAULT 0,');
  out.push('  banned TINYINT(1) DEFAULT 0,');
  out.push('  tg_chat_id VARCHAR(64) DEFAULT NULL,');
  out.push('  is_reseller TINYINT(1) DEFAULT 0,');
  out.push('  signup_date VARCHAR(64) DEFAULT NULL,');
  out.push('  extra JSON DEFAULT NULL,');
  out.push('  UNIQUE KEY uq_users_email (email)');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS user_orders (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  user_email VARCHAR(255) NOT NULL,');
  out.push('  order_id VARCHAR(64) DEFAULT NULL,');
  out.push('  product VARCHAR(255) DEFAULT NULL,');
  out.push('  product_id VARCHAR(64) DEFAULT NULL,');
  out.push('  plan VARCHAR(255) DEFAULT NULL,');
  out.push('  price DECIMAL(12,2) DEFAULT NULL,');
  out.push('  account_email VARCHAR(255) DEFAULT NULL,');
  out.push('  account_pass TEXT,');
  out.push('  order_date VARCHAR(64) DEFAULT NULL,');
  out.push('  expiry_date VARCHAR(64) DEFAULT NULL,');
  out.push('  profile_name VARCHAR(255) DEFAULT NULL,');
  out.push('  profile_pin VARCHAR(64) DEFAULT NULL,');
  out.push('  fulfilled_externally TINYINT(1) DEFAULT 0,');
  out.push('  extra JSON DEFAULT NULL,');
  out.push('  KEY idx_user_orders_email (user_email),');
  out.push('  KEY idx_user_orders_order_id (order_id)');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS sub_customers (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  owner_email VARCHAR(255) NOT NULL,');
  out.push('  customer_id INT DEFAULT NULL,');
  out.push('  fname VARCHAR(255) DEFAULT NULL,');
  out.push('  lname VARCHAR(255) DEFAULT NULL,');
  out.push('  code VARCHAR(64) DEFAULT NULL,');
  out.push('  phone VARCHAR(64) DEFAULT NULL,');
  out.push('  tg_chat_id VARCHAR(64) DEFAULT NULL,');
  out.push('  extra JSON DEFAULT NULL,');
  out.push('  KEY idx_sub_customers_owner (owner_email)');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS sub_customer_orders (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  owner_email VARCHAR(255) NOT NULL,');
  out.push('  customer_id INT DEFAULT NULL,');
  out.push('  order_id VARCHAR(64) DEFAULT NULL,');
  out.push('  product VARCHAR(255) DEFAULT NULL,');
  out.push('  plan VARCHAR(255) DEFAULT NULL,');
  out.push('  price DECIMAL(12,2) DEFAULT NULL,');
  out.push('  account_email VARCHAR(255) DEFAULT NULL,');
  out.push('  account_pass TEXT,');
  out.push('  order_date VARCHAR(64) DEFAULT NULL,');
  out.push('  expiry_date VARCHAR(64) DEFAULT NULL,');
  out.push('  extra JSON DEFAULT NULL,');
  out.push('  KEY idx_sub_customer_orders_owner (owner_email)');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS stock_accounts (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  skey VARCHAR(255) NOT NULL,');
  out.push('  email VARCHAR(255) DEFAULT NULL,');
  out.push('  pass TEXT,');
  out.push('  used TINYINT(1) DEFAULT 0,');
  out.push('  expiry_date VARCHAR(64) DEFAULT NULL,');
  out.push('  profile_pin VARCHAR(64) DEFAULT NULL,');
  out.push('  acc_key VARCHAR(128) DEFAULT NULL,');
  out.push('  main_email VARCHAR(255) DEFAULT NULL,');
  out.push('  extra JSON DEFAULT NULL,');
  out.push('  KEY idx_stock_skey (skey),');
  out.push('  KEY idx_stock_email (email)');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS stock_blocks (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  block_type ENUM(\'reseller\',\'retail\') NOT NULL DEFAULT \'reseller\',');
  out.push('  skey VARCHAR(255) NOT NULL,');
  out.push('  blocked TINYINT(1) DEFAULT 1,');
  out.push('  blocked_at BIGINT DEFAULT NULL,');
  out.push('  UNIQUE KEY uq_stock_blocks (block_type, skey)');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS pending_orders (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  order_id VARCHAR(64) DEFAULT NULL,');
  out.push('  user_email VARCHAR(255) DEFAULT NULL,');
  out.push('  user_name VARCHAR(255) DEFAULT NULL,');
  out.push('  product VARCHAR(255) DEFAULT NULL,');
  out.push('  product_id VARCHAR(64) DEFAULT NULL,');
  out.push('  plan VARCHAR(255) DEFAULT NULL,');
  out.push('  price DECIMAL(12,2) DEFAULT NULL,');
  out.push('  skey VARCHAR(255) DEFAULT NULL,');
  out.push('  order_date VARCHAR(64) DEFAULT NULL,');
  out.push('  extra JSON DEFAULT NULL,');
  out.push('  KEY idx_pending_user (user_email)');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS topup_requests (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  request_id VARCHAR(64) DEFAULT NULL,');
  out.push('  email VARCHAR(255) DEFAULT NULL,');
  out.push('  amount DECIMAL(12,2) DEFAULT NULL,');
  out.push('  status VARCHAR(64) DEFAULT NULL,');
  out.push('  request_date VARCHAR(64) DEFAULT NULL,');
  out.push('  extra JSON DEFAULT NULL,');
  out.push('  KEY idx_topup_email (email)');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS product_requests (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  request_id VARCHAR(64) DEFAULT NULL,');
  out.push('  email VARCHAR(255) DEFAULT NULL,');
  out.push('  request_type VARCHAR(64) DEFAULT NULL,');
  out.push('  product VARCHAR(255) DEFAULT NULL,');
  out.push('  resolved TINYINT(1) DEFAULT 0,');
  out.push('  request_date VARCHAR(64) DEFAULT NULL,');
  out.push('  extra JSON DEFAULT NULL');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS game_orders (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  order_id VARCHAR(64) DEFAULT NULL,');
  out.push('  user_email VARCHAR(255) DEFAULT NULL,');
  out.push('  product VARCHAR(255) DEFAULT NULL,');
  out.push('  price DECIMAL(12,2) DEFAULT NULL,');
  out.push('  status VARCHAR(64) DEFAULT NULL,');
  out.push('  order_date VARCHAR(64) DEFAULT NULL,');
  out.push('  extra JSON DEFAULT NULL');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS sms_orders (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  order_id VARCHAR(64) DEFAULT NULL,');
  out.push('  user_email VARCHAR(255) DEFAULT NULL,');
  out.push('  service VARCHAR(255) DEFAULT NULL,');
  out.push('  price DECIMAL(12,2) DEFAULT NULL,');
  out.push('  status VARCHAR(64) DEFAULT NULL,');
  out.push('  order_date VARCHAR(64) DEFAULT NULL,');
  out.push('  extra JSON DEFAULT NULL');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS gmail_monitors (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  inbox_email VARCHAR(255) NOT NULL,');
  out.push('  gmail_user VARCHAR(255) DEFAULT NULL,');
  out.push('  gmail_pass TEXT,');
  out.push('  last_uid BIGINT DEFAULT NULL,');
  out.push('  last_checked_at BIGINT DEFAULT NULL,');
  out.push('  extra JSON DEFAULT NULL,');
  out.push('  UNIQUE KEY uq_gmail_inbox (inbox_email)');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS link_tokens (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  token VARCHAR(128) NOT NULL,');
  out.push('  payload JSON DEFAULT NULL,');
  out.push('  UNIQUE KEY uq_link_tokens (token)');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS json_configs (');
  out.push('  config_key VARCHAR(128) PRIMARY KEY,');
  out.push('  config_value JSON NOT NULL');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS activity_log (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  action VARCHAR(255) DEFAULT NULL,');
  out.push('  details TEXT,');
  out.push('  actor VARCHAR(255) DEFAULT NULL,');
  out.push('  ts BIGINT DEFAULT NULL,');
  out.push('  time_label VARCHAR(64) DEFAULT NULL');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
  out.push('CREATE TABLE IF NOT EXISTS reseller_applications (');
  out.push('  id INT AUTO_INCREMENT PRIMARY KEY,');
  out.push('  payload JSON NOT NULL');
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  out.push('');
}

function pickExtra(obj, knownKeys) {
  const extra = { ...(obj || {}) };
  knownKeys.forEach((k) => delete extra[k]);
  return Object.keys(extra).length ? extra : null;
}

function convertJsonToSql(data, options = {}) {
  const out = [];
  const meta = data.exportMeta || options.meta || {};
  delete data.exportMeta;

  addSchema(out);
  out.push('-- Export source:', sqlEscape(meta.source || 'unknown'));
  out.push('-- Exported at:', sqlEscape(meta.exportedAt || new Date().toISOString()));
  out.push('');

  const users = Array.isArray(data.users) ? data.users : [];
  for (const user of users) {
    const known = ['email', 'name', 'pass', 'balance', 'verified', 'banned', 'tgChatId', 'isReseller', 'date', 'orders', 'myCustomers'];
    const extra = pickExtra(user, known);
    out.push(
      'INSERT INTO users (email, name, pass, balance, verified, banned, tg_chat_id, is_reseller, signup_date, extra) VALUES ('
      + [
        sqlEscape(user.email),
        sqlEscape(user.name),
        sqlEscape(user.pass),
        sqlEscape(user.balance ?? 0),
        sqlEscape(Boolean(user.verified)),
        sqlEscape(Boolean(user.banned)),
        sqlEscape(user.tgChatId || null),
        sqlEscape(Boolean(user.isReseller)),
        sqlEscape(user.date || null),
        extra ? sqlJson(extra) : 'NULL'
      ].join(', ') + ');'
    );

    for (const order of Array.isArray(user.orders) ? user.orders : []) {
      const orderKnown = ['id', 'product', 'productId', 'plan', 'price', 'email', 'pass', 'date', 'expiryDate', 'profileName', 'profilePin', 'fulfilledExternally'];
      const orderExtra = pickExtra(order, orderKnown);
      out.push(
        'INSERT INTO user_orders (user_email, order_id, product, product_id, plan, price, account_email, account_pass, order_date, expiry_date, profile_name, profile_pin, fulfilled_externally, extra) VALUES ('
        + [
          sqlEscape(user.email),
          sqlEscape(order.id),
          sqlEscape(order.product),
          sqlEscape(order.productId),
          sqlEscape(order.plan),
          sqlEscape(order.price),
          sqlEscape(order.email),
          sqlEscape(order.pass),
          sqlEscape(order.date),
          sqlEscape(order.expiryDate),
          sqlEscape(order.profileName),
          sqlEscape(order.profilePin),
          sqlEscape(Boolean(order.fulfilledExternally)),
          orderExtra ? sqlJson(orderExtra) : 'NULL'
        ].join(', ') + ');'
      );
    }

    for (const customer of Array.isArray(user.myCustomers) ? user.myCustomers : []) {
      const custKnown = ['id', 'fname', 'lname', 'code', 'phone', 'tgChatId', 'subs'];
      const custExtra = pickExtra(customer, custKnown);
      out.push(
        'INSERT INTO sub_customers (owner_email, customer_id, fname, lname, code, phone, tg_chat_id, extra) VALUES ('
        + [
          sqlEscape(user.email),
          sqlEscape(customer.id),
          sqlEscape(customer.fname),
          sqlEscape(customer.lname),
          sqlEscape(customer.code),
          sqlEscape(customer.phone),
          sqlEscape(customer.tgChatId),
          custExtra ? sqlJson(custExtra) : 'NULL'
        ].join(', ') + ');'
      );

      for (const order of Array.isArray(customer.subs) ? customer.subs : []) {
        const orderKnown = ['id', 'product', 'plan', 'price', 'email', 'pass', 'date', 'expiryDate'];
        const orderExtra = pickExtra(order, orderKnown);
        out.push(
          'INSERT INTO sub_customer_orders (owner_email, customer_id, order_id, product, plan, price, account_email, account_pass, order_date, expiry_date, extra) VALUES ('
          + [
            sqlEscape(user.email),
            sqlEscape(customer.id),
            sqlEscape(order.id),
            sqlEscape(order.product),
            sqlEscape(order.plan),
            sqlEscape(order.price),
            sqlEscape(order.email),
            sqlEscape(order.pass),
            sqlEscape(order.date),
            sqlEscape(order.expiryDate),
            orderExtra ? sqlJson(orderExtra) : 'NULL'
          ].join(', ') + ');'
        );
      }
    }
  }

  for (const [skey, accounts] of Object.entries(data.stock || {})) {
    for (const acc of Array.isArray(accounts) ? accounts : []) {
      const accKnown = ['email', 'pass', 'used', 'expiryDate', 'profilePin', 'accKey', 'mainEmail'];
      const accExtra = pickExtra(acc, accKnown);
      out.push(
        'INSERT INTO stock_accounts (skey, email, pass, used, expiry_date, profile_pin, acc_key, main_email, extra) VALUES ('
        + [
          sqlEscape(skey),
          sqlEscape(acc.email),
          sqlEscape(acc.pass),
          sqlEscape(Boolean(acc.used)),
          sqlEscape(acc.expiryDate),
          sqlEscape(acc.profilePin),
          sqlEscape(acc.accKey),
          sqlEscape(acc.mainEmail),
          accExtra ? sqlJson(accExtra) : 'NULL'
        ].join(', ') + ');'
      );
    }
  }

  for (const [skey, block] of Object.entries(data.stockBlocks || {})) {
    out.push(
      'INSERT INTO stock_blocks (block_type, skey, blocked, blocked_at) VALUES ('
      + [
        sqlEscape('reseller'),
        sqlEscape(skey),
        sqlEscape(Boolean(block && block.blocked)),
        sqlEscape(block && block.ts)
      ].join(', ') + ');'
    );
  }

  for (const [skey, block] of Object.entries(data.retailStockBlocks || {})) {
    out.push(
      'INSERT INTO stock_blocks (block_type, skey, blocked, blocked_at) VALUES ('
      + [
        sqlEscape('retail'),
        sqlEscape(skey),
        sqlEscape(Boolean(block && block.blocked)),
        sqlEscape(block && block.ts)
      ].join(', ') + ');'
    );
  }

  for (const po of Array.isArray(data.pending) ? data.pending : []) {
    const known = ['id', 'userEmail', 'userName', 'product', 'productId', 'plan', 'price', 'skey', 'date'];
    const extra = pickExtra(po, known);
    out.push(
      'INSERT INTO pending_orders (order_id, user_email, user_name, product, product_id, plan, price, skey, order_date, extra) VALUES ('
      + [
        sqlEscape(po.id),
        sqlEscape(po.userEmail),
        sqlEscape(po.userName),
        sqlEscape(po.product),
        sqlEscape(po.productId),
        sqlEscape(po.plan),
        sqlEscape(po.price),
        sqlEscape(po.skey),
        sqlEscape(po.date),
        extra ? sqlJson(extra) : 'NULL'
      ].join(', ') + ');'
    );
  }

  for (const row of Array.isArray(data.topupreqs) ? data.topupreqs : []) {
    const known = ['id', 'email', 'amount', 'status', 'date'];
    const extra = pickExtra(row, known);
    out.push(
      'INSERT INTO topup_requests (request_id, email, amount, status, request_date, extra) VALUES ('
      + [
        sqlEscape(row.id),
        sqlEscape(row.email),
        sqlEscape(row.amount),
        sqlEscape(row.status),
        sqlEscape(row.date),
        extra ? sqlJson(extra) : 'NULL'
      ].join(', ') + ');'
    );
  }

  for (const row of Array.isArray(data.requests) ? data.requests : []) {
    const known = ['id', 'email', 'type', 'product', 'resolved', 'date'];
    const extra = pickExtra(row, known);
    out.push(
      'INSERT INTO product_requests (request_id, email, request_type, product, resolved, request_date, extra) VALUES ('
      + [
        sqlEscape(row.id),
        sqlEscape(row.email),
        sqlEscape(row.type),
        sqlEscape(row.product),
        sqlEscape(Boolean(row.resolved)),
        sqlEscape(row.date),
        extra ? sqlJson(extra) : 'NULL'
      ].join(', ') + ');'
    );
  }

  for (const row of Array.isArray(data.gameorders) ? data.gameorders : []) {
    const known = ['id', 'userEmail', 'product', 'price', 'status', 'date'];
    const extra = pickExtra(row, known);
    out.push(
      'INSERT INTO game_orders (order_id, user_email, product, price, status, order_date, extra) VALUES ('
      + [
        sqlEscape(row.id),
        sqlEscape(row.userEmail),
        sqlEscape(row.product),
        sqlEscape(row.price),
        sqlEscape(row.status),
        sqlEscape(row.date),
        extra ? sqlJson(extra) : 'NULL'
      ].join(', ') + ');'
    );
  }

  for (const row of Array.isArray(data.smsorders) ? data.smsorders : []) {
    const known = ['id', 'userEmail', 'service', 'price', 'status', 'date'];
    const extra = pickExtra(row, known);
    out.push(
      'INSERT INTO sms_orders (order_id, user_email, service, price, status, order_date, extra) VALUES ('
      + [
        sqlEscape(row.id),
        sqlEscape(row.userEmail),
        sqlEscape(row.service),
        sqlEscape(row.price),
        sqlEscape(row.status),
        sqlEscape(row.date),
        extra ? sqlJson(extra) : 'NULL'
      ].join(', ') + ');'
    );
  }

  for (const [inboxEmail, monitor] of Object.entries(data.gmailMonitors || {})) {
    const known = ['user', 'pass', 'lastUid', 'lastCheckedAt'];
    const extra = pickExtra(monitor, known);
    out.push(
      'INSERT INTO gmail_monitors (inbox_email, gmail_user, gmail_pass, last_uid, last_checked_at, extra) VALUES ('
      + [
        sqlEscape(inboxEmail),
        sqlEscape(monitor && monitor.user),
        sqlEscape(monitor && monitor.pass),
        sqlEscape(monitor && monitor.lastUid),
        sqlEscape(monitor && monitor.lastCheckedAt),
        extra ? sqlJson(extra) : 'NULL'
      ].join(', ') + ');'
    );
  }

  for (const [token, payload] of Object.entries(data.linkTokens || {})) {
    out.push(
      'INSERT INTO link_tokens (token, payload) VALUES ('
      + [sqlEscape(token), sqlJson(payload)] .join(', ') + ');'
    );
  }

  const configKeys = [
    'siteSettings',
    'smsConfig',
    'strong8kConfig',
    'iptvTrials',
    'priceCatalog',
    'retailPriceCatalog',
    'priceChangeLog',
    'revokedLinks',
    'sessions',
    'emergencyDb'
  ];
  for (const key of configKeys) {
    if (data[key] !== undefined && data[key] !== null) {
      out.push(`INSERT INTO json_configs (config_key, config_value) VALUES (${sqlEscape(key)}, ${sqlJson(data[key])});`);
    }
  }

  for (const row of Array.isArray(data.activityLog) ? data.activityLog : []) {
    out.push(
      'INSERT INTO activity_log (action, details, actor, ts, time_label) VALUES ('
      + [
        sqlEscape(row.action),
        sqlEscape(typeof row.details === 'string' ? row.details : JSON.stringify(row.details || '')),
        sqlEscape(row.actor),
        sqlEscape(row.ts),
        sqlEscape(row.time)
      ].join(', ') + ');'
    );
  }

  for (const row of Array.isArray(data.resellerApplications) ? data.resellerApplications : []) {
    out.push(`INSERT INTO reseller_applications (payload) VALUES (${sqlJson(row)});`);
  }

  out.push('');
  out.push('SET FOREIGN_KEY_CHECKS = 1;');
  out.push('');
  return out.join('\n');
}

async function loadJsonInput(argv) {
  if (argv.includes('--api')) {
    const loginRes = await fetch(`${SERVER}/auth/admin2-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN2_PASSWORD })
    });
    const login = await loginRes.json();
    if (!loginRes.ok || !login.token) throw new Error(login.error || 'Admin login failed');
    const exportRes = await fetch(`${SERVER}/admin/export-database`, {
      headers: { Authorization: `Bearer ${login.token}` }
    });
    if (!exportRes.ok) {
      const err = await exportRes.json().catch(() => ({}));
      throw new Error(err.error || `Export failed (${exportRes.status})`);
    }
    return JSON.parse(await exportRes.text());
  }

  const fileArg = argv.find(a => !a.startsWith('-') && a.endsWith('.json'));
  const input = fileArg || path.join(OUT_DIR, fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json')).sort().pop() || '');
  if (!input || !fs.existsSync(input)) throw new Error('Provide a JSON export path or run with --api');
  return JSON.parse(fs.readFileSync(input, 'utf8'));
}

async function main() {
  const data = await loadJsonInput(process.argv.slice(2));
  const sql = convertJsonToSql(data);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outfile = path.join(OUT_DIR, `rashadtech-database-${stamp}.sql`);
  fs.writeFileSync(outfile, sql, 'utf8');
  console.log(`Saved: ${outfile}`);
  console.log(`Size: ${fs.statSync(outfile).size} bytes`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('SQL export failed:', e.message);
    process.exit(1);
  });
}

module.exports = { convertJsonToSql, sqlEscape, sqlJson };
