const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { registerEnhancements } = require('./enhancements');

const app = express();
const ALLOWED_ORIGINS = new Set([
  'https://rashadtech.tv',
  'https://www.rashadtech.tv',
  'https://rashadtechtv.netlify.app',
  'https://rashadtech-server.onrender.com'
]);
app.use(cors({
  origin(origin, cb) {
    try {
      if (!origin || ALLOWED_ORIGINS.has(origin) || /\.netlify\.app$/.test(new URL(origin).hostname)) return cb(null, true);
    } catch(e) {}
    cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function normalizeEnvSecret(value) {
  let secret = String(value || '').trim();
  if ((secret.startsWith('"') && secret.endsWith('"')) || (secret.startsWith("'") && secret.endsWith("'"))) {
    secret = secret.slice(1, -1).trim();
  }
  // Some dashboards/CLI copy flows leave shell escaping in bcrypt-style keys.
  return secret.replace(/\\\$/g, '$');
}

const API_SECRET = normalizeEnvSecret(process.env.API_SECRET);
const TG_TOKEN   = normalizeEnvSecret(process.env.TG_TOKEN);
const TG_ADMIN   = normalizeEnvSecret(process.env.TG_ADMIN);
const JB_KEY     = normalizeEnvSecret(process.env.JB_KEY);
const JB_BIN     = normalizeEnvSecret(process.env.JB_BIN);
const NETLIFY_SITE_ID = normalizeEnvSecret(process.env.NETLIFY_SITE_ID);
const NETLIFY_BLOBS_TOKEN = normalizeEnvSecret(process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN);
const NETLIFY_DB_STORE = normalizeEnvSecret(process.env.NETLIFY_DB_STORE) || 'rashadtech-db';
const NETLIFY_DB_KEY = normalizeEnvSecret(process.env.NETLIFY_DB_KEY) || 'database';
const NETLIFY_BACKUP_MANIFEST_KEY = normalizeEnvSecret(process.env.NETLIFY_BACKUP_MANIFEST_KEY) || `${NETLIFY_DB_KEY}-backup-manifest`;
const NETLIFY_BACKUP_PREFIX = normalizeEnvSecret(process.env.NETLIFY_BACKUP_PREFIX) || `${NETLIFY_DB_KEY}-backup-`;
const MAX_BACKUPS = Number(process.env.MAX_BACKUPS || 100);
const EMAILJS_SERVICE_ID = normalizeEnvSecret(process.env.EMAILJS_SERVICE_ID) || 'service_g05xq5o';
const EMAILJS_TEMPLATE_ID = normalizeEnvSecret(process.env.EMAILJS_TEMPLATE_ID) || 'template_e0h7eia';
const EMAILJS_PUBLIC_KEY = normalizeEnvSecret(process.env.EMAILJS_PUBLIC_KEY) || 'LyKu6ZB_y6qoFh7Ef';
const EMAILJS_PRIVATE_KEY = normalizeEnvSecret(process.env.EMAILJS_PRIVATE_KEY);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'RkhRkh7979@';
const ADMIN_PIN = process.env.ADMIN_PIN || '7979';
const JSONBIN_ALLOW_PUBLIC_READ = normalizeEnvSecret(process.env.JSONBIN_ALLOW_PUBLIC_READ) === 'true';
let FALLBACK_DB_FILE = process.env.FALLBACK_DB_FILE || (fs.existsSync('/var/data') ? '/var/data/rashadtech-db.json' : path.join(process.cwd(), '.data', 'emergency-db.json'));
const JSONBIN_SYNC_INTERVAL_MS = Number(process.env.JSONBIN_SYNC_INTERVAL_MS || 10 * 60 * 1000);
const GMAIL_MONITORS_KEY = 'gmailMonitors';
const BACKUPS_KEY = 'backups';
const LINK_TOKENS_KEY = 'linkTokens';
const CODE_TTL_MS = 15 * 60 * 1000;
const EMAIL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PASSWORD_HASH_PREFIX = 'pbkdf2$';
const ACCOUNT_SERVICE_UNAVAILABLE = 'Account service is temporarily unavailable. Please try again soon.';
const OTP_TTL_MS = 10 * 60 * 1000;

if (!API_SECRET || !TG_TOKEN || !TG_ADMIN) {
  console.error('❌ Missing required env vars: API_SECRET, TG_TOKEN, TG_ADMIN');
}

let latestCodes = {};
let notifiedCustomers = {};
let monitoredEmails = {}; // { gmailEmail: { user, pass, lastUid, lastCheckedAt } }
let gmailMonitorsLoaded = false;
let sessions = new Map();
let rateBuckets = new Map();
let dbCache = null;
let dbCacheLoadedAt = 0;
let dbDirty = false;
let dbSyncInFlight = false;
let dbLastSyncAttempt = 0;
let netlifyStorePromise = null;
let signupOtps = new Map();
let resetOtps = new Map();

function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const key = `${name}:${ip}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > limit) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    next();
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function uniqueNormalizedEmails(values) {
  return [...new Set((values || []).map(normalizeEmail).filter(Boolean))];
}

function normalizeGmailPassword(password) {
  // Google displays app passwords in groups; IMAP auth expects the raw 16 chars.
  return String(password || '').replace(/\s+/g, '');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `${PASSWORD_HASH_PREFIX}${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!String(stored).startsWith(PASSWORD_HASH_PREFIX)) return String(password) === String(stored);
  const [, salt, expected] = String(stored).split('$');
  if (!salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function setOtp(store, email, extra = {}) {
  const cleanEmail = normalizeEmail(email);
  const otp = generateOtp();
  store.set(cleanEmail, { otp, expiresAt: Date.now() + OTP_TTL_MS, ...extra });
  return otp;
}

function verifyOtp(store, email, otp) {
  const cleanEmail = normalizeEmail(email);
  const item = store.get(cleanEmail);
  if (!item || Date.now() > Number(item.expiresAt || 0) || String(item.otp) !== String(otp || '').trim()) return false;
  store.delete(cleanEmail);
  return true;
}

function emailJsTemplateParams(email, otp, name) {
  const recipient = normalizeEmail(email);
  const displayName = name || recipient;
  return {
    to_email: recipient,
    email: recipient,
    user_email: recipient,
    recipient,
    to_name: displayName,
    user_name: displayName,
    from_name: 'rashadtech.tv',
    otp_code: otp,
    verification_code: otp,
    passcode: otp,
    code: otp,
    otp,
    reset_code: otp,
    message: `Your rashadtech.tv verification code is ${otp}. It expires in 10 minutes.`,
    reply_to: recipient
  };
}

async function sendOtpEmail(email, otp, name) {
  const payload = {
    service_id: EMAILJS_SERVICE_ID,
    template_id: EMAILJS_TEMPLATE_ID,
    user_id: EMAILJS_PUBLIC_KEY,
    template_params: emailJsTemplateParams(email, otp, name)
  };
  if (EMAILJS_PRIVATE_KEY) payload.accessToken = EMAILJS_PRIVATE_KEY;
  const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Email OTP failed: ${r.status}${body ? ` — ${body}` : ''}`);
  }
}

async function deliverOtp({ email, otp, name, tgChatId, purpose }) {
  let emailSent = false;
  let telegramSent = false;
  try {
    await sendOtpEmail(email, otp, name);
    emailSent = true;
  } catch(e) {
    console.error(`${purpose || 'OTP'} email delivery error:`, e.message);
  }
  if (tgChatId) {
    try {
      await sendTG(String(tgChatId), `🔐 <b>Your rashadtech.tv verification code:</b>\n\n<b>${otp}</b>\n\nThis code expires in 10 minutes. Do not share it.`, 'HTML');
      telegramSent = true;
    } catch(e) {
      console.error(`${purpose || 'OTP'} Telegram delivery error:`, e.message);
    }
  }
  // Browser EmailJS fallback handles delivery when server email fails.
  return {
    emailSent,
    telegramSent,
    clientEmailRequired: !emailSent
  };
}

function linkEncryptionKey() {
  return crypto.createHash('sha256').update(API_SECRET || 'rashadtech-link-fallback').digest();
}

function encodeLinkToken(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', linkEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decodeLinkToken(token) {
  const raw = Buffer.from(String(token || ''), 'base64url');
  if (raw.length < 29) throw new Error('Invalid encrypted link token');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', linkEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  const payload = JSON.parse(decrypted);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid encrypted link payload');
  return payload;
}

function createSession(role, email) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { role, email: normalizeEmail(email), expiresAt: Date.now() + SESSION_TTL_MS });
  if (rtEnhancements && rtEnhancements.persistSessions) rtEnhancements.persistSessions().catch(() => {});
  return token;
}

function getSession(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(match[1]);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function requireSession(req, res, roles) {
  const session = getSession(req);
  if (!session || (roles && !roles.includes(session.role))) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return session;
}

function describeGmailError(error) {
  const raw = [
    error && error.message,
    error && error.response,
    error && error.responseText,
    error && error.serverResponse
  ].filter(Boolean).join(' ');
  const lower = raw.toLowerCase();

  if (lower.includes('invalid credentials') || lower.includes('authentication') || lower.includes('auth') || lower.includes('command failed')) {
    return 'Gmail rejected the login. Use the Gmail address and a 16-character Gmail App Password (not the normal Gmail password). Make sure 2-Step Verification is enabled and IMAP is enabled in Gmail settings.';
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return 'Gmail connection timed out. Try again and make sure IMAP is enabled for this Gmail account.';
  }
  if (lower.includes('certificate') || lower.includes('tls')) {
    return 'Could not make a secure IMAP connection to Gmail. Try again in a moment.';
  }
  return raw || 'Gmail setup failed. Use a Gmail App Password with IMAP enabled.';
}

function emptyDbData() {
  return {
    users: [],
    stock: {},
    stockBlocks: {},
    requests: [],
    topupreqs: [],
    pending: [],
    gameorders: [],
    [LINK_TOKENS_KEY]: {},
    [GMAIL_MONITORS_KEY]: {}
  };
}

function isJsonBinQuotaError(error) {
  const text = `${error && error.message || ''} ${error && error.body || ''}`.toLowerCase();
  return text.includes('requests exhausted') || text.includes('quota');
}

function createJsonBinError(action, status, body) {
  const error = new Error(`JSONBin ${action} failed: ${status}`);
  error.status = status;
  error.body = body || '';
  return error;
}

function readFallbackDb() {
  try {
    const raw = fs.readFileSync(FALLBACK_DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch(e) {
    if (e.code !== 'ENOENT') console.error('Emergency DB read error:', e.message);
  }
  return emptyDbData();
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data || emptyDbData()));
}

function setDbCache(data, dirty = dbDirty) {
  dbCache = cloneData(data);
  dbCacheLoadedAt = Date.now();
  dbDirty = Boolean(dirty);
}

function writeFallbackDb(data) {
  const writeTo = file => {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data || emptyDbData(), null, 2));
    fs.renameSync(tmp, file);
  };
  try {
    writeTo(FALLBACK_DB_FILE);
  } catch(e) {
    const safeFile = path.join(process.cwd(), '.data', 'emergency-db.json');
    if (FALLBACK_DB_FILE === safeFile) throw e;
    console.error(`Primary DB file ${FALLBACK_DB_FILE} is not writable; falling back to ${safeFile}:`, e.message);
    FALLBACK_DB_FILE = safeFile;
    writeTo(FALLBACK_DB_FILE);
  }
}

function saveLocalDb(data, dirty = true) {
  const next = cloneData(data);
  writeFallbackDb(next);
  setDbCache(next, dirty);
}

async function getNetlifyStore() {
  if (!NETLIFY_SITE_ID || !NETLIFY_BLOBS_TOKEN) return null;
  if (!netlifyStorePromise) {
    netlifyStorePromise = import('@netlify/blobs').then(({ getStore }) => getStore({
      name: NETLIFY_DB_STORE,
      siteID: NETLIFY_SITE_ID,
      token: NETLIFY_BLOBS_TOKEN
    }));
  }
  return netlifyStorePromise;
}

async function readNetlifyDb() {
  const store = await getNetlifyStore();
  if (!store) return null;
  const raw = await store.get(NETLIFY_DB_KEY, { type: 'text', consistency: 'strong' });
  if (!raw) return null;
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

async function writeNetlifyDb(data) {
  const store = await getNetlifyStore();
  if (!store) throw new Error('Netlify database is not configured');
  await store.set(NETLIFY_DB_KEY, JSON.stringify(data || emptyDbData()), {
    metadata: { updatedAt: new Date().toISOString() }
  });
}

function backupSummary(data) {
  const stock = data && data.stock ? data.stock : {};
  return {
    users: Array.isArray(data && data.users) ? data.users.length : 0,
    stockKeys: Object.keys(stock).length,
    stockAccounts: Object.values(stock).reduce((sum, accounts) => sum + (Array.isArray(accounts) ? accounts.length : 0), 0),
    pending: Array.isArray(data && data.pending) ? data.pending.length : 0,
    gameorders: Array.isArray(data && data.gameorders) ? data.gameorders.length : 0,
    topupreqs: Array.isArray(data && data.topupreqs) ? data.topupreqs.length : 0
  };
}

async function readBackupManifest() {
  const store = await getNetlifyStore();
  if (!store) return [];
  const raw = await store.get(NETLIFY_BACKUP_MANIFEST_KEY, { type: 'text', consistency: 'strong' }).catch(() => null);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function writeBackupManifest(manifest) {
  const store = await getNetlifyStore();
  if (!store) return;
  await store.set(NETLIFY_BACKUP_MANIFEST_KEY, JSON.stringify(manifest || []), {
    metadata: { updatedAt: new Date().toISOString() }
  });
}

async function createBackupSnapshot(data, reason = 'auto') {
  const store = await getNetlifyStore();
  if (!store || !data) return null;
  const snapshot = cloneData(data);
  delete snapshot[BACKUPS_KEY];
  const ts = Date.now();
  const id = `${ts}-${crypto.randomBytes(4).toString('hex')}`;
  const key = `${NETLIFY_BACKUP_PREFIX}${id}`;
  const meta = {
    id,
    key,
    ts,
    iso: new Date(ts).toISOString(),
    reason,
    summary: backupSummary(snapshot)
  };
  await store.set(key, JSON.stringify(snapshot), { metadata: meta });
  const manifest = await readBackupManifest().catch(() => []);
  const nextManifest = [meta, ...manifest.filter(item => item && item.key !== key)].slice(0, MAX_BACKUPS);
  const removed = manifest.slice(Math.max(0, MAX_BACKUPS - 1));
  await writeBackupManifest(nextManifest);
  if (typeof store.delete === 'function') {
    await Promise.allSettled(removed.map(item => item && item.key ? store.delete(item.key) : null));
  }
  return meta;
}

async function readBackupSnapshot(keyOrId) {
  const store = await getNetlifyStore();
  if (!store) throw new Error('Netlify database is not configured');
  const manifest = await readBackupManifest();
  const entry = manifest.find(item => item && (item.id === keyOrId || item.key === keyOrId));
  if (!entry) throw new Error('Backup not found');
  const raw = await store.get(entry.key, { type: 'text', consistency: 'strong' });
  if (!raw) throw new Error('Backup data missing');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Backup data invalid');
  return { entry, data };
}

function markEmergencyDb(data, reason = 'JSONBin quota exhausted', active = true) {
  const next = { ...(data || emptyDbData()) };
  next.emergencyDb = {
    active: Boolean(active),
    reason,
    updatedAt: new Date().toISOString()
  };
  return next;
}

function mergeArrayByKey(primaryItems, fallbackItems, keyFn) {
  const output = Array.isArray(primaryItems) ? [...primaryItems] : [];
  const seen = new Set(output.map(keyFn).filter(Boolean));
  for (const item of Array.isArray(fallbackItems) ? fallbackItems : []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function mergeEmergencyDb(primary, fallback) {
  if (!fallback || !fallback.emergencyDb || !fallback.emergencyDb.active) return primary;
  const merged = { ...(primary || emptyDbData()) };
  merged.users = mergeArrayByKey(merged.users, fallback.users, user => normalizeEmail(user && user.email));
  merged.pending = mergeArrayByKey(merged.pending, fallback.pending, item => item && item.id);
  merged.gameorders = mergeArrayByKey(merged.gameorders, fallback.gameorders, item => item && item.id);
  merged.topupreqs = mergeArrayByKey(merged.topupreqs, fallback.topupreqs, item => item && (item.id || `${normalizeEmail(item.email)}:${item.date || ''}:${item.amount || ''}`));
  merged.requests = mergeArrayByKey(merged.requests, fallback.requests, item => item && (item.id || `${normalizeEmail(item.email)}:${item.date || ''}:${item.type || ''}`));
  merged[LINK_TOKENS_KEY] = { ...(fallback[LINK_TOKENS_KEY] || {}), ...(merged[LINK_TOKENS_KEY] || {}) };
  merged.emergencyDb = {
    active: false,
    reason: 'Merged emergency fallback data after JSONBin recovery',
    updatedAt: new Date().toISOString()
  };
  return merged;
}

async function fetchJsonBinRaw() {
  if (!JB_KEY || !JB_BIN) throw new Error('DB not configured');
  const url = `https://api.jsonbin.io/v3/b/${JB_BIN}/latest`;
  const headerModes = [
    { 'X-Master-Key': JB_KEY, 'X-Bin-Meta': 'false' },
    { 'X-Access-Key': JB_KEY, 'X-Bin-Meta': 'false' }
  ];
  if (JSONBIN_ALLOW_PUBLIC_READ) headerModes.push({ 'X-Bin-Meta': 'false' });
  let lastStatus = 0;
  let lastBody = '';
  let quotaSeen = false;
  for (const headers of headerModes) {
    const r = await fetch(url, { headers });
    lastStatus = r.status;
    if (r.ok) {
      const fallback = readFallbackDb();
      const data = mergeEmergencyDb(await r.json(), fallback);
      writeFallbackDb(data);
      return data;
    }
    lastBody = await r.text().catch(() => '');
    if (isJsonBinQuotaError(createJsonBinError('read', r.status, lastBody))) quotaSeen = true;
    if (r.status !== 401 && r.status !== 403) break;
  }
  const error = createJsonBinError('read', lastStatus, lastBody);
  if (quotaSeen || isJsonBinQuotaError(error)) {
    dbLastSyncAttempt = Date.now();
    console.warn('JSONBin quota exhausted; using emergency local DB fallback.');
    return markEmergencyDb(readFallbackDb());
  }
  throw error;
}

async function pushJsonBinRaw(data) {
  if (!JB_KEY || !JB_BIN) throw new Error('DB not configured');
  const url = `https://api.jsonbin.io/v3/b/${JB_BIN}`;
  const headerModes = [
    { 'Content-Type': 'application/json', 'X-Master-Key': JB_KEY, 'X-Bin-Meta': 'false' },
    { 'Content-Type': 'application/json', 'X-Access-Key': JB_KEY, 'X-Bin-Meta': 'false' }
  ];
  let lastStatus = 0;
  let quotaSeen = false;
  for (const headers of headerModes) {
    const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(data || emptyDbData()) });
    lastStatus = r.status;
    if (r.ok) return await r.json();
    const body = await r.text().catch(() => '');
    if (isJsonBinQuotaError(createJsonBinError('write', r.status, body))) quotaSeen = true;
    if (quotaSeen) {
      const error = createJsonBinError('write', r.status, body);
      error.quota = true;
      throw error;
    }
    if (r.status !== 401 && r.status !== 403) break;
  }
  throw new Error('JSONBin write failed: ' + lastStatus);
}

async function syncDbToJsonBin(force = false) {
  if (!JB_KEY || !JB_BIN) return { skipped: true, reason: 'JSONBin not configured' };
  if (!dbCache || dbSyncInFlight) return { skipped: true };
  const now = Date.now();
  if (!force && (!dbDirty || now - dbLastSyncAttempt < JSONBIN_SYNC_INTERVAL_MS)) return { skipped: true };
  dbSyncInFlight = true;
  dbLastSyncAttempt = now;
  try {
    let data = cloneData(dbCache);
    delete data.emergencyDb;
    await pushJsonBinRaw(data);
    setDbCache({ ...data, emergencyDb: { active: false, reason: 'Synced to JSONBin', updatedAt: new Date().toISOString() } }, false);
    writeFallbackDb(dbCache);
    console.log('JSONBin sync completed');
    return { success: true };
  } catch(e) {
    if (e.quota || isJsonBinQuotaError(e)) {
      console.warn('JSONBin sync skipped: quota exhausted');
      return { emergencyDb: true, saved: true };
    }
    console.error('JSONBin sync error:', e.message);
    throw e;
  } finally {
    dbSyncInFlight = false;
  }
}

async function readJsonBinRaw() {
  if (dbCache) return cloneData(dbCache);
  let data = null;
  try {
    data = await readNetlifyDb();
  } catch(e) {
    console.error('Netlify database read error:', e.message);
  }
  if (!data) data = readFallbackDb();
  data = markEmergencyDb(data, NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN ? 'Netlify Blobs primary database' : 'Primary server file database', !(NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN));
  setDbCache(data, false);
  writeFallbackDb(data);
  return cloneData(dbCache);
}

async function writeJsonBinRaw(data, options = {}) {
  const nextData = { ...(data || {}) };
  const existingBackups = Array.isArray(nextData[BACKUPS_KEY])
    ? nextData[BACKUPS_KEY].filter(item => item && item.data).slice(0, 9)
    : [];
  let backupSource = options.backupSource;
  if (backupSource === undefined) backupSource = await readJsonBinRaw().catch(() => null);
  if (backupSource) {
    backupSource = { ...backupSource };
    delete backupSource[BACKUPS_KEY];
    delete backupSource[GMAIL_MONITORS_KEY];
    nextData[BACKUPS_KEY] = [
      { ts: Date.now(), data: backupSource },
      ...existingBackups
    ].slice(0, 10);
  } else {
    nextData[BACKUPS_KEY] = existingBackups;
  }
  const fallbackData = markEmergencyDb(nextData, NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN ? 'Netlify Blobs primary database' : 'Primary server file database', !(NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN));
  saveLocalDb(fallbackData, true);
  if (NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN) {
    if (backupSource) await createBackupSnapshot(backupSource, options.backupReason || 'before-write').catch(e => console.error('Backup snapshot error:', e.message));
    await writeNetlifyDb(fallbackData);
    setDbCache(fallbackData, false);
  }
  syncDbToJsonBin(false).catch(e => console.error('Background JSONBin sync error:', e.message));
  return { cached: true, emergencyDb: Boolean(fallbackData.emergencyDb && fallbackData.emergencyDb.active) };
}

function stripPrivateData(data) {
  const publicData = { ...(data || {}) };
  delete publicData[GMAIL_MONITORS_KEY];
  if (Array.isArray(publicData.users)) {
    publicData.users = publicData.users.map(sanitizeUser);
  }
  if (Array.isArray(publicData[BACKUPS_KEY])) {
    publicData[BACKUPS_KEY] = publicData[BACKUPS_KEY].map(b => ({ ts: b.ts }));
  }
  return publicData;
}

function sanitizeStock(stock) {
  const safe = {};
  for (const [key, accounts] of Object.entries(stock || {})) {
    safe[key] = (accounts || []).map(account => ({ used: Boolean(account.used) }));
  }
  return safe;
}

function sanitizeStockBlocks(blocks) {
  return { ...(blocks || {}) };
}

function sanitizeUser(user) {
  if (!user) return null;
  const safeUser = { ...user };
  delete safeUser.pass;
  return safeUser;
}

function safeDataForSession(data, session) {
  try {
    return dataForSession(data, session);
  } catch(e) {
    console.error('Session data serialization error:', e.message);
    return session.role === 'admin'
      ? { users: [], stock: {}, stockBlocks: {}, requests: [], topupreqs: [], pending: [], gameorders: [] }
      : { users: [], stock: {}, stockBlocks: {}, requests: [], topupreqs: [], pending: [], gameorders: [] };
  }
}

function dataForSession(data, session) {
  const publicData = stripPrivateData(data || {});
  if (session.role === 'admin') return publicData;
  const user = (publicData.users || []).find(u => normalizeEmail(u.email) === session.email);
  return {
    users: user ? [sanitizeUser(user)] : [],
    stock: sanitizeStock(publicData.stock || {}),
    stockBlocks: sanitizeStockBlocks(publicData.stockBlocks || {}),
    requests: publicData.requests || [],
    topupreqs: (publicData.topupreqs || []).filter(r => normalizeEmail(r.email) === session.email),
    pending: (publicData.pending || []).filter(o => normalizeEmail(o.userEmail) === session.email),
    gameorders: (publicData.gameorders || []).filter(o => normalizeEmail(o.userEmail) === session.email)
  };
}

function mergeUserWrite(existing, incoming, session) {
  const next = { ...(existing || {}) };
  const email = session.email;
  const users = Array.isArray(next.users) ? next.users : [];
  const incomingUser = (incoming.users || []).find(u => normalizeEmail(u.email) === email);
  if (incomingUser) {
    const idx = users.findIndex(u => normalizeEmail(u.email) === email);
    if (idx >= 0) {
      users[idx] = {
        ...users[idx],
        name: incomingUser.name,
        tgChatId: incomingUser.tgChatId || '',
        verified: Boolean(incomingUser.verified),
        myCustomers: Array.isArray(incomingUser.myCustomers) ? incomingUser.myCustomers : users[idx].myCustomers
      };
    }
  }
  next.users = users;

  if (Array.isArray(incoming.requests)) next.requests = incoming.requests;

  const existingTopups = Array.isArray(next.topupreqs) ? next.topupreqs : [];
  const otherTopups = existingTopups.filter(r => normalizeEmail(r.email) !== email);
  const ownTopups = (incoming.topupreqs || []).filter(r => normalizeEmail(r.email) === email);
  next.topupreqs = [...otherTopups, ...ownTopups];

  if (Array.isArray(incoming.gameorders)) {
    const existingGameOrders = Array.isArray(next.gameorders) ? next.gameorders : [];
    const ownIncomingGameOrders = incoming.gameorders.filter(order => normalizeEmail(order.userEmail) === email);
    next.gameorders = mergeArrayByKey(existingGameOrders, ownIncomingGameOrders, order => order && order.id);
  }

  if (existing && existing[GMAIL_MONITORS_KEY]) next[GMAIL_MONITORS_KEY] = existing[GMAIL_MONITORS_KEY];
  if (existing && existing.stockBlocks) next.stockBlocks = existing.stockBlocks;
  return next;
}

function preserveSensitiveFields(existing, incoming) {
  const next = { ...(incoming || {}) };
  const existingUsers = Array.isArray(existing && existing.users) ? existing.users : [];
  if (Array.isArray(next.users)) {
    next.users = next.users.map(user => {
      const current = existingUsers.find(existingUser => normalizeEmail(existingUser.email) === normalizeEmail(user.email));
      return {
        ...user,
        pass: user.pass || (current && current.pass) || ''
      };
    });
  }
  if (existing && existing[GMAIL_MONITORS_KEY]) next[GMAIL_MONITORS_KEY] = existing[GMAIL_MONITORS_KEY];
  if (existing && existing[LINK_TOKENS_KEY] && !next[LINK_TOKENS_KEY]) next[LINK_TOKENS_KEY] = existing[LINK_TOKENS_KEY];
  if (existing && existing[BACKUPS_KEY]) next[BACKUPS_KEY] = existing[BACKUPS_KEY];
  return next;
}

function recoverMissingPasswordFromBackups(data, user) {
  if (!user || user.pass) return false;
  const backups = Array.isArray(data && data[BACKUPS_KEY]) ? data[BACKUPS_KEY] : [];
  for (const backup of backups) {
    const users = backup && backup.data && Array.isArray(backup.data.users) ? backup.data.users : [];
    const previous = users.find(item => normalizeEmail(item.email) === normalizeEmail(user.email) && item.pass);
    if (previous) {
      user.pass = previous.pass;
      return true;
    }
  }
  return false;
}

function isNetflixStockKey(skey) {
  return String(skey || '').startsWith('netflix__');
}

function isNetflixFullStockKey(skey) {
  return /^netflix__full__/.test(String(skey || ''));
}

function isNetflixOneUserStockKey(skey) {
  return /^netflix__1user__/.test(String(skey || ''));
}

function netflixAliasUsage(data, aliasEmail) {
  const alias = normalizeEmail(aliasEmail);
  const usage = { oneUser: 0, full: 0 };
  if (!alias) return usage;
  for (const [key, accounts] of Object.entries((data && data.stock) || {})) {
    if (!isNetflixStockKey(key)) continue;
    for (const account of Array.isArray(accounts) ? accounts : []) {
      if (normalizeEmail(account && account.email) !== alias) continue;
      if (isNetflixFullStockKey(key)) usage.full += 1;
      if (isNetflixOneUserStockKey(key)) usage.oneUser += 1;
    }
  }
  return usage;
}

function validateNetflixAliasPurchase(data, skey, acc) {
  if (!acc || !isNetflixStockKey(skey)) return null;
  const usage = netflixAliasUsage(data, acc.email);
  if (isNetflixFullStockKey(skey) && usage.oneUser > 0) {
    return 'This Netflix alias is already split into 1-user profiles and cannot be sold as full account.';
  }
  if (isNetflixFullStockKey(skey) && usage.full > 1) {
    return 'This Netflix alias is already reserved as a full account and cannot be sold again.';
  }
  if (isNetflixOneUserStockKey(skey) && usage.full > 0) {
    return 'This Netflix alias is already reserved as a full account and cannot be sold as 1-user profile.';
  }
  if (isNetflixOneUserStockKey(skey) && usage.oneUser > 5) {
    return 'This Netflix alias already has more than 5 one-user profile slots.';
  }
  return null;
}

// ── HEALTH ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'rashadtech server running', codes: Object.keys(latestCodes) });
});
app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get('/backup-admin', (req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RashadTech Backups</title>
<style>
body{font-family:Arial,sans-serif;background:#0f1115;color:#f5f5f5;margin:0;padding:20px}
.card{max-width:760px;margin:0 auto;background:#181b22;border:1px solid #2b303b;border-radius:14px;padding:18px}
input,button{border-radius:8px;border:1px solid #333;padding:10px;margin:5px 0;background:#11141a;color:#fff}
button{cursor:pointer;background:#e50914;border-color:#e50914;font-weight:700}
.row{border-bottom:1px solid #2b303b;padding:12px 0;display:flex;justify-content:space-between;gap:12px;align-items:center}
.muted{color:#9ca3af;font-size:12px}.ok{color:#22c55e}.err{color:#ef4444}
</style></head><body><div class="card">
<h2>🛡️ RashadTech Database Backups</h2>
<p class="muted">Backups are created automatically before every save. Use restore only if data was damaged.</p>
<div id="login">
<input id="pass" type="password" placeholder="Admin password" style="width:100%"><br>
<input id="pin" type="password" placeholder="Admin PIN" style="width:100%"><br>
<button onclick="login()">Login</button>
</div>
<div id="panel" style="display:none">
<button onclick="createBackup()">Backup now</button>
<button onclick="loadBackups()">Refresh list</button>
<div id="status" class="muted"></div>
<div id="list"></div>
</div>
</div>
<script>
let token='';
async function api(path, opts={}){
  opts.headers=Object.assign({'Content-Type':'application/json'}, opts.headers||{});
  if(token)opts.headers.Authorization='Bearer '+token;
  const r=await fetch(path, opts); const j=await r.json().catch(()=>({}));
  if(!r.ok||j.success===false)throw new Error(j.error||'Request failed');
  return j;
}
function summary(s){s=s||{};return (s.users||0)+' users · '+(s.stockAccounts||0)+' stock · '+(s.pending||0)+' pending · '+(s.gameorders||0)+' games';}
async function login(){
  try{
    const j=await api('/auth/admin-login',{method:'POST',body:JSON.stringify({password:pass.value,pin:pin.value})});
    token=j.token; document.getElementById('login').style.display='none'; document.getElementById('panel').style.display='block'; await loadBackups();
  }catch(e){alert(e.message)}
}
async function loadBackups(){
  const st=document.getElementById('status'); st.textContent='Loading...';
  try{
    const j=await api('/admin/backups');
    const backups=j.backups||[];
    st.textContent=backups.length+' backups available';
    document.getElementById('list').innerHTML=backups.length?backups.map(b=>'<div class="row"><div><b>'+new Date(b.ts).toLocaleString()+'</b><div class="muted">'+(b.reason||'auto')+' · '+summary(b.summary)+'</div></div><button onclick="restore(\\''+b.id+'\\')">Restore</button></div>').join(''):'<p class="muted">No backups yet.</p>';
  }catch(e){st.innerHTML='<span class="err">'+e.message+'</span>'}
}
async function createBackup(){
  try{await api('/admin/backups/create',{method:'POST',body:'{}'}); status.innerHTML='<span class="ok">Backup created</span>'; await loadBackups();}catch(e){alert(e.message)}
}
async function restore(id){
  if(!confirm('Restore this backup? Current data will be backed up first.'))return;
  const txt=prompt('Type RESTORE to confirm');
  if(txt!=='RESTORE')return;
  try{await api('/admin/backups/restore',{method:'POST',body:JSON.stringify({id})}); status.innerHTML='<span class="ok">Backup restored</span>'; await loadBackups();}catch(e){alert(e.message)}
}
</script></body></html>`);
});

app.use('/auth', rateLimit('auth', 40, 15 * 60 * 1000));
app.use('/get-code', rateLimit('get-code', 30, 5 * 60 * 1000));
app.use('/notify', rateLimit('notify', 60, 5 * 60 * 1000));
app.use('/links', rateLimit('links', 80, 5 * 60 * 1000));

// ── JSONBIN PROXY ──────────────────────────────────────────────────────
app.post('/db/read', async (req, res) => {
  const session = requireSession(req, res, ['admin', 'user']);
  if (!session) return;
  try {
    const data = await readJsonBinRaw();
    res.json({ success: true, data: safeDataForSession(data, session) });
  } catch(e) {
    console.error('DB read error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/db/write', async (req, res) => {
  const session = requireSession(req, res, ['admin', 'user']);
  if (!session) return;
  const { data } = req.body;
  try {
    const existing = await readJsonBinRaw();
    let nextData;
    if (session.role === 'admin') {
      nextData = preserveSensitiveFields(existing, data || {});
    } else {
      nextData = mergeUserWrite(existing, data || {}, session);
    }
    const result = await writeJsonBinRaw(nextData, { backupSource: existing });
    res.json({ success: true, result });
  } catch(e) {
    console.error('DB write error:', e.message);
    res.status(503).json({ error: 'Database is unavailable. Nothing was saved.' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const data = await readJsonBinRaw();
    const user = (data.users || []).find(u => normalizeEmail(u.email) === normalizeEmail(email));
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const recoveredPassword = recoverMissingPasswordFromBackups(data, user);
    if (!user.pass) return res.status(401).json({ error: 'This account needs a password reset. Please use Forgot password.' });
    if (!verifyPassword(password, user.pass)) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.banned) return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });
    if (recoveredPassword || !String(user.pass || '').startsWith(PASSWORD_HASH_PREFIX)) {
      user.pass = hashPassword(password);
      await writeJsonBinRaw(data);
    }
    const token = createSession('user', user.email);
    res.json({ success: true, token, user: sanitizeUser(user), data: safeDataForSession(data, { role: 'user', email: normalizeEmail(user.email) }) });
  } catch(e) {
    console.error('Login error:', e.message);
    res.status(503).json({ error: 'Login service is temporarily unavailable. Please try again soon.' });
  }
});

app.post('/auth/admin-login', async (req, res) => {
  const { password, pin } = req.body;
  if (password !== ADMIN_PASSWORD || pin !== ADMIN_PIN) return res.status(401).json({ error: 'Wrong password or PIN' });
  const token = createSession('admin', 'admin');
  try {
    const data = await readJsonBinRaw();
    res.json({ success: true, token, data: safeDataForSession(data, { role: 'admin' }) });
  } catch(e) {
    console.error('Admin login error:', e.message);
    res.json({ success: true, token, data: { users: [], stock: {}, stockBlocks: {}, requests: [], topupreqs: [], pending: [], gameorders: [] }, warning: 'Logged in, but data could not be loaded. Try refreshing.' });
  }
});

app.post('/auth/signup-start', async (req, res) => {
  const { name, email, tgChatId } = req.body;
  const cleanEmail = normalizeEmail(email);
  if (!name || !cleanEmail) return res.status(400).json({ error: 'Invalid signup data' });
  try {
    const data = await readJsonBinRaw();
    data.users = Array.isArray(data.users) ? data.users : [];
    if (data.users.some(u => normalizeEmail(u.email) === cleanEmail)) return res.status(409).json({ error: 'Email already registered' });
    const otp = setOtp(signupOtps, cleanEmail, { name: String(name).trim(), tgChatId: String(tgChatId || '').trim() });
    const delivery = await deliverOtp({ email: cleanEmail, otp, name, tgChatId, purpose: 'signup' });
    if (!delivery.emailSent && !delivery.telegramSent && !delivery.clientEmailRequired) {
      return res.status(503).json({ error: 'Could not send verification code. Please try again.' });
    }
    res.json({
      success: true,
      message: delivery.clientEmailRequired ? 'Verification code ready — check your email shortly' : 'Verification code sent',
      emailSent: delivery.emailSent,
      telegramSent: delivery.telegramSent,
      clientEmailRequired: delivery.clientEmailRequired,
      ...(delivery.clientEmailRequired ? { otp, name: String(name).trim(), email: cleanEmail } : {})
    });
  } catch(e) {
    console.error('Signup start error:', e.message);
    res.status(503).json({ error: 'Could not send verification code. Please try again.' });
  }
});

app.post('/auth/signup', async (req, res) => {
  const { name, email, password, tgChatId, otp } = req.body;
  const cleanEmail = normalizeEmail(email);
  if (!name || !cleanEmail || !password || password.length < 6) return res.status(400).json({ error: 'Invalid signup data' });
  if (!verifyOtp(signupOtps, cleanEmail, otp)) return res.status(400).json({ error: 'Invalid or expired verification code' });
  try {
    const data = await readJsonBinRaw();
    data.users = Array.isArray(data.users) ? data.users : [];
    if (data.users.some(u => normalizeEmail(u.email) === cleanEmail)) return res.status(409).json({ error: 'Email already registered' });
    const user = {
      name: String(name).trim(),
      email: cleanEmail,
      pass: hashPassword(password),
      tgChatId: String(tgChatId || '').trim(),
      balance: 0,
      transactions: [],
      orders: [],
      myCustomers: [],
      verified: true,
      joinedDate: new Date().toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
    };
    data.users.push(user);
    await writeJsonBinRaw(data);
    const token = createSession('user', user.email);
    res.json({ success: true, token, user: sanitizeUser(user), data: safeDataForSession(data, { role: 'user', email: cleanEmail }) });
  } catch(e) {
    console.error('Signup error:', e.message);
    res.status(503).json({ error: ACCOUNT_SERVICE_UNAVAILABLE });
  }
});

app.post('/auth/reset-start', async (req, res) => {
  const { email } = req.body;
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return res.status(400).json({ error: 'Email required' });
  try {
    const data = await readJsonBinRaw();
    const user = (data.users || []).find(u => normalizeEmail(u.email) === cleanEmail);
    let delivery = null;
    let otpForClient = null;
    if (user) {
      const otp = setOtp(resetOtps, cleanEmail);
      otpForClient = otp;
      delivery = await deliverOtp({ email: cleanEmail, otp, name: user.name || cleanEmail, tgChatId: user.tgChatId || '', purpose: 'password reset' });
      if (!delivery.emailSent && !delivery.telegramSent && !delivery.clientEmailRequired) {
        return res.status(503).json({ error: 'Could not send reset code. Please try again.' });
      }
    }
    res.json({
      success: true,
      message: 'If the email exists, a reset code was sent.',
      ...(delivery ? {
        emailSent: delivery.emailSent,
        telegramSent: delivery.telegramSent,
        clientEmailRequired: delivery.clientEmailRequired,
        ...(delivery.clientEmailRequired ? { otp: otpForClient, name: user.name || cleanEmail, email: cleanEmail } : {})
      } : {})
    });
  } catch(e) {
    console.error('Reset start error:', e.message);
    res.status(503).json({ error: 'Could not send reset code. Please try again.' });
  }
});

app.post('/auth/user-lookup', async (req, res) => {
  const { email } = req.body;
  try {
    const data = await readJsonBinRaw();
    const user = (data.users || []).find(u => normalizeEmail(u.email) === normalizeEmail(email));
    if (!user) return res.json({ success: true, exists: false });
    res.json({ success: true, exists: true, name: user.name || normalizeEmail(email) });
  } catch(e) {
    console.error('User lookup error:', e.message);
    res.status(503).json({ error: ACCOUNT_SERVICE_UNAVAILABLE });
  }
});

app.post('/auth/reset-password', async (req, res) => {
  const { email, password, otp } = req.body;
  if (!email || !password || password.length < 6) return res.status(400).json({ error: 'Invalid password' });
  if (!verifyOtp(resetOtps, email, otp)) return res.status(400).json({ error: 'Invalid or expired reset code' });
  try {
    const data = await readJsonBinRaw();
    const user = (data.users || []).find(u => normalizeEmail(u.email) === normalizeEmail(email));
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.pass = hashPassword(password);
    await writeJsonBinRaw(data);
    res.json({ success: true });
  } catch(e) {
    console.error('Reset password error:', e.message);
    res.status(503).json({ error: ACCOUNT_SERVICE_UNAVAILABLE });
  }
});

app.post('/auth/logout', (req, res) => {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) sessions.delete(match[1]);
  if (rtEnhancements && rtEnhancements.persistSessions) rtEnhancements.persistSessions().catch(() => {});
  res.json({ success: true });
});

app.post('/auth/logout-all', (req, res) => {
  const session = requireSession(req, res, ['admin', 'user']);
  if (!session) return;
  for (const [token, item] of sessions.entries()) {
    if (session.role === 'admin' || (item.role === 'user' && item.email === session.email)) sessions.delete(token);
  }
  if (rtEnhancements && rtEnhancements.persistSessions) rtEnhancements.persistSessions().catch(() => {});
  res.json({ success: true });
});

app.post('/links/create', async (req, res) => {
  const session = requireSession(req, res, ['admin', 'user']);
  if (!session) return;
  const { subscription } = req.body;
  if (!subscription || !subscription.email || !subscription.pass) return res.status(400).json({ error: 'Invalid subscription link data' });
  try {
    const token = encodeLinkToken({
      subscription,
      owner: session.email,
      createdAt: Date.now(),
      expiresAt: Date.now() + LINK_TTL_MS
    });
    res.json({ success: true, token, url: `https://rashadtech.tv?t=${token}` });
  } catch(e) {
    console.error('Create link error:', e.message);
    res.status(500).json({ error: 'Could not create subscription link' });
  }
});

app.get('/links/:token', async (req, res) => {
  try {
    if (rtEnhancements && await rtEnhancements.isLinkRevoked(req.params.token)) {
      return res.status(404).json({ error: 'Subscription link has been revoked' });
    }
    try {
      const payload = decodeLinkToken(req.params.token);
      if (!payload.subscription || Date.now() > Number(payload.expiresAt || 0)) {
        return res.status(404).json({ error: 'Subscription link not found or expired' });
      }
      return res.json({ success: true, subscription: payload.subscription });
    } catch(e) {
      // Continue to legacy database-backed token lookup below.
    }
    const data = await readJsonBinRaw();
    const entry = data[LINK_TOKENS_KEY] && data[LINK_TOKENS_KEY][req.params.token];
    if (!entry || Date.now() > Number(entry.expiresAt || 0)) return res.status(404).json({ error: 'Subscription link not found or expired' });
    res.json({ success: true, subscription: entry.subscription });
  } catch(e) {
    console.error('Read link error:', e.message);
    res.status(500).json({ error: 'Could not load subscription link' });
  }
});

async function notifyPurchasePending(user, product, planLabel, price) {
  await sendTG(TG_ADMIN, `⏳ <b>Pending Order</b>\n👤 ${user.name} (${user.email})\n📦 ${product.name} · ${planLabel}\n💵 $${Number(price).toFixed(2)}\n⚠️ No stock — add accounts in Stock tab to fulfill.`, 'HTML').catch(() => {});
  if (user.tgChatId) {
    await sendTG(user.tgChatId, `✅ <b>Purchase Confirmed!</b>\n\n📦 ${product.name} · ${planLabel}\n💵 $${Number(price).toFixed(2)}\n💰 New balance: $${Number(user.balance || 0).toFixed(2)}\n\n⏳ Your credentials will be delivered here shortly.`, 'HTML').catch(() => {});
  }
}

async function notifyPurchaseFulfilled(user, product, planLabel, price, order) {
  let adminMsg = `🎉 <b>New Purchase</b>\n\n📦 <b>Product:</b> ${product.name}\n📋 <b>Plan:</b> ${planLabel}\n💵 <b>Price:</b> $${Number(price).toFixed(2)}\n👤 <b>Buyer:</b> ${user.name} (${user.email})\n\n🔐 <b>Credentials:</b>\n📧 <code>${order.email}</code>\n🔑 <code>${order.pass}</code>`;
  if (order.extra) adminMsg += `\nℹ️ Extra: <code>${order.extra}</code>`;
  if (order.expiryDate) adminMsg += `\n📅 Expires: ${order.expiryDate}`;
  await sendTG(TG_ADMIN, adminMsg, 'HTML').catch(() => {});
  if (!user.tgChatId) return;
  const linkData = {
    id: order.id,
    product: product.name,
    short: product.short,
    color: product.color,
    tc: product.tc,
    productId: product.id,
    plan: planLabel,
    email: order.email,
    pass: order.pass,
    expiryDate: order.expiryDate || '',
    profileName: order.profileName || '',
    profilePin: order.profilePin || '',
    accKey: order.accKey || '',
    mainEmail: order.mainEmail || '',
    codeEmail: order.email,
    inboxEmail: order.mainEmail || order.email
  };
  const token = encodeLinkToken({
    subscription: linkData,
    owner: normalizeEmail(user.email),
    createdAt: Date.now(),
    expiresAt: Date.now() + LINK_TTL_MS
  });
  const subLink = `https://rashadtech.tv?t=${token}`;
  let custMsg = `✅ <b>Your ${product.name} is ready!</b>\n\n📋 ${planLabel}\n\n🔐 <b>Your credentials:</b>\n📧 <code>${order.email}</code>\n🔑 <code>${order.pass}</code>`;
  if (order.extra) custMsg += `\nℹ️ Extra: <code>${order.extra}</code>`;
  if (order.expiryDate) custMsg += `\n⏰ Expires: ${order.expiryDate}`;
  if (order.profilePin) custMsg += `\n🔢 PIN: <code>${order.profilePin}</code>`;
  custMsg += `\n\n🔗 <b>Your subscription link:</b>\n${subLink}\n\nEnjoy! 🌟`;
  await sendTG(user.tgChatId, custMsg, 'HTML').catch(() => {});
}

app.post('/purchase', async (req, res) => {
  const session = requireSession(req, res, ['user']);
  if (!session) return;
  const { product, planLabel, price, skey, extraFields, assignCustId } = req.body;
  if (!product || !planLabel || !skey || !Number(price)) return res.status(400).json({ error: 'Invalid purchase' });
  try {
    const data = await readJsonBinRaw();
    data.users = Array.isArray(data.users) ? data.users : [];
    data.stock = data.stock || {};
    data.pending = Array.isArray(data.pending) ? data.pending : [];
    data.stockBlocks = data.stockBlocks || {};
    const user = data.users.find(u => normalizeEmail(u.email) === session.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.banned) return res.status(403).json({ error: 'Your account has been suspended. Contact support.' });
    if (data.stockBlocks[skey]) return res.status(403).json({ error: 'This plan is temporarily unavailable.' });
    if (Number(user.balance || 0) < Number(price)) return res.status(400).json({ error: 'Insufficient balance' });

    const dateStr = new Date().toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const accounts = data.stock[skey] || [];
    const acc = accounts.find(a => !a.used);
    user.transactions = Array.isArray(user.transactions) ? user.transactions : [];

    if (!acc) {
      user.balance = Number(user.balance || 0) - Number(price);
      const assignedCustomer = assignCustId !== null && assignCustId !== undefined
        ? (user.myCustomers || []).find(c => c.id === assignCustId)
        : null;
      const pendingOrder = {
        id:'#'+(Math.floor(Math.random()*90000+10000)),
        userEmail:user.email,userName:user.name,userTgChatId:user.tgChatId||'',
        product:product.name,short:product.short,color:product.color,tc:product.tc,
        productId:product.id,plan:planLabel,price:Number(price),skey,date:dateStr,
        ...(assignedCustomer ? { assignCustId, profileName: extraFields?.profileName || assignedCustomer.fname } : {}),
        ...(extraFields||{})
      };
      data.pending.unshift(pendingOrder);
      user.transactions.unshift({type:'purchase',label:'Bought '+product.name+' · '+planLabel,amount:Number(price),balance:user.balance,date:dateStr});
      await writeJsonBinRaw(data);
      await notifyPurchasePending(user, product, planLabel, price);
      return res.json({ success:true, pending:true, user:sanitizeUser(user), order:pendingOrder, data:safeDataForSession(data, session) });
    }

    const aliasError = validateNetflixAliasPurchase(data, skey, acc);
    if (aliasError) return res.status(409).json({ error: aliasError });

    user.balance = Number(user.balance || 0) - Number(price);
    acc.used = true;
    const order = {
      id:'#'+(Math.floor(Math.random()*90000+10000)),
      product:product.name,short:product.short,color:product.color,tc:product.tc,
      productId:product.id,plan:planLabel,price:Number(price),
      email:acc.email,pass:acc.pass,date:dateStr,expiryDate:acc.expiryDate||null,
      ...(extraFields||{}),
      ...(acc.extra?{extra:acc.extra}:{}),
      ...(acc.profilePin?{profilePin:acc.profilePin}:{}),
      accKey:acc.accKey||'',mainEmail:acc.mainEmail||''
    };
    if (assignCustId !== null && assignCustId !== undefined) {
      const customer = (user.myCustomers||[]).find(c => c.id === assignCustId);
      if (customer) {
        order.profileName = order.profileName || customer.fname;
        customer.subs = Array.isArray(customer.subs) ? customer.subs : [];
        customer.subs.unshift(order);
      } else {
        user.orders = Array.isArray(user.orders) ? user.orders : [];
        user.orders.unshift(order);
      }
    } else {
      user.orders = Array.isArray(user.orders) ? user.orders : [];
      user.orders.unshift(order);
    }
    user.transactions.unshift({type:'purchase',label:'Bought '+product.name+' · '+planLabel,amount:Number(price),balance:user.balance,date:dateStr});
    await writeJsonBinRaw(data);
    if (assignCustId === null || assignCustId === undefined) {
      await notifyPurchaseFulfilled(user, product, planLabel, price, order);
    }
    res.json({ success:true, pending:false, user:sanitizeUser(user), order, data:safeDataForSession(data, session) });
  } catch(e) {
    console.error('Purchase error:', e.message);
    res.status(500).json({ error: 'Purchase failed' });
  }
});

app.post('/admin/stock-block', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { skey, blocked } = req.body;
  if (!skey) return res.status(400).json({ error: 'Stock key is required' });
  try {
    const data = await readJsonBinRaw();
    data.stockBlocks = data.stockBlocks || {};
    if (blocked) data.stockBlocks[skey] = { blocked: true, ts: Date.now() };
    else delete data.stockBlocks[skey];
    await writeJsonBinRaw(data);
    res.json({ success: true, stockBlocks: data.stockBlocks, data: safeDataForSession(data, { role: 'admin' }) });
  } catch(e) {
    console.error('Stock block error:', e.message);
    res.status(500).json({ error: 'Could not update stock block' });
  }
});

app.post('/admin/cancel-pending', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { orderId, reason } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Order ID is required' });
  try {
    const data = await readJsonBinRaw();
    data.pending = Array.isArray(data.pending) ? data.pending : [];
    data.users = Array.isArray(data.users) ? data.users : [];
    const idx = data.pending.findIndex(o => o.id === orderId);
    if (idx < 0) return res.status(404).json({ error: 'Pending order not found' });
    const order = data.pending[idx];
    const user = data.users.find(u => normalizeEmail(u.email) === normalizeEmail(order.userEmail));
    const refund = Number(order.price || 0);
    if (user && refund > 0) {
      user.balance = Number(user.balance || 0) + refund;
      user.transactions = Array.isArray(user.transactions) ? user.transactions : [];
      user.transactions.unshift({
        type: 'refund',
        label: `Refund — canceled ${order.product} · ${order.plan}`,
        amount: refund,
        balance: user.balance,
        date: new Date().toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }),
        orderId: order.id
      });
    }
    data.pending.splice(idx, 1);
    await writeJsonBinRaw(data);
    const message = `❌ <b>Order Canceled & Refunded</b>\n\n📦 ${order.product} · ${order.plan}\n💵 Refund: $${refund.toFixed(2)}${reason ? `\n📝 Reason: ${reason}` : ''}\n\nYour wallet balance has been updated.`;
    if (user && user.tgChatId) await sendTG(user.tgChatId, message, 'HTML').catch(() => {});
    await sendTG(TG_ADMIN, `↩️ Canceled pending order ${order.id} for ${order.userName} — refunded $${refund.toFixed(2)}`, 'HTML').catch(() => {});
    res.json({ success: true, order, user: sanitizeUser(user), data: safeDataForSession(data, { role: 'admin' }) });
  } catch(e) {
    console.error('Cancel pending error:', e.message);
    res.status(500).json({ error: 'Could not cancel pending order' });
  }
});

app.get('/admin/backups', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  try {
    const backups = await readBackupManifest();
    res.json({ success: true, backups: backups.slice(0, MAX_BACKUPS) });
  } catch(e) {
    console.error('List backups error:', e.message);
    res.status(500).json({ error: 'Could not load backups' });
  }
});

app.post('/admin/backups/create', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  try {
    const data = await readJsonBinRaw();
    const backup = await createBackupSnapshot(data, 'manual');
    res.json({ success: true, backup });
  } catch(e) {
    console.error('Create backup error:', e.message);
    res.status(500).json({ error: 'Could not create backup' });
  }
});

app.post('/admin/backups/restore', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { id, key } = req.body || {};
  if (!id && !key) return res.status(400).json({ error: 'Backup ID is required' });
  try {
    const current = await readJsonBinRaw().catch(() => null);
    if (current) await createBackupSnapshot(current, 'before-restore').catch(e => console.error('Pre-restore backup error:', e.message));
    const { entry, data } = await readBackupSnapshot(id || key);
    const restored = markEmergencyDb(data, 'Restored from backup', false);
    saveLocalDb(restored, false);
    if (NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN) await writeNetlifyDb(restored);
    syncDbToJsonBin(false).catch(e => console.error('Background JSONBin sync error:', e.message));
    await sendTG(TG_ADMIN, `♻️ <b>Database restored</b>\nBackup: <code>${entry.id}</code>\nTime: ${entry.iso}`, 'HTML').catch(() => {});
    res.json({ success: true, backup: entry, data: safeDataForSession(restored, { role: 'admin' }) });
  } catch(e) {
    console.error('Restore backup error:', e.message);
    res.status(500).json({ error: 'Could not restore backup' });
  }
});

// ── TELEGRAM PROXY (NEW — keeps TG_TOKEN off the frontend) ─────────────
app.post('/notify', async (req, res) => {
  const session = requireSession(req, res, ['admin', 'user']);
  if (!session) return;
  const { message, chatId, parse_mode } = req.body;
  try {
    if (session.role === 'user' && chatId) {
      const data = await readJsonBinRaw();
      const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
      if (!user || String(user.tgChatId || '') !== String(chatId)) return res.status(403).json({ error: 'Cannot send Telegram messages to this chat.' });
    }
    await sendTG(chatId || TG_ADMIN, message, parse_mode);
    res.json({ success: true });
  } catch(e) {
    console.error('Notify error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TELEGRAM BOT WEBHOOK ───────────────────────────────────────────────
app.post('/telegram', async (req, res) => {
  try {
    const update = req.body;
    const msg = update.message;
    if (!msg) return res.json({ ok: true });
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    if (chatId !== TG_ADMIN) {
      await sendTG(chatId, '❌ Unauthorized');
      return res.json({ ok: true });
    }
    if (text.startsWith('/code ')) {
      const parts = text.replace('/code ', '').trim().split(' ');
      let key = 'default', code = '';
      if (parts.length === 1 && parts[0].match(/^\d{4,8}$/)) {
        code = parts[0];
      } else if (parts.length === 2 && parts[1].match(/^\d{4,8}$/)) {
        key = parts[0].toLowerCase(); code = parts[1];
      } else {
        await sendTG(chatId, '⚠️ Usage:\n/code 1234\n/code Ali 1234');
        return res.json({ ok: true });
      }
      latestCodes[key] = { code, timestamp: Date.now() };
      delete notifiedCustomers[key];
      await sendTG(chatId, `✅ Code <b>${code}</b> saved for ${key === 'default' ? 'all' : `<b>${key}</b>`}`, 'HTML');
    } else if (text === '/clear') {
      latestCodes = {}; notifiedCustomers = {};
      await sendTG(chatId, '✅ All codes cleared');
    } else if (text.startsWith('/clear ')) {
      const key = text.replace('/clear ', '').trim().toLowerCase();
      delete latestCodes[key]; delete notifiedCustomers[key];
      await sendTG(chatId, `✅ Cleared for ${key}`);
    } else if (text === '/status') {
      if (!Object.keys(latestCodes).length) {
        await sendTG(chatId, '📋 No codes stored');
      } else {
        const lines = Object.entries(latestCodes).map(([k, v]) => {
          const age = Math.round((Date.now() - v.timestamp) / 1000);
          return `• ${k}: <b>${v.code}</b> (${age}s ago)${age > 900 ? ' ❌ EXPIRED' : ''}`;
        });
        await sendTG(chatId, '📋 Codes:\n' + lines.join('\n'), 'HTML');
      }
    } else {
      await sendTG(chatId, "📖 Commands:\n/code 1234\n/code Ali 1234\n/status\n/clear\n/clear Ali");
    }
    res.json({ ok: true });
  } catch(e) { console.error('TG error:', e.message); res.json({ ok: true }); }
});

async function sendTG(chatId, text, parse_mode) {
  const body = { chat_id: chatId, text };
  if (parse_mode) body.parse_mode = parse_mode;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function loadGmailMonitors(force = false) {
  if (gmailMonitorsLoaded && !force) return monitoredEmails;
  try {
    const data = await readJsonBinRaw();
    const stored = data[GMAIL_MONITORS_KEY] || {};
    const loaded = {};
    for (const [email, creds] of Object.entries(stored)) {
      const key = normalizeEmail(email);
      const pass = normalizeGmailPassword(creds && (creds.pass || creds.password));
      if (!key || !pass) continue;
      loaded[key] = {
        user: normalizeEmail(creds.user || key),
        pass,
        lastUid: Number(creds.lastUid || 0),
        lastCheckedAt: Number(creds.lastCheckedAt || 0)
      };
    }
    monitoredEmails = loaded;
    gmailMonitorsLoaded = true;
    console.log(`Loaded ${Object.keys(monitoredEmails).length} Gmail monitor(s)`);
  } catch(e) {
    console.log('Gmail monitor load error:', e.message);
    gmailMonitorsLoaded = true;
  }
  return monitoredEmails;
}

async function persistGmailMonitors() {
  const data = await readJsonBinRaw();
  data[GMAIL_MONITORS_KEY] = monitoredEmails;
  await writeJsonBinRaw(data, { backupReason: 'gmail-monitor-update' });
}

async function getInboxMaxUid(email, password) {
  let client;
  try {
    client = createGmailClient(email, password);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidNext = Number(client.mailbox && client.mailbox.uidNext);
      return uidNext > 1 ? uidNext - 1 : 0;
    } finally {
      lock.release();
    }
  } finally {
    if (client && client.usable) {
      try { await client.logout(); } catch(e) {}
    }
  }
}

// ── CODE ENDPOINTS ─────────────────────────────────────────────────────
app.post('/get-code', async (req, res) => {
  const { profileName, mainEmail, codeEmail, inboxEmail } = req.body;
  
  // codeEmail is the Netflix recipient alias; inboxEmail/mainEmail is the Gmail login inbox.
  const codeKey = normalizeEmail(codeEmail || mainEmail);
  const inboxKey = normalizeEmail(inboxEmail || mainEmail || codeEmail);
  const key = codeKey || (profileName ? profileName.toLowerCase() : 'default');
  if (inboxKey) {
    await loadGmailMonitors();
    if (monitoredEmails[inboxKey]) {
      await fetchNetflixCodes(inboxKey);
    }
  }
  const entry = latestCodes[key] || (!codeEmail && inboxKey ? latestCodes[inboxKey] : null) || (codeKey ? null : latestCodes['default']);
  
  if (!entry) {
    const name = profileName || 'Unknown';
    if (!notifiedCustomers[key] || Date.now() - notifiedCustomers[key] > 5*60*1000) {
      notifiedCustomers[key] = Date.now();
      const monitorHint = inboxKey && !monitoredEmails[inboxKey]
        ? `\n⚠️ Gmail monitoring is not configured for inbox <code>${inboxKey}</code>. Add this Gmail in Admin stock with an app password.`
        : '';
      await sendTG(TG_ADMIN, `🔔 <b>${name}</b> is waiting for a sign-in code!${codeKey ? `\n📧 Netflix email: <code>${codeKey}</code>` : ''}${inboxKey && inboxKey !== codeKey ? `\n📥 Gmail inbox: <code>${inboxKey}</code>` : ''}${monitorHint}\nManual fallback: /code ${codeKey || name} 1234`, 'HTML').catch(() => {});
    }
    return res.json({ success: false, message: 'No code found yet — check back in a moment' });
  }
  if (Date.now() - entry.timestamp > CODE_TTL_MS) return res.json({ success: false, message: 'Code expired' });
  await sendTG(TG_ADMIN, `👀 <b>${profileName || 'Unknown'}</b> viewed code: ${entry.code}`, 'HTML').catch(() => {});
  res.json({ success: true, code: entry.code });
});

app.post('/set-code', (req, res) => {
  const { secret, code, profileName } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const key = profileName ? profileName.toLowerCase() : 'default';
  latestCodes[key] = { code, timestamp: Date.now() };
  res.json({ success: true });
});

app.post('/add-account', (req, res) => res.json({ success: true }));

// ── IMAP EMAIL POLLING FOR NETFLIX CODES ──────────────────────────────
function createGmailClient(email, password) {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: email,
      pass: password
    },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    logger: false
  });
}

function extractNetflixCode(parsedEmail) {
  const subject = parsedEmail.subject || '';
  const text = parsedEmail.text || '';
  const html = parsedEmail.html || '';
  const from = (parsedEmail.from || '').toString().toLowerCase();
  const combined = `${subject} ${text} ${html}`;
  const lower = combined.toLowerCase();
  if (!from.includes('netflix') && !lower.includes('netflix')) return null;

  const preferred = combined.match(/(?:code|verification|sign[\s-]?in|temporary)[^\d]{0,120}(\d{4,8})/i);
  if (preferred) return { code: preferred[1], customerSafe: preferred[1].length === 4 };

  const fallback = combined.match(/\b(\d{4,8})\b/);
  return fallback ? { code: fallback[1], customerSafe: fallback[1].length === 4 } : null;
}

function collectEmailRecipients(parsedEmail, fallbackEmail) {
  const values = [];
  const addAddressObject = addressObject => {
    if (!addressObject) return;
    if (Array.isArray(addressObject.value)) {
      addressObject.value.forEach(item => values.push(item && item.address));
    }
    if (addressObject.text) {
      const matches = String(addressObject.text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
      values.push(...matches);
    }
  };

  addAddressObject(parsedEmail.to);
  addAddressObject(parsedEmail.cc);
  addAddressObject(parsedEmail.bcc);

  const headers = parsedEmail.headers;
  if (headers && typeof headers.get === 'function') {
    ['delivered-to', 'x-original-to', 'envelope-to', 'to'].forEach(header => {
      const value = headers.get(header);
      if (!value) return;
      if (typeof value === 'string') {
        const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
        values.push(...matches);
      } else if (value.text || value.value) {
        addAddressObject(value);
      }
    });
  }

  const recipients = uniqueNormalizedEmails(values);
  return recipients.length ? recipients : uniqueNormalizedEmails([fallbackEmail]);
}

async function fetchNetflixCodes(targetEmail) {
  await loadGmailMonitors();
  const targetKey = targetEmail ? normalizeEmail(targetEmail) : null;
  const entries = targetKey
    ? (monitoredEmails[targetKey] ? [[targetKey, monitoredEmails[targetKey]]] : [])
    : Object.entries(monitoredEmails);
  let changed = false;

  for (const [email, creds] of entries) {
    let client;
    try {
      client = createGmailClient(creds.user || email, creds.pass);

      await client.connect();

      const lock = await client.getMailboxLock('INBOX');
      const emails = [];
      let maxUid = Number(creds.lastUid || 0);
      try {
        const since = new Date(Date.now() - EMAIL_LOOKBACK_MS);
        const seenUid = Number(creds.lastUid || 0);
        const messages = (await client.search({ since }, { uid: true }) || [])
          .filter(uid => Number(uid) > seenUid)
          .sort((a, b) => Number(a) - Number(b));
        if (messages.length) {
          for await (const message of client.fetch(messages, { uid: true, source: true }, { uid: true })) {
            maxUid = Math.max(maxUid, Number(message.uid || 0));
            if (!message.source) continue;
            const parsed = await simpleParser(message.source);
            emails.push(parsed);
          }
        }
      } finally {
        lock.release();
      }

      // Extract Netflix sign-in codes from emails
      for (const e of emails) {
        const result = extractNetflixCode(e);
        if (result) {
          const recipientKeys = collectEmailRecipients(e, email);
          if (result.customerSafe) {
            recipientKeys.forEach(key => {
              latestCodes[key] = { code: result.code, timestamp: Date.now() };
              delete notifiedCustomers[key];
            });
            console.log(`📧 Netflix sign-in code ${result.code} captured for ${email} recipients: ${recipientKeys.join(', ')}`);
            await sendTG(TG_ADMIN, `✅ <b>Netflix Sign-in Code Captured</b>\n📥 Gmail inbox: ${email}\n📧 Recipient: ${recipientKeys.join(', ')}\n🔢 Code: <b>${result.code}</b>`, 'HTML').catch(() => {});
          } else {
            console.log(`🔐 Admin-only Netflix security code ${result.code} captured for ${email} recipients: ${recipientKeys.join(', ')}`);
            await sendTG(TG_ADMIN, `🔐 <b>Netflix Security Code Captured — ADMIN ONLY</b>\n📥 Gmail inbox: ${email}\n📧 Recipient: ${recipientKeys.join(', ')}\n🔢 Code: <b>${result.code}</b>\n\nNot shown on customer subscription links.`, 'HTML').catch(() => {});
          }
        }
      }
      if (maxUid !== Number(creds.lastUid || 0)) {
        creds.lastUid = maxUid;
        changed = true;
      }
      creds.lastCheckedAt = Date.now();
    } catch(e) {
      console.log('IMAP error for', email, e.message);
    } finally {
      if (client && client.usable) {
        try { await client.logout(); } catch(e) {}
      }
    }
  }
  if (changed) {
    try { await persistGmailMonitors(); } catch(e) { console.log('Gmail monitor persist error:', e.message); }
  }
}

setInterval(fetchNetflixCodes, 30000); // Poll every 30 seconds
setInterval(() => {
  syncDbToJsonBin(false).catch(e => console.error('Periodic JSONBin sync error:', e.message));
}, Math.min(JSONBIN_SYNC_INTERVAL_MS, 60 * 1000));

app.post('/setup-gmail', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const key = normalizeEmail(email);
  const appPassword = normalizeGmailPassword(password);
  if (appPassword.length < 16) {
    return res.status(400).json({
      success: false,
      error: 'Gmail App Password looks too short. Paste the 16-character app password from Google, not your normal Gmail password.'
    });
  }
  try {
    await loadGmailMonitors();
    const previous = monitoredEmails[key];
    const currentMaxUid = await getInboxMaxUid(key, appPassword);
    const lastUid = previous ? Number(previous.lastUid || 0) : currentMaxUid;
    monitoredEmails[key] = { user: key, pass: appPassword, lastUid, lastCheckedAt: Date.now() };
    await persistGmailMonitors();
    await sendTG(TG_ADMIN, `📧 Added Gmail monitoring: <code>${key}</code>\nWill capture new Netflix codes automatically.`, 'HTML').catch(() => {});
    res.json({ success: true, message: 'Gmail added for Netflix code monitoring', gmailConfigured: true, email: key });
  } catch(e) {
    const friendlyError = describeGmailError(e);
    console.log('Gmail setup error for', key, e && (e.message || e));
    await sendTG(TG_ADMIN, `⚠️ Gmail monitoring setup failed for <code>${key}</code>\n${friendlyError}`, 'HTML').catch(() => {});
    res.status(400).json({ success: false, error: friendlyError });
  }
});

app.get('/monitored-emails', (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  res.json({
    success: true,
    emails: Object.entries(monitoredEmails).map(([email, creds]) => ({
      email,
      user: creds.user || email,
      lastUid: creds.lastUid || 0,
      lastCheckedAt: creds.lastCheckedAt || null,
      status: creds.lastCheckedAt ? 'connected' : 'unknown'
    }))
  });
});

let rtEnhancements = null;
rtEnhancements = registerEnhancements(app, {
  requireSession,
  readJsonBinRaw,
  writeJsonBinRaw,
  normalizeEmail,
  hashPassword,
  verifyPassword,
  sanitizeUser,
  safeDataForSession,
  sendTG,
  TG_ADMIN,
  encodeLinkToken,
  decodeLinkToken,
  LINK_TTL_MS,
  validateNetflixAliasPurchase,
  isNetflixStockKey,
  isNetflixFullStockKey,
  isNetflixOneUserStockKey,
  netflixAliasUsage,
  loadGmailMonitors,
  monitoredEmails,
  persistGmailMonitors,
  getInboxMaxUid,
  normalizeGmailPassword,
  describeGmailError,
  createGmailClient,
  readBackupManifest,
  createBackupSnapshot,
  sessions,
  SESSION_TTL_MS
});

// ── START ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('rashadtech server running on port ' + PORT);
  if (rtEnhancements && rtEnhancements.loadPersistedSessions) await rtEnhancements.loadPersistedSessions();
  await loadGmailMonitors();
  syncDbToJsonBin(false).catch(e => console.error('Initial JSONBin sync error:', e.message));
  try {
    const webhookUrl = process.env.RENDER_EXTERNAL_URL + '/telegram';
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const j = await r.json();
    console.log('Webhook:', j.description);
  } catch(e) { console.log('Webhook error:', e.message); }
});
