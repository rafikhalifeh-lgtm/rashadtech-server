const express = require('express');
const compression = require('compression');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { registerEnhancements } = require('./enhancements');
const { registerWhatsAppBot } = require('./whatsappBot');
const {
  getMergedCatalog,
  getCatalogForUser,
  userIsReseller,
  resolvePurchasePrice,
  computeJawakerPrice,
  pricesMatch,
  PRICE_CATALOG_KEY,
  RETAIL_PRICE_CATALOG_KEY,
  countCustomPriceDeltas,
  reconstructCatalogFromChangeLog
} = require('./priceCatalog');
const {
  deliverMarketingEmail,
  deliverOtpEmail,
  deliverPurchaseReceiptEmail,
  deliverSubscriptionEmail,
  deliverSupportEscalationEmail,
  deliverTestEmail,
  deliverTopupConfirmationEmail,
  resolveSupportInbox,
  fetchResendDomainStatus,
  getActiveEmailProvider,
  getEmailDeliverabilityStatus,
  isServerEmailConfigured,
  DEFAULT_FROM_ADDRESS,
  DEFAULT_REPLY_TO
} = require('./emailDelivery');
const {
  markStockSold,
  markLinkedStockSold,
  stockAccountsForPlan,
  stampOrderDelivery,
  initPendingOrder,
  formatBeirutTime,
  initGameOrder
} = require('./orderHelpers');
const { SMS_CONFIG_KEY, grizzlySms, registerSmsRoutes } = require('./smsRoutes');
const {
  isValidOsnOtp,
  isLikelyOsnPhoneFragment,
  extractOsnOtp,
  extractOsnCode: extractOsnCodeFromEmail
} = require('./osnCodeExtract');

const app = express();
const ALLOWED_ORIGINS = new Set([
  'https://rashadtech.tv',
  'https://www.rashadtech.tv',
  'https://rashadtechtv.netlify.app',
  'https://rashadtech-server.onrender.com'
]);
app.use(compression());
app.use(cors({
  origin(origin, cb) {
    try {
      if (!origin || ALLOWED_ORIGINS.has(origin) || /\.netlify\.app$/.test(new URL(origin).hostname)) return cb(null, true);
    } catch(e) {}
    cb(new Error('Not allowed by CORS'));
  }
}));
app.use((err, req, res, next) => {
  if (err && String(err.message || '').includes('CORS')) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next(err);
});
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

const TOTP_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function sanitizeBase32TotpSecret(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function isValidBase32TotpSecret(secret) {
  const clean = sanitizeBase32TotpSecret(secret);
  return clean.length >= 16 && clean.length <= 64;
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
const RECOVERY_SNAPSHOT_LIMIT = Number(process.env.RECOVERY_SNAPSHOT_LIMIT || 15);
const MAX_BACKUPS = RECOVERY_SNAPSHOT_LIMIT;
const EMAILJS_SERVICE_ID = normalizeEnvSecret(process.env.EMAILJS_SERVICE_ID) || 'service_g05xq5o';
const EMAILJS_TEMPLATE_ID = normalizeEnvSecret(process.env.EMAILJS_TEMPLATE_ID) || 'template_e0h7eia';
const EMAILJS_MARKETING_TEMPLATE_ID = normalizeEnvSecret(process.env.EMAILJS_MARKETING_TEMPLATE_ID) || 'template_ldrrf9e';
const OTP_EMAIL_SUBJECT = normalizeEnvSecret(process.env.OTP_EMAIL_SUBJECT) || 'Your RashadTech verification code';
const MARKETING_EMAIL_SETUP_HINT = 'Create a second EmailJS template (Subject: {{subject}}, Body: {{message}}), then set EMAILJS_MARKETING_TEMPLATE_ID on Render or save the template ID in Admin → Dashboard → Marketing email template.';
const EMAILJS_PUBLIC_KEY = normalizeEnvSecret(process.env.EMAILJS_PUBLIC_KEY) || 'LyKu6ZB_y6qoFh7Ef';
const EMAILJS_PRIVATE_KEY = normalizeEnvSecret(process.env.EMAILJS_PRIVATE_KEY);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'RkhRkh7979@';
const ADMIN_TOTP_SECRET = sanitizeBase32TotpSecret(normalizeEnvSecret(process.env.ADMIN_TOTP_SECRET) || 'QZA7V6TTYJGUMAMUZLE57JP6AQ');
const ADMIN_TOTP_ISSUER = 'rashadtech.tv';
const ADMIN_TOTP_LABEL = 'Admin';
const ADMIN_TOTP_SETUP_ALLOWED = process.env.ADMIN_TOTP_SETUP_ALLOWED === 'true';
const adminLoginFailures = new Map();
const ADMIN_LOGIN_MAX_FAILURES = 5;
const ADMIN_LOGIN_LOCK_MS = 30 * 60 * 1000;
const JSONBIN_ALLOW_PUBLIC_READ = normalizeEnvSecret(process.env.JSONBIN_ALLOW_PUBLIC_READ) === 'true';
let FALLBACK_DB_FILE = process.env.FALLBACK_DB_FILE || (fs.existsSync('/var/data') ? '/var/data/rashadtech-db.json' : path.join(process.cwd(), '.data', 'emergency-db.json'));
const JSONBIN_SYNC_INTERVAL_MS = Number(process.env.JSONBIN_SYNC_INTERVAL_MS || 10 * 60 * 1000);
const GMAIL_MONITORS_KEY = 'gmailMonitors';
const BACKUPS_KEY = 'backups';
const LINK_TOKENS_KEY = 'linkTokens';
const CODE_TTL_MS = 15 * 60 * 1000;
const SHAHID_RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SHAHID_FORGET_PASSWORD_URL = 'https://shahid.mbc.net/en/hub/forget-password';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PASSWORD_HASH_PREFIX = 'pbkdf2$';
const ACCOUNT_SERVICE_UNAVAILABLE = 'Account service is temporarily unavailable. Please try again soon.';
const OTP_TTL_MS = 10 * 60 * 1000;

if (!API_SECRET || !TG_TOKEN || !TG_ADMIN) {
  console.error('❌ Missing required env vars: API_SECRET, TG_TOKEN, TG_ADMIN');
}
if (!isValidBase32TotpSecret(ADMIN_TOTP_SECRET)) {
  console.error('❌ ADMIN_TOTP_SECRET must be 16–64 base32 characters (A–Z and 2–7 only)');
}

let latestCodes = {};
let latestShahidResetLinks = {};
let notifiedCustomers = {};
let notifiedShahidReset = {};
const notifiedCaptureAlerts = {};
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
const activePurchases = new Set();
const activeTopupCredits = new Set();
const activeStockAdds = new Set();
let dbWriteQueue = Promise.resolve();
let netlifyWriteQueue = Promise.resolve();
let soldAccIndexCache = { at: 0, index: null };

function enqueueDbWrite(task) {
  const run = dbWriteQueue.then(task);
  dbWriteQueue = run.catch(() => {});
  return run;
}

function enqueueNetlifyWrite(data) {
  const run = netlifyWriteQueue.then(() => writeNetlifyDb(data));
  netlifyWriteQueue = run.catch(e => console.error('Deferred Netlify write error:', e.message));
  return netlifyWriteQueue;
}

async function readDbForWrite() {
  return readJsonBinRaw({ skipRecoverWrite: true, fast: true });
}

async function writeDbFast(data, options = {}) {
  return writeJsonBinRaw(data, { ...options, lightWrite: true });
}

function buildSoldAccIndex(data) {
  const accKeys = new Set();
  const emails = new Set();
  const addOrder = order => {
    if (!order) return;
    const key = String(order.accKey || '');
    if (key) accKeys.add(key);
    const email = normalizeEmail(order.email);
    if (email) emails.add(email);
  };
  for (const user of Array.isArray(data.users) ? data.users : []) {
    for (const order of Array.isArray(user.orders) ? user.orders : []) addOrder(order);
    for (const customer of Array.isArray(user.myCustomers) ? user.myCustomers : []) {
      for (const order of Array.isArray(customer.subs) ? customer.subs : []) addOrder(order);
    }
  }
  return { accKeys, emails };
}

function pickAvailableAccount(data, skey) {
  const sold = getSoldAccIndex(data);
  const accounts = stockAccountsForPlan(data.stock || {}, skey);
  for (const acc of accounts) {
    if (!acc || acc.used) continue;
    const accKey = String(acc.accKey || '');
    const email = normalizeEmail(acc.email);
    const alreadySold = (accKey && sold.accKeys.has(accKey)) || (!accKey && email && sold.emails.has(email));
    if (alreadySold) {
      markLinkedStockSold(data.stock, acc, acc.soldTo || { userEmail: 'unknown', userName: 'unknown', orderId: 'recovered' }, skey);
      continue;
    }
    return acc;
  }
  return null;
}

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
  return String(email || '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeLoginPassword(password) {
  return String(password || '').replace(/\u00a0/g, ' ').trim();
}

function normalizePhone(phone) {
  const raw = String(phone || '').replace(/\u00a0/g, ' ').trim();
  if (!raw) return '';
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('+')) return '+' + digits.slice(1).replace(/\D/g, '');
  return digits.replace(/\D/g, '');
}

function adminLoginBlocked(res, ip) {
  const rec = adminLoginFailures.get(ip);
  if (rec && rec.lockUntil > Date.now() && rec.count >= ADMIN_LOGIN_MAX_FAILURES) {
    res.status(429).json({ error: 'Too many failed admin login attempts. Try again in 30 minutes.' });
    return true;
  }
  return false;
}

function recordAdminLoginFailure(ip) {
  const now = Date.now();
  const rec = adminLoginFailures.get(ip) || { count: 0, lockUntil: now + ADMIN_LOGIN_LOCK_MS };
  if (now > rec.lockUntil) {
    rec.count = 0;
    rec.lockUntil = now + ADMIN_LOGIN_LOCK_MS;
  }
  rec.count += 1;
  if (rec.count >= ADMIN_LOGIN_MAX_FAILURES) rec.lockUntil = now + ADMIN_LOGIN_LOCK_MS;
  adminLoginFailures.set(ip, rec);
}

function clearAdminLoginFailures(ip) {
  adminLoginFailures.delete(ip);
}

const TOTP_BASE32_DECODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32Secret(input) {
  const str = sanitizeBase32TotpSecret(input);
  let bits = '';
  for (const char of str) {
    const val = TOTP_BASE32_DECODE.indexOf(char);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const key = decodeBase32Secret(secret);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(code).padStart(digits, '0');
}

function verifyAdminTotp(secret, token, window = 1) {
  const clean = String(token || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i += 1) {
    if (totpAt(secret, step + i) === clean) return true;
  }
  return false;
}

function adminTotpSetupInfo() {
  const secret = sanitizeBase32TotpSecret(ADMIN_TOTP_SECRET);
  const label = encodeURIComponent(`${ADMIN_TOTP_ISSUER} ${ADMIN_TOTP_LABEL}`);
  const issuer = encodeURIComponent(ADMIN_TOTP_ISSUER);
  const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  return { secret, issuer: ADMIN_TOTP_ISSUER, account: ADMIN_TOTP_LABEL, otpauth };
}

function isAdmin2faSetupAvailable(data) {
  if (data?.siteSettings?.admin2faEnrolled === true) return false;
  return ADMIN_TOTP_SETUP_ALLOWED;
}

async function markAdmin2faEnrolled() {
  try {
    const data = await readJsonBinRaw({ fast: true });
    if (data?.siteSettings?.admin2faEnrolled === true) return;
    data.siteSettings = { ...(data.siteSettings || {}), admin2faEnrolled: true };
    await writeJsonBinRaw(data, { lightWrite: true });
  } catch (e) {
    console.warn('Could not persist admin2faEnrolled:', e.message);
  }
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

async function loadEmailSettingsData() {
  try {
    return await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
  } catch (e) {
    return { siteSettings: {} };
  }
}

async function sendOtpEmail(email, otp, name, data) {
  const mailData = data || await loadEmailSettingsData();
  await deliverOtpEmail({
    email,
    otp,
    name,
    subject: OTP_EMAIL_SUBJECT,
    data: mailData,
    emailJs: {
      serviceId: EMAILJS_SERVICE_ID,
      otpTemplateId: EMAILJS_TEMPLATE_ID,
      publicKey: EMAILJS_PUBLIC_KEY,
      privateKey: EMAILJS_PRIVATE_KEY
    }
  });
}

async function sendSubscriptionEmail(user, product, planLabel, order, subLink, options = {}) {
  const email = normalizeEmail(user && user.email);
  if (!email) return false;
  const mailData = options.data || await loadEmailSettingsData();
  if (!isServerEmailConfigured(mailData)) {
    console.warn('Subscription email skipped — email not configured:', email);
    return false;
  }
  try {
    await deliverSubscriptionEmail({
      email,
      name: user.name,
      productName: product && product.name,
      planLabel,
      order,
      subLink,
      assignedCustomerName: options.assignedCustomerName || '',
      kind: options.kind || 'fulfilled',
      data: mailData,
      emailJs: {
        serviceId: EMAILJS_SERVICE_ID,
        otpTemplateId: EMAILJS_TEMPLATE_ID,
        marketingTemplateId: resolveMarketingTemplateId(mailData) || EMAILJS_MARKETING_TEMPLATE_ID,
        publicKey: EMAILJS_PUBLIC_KEY,
        privateKey: EMAILJS_PRIVATE_KEY
      }
    });
    return true;
  } catch (e) {
    console.error('Subscription email error:', e.message);
    return false;
  }
}

async function sendPurchaseReceiptEmail(user, product, planLabel, price, order, options = {}) {
  const email = normalizeEmail(user && user.email);
  if (!email) return false;
  const mailData = options.data || await loadEmailSettingsData();
  if (!isServerEmailConfigured(mailData)) {
    console.warn('Receipt email skipped — email not configured:', email);
    return false;
  }
  try {
    await deliverPurchaseReceiptEmail({
      email,
      name: user.name,
      productName: product && product.name,
      planLabel,
      orderId: order && (order.id || order.orderId),
      amount: Number(price),
      balanceAfter: Number(user.balance || 0),
      status: options.status || (order && order.pending ? 'pending' : 'confirmed'),
      date: (order && order.date) || options.date || formatBeirutTime(),
      assignedCustomerName: options.assignedCustomerName || '',
      data: mailData,
      emailJs: {
        serviceId: EMAILJS_SERVICE_ID,
        otpTemplateId: EMAILJS_TEMPLATE_ID,
        marketingTemplateId: resolveMarketingTemplateId(mailData) || EMAILJS_MARKETING_TEMPLATE_ID,
        publicKey: EMAILJS_PUBLIC_KEY,
        privateKey: EMAILJS_PRIVATE_KEY
      }
    });
    return true;
  } catch (e) {
    console.error('Receipt email error:', e.message);
    return false;
  }
}

async function sendTopupConfirmationEmail(user, amount, label, options = {}) {
  const email = normalizeEmail(user && user.email);
  if (!email) return false;
  const mailData = options.data || await loadEmailSettingsData();
  if (!isServerEmailConfigured(mailData)) {
    console.warn('Topup email skipped — email not configured:', email);
    return false;
  }
  try {
    await deliverTopupConfirmationEmail({
      email,
      name: user.name,
      amount: Number(amount),
      balanceAfter: Number(user.balance || 0),
      label: label || `$${Number(amount).toFixed(2)}`,
      date: options.date || formatBeirutTime(),
      data: mailData,
      emailJs: {
        serviceId: EMAILJS_SERVICE_ID,
        otpTemplateId: EMAILJS_TEMPLATE_ID,
        marketingTemplateId: resolveMarketingTemplateId(mailData) || EMAILJS_MARKETING_TEMPLATE_ID,
        publicKey: EMAILJS_PUBLIC_KEY,
        privateKey: EMAILJS_PRIVATE_KEY
      }
    });
    return true;
  } catch (e) {
    console.error('Topup confirmation email error:', e.message);
    return false;
  }
}

async function sendUserEmail(email, subject, message, name, data) {
  const mailData = data || await loadEmailSettingsData();
  const templateId = getActiveEmailProvider(mailData) === 'resend'
    ? (resolveMarketingTemplateId(mailData) || EMAILJS_MARKETING_TEMPLATE_ID || 'resend')
    : requireMarketingTemplateId(mailData);
  await deliverMarketingEmail({
    email,
    name,
    subject,
    message,
    templateId,
    data: mailData,
    emailJs: {
      serviceId: EMAILJS_SERVICE_ID,
      publicKey: EMAILJS_PUBLIC_KEY,
      privateKey: EMAILJS_PRIVATE_KEY
    }
  });
}
function resolveMarketingTemplateId(data) {
  const fromSettings = normalizeEnvSecret(data?.siteSettings?.emailjsMarketingTemplateId);
  if (fromSettings) return fromSettings;
  if (EMAILJS_MARKETING_TEMPLATE_ID) return EMAILJS_MARKETING_TEMPLATE_ID;
  return '';
}

function requireMarketingTemplateId(data) {
  const templateId = resolveMarketingTemplateId(data);
  if (!templateId) {
    throw new Error(`Marketing email template is not configured. ${MARKETING_EMAIL_SETUP_HINT}`);
  }
  if (templateId === EMAILJS_TEMPLATE_ID) {
    throw new Error(`Profile reminders and broadcasts cannot use the verification-code EmailJS template (${EMAILJS_TEMPLATE_ID}). ${MARKETING_EMAIL_SETUP_HINT}`);
  }
  return templateId;
}

async function marketingEmailTemplateId(data) {
  if (data) return resolveMarketingTemplateId(data);
  try {
    const data = await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
    return resolveMarketingTemplateId(data);
  } catch (e) {
    return EMAILJS_MARKETING_TEMPLATE_ID || '';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function deliverOtp({ email, otp, name, tgChatId, purpose }) {
  let emailSent = false;
  let telegramSent = false;
  const mailData = await loadEmailSettingsData();
  if (isServerEmailConfigured(mailData)) {
    try {
      await sendOtpEmail(email, otp, name, mailData);
      emailSent = true;
    } catch(e) {
      console.error(`${purpose || 'OTP'} email delivery error:`, e.message);
    }
  } else {
    console.warn(`${purpose || 'OTP'}: server email skipped — add Resend API key in Admin → Dashboard or set RESEND_API_KEY / EMAILJS_PRIVATE_KEY on Render`);
  }
  if (tgChatId) {
    try {
      await sendTG(String(tgChatId), `🔐 <b>Your rashadtech.tv verification code:</b>\n\n<b>${otp}</b>\n\nThis code expires in 10 minutes. Do not share it.`, 'HTML');
      telegramSent = true;
    } catch(e) {
      console.error(`${purpose || 'OTP'} Telegram delivery error:`, e.message);
    }
  }
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
  const session = { role, email: normalizeEmail(email), expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(token, session);
  if (dbCache) {
    dbCache.sessions = dbCache.sessions || {};
    dbCache.sessions[token] = session;
  }
  if (rtEnhancements && rtEnhancements.persistSessions) {
    rtEnhancements.persistSessions().catch((e) => console.error('Session persist error:', e.message));
  }
  return token;
}

function getSession(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  let session = sessions.get(token);
  if (!session && dbCache && dbCache.sessions && dbCache.sessions[token]) {
    const stored = dbCache.sessions[token];
    if (stored && Date.now() < Number(stored.expiresAt || 0)) {
      session = stored;
      sessions.set(token, session);
    }
  }
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
    [RETAIL_STOCK_BLOCKS_KEY]: {},
    requests: [],
    topupreqs: [],
    pending: [],
    gameorders: [],
    smsorders: [],
    [SMS_CONFIG_KEY]: grizzlySms.defaultSmsConfig(),
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
  soldAccIndexCache = { at: 0, index: null };
}

function getSoldAccIndex(data) {
  if (soldAccIndexCache.at === dbCacheLoadedAt && soldAccIndexCache.index) {
    return soldAccIndexCache.index;
  }
  const index = buildSoldAccIndex(data);
  soldAccIndexCache = { at: dbCacheLoadedAt, index };
  return index;
}

function writeFallbackDb(data) {
  const writeTo = file => {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data || emptyDbData()));
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

function countStockStats(stock) {
  let available = 0;
  let sold = 0;
  for (const accs of Object.values(stock || {})) {
    if (!Array.isArray(accs)) continue;
    for (const a of accs) {
      if (a && a.used) sold++;
      else available++;
    }
  }
  return { available, sold, total: available + sold };
}

function backupSummary(data) {
  const stock = data && data.stock ? data.stock : {};
  const stockStats = countStockStats(stock);
  return {
    users: Array.isArray(data && data.users) ? data.users.length : 0,
    stockKeys: Object.keys(stock).length,
    stockAccounts: stockStats.available,
    stockSold: stockStats.sold,
    stockTotal: stockStats.total,
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
  merged.users = (merged.users || []).map((user) => {
    if (!user || !user.email) return user;
    const match = (fallback.users || []).find(item => normalizeEmail(item.email) === normalizeEmail(user.email));
    if (!match) return user;
    const myCustomers = mergeMyCustomers(match.myCustomers, user.myCustomers);
    return {
      ...user,
      myCustomers: myCustomers.length ? myCustomers : (user.myCustomers || [])
    };
  });
  for (const fbUser of Array.isArray(fallback.users) ? fallback.users : []) {
    if (!fbUser || !fbUser.email) continue;
    const exists = merged.users.some(item => normalizeEmail(item.email) === normalizeEmail(fbUser.email));
    if (!exists && Array.isArray(fbUser.myCustomers) && fbUser.myCustomers.length) {
      merged.users.push({ ...fbUser });
    }
  }
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

let readJsonBinInFlight = null;

async function readJsonBinRaw(options = {}) {
  if (dbCache && !options.forceRefresh) {
    return options.noClone ? dbCache : cloneData(dbCache);
  }
  if (readJsonBinInFlight && !options.forceRefresh) {
    const data = await readJsonBinInFlight;
    return options.noClone ? data : cloneData(data);
  }
  const run = async () => {
    let data = null;
    try {
      data = await readNetlifyDb();
    } catch(e) {
      console.error('Netlify database read error:', e.message);
    }
    if (!data) data = readFallbackDb();
    data = markEmergencyDb(data, NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN ? 'Netlify Blobs primary database' : 'Primary server file database', !(NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN));
    const loaded = data;
    if (!options.fast) {
      const recovered = await recoverSettingsFromBackups(loaded, { recoverBlocks: false });
      data = recovered.data;
      if (recovered.changed && !options.skipRecoverWrite) {
        console.log(`Recovered settings: ${recovered.customPriceCount} custom prices (${recovered.catalogSource}), ${recovered.blockCount} blocks (${recovered.blockSource})`);
        await writeJsonBinRaw(data, { backupReason: 'auto-recover-settings', backupSource: loaded }).catch(e => {
          console.error('Auto-recover write error:', e.message);
        });
      }
    }
    setDbCache(data, false);
    writeFallbackDb(data);
    return cloneData(dbCache);
  };
  readJsonBinInFlight = run().finally(() => { readJsonBinInFlight = null; });
  return readJsonBinInFlight;
}

async function writeJsonBinRaw(data, options = {}) {
  const nextData = { ...(data || {}) };
  const lightWrite = Boolean(options.lightWrite);
  const existingBackups = Array.isArray(nextData[BACKUPS_KEY])
    ? nextData[BACKUPS_KEY].filter(item => item && item.data).slice(0, 9)
    : [];
  let backupSource = options.backupSource;
  if (!lightWrite) {
    if (backupSource === undefined) backupSource = await readJsonBinRaw({ fast: true }).catch(() => null);
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
  } else {
    nextData[BACKUPS_KEY] = existingBackups;
  }
  const fallbackData = markEmergencyDb(nextData, NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN ? 'Netlify Blobs primary database' : 'Primary server file database', !(NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN));
  if (lightWrite) {
    setDbCache(fallbackData, false);
    runAfterResponse(() => {
      try {
        writeFallbackDb(dbCache);
      } catch (e) {
        console.error('Fallback DB write error:', e.message);
      }
      if (NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN) {
        enqueueNetlifyWrite(fallbackData);
      }
    });
    syncDbToJsonBin(false).catch(e => console.error('Background JSONBin sync error:', e.message));
    return { cached: true, emergencyDb: Boolean(fallbackData.emergencyDb && fallbackData.emergencyDb.active) };
  }
  saveLocalDb(fallbackData, true);
  if (NETLIFY_SITE_ID && NETLIFY_BLOBS_TOKEN) {
    if (backupSource) {
      await createBackupSnapshot(backupSource, options.backupReason || 'before-write').catch(e => console.error('Backup snapshot error:', e.message));
    }
    await writeNetlifyDb(fallbackData);
    setDbCache(fallbackData, false);
  }
  syncDbToJsonBin(false).catch(e => console.error('Background JSONBin sync error:', e.message));
  return { cached: true, emergencyDb: Boolean(fallbackData.emergencyDb && fallbackData.emergencyDb.active) };
}

function stripPrivateData(data) {
  const publicData = { ...(data || {}) };
  delete publicData[GMAIL_MONITORS_KEY];
  delete publicData.sessions;
  if (publicData[SMS_CONFIG_KEY]) {
    publicData[SMS_CONFIG_KEY] = grizzlySms.sanitizeSmsConfigForClient(publicData[SMS_CONFIG_KEY], false);
  }
  if (Array.isArray(publicData.users)) {
    publicData.users = publicData.users.map(u => sanitizeUser(u, { admin: true }));
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

function sanitizeOrder(order) {
  if (!order) return order;
  const safe = { ...order };
  delete safe.inboxPass;
  return safe;
}

function sanitizeUser(user, options = {}) {
  if (!user) return null;
  const safeUser = { ...user };
  delete safeUser.pass;
  if (!options.admin) delete safeUser.signupPass;
  if (Array.isArray(safeUser.orders)) safeUser.orders = safeUser.orders.map(sanitizeOrder);
  if (Array.isArray(safeUser.myCustomers)) {
    safeUser.myCustomers = safeUser.myCustomers.map(customer => ({
      ...customer,
      subs: Array.isArray(customer.subs) ? customer.subs.map(sanitizeOrder) : []
    }));
  }
  return safeUser;
}

function isShahidOrder(order) {
  if (!order) return false;
  if (order.productId === 'shahid') return true;
  return /shahid/i.test(String(order.product || ''));
}

function findStockAccountForOrder(data, order) {
  if (!order || !order.email) return null;
  const targetEmail = normalizeEmail(order.email);
  const targetKey = String(order.accKey || '');
  for (const accounts of Object.values((data && data.stock) || {})) {
    for (const acc of accounts || []) {
      if (!acc || normalizeEmail(acc.email) !== targetEmail) continue;
      if (targetKey && acc.accKey && acc.accKey !== targetKey) continue;
      return acc;
    }
  }
  return null;
}

function isGmailAddress(email) {
  const domain = String(email || '').split('@')[1] || '';
  return /^(gmail|googlemail)\.com$/i.test(domain);
}

function resolveShahidInboxEmail(data, order) {
  const stockAcc = findStockAccountForOrder(data, order);
  const inboxEmail = normalizeEmail(order.mainEmail || (stockAcc && stockAcc.mainEmail) || '');
  return { inboxEmail, accountEmail: normalizeEmail(order.email) };
}

function resolveSignInCodeEmails(data, meta) {
  const orderLike = {
    email: meta.codeEmail || meta.email || '',
    mainEmail: meta.mainEmail || meta.inboxEmail || '',
    accKey: meta.accKey || ''
  };
  const stockAcc = findStockAccountForOrder(data, orderLike);
  const codeKey = normalizeEmail(
    meta.codeEmail || meta.email || (stockAcc && stockAcc.email) || ''
  );
  const inboxFromMeta = normalizeEmail(meta.inboxEmail || meta.mainEmail || '');
  const inboxFromStock = normalizeEmail(stockAcc && stockAcc.mainEmail || '');
  const inboxKey = inboxFromMeta && isGmailAddress(inboxFromMeta)
    ? inboxFromMeta
    : (inboxFromStock || inboxFromMeta || codeKey);
  return { codeKey, inboxKey, stockAcc };
}

function safeDataForSession(data, session) {
  try {
    return dataForSession(data, session);
  } catch(e) {
    console.error('Session data serialization error:', e.message);
    return session.role === 'admin'
      ? { users: [], stock: {}, stockBlocks: {}, [RETAIL_STOCK_BLOCKS_KEY]: {}, requests: [], topupreqs: [], pending: [], gameorders: [] }
      : { users: [], stock: {}, stockBlocks: {}, [RETAIL_STOCK_BLOCKS_KEY]: {}, requests: [], topupreqs: [], pending: [], gameorders: [] };
  }
}

/** Lightweight payload for mutation endpoints — omits full admin stock unless requested. */
function slimMutationData(session, data, options = {}) {
  if (options.topupreqsOnly) {
    return { topupreqs: data.topupreqs || [] };
  }
  if (session.role === 'admin') {
    const out = {
      topupreqs: data.topupreqs || [],
      users: (data.users || []).map(u => sanitizeUser(u, { admin: true })),
      stockBlocks: data.stockBlocks || {},
      [RETAIL_STOCK_BLOCKS_KEY]: data[RETAIL_STOCK_BLOCKS_KEY] || {}
    };
    if (options.pending) out.pending = data.pending || [];
    if (options.stock) {
      const stripped = stripPrivateData(data);
      out.stock = stripped.stock || {};
    }
    if (options.gameorders) out.gameorders = data.gameorders || [];
    if (options.requests) out.requests = data.requests || [];
    return out;
  }
  return dataForSession(data, session);
}

function runAfterResponse(task) {
  setImmediate(() => {
    Promise.resolve().then(task).catch(e => console.error('Background task error:', e.message));
  });
}

function dataForSession(data, session) {
  const publicData = stripPrivateData(data || {});
  if (session.role === 'admin') {
    const adminData = { ...publicData };
    // SMS catalog can be 250KB+ — load via /admin/sms/config on demand.
    delete adminData[SMS_CONFIG_KEY];
    return adminData;
  }
  const user = (publicData.users || []).find(u => normalizeEmail(u.email) === session.email);
  return {
    users: user ? [sanitizeUser(user)] : [],
    stock: sanitizeStock(publicData.stock || {}),
    stockBlocks: sanitizeStockBlocks(publicData.stockBlocks || {}),
    [RETAIL_STOCK_BLOCKS_KEY]: sanitizeStockBlocks(publicData[RETAIL_STOCK_BLOCKS_KEY] || {}),
    requests: publicData.requests || [],
    topupreqs: (publicData.topupreqs || []).filter(r => normalizeEmail(r.email) === session.email),
    pending: (publicData.pending || []).filter(o => normalizeEmail(o.userEmail) === session.email),
    gameorders: (publicData.gameorders || []).filter(o => normalizeEmail(o.userEmail) === session.email)
  };
}

function mergeOwnTopupRequests(existingOwn, incomingOwn) {
  const byId = new Map();
  (existingOwn || []).forEach((row) => {
    if (!row) return;
    const key = row.id || `${normalizeEmail(row.email)}:${row.amount}:${row.date || ''}`;
    byId.set(key, row);
  });
  (incomingOwn || []).forEach((row) => {
    if (!row) return;
    const key = row.id || `${normalizeEmail(row.email)}:${row.amount}:${row.date || ''}`;
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, row);
      return;
    }
    const credited = prev.status === 'credited' || row.status === 'credited';
    byId.set(key, { ...prev, ...row, status: credited ? 'credited' : (row.status || prev.status) });
  });
  return Array.from(byId.values());
}

function mergeMyCustomers(prev, incoming) {
  const a = Array.isArray(prev) ? prev : [];
  const b = Array.isArray(incoming) ? incoming : [];
  if (!b.length) return a;
  if (!a.length) return b;
  const byId = new Map();
  a.forEach((c) => {
    if (!c || c.id == null) return;
    byId.set(String(c.id), {
      ...c,
      subs: Array.isArray(c.subs) ? c.subs.map(s => ({ ...s })) : []
    });
  });
  b.forEach((c) => {
    if (!c || c.id == null) return;
    const id = String(c.id);
    const prevC = byId.get(id) || {};
    const subs = Array.isArray(c.subs) && c.subs.length
      ? c.subs
      : (Array.isArray(prevC.subs) ? prevC.subs : []);
    byId.set(id, { ...prevC, ...c, subs });
  });
  return Array.from(byId.values());
}

function applyMyCustomersWrite(prev, incoming, options = {}) {
  const inc = Array.isArray(incoming) ? incoming : [];
  const prevList = Array.isArray(prev) ? prev : [];
  if (!inc.length && prevList.length && !options.allowEmpty) return prevList;
  const prevById = new Map();
  prevList.forEach((c) => {
    if (c && c.id != null) prevById.set(String(c.id), c);
  });
  return inc.map((c) => {
    if (!c || c.id == null) return null;
    const old = prevById.get(String(c.id)) || {};
    const subs = Array.isArray(c.subs) && c.subs.length
      ? c.subs
      : (Array.isArray(old.subs) ? old.subs : []);
    return { ...old, ...c, subs };
  }).filter(Boolean);
}

function mergeUserWrite(existing, incoming, session) {
  const next = { ...(existing || {}) };
  const email = session.email;
  const users = Array.isArray(next.users) ? next.users : [];
  const incomingUser = (incoming.users || []).find(u => normalizeEmail(u.email) === email);
  if (incomingUser) {
    const idx = users.findIndex(u => normalizeEmail(u.email) === email);
    if (idx >= 0) {
      const prev = users[idx];
      const nextPhone = normalizePhone(incomingUser.phone);
      users[idx] = {
        ...prev,
        name: incomingUser.name,
        phone: nextPhone || normalizePhone(prev.phone) || '',
        tgChatId: String(incomingUser.tgChatId || '').trim() || String(prev.tgChatId || '').trim(),
        verified: Boolean(incomingUser.verified),
        myCustomers: mergeMyCustomers(prev.myCustomers, incomingUser.myCustomers),
        balance: Number(prev.balance || 0),
        orders: Array.isArray(prev.orders) ? prev.orders : [],
        transactions: Array.isArray(prev.transactions) ? prev.transactions : [],
        isReseller: prev.isReseller
      };
    }
  }
  next.users = users;

  // Users cannot overwrite global product requests from a stale browser cache.
  if (Array.isArray(incoming.requests)) {
    const existingRequests = Array.isArray(next.requests) ? next.requests : [];
    next.requests = session.role === 'admin'
      ? incoming.requests
      : mergeProductRequests(existingRequests, incoming.requests);
  }

  const existingTopups = Array.isArray(next.topupreqs) ? next.topupreqs : [];
  const otherTopups = existingTopups.filter(r => normalizeEmail(r.email) !== email);
  const existingOwn = existingTopups.filter(r => normalizeEmail(r.email) === email);
  const ownTopups = (incoming.topupreqs || []).filter(r => normalizeEmail(r.email) === email);
  next.topupreqs = [...otherTopups, ...mergeOwnTopupRequests(existingOwn, ownTopups)];

  if (Array.isArray(incoming.gameorders)) {
    const existingGameOrders = Array.isArray(next.gameorders) ? next.gameorders : [];
    const ownIncomingGameOrders = incoming.gameorders.filter(order => normalizeEmail(order.userEmail) === email);
    next.gameorders = mergeArrayByKey(existingGameOrders, ownIncomingGameOrders, order => order && order.id);
  }

  if (existing && existing[GMAIL_MONITORS_KEY]) next[GMAIL_MONITORS_KEY] = existing[GMAIL_MONITORS_KEY];
  if (existing && existing[SMS_CONFIG_KEY]) next[SMS_CONFIG_KEY] = existing[SMS_CONFIG_KEY];
  if (existing && Array.isArray(existing.smsorders)) next.smsorders = existing.smsorders;
  if (existing && existing.stockBlocks) next.stockBlocks = existing.stockBlocks;
  if (existing && existing[RETAIL_STOCK_BLOCKS_KEY]) next[RETAIL_STOCK_BLOCKS_KEY] = existing[RETAIL_STOCK_BLOCKS_KEY];
  return next;
}

function stockBlockCount(blocks) {
  return Object.keys(blocks || {}).length;
}

async function collectRecoverySources(data) {
  const sources = [];
  const addSource = (label, catalog, stockBlocks) => {
    const customPrices = countCustomPriceDeltas(catalog);
    const blocks = stockBlockCount(stockBlocks);
    if (customPrices > 0 || blocks > 0) {
      sources.push({
        id: sources.length,
        label,
        catalog: catalog || null,
        stockBlocks: stockBlocks || {},
        customPrices,
        blocks
      });
    }
  };

  addSource('current', data && data[PRICE_CATALOG_KEY], data && data.stockBlocks);

  const embedded = Array.isArray(data && data[BACKUPS_KEY]) ? data[BACKUPS_KEY] : [];
  embedded.forEach((backup, index) => {
    if (!backup || !backup.data) return;
    addSource(`embedded-backup-${index + 1}`, backup.data[PRICE_CATALOG_KEY], backup.data.stockBlocks);
  });

  const fromLog = reconstructCatalogFromChangeLog(data);
  if (fromLog) addSource('price-change-log', fromLog, null);

  try {
    const manifest = await readBackupManifest();
    for (const entry of manifest.slice(0, RECOVERY_SNAPSHOT_LIMIT)) {
      try {
        const { data: snapshot } = await readBackupSnapshot(entry.id);
        addSource(`snapshot-${formatBeirutTime(entry.ts)}`, snapshot[PRICE_CATALOG_KEY], snapshot.stockBlocks);
      } catch (e) {
        console.warn('Recovery snapshot skipped:', entry && entry.id, e.message);
      }
    }
  } catch (e) {
    console.warn('Recovery manifest read failed:', e.message);
  }

  return sources.sort((a, b) => b.customPrices - a.customPrices || b.blocks - a.blocks);
}

async function recoverSettingsFromBackups(data, options = {}) {
  const recoverBlocks = options.recoverBlocks === true;
  const result = { ...(data || {}) };
  const sources = await collectRecoverySources(data);

  let bestCatalog = result[PRICE_CATALOG_KEY];
  let bestCatalogScore = countCustomPriceDeltas(bestCatalog);
  let bestCatalogSource = 'current';
  let bestBlocks = result.stockBlocks || {};
  let bestBlockScore = stockBlockCount(bestBlocks);
  let bestBlockSource = 'current';

  sources.forEach(source => {
    if (source.customPrices > bestCatalogScore && source.catalog) {
      bestCatalog = source.catalog;
      bestCatalogScore = source.customPrices;
      bestCatalogSource = source.label;
    }
    if (source.blocks > bestBlockScore && source.stockBlocks) {
      bestBlocks = source.stockBlocks;
      bestBlockScore = source.blocks;
      bestBlockSource = source.label;
    }
  });

  let changed = false;
  if (bestCatalogScore > countCustomPriceDeltas(result[PRICE_CATALOG_KEY])) {
    result[PRICE_CATALOG_KEY] = bestCatalog;
    changed = true;
  }
  if (recoverBlocks && bestBlockScore > stockBlockCount(result.stockBlocks)) {
    result.stockBlocks = bestBlocks;
    changed = true;
  }

  return {
    data: result,
    changed,
    customPriceCount: bestCatalogScore,
    catalogSource: bestCatalogSource,
    blockSource: bestBlockSource,
    blockCount: bestBlockScore,
    sources
  };
}

function mergeStockPreservingSold(existingStock, incomingStock) {
  const existing = existingStock || {};
  const incoming = incomingStock || {};
  const merged = { ...existing };
  for (const key of Object.keys(incoming)) {
    const existingAccounts = Array.isArray(existing[key]) ? existing[key] : [];
    const incomingAccounts = Array.isArray(incoming[key]) ? incoming[key] : [];
    const byId = new Map();
    existingAccounts.forEach((acc) => {
      if (!acc) return;
      const id = String(acc.accKey || acc.email || '');
      if (id) byId.set(id, acc);
    });
    const incomingIds = new Set();
    incomingAccounts.forEach((acc) => {
      if (!acc) return;
      const id = String(acc.accKey || acc.email || '');
      if (!id) return;
      incomingIds.add(id);
      const prev = byId.get(id);
      if (prev && prev.used) {
        byId.set(id, { ...acc, used: true, soldTo: prev.soldTo || acc.soldTo });
      } else if (prev) {
        byId.set(id, { ...prev, ...acc, used: Boolean(prev.used || acc.used) });
      } else {
        byId.set(id, acc);
      }
    });
    for (const [id, acc] of [...byId.entries()]) {
      if (!incomingIds.has(id) && !acc.used) byId.delete(id);
    }
    merged[key] = Array.from(byId.values());
  }
  return merged;
}

function netflixOneUserPlanKeys() {
  return ['netflix__1user__1m', 'netflix__1user__3m', 'netflix__1user__6m', 'netflix__1user__1y'];
}

function stockAccountMatches(a, b) {
  if (!a || !b) return false;
  const phoneA = String(a.phone || '').replace(/\s+/g, '');
  const phoneB = String(b.phone || '').replace(/\s+/g, '');
  if (phoneA && phoneB) {
    if (phoneA !== phoneB) return false;
    const profileA = String(a.profileName || '').trim().toLowerCase();
    const profileB = String(b.profileName || '').trim().toLowerCase();
    return profileA === profileB;
  }
  const emailA = normalizeEmail(a.email);
  const emailB = normalizeEmail(b.email);
  const profileA = String(a.profileName || '').trim().toLowerCase();
  const profileB = String(b.profileName || '').trim().toLowerCase();
  if (!emailA && !emailB) {
    const linkA = String(a.serviceLink || '').trim();
    const linkB = String(b.serviceLink || '').trim();
    if (linkA && linkB) return linkA === linkB;
    return Boolean(profileA) && profileA === profileB;
  }
  if (emailA !== emailB) return false;
  if (profileA !== profileB) return false;
  if (String(a.profilePin || '').trim() !== String(b.profilePin || '').trim()) return false;
  return true;
}

function findDuplicateStockAccount(stock, key, accPayload) {
  if (isAmazonStockKey(key)) return null;
  const list = Array.isArray(stock && stock[key]) ? stock[key] : [];
  return list.find(a => a && !a.used && stockAccountMatches(a, accPayload));
}

function stockAddFingerprint(rowAccount, rowKeys) {
  const phone = String(rowAccount && rowAccount.phone || '').replace(/\s+/g, '');
  const email = normalizeEmail(rowAccount && rowAccount.email);
  const profile = String(rowAccount && rowAccount.profileName || '').trim().toLowerCase();
  const pin = String(rowAccount && rowAccount.profilePin || '').trim();
  return [phone || email, profile, pin, (rowKeys || []).join('|')].join('::');
}

function stockAccountFingerprints(acc) {
  const fps = [];
  const key = String(acc && acc.accKey || '');
  if (key) fps.push(`k:${key}`);
  const phone = String(acc && acc.phone || '').replace(/\s+/g, '');
  const email = normalizeEmail(acc && acc.email);
  const profile = String(acc && acc.profileName || '').trim().toLowerCase();
  const pin = String(acc && acc.profilePin || '').trim();
  if (phone) fps.push(`p:${phone}::${profile}`);
  if (email) fps.push(`f:${email}::${profile}::${pin}`);
  return fps;
}

function buildNetflixMirrorIndex(stock, keepSkey) {
  const index = new Set();
  const keep = Array.isArray(stock && stock[keepSkey]) ? stock[keepSkey] : [];
  keep.forEach((acc) => {
    stockAccountFingerprints(acc).forEach((fp) => index.add(fp));
  });
  return index;
}

function accountMatchesNetflixMirror(acc, index) {
  return stockAccountFingerprints(acc).some((fp) => index.has(fp));
}

function countNetflixMirrorCopies(stock, keepSkey) {
  if (!/^netflix__1user__/.test(String(keepSkey || ''))) return 0;
  const index = buildNetflixMirrorIndex(stock, keepSkey);
  let mirrors = 0;
  for (const planKey of netflixOneUserPlanKeys()) {
    if (planKey === keepSkey) continue;
    for (const acc of Array.isArray(stock[planKey]) ? stock[planKey] : []) {
      if (acc && accountMatchesNetflixMirror(acc, index)) mirrors += 1;
    }
  }
  return mirrors;
}

function pruneNetflixMirrors(stock, keepSkey) {
  if (!/^netflix__1user__/.test(String(keepSkey || ''))) return { removed: 0 };
  const index = buildNetflixMirrorIndex(stock, keepSkey);
  let removed = 0;
  for (const planKey of netflixOneUserPlanKeys()) {
    if (planKey === keepSkey) continue;
    const accounts = Array.isArray(stock[planKey]) ? stock[planKey] : [];
    const next = accounts.filter((acc) => {
      if (!acc) return false;
      if (accountMatchesNetflixMirror(acc, index)) {
        removed += 1;
        return false;
      }
      return true;
    });
    stock[planKey] = next;
  }
  return { removed };
}

function mergeAllTopupRequests(existingTopups, incomingTopups) {
  if (!Array.isArray(incomingTopups)) return Array.isArray(existingTopups) ? existingTopups : [];
  const existingByKey = new Map();
  (existingTopups || []).forEach((row) => {
    if (!row) return;
    const key = row.id || `${normalizeEmail(row.email)}:${row.amount}:${row.date || ''}`;
    existingByKey.set(key, row);
  });
  return incomingTopups.map((row) => {
    if (!row) return row;
    const key = row.id || `${normalizeEmail(row.email)}:${row.amount}:${row.date || ''}`;
    const prev = existingByKey.get(key);
    if (!prev) return row;
    const credited = prev.status === 'credited' || row.status === 'credited';
    return { ...prev, ...row, status: credited ? 'credited' : (row.status || prev.status) };
  });
}

function mergeProductRequests(existingRequests, incomingRequests) {
  if (!Array.isArray(incomingRequests)) return Array.isArray(existingRequests) ? existingRequests : [];
  const byId = new Map();
  (existingRequests || []).forEach((row) => {
    if (!row || row.id == null) return;
    byId.set(String(row.id), {
      ...row,
      requesters: Array.isArray(row.requesters) ? [...row.requesters] : []
    });
  });
  incomingRequests.forEach((row) => {
    if (!row || row.id == null) return;
    const key = String(row.id);
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, {
        ...row,
        requesters: Array.isArray(row.requesters) ? [...row.requesters] : []
      });
      return;
    }
    const requesters = [...new Set([
      ...(prev.requesters || []).map(e => normalizeEmail(e)),
      ...(row.requesters || []).map(e => normalizeEmail(e))
    ].filter(Boolean))];
    byId.set(key, { ...prev, ...row, requesters });
  });
  return Array.from(byId.values());
}

function mergePendingOrders(existingPending, incomingPending) {
  if (!Array.isArray(incomingPending)) return Array.isArray(existingPending) ? existingPending : [];
  const byId = new Map();
  (existingPending || []).forEach((row) => {
    if (!row || row.id == null) return;
    byId.set(String(row.id), row);
  });
  incomingPending.forEach((row) => {
    if (!row || row.id == null) return;
    const key = String(row.id);
    const prev = byId.get(key);
    byId.set(key, prev ? { ...prev, ...row } : row);
  });
  return Array.from(byId.values());
}

function mergeGameOrders(existingOrders, incomingOrders) {
  if (!Array.isArray(incomingOrders)) return Array.isArray(existingOrders) ? existingOrders : [];
  const byId = new Map();
  (existingOrders || []).forEach((row) => {
    if (!row || row.id == null) return;
    byId.set(String(row.id), row);
  });
  incomingOrders.forEach((row) => {
    if (!row || row.id == null) return;
    const key = String(row.id);
    const prev = byId.get(key);
    byId.set(key, prev ? { ...prev, ...row } : row);
  });
  return Array.from(byId.values());
}

function mergeUsersPreservingWallet(existingUsers, incomingUsers) {
  const existing = Array.isArray(existingUsers) ? existingUsers : [];
  if (!Array.isArray(incomingUsers)) return existing;
  const byEmail = new Map(existing.map(u => [normalizeEmail(u.email), { ...u }]));
  const merged = incomingUsers.map((inc) => {
    if (!inc || !inc.email) return inc;
    const email = normalizeEmail(inc.email);
    const prev = byEmail.get(email);
    if (!prev) return { ...inc };
    return {
      ...prev,
      name: String(inc.name || prev.name || '').trim() || prev.name,
      tgChatId: String(inc.tgChatId || prev.tgChatId || '').trim(),
      verified: inc.verified !== undefined ? Boolean(inc.verified) : prev.verified,
      banned: inc.banned !== undefined ? Boolean(inc.banned) : prev.banned,
      isReseller: inc.isReseller !== undefined ? Boolean(inc.isReseller) : prev.isReseller,
      joinedDate: inc.joinedDate || prev.joinedDate,
      pass: inc.pass || prev.pass || '',
      balance: Number(prev.balance || 0),
      orders: Array.isArray(prev.orders) ? prev.orders : [],
      transactions: Array.isArray(prev.transactions) ? prev.transactions : [],
      myCustomers: mergeMyCustomers(prev.myCustomers, inc.myCustomers),
    };
  }).filter(Boolean);
  const incomingEmails = new Set(
    incomingUsers.filter(u => u && u.email).map(u => normalizeEmail(u.email))
  );
  existing.forEach((prev) => {
    const email = normalizeEmail(prev.email);
    if (!email || incomingEmails.has(email)) return;
    merged.push({ ...prev });
  });
  return merged;
}

function preserveSensitiveFields(existing, incoming) {
  const next = { ...(incoming || {}) };
  const existingUsers = Array.isArray(existing && existing.users) ? existing.users : [];
  if (Array.isArray(next.users)) {
    next.users = mergeUsersPreservingWallet(existingUsers, next.users);
  }
  const preserveKeys = [
    GMAIL_MONITORS_KEY,
    LINK_TOKENS_KEY,
    BACKUPS_KEY,
    PRICE_CATALOG_KEY,
    RETAIL_PRICE_CATALOG_KEY,
    SMS_CONFIG_KEY,
    'priceChangeLog',
    'siteSettings',
    'activityLog',
    'revokedLinks',
    'sessions',
    'gameorders',
    'smsorders'
  ];
  preserveKeys.forEach(key => {
    if (existing && existing[key] !== undefined && (next[key] === undefined || next[key] === null)) {
      next[key] = existing[key];
    }
  });
  const existingCatalog = existing && existing[PRICE_CATALOG_KEY];
  const incomingCatalog = next[PRICE_CATALOG_KEY];
  if (existingCatalog) {
    const existingRich = countCustomPriceDeltas(existingCatalog);
    const incomingRich = countCustomPriceDeltas(incomingCatalog);
    const existingTs = Number(existingCatalog.updatedAt || 0);
    const incomingTs = Number(incomingCatalog && incomingCatalog.updatedAt || 0);
    if (!incomingCatalog || incomingRich < existingRich || !incomingTs || incomingTs < existingTs) {
      next[PRICE_CATALOG_KEY] = existingCatalog;
    }
  }
  if (existing && existing.stockBlocks) {
    // Stock blocks are changed only via /admin/stock-block — never from browser saveData.
    next.stockBlocks = existing.stockBlocks;
  }
  if (existing && existing[RETAIL_STOCK_BLOCKS_KEY]) {
    next[RETAIL_STOCK_BLOCKS_KEY] = existing[RETAIL_STOCK_BLOCKS_KEY];
  }
  if (existing && existing.stock && incoming && incoming.stock) {
    next.stock = mergeStockPreservingSold(existing.stock, incoming.stock);
  } else if (existing && existing.stock && (!incoming || !incoming.stock)) {
    next.stock = existing.stock;
  }
  if (existing && Array.isArray(existing.topupreqs)) {
    next.topupreqs = Array.isArray(incoming && incoming.topupreqs)
      ? mergeAllTopupRequests(existing.topupreqs, incoming.topupreqs)
      : existing.topupreqs;
  }
  if (existing && Array.isArray(existing.requests)) {
    if (!incoming || !Array.isArray(incoming.requests)) {
      next.requests = existing.requests;
    } else if (incoming._replaceRequests) {
      next.requests = incoming.requests;
    } else if (!incoming.requests.length && existing.requests.length) {
      next.requests = existing.requests;
    } else {
      next.requests = mergeProductRequests(existing.requests, incoming.requests);
    }
  }
  if (existing && Array.isArray(existing.pending)) {
    if (!incoming || !Array.isArray(incoming.pending)) {
      next.pending = existing.pending;
    } else if (incoming._replacePending) {
      next.pending = incoming.pending;
    } else if (!incoming.pending.length && existing.pending.length) {
      next.pending = existing.pending;
    } else {
      next.pending = mergePendingOrders(existing.pending, incoming.pending);
    }
  }
  if (existing && Array.isArray(existing.gameorders)) {
    if (!incoming || !Array.isArray(incoming.gameorders)) {
      next.gameorders = existing.gameorders;
    } else if (incoming._replaceGameorders) {
      next.gameorders = incoming.gameorders;
    } else if (!incoming.gameorders.length && existing.gameorders.length) {
      next.gameorders = existing.gameorders;
    } else {
      next.gameorders = mergeGameOrders(existing.gameorders, incoming.gameorders);
    }
  }
  if (existing && existing[SMS_CONFIG_KEY]) {
    const incomingSms = next[SMS_CONFIG_KEY] || {};
    const existingSms = existing[SMS_CONFIG_KEY] || {};
    next[SMS_CONFIG_KEY] = {
      ...existingSms,
      ...incomingSms,
      apiKey: String(incomingSms.apiKey || existingSms.apiKey || '').trim()
    };
  }
  if (existing && Array.isArray(existing.smsorders) && !Array.isArray(next.smsorders)) {
    next.smsorders = existing.smsorders;
  }
  return next;
}

function scoreMyCustomers(list) {
  const customers = Array.isArray(list) ? list : [];
  const subs = customers.reduce((n, c) => n + (Array.isArray(c.subs) ? c.subs.length : 0), 0);
  return customers.length * 1000 + subs;
}

function cloneMyCustomersList(list) {
  return (Array.isArray(list) ? list : []).map(c => ({
    ...c,
    subs: Array.isArray(c.subs) ? c.subs.map(s => ({ ...s })) : []
  }));
}

function myCustomersFromSnapshot(snapshot, userEmail) {
  const users = Array.isArray(snapshot && snapshot.users) ? snapshot.users : [];
  const user = users.find(item => normalizeEmail(item.email) === normalizeEmail(userEmail));
  return Array.isArray(user && user.myCustomers) ? user.myCustomers : [];
}

function mergeMyCustomersFromSnapshots(sources, userEmail) {
  let merged = [];
  for (const snapshot of sources) {
    merged = mergeMyCustomers(merged, myCustomersFromSnapshot(snapshot, userEmail));
  }
  return cloneMyCustomersList(merged);
}

async function collectFullDataRecoverySources(data) {
  const sources = [];
  const seen = new Set();
  const add = (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
    const key = JSON.stringify(
      (Array.isArray(snapshot.users) ? snapshot.users : []).map((u) => ({
        e: normalizeEmail(u && u.email),
        s: scoreMyCustomers(u && u.myCustomers)
      }))
    );
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(snapshot);
  };
  add(data);
  const embedded = Array.isArray(data && data[BACKUPS_KEY]) ? data[BACKUPS_KEY] : [];
  embedded.forEach((backup) => { if (backup && backup.data) add(backup.data); });
  try {
    const manifest = await readBackupManifest();
    for (const entry of manifest.slice(0, RECOVERY_SNAPSHOT_LIMIT)) {
      try {
        const { data: snapshot } = await readBackupSnapshot(entry.id);
        add(snapshot);
      } catch (e) {
        console.warn('Sub-customer recovery snapshot skipped:', entry && entry.id, e.message);
      }
    }
  } catch (e) {
    console.warn('Sub-customer recovery manifest read failed:', e.message);
  }
  return sources;
}

function recoverMyCustomersForUser(data, user, sources) {
  if (!user || !user.email) return false;
  const recovered = mergeMyCustomersFromSnapshots(sources || [data], user.email);
  if (!recovered.length) return false;
  const current = Array.isArray(user.myCustomers) ? user.myCustomers : [];
  const merged = mergeMyCustomers(current, recovered);
  if (scoreMyCustomers(merged) < scoreMyCustomers(current)) return false;
  user.myCustomers = merged;
  return true;
}

async function recoverMyCustomersFromAllSources(data, user) {
  if (!user) return false;
  const sources = await collectFullDataRecoverySources(data);
  return recoverMyCustomersForUser(data, user, sources);
}

async function recoverAllSubCustomers(data) {
  const sources = await collectFullDataRecoverySources(data);
  let usersRecovered = 0;
  let customersRecovered = 0;
  for (const user of Array.isArray(data.users) ? data.users : []) {
    const before = scoreMyCustomers(user.myCustomers);
    if (!recoverMyCustomersForUser(data, user, sources)) continue;
    usersRecovered += 1;
    customersRecovered += Math.max(0, scoreMyCustomers(user.myCustomers) - before);
  }
  return { usersRecovered, customersRecovered, sourcesChecked: sources.length };
}

function recoverMyCustomersFromBackups(data, user) {
  return recoverMyCustomersForUser(data, user, [data, ...((data && data[BACKUPS_KEY]) || []).map(b => b && b.data).filter(Boolean)]);
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

function isAnghamiStockKey(skey) {
  return String(skey || '').startsWith('anghami__');
}

function isDisneyStockKey(skey) {
  return String(skey || '').startsWith('disney__');
}

function isDisneyOneUserStockKey(skey) {
  return /^disney__1user__/.test(String(skey || ''));
}

function isDisneyFullStockKey(skey) {
  return /^disney__full__/.test(String(skey || ''));
}

function isOsnStockKey(skey) {
  return String(skey || '').startsWith('osn__');
}

function isOsnOneUserStockKey(skey) {
  return /^osn__1user__/.test(String(skey || ''));
}

function isOsnFullStockKey(skey) {
  return /^osn__full__/.test(String(skey || ''));
}

function isAmazonStockKey(skey) {
  return String(skey || '').startsWith('amazon__');
}

function isCanvaStockKey(skey) {
  return String(skey || '').startsWith('canva__');
}

function isCanvaOwnStockKey(skey) {
  return /^canva__own__/.test(String(skey || ''));
}

function isCanvaNewStockKey(skey) {
  return /^canva__new__/.test(String(skey || ''));
}

function isCanvaOrder(sub) {
  return Boolean(sub && (sub.productId === 'canva' || /canva/i.test(sub.product || '')));
}

function isCanvaNewSubscription(sub) {
  if (!isCanvaOrder(sub)) return false;
  if (/use my email/i.test(String(sub.plan || ''))) return false;
  if (/new account/i.test(String(sub.plan || ''))) return true;
  return Boolean(String(sub.email || '').trim() && !String(sub.pass || '').trim() && !String(sub.phone || '').trim() && String(sub.accKey || '').trim());
}

function isCanvaOwnSubscription(sub) {
  return isCanvaOrder(sub) && /use my email/i.test(String(sub.plan || ''));
}

function isCanvaNewOrder(order) {
  return isCanvaNewSubscription(order);
}

function isCanvaOwnOrder(order) {
  return isCanvaOwnSubscription(order);
}

function isDisneyOneUserSubscription(sub) {
  return Boolean(sub && (sub.productId === 'disney' || /disney/i.test(sub.product || '')) && /1\s*user/i.test(String(sub.plan || '')));
}

function isDisneyOneUserOrder(order) {
  return isDisneyOneUserSubscription(order);
}

function isOsnSubscription(sub) {
  return Boolean(sub && (sub.productId === 'osn' || /osn\+?/i.test(String(sub.product || ''))));
}

function isOsnOneUserSubscription(sub) {
  return isOsnSubscription(sub) && /1\s*user/i.test(String(sub.plan || ''));
}

function isOsnOneUserOrder(order) {
  return isOsnOneUserSubscription(order);
}

function isOsnPasswordlessSubscription(sub) {
  return isOsnSubscription(sub);
}

function disneyOneUserPlanKeys() {
  return ['disney__1user__1m', 'disney__1user__3m', 'disney__1user__1y'];
}

function isAnghamiSubscription(sub) {
  return Boolean(sub && (sub.productId === 'anghami' || /anghami/i.test(sub.product || '')));
}

const ANGHAMI_CANCEL_NOTE_EN = 'NOTE: If you already have an Anghami Plus subscription, cancel it then try to click on the link again.';
const ANGHAMI_CANCEL_NOTE_AR = 'ملاحظة: إذا كان لديك اشتراك Anghami Plus بالفعل، قم بإلغائه ثم اضغط على الرابط مرة أخرى.';

function anghamiCustomerMessage(planLabel, serviceLink, expiryDate) {
  let msg = `Thanks for purchasing Anghami+!\n\n📋 ${planLabel}\n\n🔗 Here is your activation link:\n${serviceLink}`;
  if (expiryDate) msg += `\n\n⏰ Expires: ${expiryDate}`;
  msg += `\n\n${ANGHAMI_CANCEL_NOTE_EN}\n\n${ANGHAMI_CANCEL_NOTE_AR}`;
  return msg;
}

function isValidLinkSubscription(subscription) {
  if (!subscription) return false;
  if (isAnghamiSubscription(subscription)) {
    return Boolean(String(subscription.serviceLink || '').trim() || String(subscription.profileName || '').trim());
  }
  if (isDisneyOneUserSubscription(subscription)) {
    return Boolean(String(subscription.phone || '').trim() || String(subscription.email || '').trim());
  }
  if (isOsnPasswordlessSubscription(subscription)) {
    return Boolean(String(subscription.email || '').trim());
  }
  if (isCanvaNewSubscription(subscription) || isCanvaOwnSubscription(subscription)) {
    return Boolean(String(subscription.email || '').trim());
  }
  return Boolean(subscription.email && subscription.pass);
}

function validateStockAccountForAdd(skey, rowAccount) {
  if (isAnghamiStockKey(skey)) {
    const serviceLink = String(rowAccount && rowAccount.serviceLink || '').trim();
    if (!serviceLink) return 'Activation link is required for Anghami stock';
    if (!/^https?:\/\//i.test(serviceLink)) return 'Enter a valid http(s) activation link';
    const expiryDate = String(rowAccount && rowAccount.expiryDate || '').trim();
    if (!expiryDate) return 'Expiry date is required for Anghami stock (dd/mm/yyyy)';
    return null;
  }
  if (isDisneyOneUserStockKey(skey)) {
    const phone = String(rowAccount && rowAccount.phone || '').trim();
    const email = String(rowAccount && rowAccount.email || '').trim();
    if (!phone) return 'Phone number with country code is required for Disney+ 1-user stock';
    if (!email) return 'Code email is required for Disney+ 1-user stock (receives sign-in codes)';
    return null;
  }
  if (isOsnOneUserStockKey(skey) || isOsnFullStockKey(skey)) {
    const email = String(rowAccount && rowAccount.email || '').trim();
    const mainEmail = String(rowAccount && rowAccount.mainEmail || '').trim();
    if (!email) return 'Alias email is required for OSN+ stock';
    if (!mainEmail) return 'Main Gmail is required for OSN+ sign-in codes';
    return null;
  }
  if (isCanvaNewStockKey(skey)) {
    const email = String(rowAccount && rowAccount.email || '').trim();
    const expiryDate = String(rowAccount && rowAccount.expiryDate || '').trim();
    const mainEmail = String(rowAccount && rowAccount.mainEmail || '').trim();
    if (!email) return 'Alias email is required for Canva stock';
    if (!expiryDate) return 'Expiry date is required for Canva stock (dd/mm/yyyy)';
    if (!mainEmail) return 'Main Gmail is required for Canva sign-in codes';
    return null;
  }
  if (!rowAccount || !rowAccount.email || !rowAccount.pass) {
    return 'Each account needs email and password';
  }
  return null;
}

function customDayBlockKeyFromSkey(skey) {
  const parts = String(skey || '').split('__');
  if (parts.length < 2) return null;
  return `${parts[0]}__${parts[1]}__custom`;
}

function purchaseBlockKey(skey, customDays) {
  const days = Number(customDays || 0);
  if (days > 0) {
    const customKey = customDayBlockKeyFromSkey(skey);
    if (customKey) return customKey;
  }
  return skey;
}

const RETAIL_STOCK_BLOCKS_KEY = 'retailStockBlocks';

function stockBlocksFieldForUser(user) {
  return user && userIsReseller(user) ? 'stockBlocks' : RETAIL_STOCK_BLOCKS_KEY;
}

function isPlanStockBlocked(data, user, skey, customDays) {
  const field = stockBlocksFieldForUser(user);
  const blocks = data[field] || {};
  return Boolean(blocks[purchaseBlockKey(skey, customDays)]);
}

function netflixAliasUsage(data, aliasEmail, planKey) {
  const alias = normalizeEmail(aliasEmail);
  const usage = { oneUser: 0, full: 0 };
  if (!alias) return usage;
  const keys = planKey
    ? [String(planKey)]
    : Object.keys((data && data.stock) || {}).filter(isNetflixStockKey);
  const seenProfiles = new Set();
  for (const key of keys) {
    if (!isNetflixStockKey(key)) continue;
    for (const account of Array.isArray(data.stock[key]) ? data.stock[key] : []) {
      if (normalizeEmail(account && account.email) !== alias) continue;
      if (isNetflixFullStockKey(key)) {
        usage.full += 1;
        continue;
      }
      if (isNetflixOneUserStockKey(key)) {
        if (planKey) {
          usage.oneUser += 1;
          continue;
        }
        const profileKey = String(account.accKey || '');
        if (profileKey.startsWith('nfprof__')) {
          if (seenProfiles.has(profileKey)) continue;
          seenProfiles.add(profileKey);
        }
        usage.oneUser += 1;
      }
    }
  }
  return usage;
}

function netflixAliasUsageGlobal(data, aliasEmail) {
  return netflixAliasUsage(data, aliasEmail);
}

function validateNetflixAliasPurchase(data, skey, acc) {
  if (!acc || !isNetflixStockKey(skey)) return null;
  const globalUsage = netflixAliasUsageGlobal(data, acc.email);
  const planUsage = isNetflixOneUserStockKey(skey) ? netflixAliasUsage(data, acc.email, skey) : globalUsage;
  if (isNetflixFullStockKey(skey) && globalUsage.oneUser > 0) {
    return 'This Netflix alias is already split into 1-user profiles and cannot be sold as full account.';
  }
  if (isNetflixFullStockKey(skey) && globalUsage.full > 1) {
    return 'This Netflix alias is already reserved as a full account and cannot be sold again.';
  }
  if (isNetflixOneUserStockKey(skey) && globalUsage.full > 0) {
    return 'This Netflix alias is already reserved as a full account and cannot be sold as 1-user profile.';
  }
  if (isNetflixOneUserStockKey(skey) && planUsage.oneUser > 5) {
    return 'This Netflix alias already has more than 5 one-user profile slots on this plan.';
  }
  return null;
}

// ── HEALTH ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'rashadtech server running', ok: true });
});
app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now(), ready: true });
});
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), ready: true });
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
<input id="totp" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="Authenticator code (6 digits)" style="width:100%"><br>
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
    const j=await api('/auth/admin-login',{method:'POST',body:JSON.stringify({password:pass.value,totp:totp.value})});
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
app.use('/chat/escalate', rateLimit('chat-escalate', 4, 15 * 60 * 1000));
app.use('/notify', rateLimit('notify', 60, 5 * 60 * 1000));
app.use('/links', rateLimit('links', 80, 5 * 60 * 1000));
app.use('/admin', rateLimit('admin', 120, 15 * 60 * 1000));

// ── JSONBIN PROXY ──────────────────────────────────────────────────────
app.post('/db/read', async (req, res) => {
  const session = requireSession(req, res, ['admin', 'user']);
  if (!session) return;
  const fullRecover = Boolean(req.body && req.body.recover);
  try {
    const data = await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
    let recovered = false;
    if (session.role === 'user') {
      const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
      if (user) {
        if (recoverMyCustomersFromBackups(data, user)) {
          recovered = true;
          const snapshot = cloneData(data);
          runAfterResponse(() => {
            enqueueDbWrite(() => writeDbFast(snapshot)).catch(e => console.error('DB read recovery write error:', e.message));
          });
        }
        if (fullRecover && await recoverMyCustomersFromAllSources(data, user)) recovered = true;
      }
    }
    if (recovered && fullRecover) await writeDbFast(data);
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
    const result = await enqueueDbWrite(async () => {
      const existing = await readDbForWrite();
      let nextData;
      if (session.role === 'admin') {
        nextData = preserveSensitiveFields(existing, data || {});
      } else {
        nextData = mergeUserWrite(existing, data || {}, session);
      }
      return writeDbFast(nextData, { backupSource: existing });
    });
    res.json({ success: true, result });
  } catch(e) {
    console.error('DB write error:', e.message);
    res.status(503).json({ error: 'Database is unavailable. Nothing was saved.' });
  }
});

app.get('/admin/price-recovery-options', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  try {
    const data = await readJsonBinRaw({ forceRefresh: true, skipRecoverWrite: true });
    const sources = await collectRecoverySources(data);
    res.json({
      success: true,
      currentCustomPrices: countCustomPriceDeltas(data[PRICE_CATALOG_KEY]),
      currentBlocks: stockBlockCount(data.stockBlocks),
      sources: sources.map(source => ({
        id: source.id,
        label: source.label,
        customPrices: source.customPrices,
        blocks: source.blocks
      }))
    });
  } catch (e) {
    console.error('Price recovery options error:', e.message);
    res.status(500).json({ error: 'Could not load recovery options' });
  }
});

app.post('/admin/recover-settings', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  try {
    dbCache = null;
    const data = await readJsonBinRaw({ forceRefresh: true, skipRecoverWrite: true });
    const recovered = await recoverSettingsFromBackups(data, { recoverBlocks: false });
    if (!recovered.changed) {
      return res.json({
        success: true,
        recovered: false,
        customPriceCount: recovered.customPriceCount,
        catalog: getMergedCatalog(data),
        stockBlocks: data.stockBlocks || {},
        sources: (recovered.sources || []).slice(0, 12),
        data: safeDataForSession(data, { role: 'admin' })
      });
    }
    await writeJsonBinRaw(recovered.data, { backupReason: 'manual-recover-settings', backupSource: data });
    setDbCache(recovered.data, false);
    res.json({
      success: true,
      recovered: true,
      customPriceCount: recovered.customPriceCount,
      catalogSource: recovered.catalogSource,
      blockSource: recovered.blockSource,
      catalog: getMergedCatalog(recovered.data),
      stockBlocks: recovered.data.stockBlocks || {},
      sources: (recovered.sources || []).slice(0, 12),
      data: safeDataForSession(recovered.data, { role: 'admin' })
    });
  } catch (e) {
    console.error('Recover settings error:', e.message);
    res.status(500).json({ error: 'Could not recover settings from backup' });
  }
});

app.post('/admin/recover-sub-customers', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  try {
    dbCache = null;
    const beforeData = await readJsonBinRaw({ forceRefresh: true, skipRecoverWrite: true });
    const data = cloneData(beforeData);
    const result = await recoverAllSubCustomers(data);
    if (!result.usersRecovered) {
      return res.json({
        success: true,
        recovered: false,
        usersRecovered: 0,
        sourcesChecked: result.sourcesChecked,
        data: safeDataForSession(data, { role: 'admin' })
      });
    }
    await writeJsonBinRaw(data, { backupReason: 'manual-recover-sub-customers', backupSource: beforeData });
    setDbCache(data, false);
    res.json({
      success: true,
      recovered: true,
      usersRecovered: result.usersRecovered,
      sourcesChecked: result.sourcesChecked,
      data: safeDataForSession(data, { role: 'admin' })
    });
  } catch (e) {
    console.error('Recover sub-customers error:', e.message);
    res.status(500).json({ error: e.message || 'Could not recover sub-customers' });
  }
});

app.post('/admin/backups/restore-settings', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { id, key, label, sourceIndex, restoreBlocks } = req.body || {};
  if (!id && !key && label == null && sourceIndex == null) return res.status(400).json({ error: 'Backup id is required' });
  try {
    const current = await readJsonBinRaw({ forceRefresh: true, skipRecoverWrite: true });
    let snapshotData = null;
    let entry = null;
    if (sourceIndex != null || label != null) {
      const sources = await collectRecoverySources(current);
      const match = sources.find(source => source.id === Number(sourceIndex))
        || sources.find(source => source.label === label);
      if (!match) return res.status(404).json({ error: 'Recovery source not found' });
      snapshotData = {
        [PRICE_CATALOG_KEY]: match.catalog,
        stockBlocks: match.stockBlocks
      };
      entry = { id: String(match.id), iso: match.label };
    } else {
      const snapshot = await readBackupSnapshot(id || key);
      entry = snapshot.entry;
      snapshotData = snapshot.data;
    }
    const next = { ...current };
    let changed = false;
    const snapshotCatalog = snapshotData[PRICE_CATALOG_KEY];
    if (snapshotCatalog && countCustomPriceDeltas(snapshotCatalog) > countCustomPriceDeltas(next[PRICE_CATALOG_KEY])) {
      next[PRICE_CATALOG_KEY] = snapshotCatalog;
      changed = true;
    }
    if (restoreBlocks === true && stockBlockCount(snapshotData.stockBlocks) > stockBlockCount(next.stockBlocks)) {
      next.stockBlocks = { ...(snapshotData.stockBlocks || {}) };
      changed = true;
    }
    if (!changed) {
      return res.json({
        success: true,
        recovered: false,
        catalog: getMergedCatalog(next),
        stockBlocks: next.stockBlocks || {},
        data: safeDataForSession(next, { role: 'admin' })
      });
    }
    await writeJsonBinRaw(next, { backupReason: 'restore-settings-from-backup', backupSource: current });
    setDbCache(next, false);
    res.json({
      success: true,
      recovered: true,
      backup: entry,
      customPriceCount: countCustomPriceDeltas(next[PRICE_CATALOG_KEY]),
      catalog: getMergedCatalog(next),
      stockBlocks: next.stockBlocks || {},
      data: safeDataForSession(next, { role: 'admin' })
    });
  } catch (e) {
    console.error('Restore settings error:', e.message);
    res.status(500).json({ error: e.message || 'Could not restore settings from backup' });
  }
});

app.get('/auth/me', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  if (session.role !== 'user') {
    return res.json({ success: true, role: session.role, email: session.email });
  }
  try {
    const data = await readJsonBinRaw({ fast: true });
    const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
    const isReseller = user ? userIsReseller(user) : false;
    res.json({
      success: true,
      role: session.role,
      email: session.email,
      isReseller,
      tier: isReseller ? 'reseller' : 'retail'
    });
  } catch (e) {
    res.json({ success: true, role: session.role, email: session.email, isReseller: false, tier: 'retail' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const cleanPassword = normalizeLoginPassword(password);
  try {
    const data = await readJsonBinRaw({ fast: true });
    const user = (data.users || []).find(u => normalizeEmail(u.email) === normalizeEmail(email));
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const recoveredPassword = recoverMissingPasswordFromBackups(data, user);
    if (!user.pass) return res.status(401).json({ error: 'This account needs a password reset. Please use Forgot password.' });
    if (!verifyPassword(cleanPassword, user.pass)) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.banned) return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });
    const recoveredCustomers = recoverMyCustomersFromBackups(data, user);
    const needsPassUpgrade = recoveredPassword || !String(user.pass || '').startsWith(PASSWORD_HASH_PREFIX);
    if (needsPassUpgrade) user.pass = hashPassword(cleanPassword);
    const token = createSession('user', user.email);
    const userEmail = normalizeEmail(user.email);
    const savedCustomers = recoveredCustomers ? cloneMyCustomersList(user.myCustomers) : null;
    const savedPass = needsPassUpgrade ? user.pass : null;
    res.json({ success: true, token, user: sanitizeUser(user), data: safeDataForSession(data, { role: 'user', email: userEmail }) });
    if (recoveredCustomers || needsPassUpgrade) {
      setImmediate(() => {
        enqueueDbWrite(async () => {
          const fresh = await readDbForWrite();
          const live = (fresh.users || []).find(u => normalizeEmail(u.email) === userEmail);
          if (!live) return null;
          if (savedPass) live.pass = savedPass;
          if (savedCustomers) live.myCustomers = savedCustomers;
          return writeDbFast(fresh, { backupSource: fresh });
        }).catch(e => console.error('Login persist error:', e.message));
      });
    }
    if (userIsReseller(user)) {
      setImmediate(() => {
        enqueueDbWrite(async () => {
          const fresh = await readDbForWrite();
          const live = (fresh.users || []).find(u => normalizeEmail(u.email) === userEmail);
          if (!live || !userIsReseller(live)) return null;
          const changed = await recoverMyCustomersFromAllSources(fresh, live);
          if (!changed) return null;
          return writeDbFast(fresh, { backupReason: 'login-recover-sub-customers', backupSource: fresh });
        }).catch(e => console.error('Login sub-customer recovery error:', e.message));
      });
    }
  } catch(e) {
    console.error('Login error:', e.message);
    res.status(503).json({ error: 'Login service is temporarily unavailable. Please try again soon.' });
  }
});

app.post('/auth/admin-login', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (adminLoginBlocked(res, ip)) return;
  const { password, totp, pin } = req.body || {};
  const code = String(totp || pin || '').trim();
  if (password !== ADMIN_PASSWORD) {
    recordAdminLoginFailure(ip);
    return res.status(401).json({ error: 'Wrong password' });
  }
  if (!verifyAdminTotp(ADMIN_TOTP_SECRET, code)) {
    recordAdminLoginFailure(ip);
    return res.status(401).json({ error: 'Wrong authenticator code' });
  }
  clearAdminLoginFailures(ip);
  const token = createSession('admin', 'admin');
  markAdmin2faEnrolled().catch(() => {});
  try {
    const data = await readJsonBinRaw({ fast: true });
    res.json({ success: true, token, data: safeDataForSession(data, { role: 'admin' }) });
  } catch(e) {
    console.error('Admin login error:', e.message);
    res.json({ success: true, token, data: { users: [], stock: {}, stockBlocks: {}, [RETAIL_STOCK_BLOCKS_KEY]: {}, requests: [], topupreqs: [], pending: [], gameorders: [] }, warning: 'Logged in, but data could not be loaded. Try refreshing.' });
  }
});

app.get('/auth/admin-2fa-status', async (req, res) => {
  try {
    const data = await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
    res.json({ success: true, setupAvailable: isAdmin2faSetupAvailable(data) });
  } catch (e) {
    res.json({ success: true, setupAvailable: false });
  }
});

app.post('/auth/admin-2fa-setup', async (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  try {
    const data = await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
    if (!isAdmin2faSetupAvailable(data)) {
      return res.status(403).json({ error: 'Authenticator is already set up. Setup is disabled for security.' });
    }
    res.json({ success: true, ...adminTotpSetupInfo() });
  } catch (e) {
    res.status(503).json({ error: 'Could not verify 2FA status' });
  }
});

function deriveSignupName(email, name) {
  const trimmed = String(name || '').trim();
  if (trimmed) return trimmed;
  const local = String(email || '').split('@')[0] || '';
  return local.replace(/[._+-]+/g, ' ').trim() || 'Customer';
}

app.post('/auth/signup-start', async (req, res) => {
  const { name, email, tgChatId } = req.body;
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return res.status(400).json({ error: 'Email is required' });
  const displayName = deriveSignupName(cleanEmail, name);
  try {
    const data = await readJsonBinRaw({ fast: true });
    data.users = Array.isArray(data.users) ? data.users : [];
    if (data.users.some(u => normalizeEmail(u.email) === cleanEmail)) return res.status(409).json({ error: 'Email already registered' });
    const otp = setOtp(signupOtps, cleanEmail, { name: displayName, tgChatId: String(tgChatId || '').trim() });
    const delivery = await deliverOtp({ email: cleanEmail, otp, name: displayName, tgChatId, purpose: 'signup' });
    if (!delivery.emailSent && !delivery.telegramSent && !delivery.clientEmailRequired) {
      return res.status(503).json({ error: 'Could not send verification code. Please try again.' });
    }
    res.json({
      success: true,
      message: delivery.emailSent
        ? 'Verification code sent to your email'
        : delivery.telegramSent
          ? 'Verification code sent to your Telegram'
          : 'Complete email delivery from your browser',
      emailSent: delivery.emailSent,
      telegramSent: delivery.telegramSent,
      clientEmailRequired: delivery.clientEmailRequired,
      ...(delivery.clientEmailRequired ? { otp, name: displayName, email: cleanEmail } : {})
    });
  } catch(e) {
    console.error('Signup start error:', e.message);
    res.status(503).json({ error: 'Could not send verification code. Please try again.' });
  }
});

app.post('/auth/signup', async (req, res) => {
  const { name, email, password, tgChatId, otp, phone } = req.body;
  const cleanEmail = normalizeEmail(email);
  const cleanPhone = String(phone || '').trim();
  if (!cleanEmail || !password || password.length < 6) return res.status(400).json({ error: 'Email and password (min 6 characters) are required' });
  if (!cleanPhone) return res.status(400).json({ error: 'Phone number is required' });
  if (!verifyOtp(signupOtps, cleanEmail, otp)) return res.status(400).json({ error: 'Invalid or expired verification code' });
  try {
    const data = await readJsonBinRaw({ fast: true });
    data.users = Array.isArray(data.users) ? data.users : [];
    if (data.users.some(u => normalizeEmail(u.email) === cleanEmail)) return res.status(409).json({ error: 'Email already registered' });
    const user = {
      name: deriveSignupName(cleanEmail, name),
      email: cleanEmail,
      pass: hashPassword(password),
      signupPass: String(password),
      phone: cleanPhone,
      tgChatId: String(tgChatId || '').trim(),
      balance: 0,
      transactions: [],
      orders: [],
      myCustomers: [],
      verified: true,
      isReseller: false,
      joinedDate: formatBeirutTime()
    };
    data.users.push(user);
    await writeDbFast(data);
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
    const data = await readJsonBinRaw({ fast: true });
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
    const data = await readJsonBinRaw({ fast: true });
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
    const data = await readJsonBinRaw({ fast: true });
    const user = (data.users || []).find(u => normalizeEmail(u.email) === normalizeEmail(email));
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.pass = hashPassword(password);
    user.signupPass = String(password);
    await writeDbFast(data);
    res.json({ success: true });
  } catch(e) {
    console.error('Reset password error:', e.message);
    res.status(503).json({ error: ACCOUNT_SERVICE_UNAVAILABLE });
  }
});

app.post('/auth/logout', (req, res) => {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) {
    sessions.delete(match[1]);
    if (dbCache && dbCache.sessions) delete dbCache.sessions[match[1]];
  }
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
  if (!subscription || !isValidLinkSubscription(subscription)) return res.status(400).json({ error: 'Invalid subscription link data' });
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
      const data = await readJsonBinRaw().catch(() => ({}));
      const subscription = enrichSubscriptionFromLiveOrder(data, payload.subscription, payload.owner);
      return res.json({ success: true, subscription });
    } catch(e) {
      // Continue to legacy database-backed token lookup below.
    }
    const data = await readJsonBinRaw();
    const entry = data[LINK_TOKENS_KEY] && data[LINK_TOKENS_KEY][req.params.token];
    if (!entry || Date.now() > Number(entry.expiresAt || 0)) return res.status(404).json({ error: 'Subscription link not found or expired' });
    const subscription = enrichSubscriptionFromLiveOrder(data, entry.subscription, entry.owner);
    res.json({ success: true, subscription });
  } catch(e) {
    console.error('Read link error:', e.message);
    res.status(500).json({ error: 'Could not load subscription link' });
  }
});

function accountProfileName(acc) {
  if (!acc) return '';
  return String(acc.profileName || acc.extra || '').trim();
}

function orderProfileName(order) {
  if (!order) return '';
  return String(order.profileName || order.extra || '').trim();
}

function normalizeTgChatId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const match = s.match(/-?\d{5,}/);
  return match ? match[0] : s.replace(/\s+/g, '');
}

function orderIdsMatch(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (x === y) return true;
  const nx = x.replace(/^#/, '');
  const ny = y.replace(/^#/, '');
  return Boolean(nx && nx === ny);
}

function findUserOrderRecord(user, orderId) {
  if (!user || !orderId) return { order: null, customer: null };
  const direct = (user.orders || []).find(o => orderIdsMatch(o.id, orderId));
  if (direct) return { order: direct, customer: null };
  for (const customer of user.myCustomers || []) {
    const sub = (customer.subs || []).find(o => orderIdsMatch(o.id, orderId));
    if (sub) return { order: sub, customer };
  }
  return { order: null, customer: null };
}

function enrichSubscriptionFromLiveOrder(data, subscription, ownerEmail) {
  if (!subscription || !subscription.id || !ownerEmail) return subscription;
  const user = (data.users || []).find(u => normalizeEmail(u.email) === normalizeEmail(ownerEmail));
  if (!user) return subscription;
  const { order } = findUserOrderRecord(user, subscription.id);
  if (!order) return subscription;
  const profileName = orderProfileName(order);
  const stockAcc = findStockAccountForOrder(data, order);
  const mainEmail = String(order.mainEmail || (stockAcc && stockAcc.mainEmail) || subscription.mainEmail || '').trim();
  const codeEmail = String(order.email || subscription.codeEmail || subscription.email || '').trim();
  const inboxEmail = mainEmail || String(subscription.inboxEmail || '').trim() || codeEmail;
  return {
    ...subscription,
    email: codeEmail || subscription.email || '',
    profileName: profileName || subscription.profileName || '',
    profilePin: order.profilePin || subscription.profilePin || '',
    phone: order.phone || subscription.phone || '',
    serviceLink: order.serviceLink || subscription.serviceLink || '',
    expiryDate: order.expiryDate || subscription.expiryDate || '',
    accKey: order.accKey || subscription.accKey || '',
    mainEmail,
    codeEmail,
    inboxEmail
  };
}

function syncUserContact(user, { tgChatId, name, phone } = {}) {
  if (!user) return user;
  const nextTg = normalizeTgChatId(tgChatId);
  if (nextTg) user.tgChatId = nextTg;
  const nextName = String(name || '').trim();
  if (nextName) user.name = nextName;
  const nextPhone = normalizePhone(phone);
  if (nextPhone) user.phone = nextPhone;
  return user;
}

async function resendSubscriptionsAfterTelegramAdded(user, data, options = {}) {
  if (!user || !normalizeTgChatId(user.tgChatId)) return 0;
  const rows = [];
  (user.orders || []).forEach((order) => {
    if (order && order.email && !order.telegramDeliveredAt) rows.push({ order, assignCustId: null });
  });
  (user.myCustomers || []).forEach((customer) => {
    (customer.subs || []).forEach((order) => {
      if (order && order.email && !order.telegramDeliveredAt) rows.push({ order, assignCustId: customer.id });
    });
  });
  let sent = 0;
  for (const row of rows.slice(0, options.limit || 8)) {
    const { order, assignCustId } = row;
    const product = {
      name: order.product,
      short: order.short || '',
      color: order.color || '',
      tc: order.tc || '',
      id: order.productId || ''
    };
    const channel = await notifyPurchaseFulfilled(
      user,
      product,
      order.plan || '',
      order.price || 0,
      order,
      assignCustId,
      { forceResend: true, skipAdminNotify: true, data }
    );
    if (channel) sent += 1;
  }
  return sent;
}

async function notifyPurchasePending(user, product, planLabel, price, assignCustId, pendingOrder = null, options = {}) {
  const assignedCustomer = assignCustId !== null && assignCustId !== undefined
    ? (user.myCustomers || []).find(c => c.id === assignCustId)
    : null;
  const assignNote = assignedCustomer
    ? `\n👥 For: ${assignedCustomer.fname} ${assignedCustomer.lname}`
    : '';
  const canvaEmail = pendingOrder && String(pendingOrder.customerCanvaEmail || '').trim();
  const isCanvaOwn = product && product.id === 'canva' && canvaEmail;
  const adminMsg = isCanvaOwn
    ? `⏳ <b>Canva Pro — activate by email</b>\n👤 ${user.name} (${user.email})\n📧 <b>Customer Canva email:</b> <code>${canvaEmail}</code>\n📦 ${product.name} · ${planLabel}\n💵 $${Number(price).toFixed(2)}${assignNote}\n\nActivate Pro on this email, then tap Fulfill in Admin → Pending Orders.`
    : `⏳ <b>Pending Order</b>\n👤 ${user.name} (${user.email})\n📦 ${product.name} · ${planLabel}\n💵 $${Number(price).toFixed(2)}${assignNote}\n⚠️ No stock — add accounts in Stock tab to fulfill.`;
  await sendTG(TG_ADMIN, adminMsg, 'HTML').catch((e) => console.error('Pending admin TG:', e.message));
  const tgChatId = String(user.tgChatId || '').trim();
  if (tgChatId) {
    try {
      const custMsg = isCanvaOwn
        ? `✅ <b>Purchase Confirmed!</b>\n\n📦 ${product.name} · ${planLabel}\n📧 Canva email: <code>${canvaEmail}</code>\n💵 $${Number(price).toFixed(2)}${assignNote}\n💰 New balance: $${Number(user.balance || 0).toFixed(2)}\n\n⏳ We will activate Canva Pro on your email shortly.`
        : `✅ <b>Purchase Confirmed!</b>\n\n📦 ${product.name} · ${planLabel}\n💵 $${Number(price).toFixed(2)}${assignNote}\n💰 New balance: $${Number(user.balance || 0).toFixed(2)}\n\n⏳ Your credentials will be delivered here shortly.`;
      await sendTG(tgChatId, custMsg, 'HTML');
      return 'telegram';
    } catch (e) {
      console.error('Pending customer TG:', e.message);
    }
  }
  const emailSent = await sendPurchaseReceiptEmail(user, product, planLabel, price, pendingOrder || { product: product.name, plan: planLabel, pending: true }, {
    data: options.data,
    status: 'pending',
    assignedCustomerName: assignedCustomer ? `${assignedCustomer.fname} ${assignedCustomer.lname}`.trim() : ''
  });
  return emailSent ? 'email' : false;
}

async function notifyPurchaseFulfilled(user, product, planLabel, price, order, assignCustId, options = {}) {
  if (order && (order.telegramDeliveredAt || order.emailDeliveredAt) && !options.forceResend) {
    return order.telegramDeliveredAt ? 'telegram' : 'email';
  }
  const assignedCustomer = assignCustId !== null && assignCustId !== undefined
    ? (user.myCustomers || []).find(c => c.id === assignCustId)
    : null;
  const profileLabel = orderProfileName(order);
  const isAnghami = product && product.id === 'anghami';
  const isDisneyOne = isDisneyOneUserOrder(order);
  const isOsn = isOsnPasswordlessSubscription(order);
  const isCanvaNew = isCanvaNewOrder(order);
  const isCanvaOwn = isCanvaOwnOrder(order);
  let adminMsg = `🎉 <b>New Purchase</b>\n\n📦 <b>Product:</b> ${product.name}\n📋 <b>Plan:</b> ${planLabel}\n💵 <b>Price:</b> $${Number(price).toFixed(2)}\n👤 <b>Buyer:</b> ${user.name} (${user.email})`;
  if (assignedCustomer) {
    adminMsg += `\n👥 <b>Assigned to:</b> ${assignedCustomer.fname} ${assignedCustomer.lname} (${assignedCustomer.code}${assignedCustomer.phone})`;
  }
  if (isAnghami) {
    adminMsg += `\n\n🔗 <b>Activation link:</b> ${order.serviceLink || '—'}`;
  } else if (isDisneyOne) {
    adminMsg += `\n\n📱 <b>Phone:</b> <code>${order.phone || '—'}</code>`;
    adminMsg += `\n📧 <b>Code email:</b> <code>${order.email || '—'}</code>`;
    if (profileLabel) adminMsg += `\n👤 Profile: <code>${profileLabel}</code>`;
  } else if (isOsn) {
    adminMsg += `\n\n📧 <b>OSN+ email:</b> <code>${order.email || '—'}</code>`;
    if (profileLabel) adminMsg += `\n👤 Profile: <code>${profileLabel}</code>`;
  } else if (isCanvaNew || isCanvaOwn) {
    adminMsg += `\n\n📧 <b>Canva email:</b> <code>${order.email || '—'}</code>`;
  } else {
    adminMsg += `\n\n🔐 <b>Credentials:</b>\n📧 <code>${order.email}</code>\n🔑 <code>${order.pass}</code>`;
    if (profileLabel) adminMsg += `\n👤 Profile: <code>${profileLabel}</code>`;
  }
  if (order.expiryDate) adminMsg += `\n📅 Expires: ${order.expiryDate}`;
  if (!options.skipAdminNotify) {
    await sendTG(TG_ADMIN, adminMsg, 'HTML').catch((e) => console.error('Purchase admin TG:', e.message));
  }
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
    phone: order.phone || '',
    expiryDate: order.expiryDate || '',
    profileName: order.profileName || '',
    profilePin: order.profilePin || '',
    serviceLink: order.serviceLink || '',
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
  const custName = assignedCustomer ? `${assignedCustomer.fname} ${assignedCustomer.lname}` : null;
  let custMsg = isAnghami
    ? (assignedCustomer
      ? `✅ <b>Anghami+ for ${custName}</b>\n\n📋 ${planLabel}\n\n🔗 <b>Activation link:</b>\n${order.serviceLink || ''}\n\n${ANGHAMI_CANCEL_NOTE_EN}\n\n${ANGHAMI_CANCEL_NOTE_AR}`
      : `✅ <b>Thanks for purchasing Anghami+!</b>\n\n📋 ${planLabel}\n\n🔗 <b>Activation link:</b>\n${order.serviceLink || ''}\n\n${ANGHAMI_CANCEL_NOTE_EN}\n\n${ANGHAMI_CANCEL_NOTE_AR}`)
    : isDisneyOne
      ? (assignedCustomer
        ? `✅ <b>Disney+ for ${custName}</b>\n\n📋 ${planLabel}\n👥 <b>For:</b> ${custName}\n\n📱 <b>Phone:</b> <code>${order.phone || ''}</code>\nOpen Disney+ app → enter phone with country code → tap Request Sign-in Code on your subscription link.`
        : `✅ <b>Your Disney+ is ready!</b>\n\n📋 ${planLabel}\n\n📱 <b>Phone:</b> <code>${order.phone || ''}</code>\nOpen Disney+ app → enter phone with country code → tap Request Sign-in Code on your subscription link.`)
      : isOsn
        ? (assignedCustomer
          ? `✅ <b>OSN+ for ${custName}</b>\n\n📋 ${planLabel}\n👥 <b>For:</b> ${custName}\n\n📧 <b>Email:</b> <code>${order.email || ''}</code>\nOpen OSN+ → enter email → tap Request Sign-in Code on your subscription link.`
          : `✅ <b>Your OSN+ is ready!</b>\n\n📋 ${planLabel}\n\n📧 <b>Email:</b> <code>${order.email || ''}</code>\nOpen OSN+ → enter email → tap Request Sign-in Code on your subscription link.`)
      : isCanvaNew
        ? (assignedCustomer
          ? `✅ <b>Canva Pro for ${custName}</b>\n\n📋 ${planLabel}\n👥 <b>For:</b> ${custName}\n\n📧 <b>Email:</b> <code>${order.email || ''}</code>\nGo to canva.com → enter email → tap Request Sign-in Code on your subscription link.`
          : `✅ <b>Your Canva Pro is ready!</b>\n\n📋 ${planLabel}\n\n📧 <b>Email:</b> <code>${order.email || ''}</code>\nGo to canva.com → enter email → tap Request Sign-in Code on your subscription link.`)
        : isCanvaOwn
          ? (assignedCustomer
            ? `✅ <b>Canva Pro activated for ${custName}</b>\n\n📋 ${planLabel}\n👥 <b>For:</b> ${custName}\n\n📧 <b>Email:</b> <code>${order.email || ''}</code>\nPro is now active on this Canva account. Sign in and enjoy!`
            : `✅ <b>Your Canva Pro is active!</b>\n\n📋 ${planLabel}\n\n📧 <b>Email:</b> <code>${order.email || ''}</code>\nPro is now enabled on your Canva account. Sign in and enjoy!`)
          : (assignedCustomer
        ? `✅ <b>${product.name} subscription for ${custName}</b>\n\n📋 ${planLabel}\n👥 <b>For:</b> ${custName}\n\n🔐 <b>Credentials:</b>\n📧 <code>${order.email}</code>\n🔑 <code>${order.pass}</code>`
        : `✅ <b>Your ${product.name} is ready!</b>\n\n📋 ${planLabel}\n\n🔐 <b>Your credentials:</b>\n📧 <code>${order.email}</code>\n🔑 <code>${order.pass}</code>`);
  if (!isAnghami && !isDisneyOne && !isOsn && !isCanvaNew && !isCanvaOwn && profileLabel) custMsg += `\n👤 Profile: <code>${profileLabel}</code>`;
  if (isDisneyOne && profileLabel) custMsg += `\n👤 Profile: <code>${profileLabel}</code>`;
  if (isOsn && profileLabel) custMsg += `\n👤 Profile: <code>${profileLabel}</code>`;
  if (order.expiryDate) custMsg += `\n⏰ Expires: ${order.expiryDate}`;
  if (order.profilePin) custMsg += `\n🔢 PIN: <code>${order.profilePin}</code>`;
  custMsg += `\n\n🔗 <b>Subscription link:</b>\n${subLink}\n\nEnjoy! 🌟`;
  if (options.skipAdminNotify) {
    custMsg = `🔁 <b>Resent your subscription</b>\n\n${custMsg}`;
  }
  if (!options.forceResend) {
    await sendPurchaseReceiptEmail(user, product, planLabel, price, order, {
      data: options.data,
      status: 'confirmed',
      assignedCustomerName: custName || ''
    });
  }
  const tgChatId = String(user.tgChatId || '').trim();
  const channels = [];
  if (tgChatId) {
    try {
      await sendTG(tgChatId, custMsg, 'HTML');
      channels.push('telegram');
      if (assignedCustomer && assignedCustomer.tgChatId && String(assignedCustomer.tgChatId) !== tgChatId) {
        const assignMsg = isAnghami
          ? `✅ <b>Anghami+</b>\n\n📋 ${planLabel}\n\n🔗 ${order.serviceLink || ''}\n\n${ANGHAMI_CANCEL_NOTE_EN}\n\n🔗 ${subLink}`
          : isDisneyOne
            ? `✅ <b>Disney+ subscription</b>\n\n📋 ${planLabel}\n\n📱 <code>${order.phone || ''}</code>\n\n🔗 ${subLink}`
            : isOsn
              ? `✅ <b>OSN+ subscription</b>\n\n📋 ${planLabel}\n\n📧 <code>${order.email || ''}</code>\n\n🔗 ${subLink}`
            : isCanvaNew
              ? `✅ <b>Canva Pro</b>\n\n📋 ${planLabel}\n\n📧 <code>${order.email || ''}</code>\n\n🔗 ${subLink}`
              : isCanvaOwn
                ? `✅ <b>Canva Pro activated</b>\n\n📋 ${planLabel}\n\n📧 <code>${order.email || ''}</code>\n\n🔗 ${subLink}`
                : `✅ <b>${product.name} subscription</b>\n\n📋 ${planLabel}\n\n🔐 <b>Credentials:</b>\n📧 <code>${order.email}</code>\n🔑 <code>${order.pass}</code>${order.profilePin ? `\n🔢 PIN: <code>${order.profilePin}</code>` : ''}\n\n🔗 ${subLink}`;
        await sendTG(assignedCustomer.tgChatId, assignMsg, 'HTML').catch(() => {});
      }
    } catch (e) {
      console.error('Purchase customer TG:', e.message);
    }
  }
  const emailSent = await sendSubscriptionEmail(user, product, planLabel, order, subLink, {
    data: options.data,
    assignedCustomerName: custName || '',
    kind: 'fulfilled'
  });
  if (emailSent) channels.push('email');
  if (channels.length) {
    console.log(`Subscription delivered via ${channels.join('+')} to`, user.email, tgChatId || '');
    return channels.join('+');
  }
  console.warn('Purchase fulfilled but could not deliver to customer:', user.email);
  return false;
}

app.post('/customer/my-customers', async (req, res) => {
  const session = requireSession(req, res, ['user']);
  if (!session) return;
  const { myCustomers, confirmEmpty } = req.body || {};
  if (!Array.isArray(myCustomers)) return res.status(400).json({ error: 'Invalid customers list' });
  try {
    await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.users = Array.isArray(data.users) ? data.users : [];
      const user = data.users.find(u => normalizeEmail(u.email) === session.email);
      if (!user) throw new Error('User not found');
      if (!userIsReseller(user)) throw new Error('Sub-customers are for reseller accounts only');
      const prev = Array.isArray(user.myCustomers) ? user.myCustomers : [];
      if (!myCustomers.length && prev.length && !confirmEmpty) {
        throw new Error('Refusing to wipe sub-customers without confirmation');
      }
      user.myCustomers = applyMyCustomersWrite(user.myCustomers, myCustomers, { allowEmpty: Boolean(confirmEmpty) });
      return writeDbFast(data, { backupSource: data });
    });
    const data = await readJsonBinRaw({ skipRecoverWrite: true });
    const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
    res.json({ success: true, user: sanitizeUser(user), data: safeDataForSession(data, session) });
  } catch (e) {
    console.error('My customers save error:', e.message);
    res.status(e.message && e.message.includes('reseller') ? 403 : 500).json({ error: e.message || 'Could not save customers' });
  }
});

app.post('/customer/my-customers/recover', async (req, res) => {
  const session = requireSession(req, res, ['user']);
  if (!session) return;
  const { myCustomers: clientCustomers } = req.body || {};
  try {
    await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.users = Array.isArray(data.users) ? data.users : [];
      const user = data.users.find(u => normalizeEmail(u.email) === session.email);
      if (!user) throw new Error('User not found');
      if (!userIsReseller(user)) throw new Error('Sub-customers are for reseller accounts only');
      const sources = await collectFullDataRecoverySources(data);
      let merged = mergeMyCustomersFromSnapshots(sources, user.email);
      if (Array.isArray(clientCustomers) && clientCustomers.length) {
        merged = mergeMyCustomers(merged, clientCustomers);
      }
      const before = scoreMyCustomers(user.myCustomers);
      const mergedFinal = mergeMyCustomers(user.myCustomers, merged);
      const after = scoreMyCustomers(mergedFinal);
      if (after >= before) user.myCustomers = cloneMyCustomersList(mergedFinal);
      return writeDbFast(data, { backupSource: data });
    });
    const data = await readJsonBinRaw({ skipRecoverWrite: true });
    const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
    res.json({
      success: true,
      recovered: true,
      customerCount: Array.isArray(user && user.myCustomers) ? user.myCustomers.length : 0,
      user: sanitizeUser(user),
      data: safeDataForSession(data, session)
    });
  } catch (e) {
    console.error('My customers recover error:', e.message);
    res.status(500).json({ error: e.message || 'Could not recover customers' });
  }
});

app.post('/customer/profile', async (req, res) => {
  const session = requireSession(req, res, ['user']);
  if (!session) return;
  const { name, tgChatId, phone } = req.body || {};
  try {
    const data = await readJsonBinRaw();
    data.users = Array.isArray(data.users) ? data.users : [];
    const user = data.users.find(u => normalizeEmail(u.email) === session.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const prevTg = normalizeTgChatId(user.tgChatId);
    syncUserContact(user, { name, tgChatId, phone });
    const newTg = normalizeTgChatId(user.tgChatId);
    const tgJustAdded = Boolean(newTg && newTg !== prevTg);
    await writeDbFast(data);
    if (tgJustAdded) {
      runAfterResponse(async () => {
        try {
          const fresh = await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
          const liveUser = (fresh.users || []).find(u => normalizeEmail(u.email) === session.email);
          if (liveUser) await resendSubscriptionsAfterTelegramAdded(liveUser, fresh);
        } catch (e) {
          console.error('Resend after Telegram ID added:', e.message);
        }
      });
    }
    res.json({ success: true, user: sanitizeUser(user), data: safeDataForSession(data, session), telegramResendQueued: tgJustAdded });
  } catch (e) {
    console.error('Profile save error:', e.message);
    res.status(500).json({ error: 'Could not save profile' });
  }
});

app.post('/customer/subscription/update', async (req, res) => {
  const session = requireSession(req, res, ['user']);
  if (!session) return;
  const { orderId, profileName, profilePin, removeProfilePin, note, autoRenew } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'Order ID required' });
  try {
    const data = await readJsonBinRaw();
    data.users = Array.isArray(data.users) ? data.users : [];
    const user = data.users.find(u => normalizeEmail(u.email) === session.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { order } = findUserOrderRecord(user, orderId);
    if (!order) return res.status(404).json({ error: 'Subscription not found' });
    if (profileName !== undefined) {
      const trimmed = String(profileName || '').trim();
      if (trimmed) order.profileName = trimmed;
      else delete order.profileName;
    }
    if (removeProfilePin) delete order.profilePin;
    else if (profilePin !== undefined) {
      const trimmed = String(profilePin || '').trim();
      if (trimmed) order.profilePin = trimmed;
      else delete order.profilePin;
    }
    if (note !== undefined) order.note = String(note || '').trim();
    if (autoRenew !== undefined) order.autoRenew = Boolean(autoRenew);
    await writeDbFast(data);
    res.json({ success: true, order, user: sanitizeUser(user), data: safeDataForSession(data, session) });
  } catch (e) {
    console.error('Subscription update error:', e.message);
    res.status(500).json({ error: e.message || 'Could not update subscription' });
  }
});

async function resolveShahidOrderForRequest(data, session, orderId, linkToken) {
  if (session && orderId) {
    const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
    if (!user) return { error: 'User not found', status: 404 };
    const found = findUserOrderRecord(user, orderId);
    if (!found.order) return { error: 'Subscription not found', status: 404 };
    if (!isShahidOrder(found.order)) return { error: 'This tool is only for Shahid subscriptions', status: 400 };
    return { order: found.order, ownerEmail: session.email };
  }
  if (linkToken) {
    try {
      const payload = decodeLinkToken(linkToken);
      const subscription = payload && payload.subscription;
      if (!subscription || !subscription.email) return { error: 'Invalid subscription link', status: 400 };
      if (Date.now() > Number(payload.expiresAt || 0)) return { error: 'Subscription link expired', status: 404 };
      if (!isShahidOrder(subscription)) return { error: 'This tool is only for Shahid subscriptions', status: 400 };
      const ownerEmail = payload.owner || '';
      if (ownerEmail) {
        const user = (data.users || []).find(u => normalizeEmail(u.email) === normalizeEmail(ownerEmail));
        if (user && subscription.id) {
          const found = findUserOrderRecord(user, subscription.id);
          if (found.order) return { order: found.order, ownerEmail };
        }
      }
      return { order: subscription, ownerEmail };
    } catch (e) {
      return { error: 'Invalid subscription link', status: 400 };
    }
  }
  return { error: 'Order ID or link token required', status: 400 };
}

app.post('/customer/shahid-reset-link', async (req, res) => {
  const session = requireSession(req, res, ['user']);
  if (!session) return;
  try {
    const data = await readJsonBinRaw();
    const resolved = await resolveShahidOrderForRequest(data, session, req.body && req.body.orderId, null);
    if (resolved.error) return res.status(resolved.status || 400).json({ error: resolved.error });
    const result = await fetchShahidResetLinkForOrder(data, resolved.order);
    if (!result.success) return res.json({ success: false, message: result.message });
    res.json({ success: true, link: result.link });
  } catch (e) {
    console.error('Shahid reset link error:', e.message);
    res.status(500).json({ error: e.message || 'Could not fetch reset link' });
  }
});

app.post('/links/shahid-reset-link', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Link token required' });
  try {
    const data = await readJsonBinRaw();
    const resolved = await resolveShahidOrderForRequest(data, null, null, token);
    if (resolved.error) return res.status(resolved.status || 400).json({ error: resolved.error });
    const result = await fetchShahidResetLinkForOrder(data, resolved.order);
    if (!result.success) return res.json({ success: false, message: result.message });
    res.json({ success: true, link: result.link });
  } catch (e) {
    console.error('Shahid reset link (token) error:', e.message);
    res.status(500).json({ error: e.message || 'Could not fetch reset link' });
  }
});

app.post('/customer/resend-subscription', async (req, res) => {
  const session = requireSession(req, res, ['user']);
  if (!session) return;
  const { orderId, tgChatId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'Order ID required' });
  try {
    const data = await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
    data.users = Array.isArray(data.users) ? data.users : [];
    const user = data.users.find(u => normalizeEmail(u.email) === session.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    syncUserContact(user, { tgChatId });
    const { order, customer } = findUserOrderRecord(user, orderId);
    if (!order || !order.email) return res.status(404).json({ error: 'Subscription not found' });
    if (!String(user.tgChatId || '').trim() && !normalizeEmail(user.email)) {
      return res.status(400).json({ error: 'Add your email in Profile, or add Telegram Chat ID to receive credentials.' });
    }
    if (String(user.tgChatId || '').trim()) await writeDbFast(data);
    const product = {
      name: order.product,
      short: order.short || '',
      color: order.color || '',
      tc: order.tc || '',
      id: order.productId || ''
    };
    const deliveryChannel = await notifyPurchaseFulfilled(user, product, order.plan || '', order.price || 0, order, customer ? customer.id : null, { forceResend: true, skipAdminNotify: true, data });
    res.json({
      success: true,
      deliveryChannel: deliveryChannel || null,
      telegramSent: String(deliveryChannel || '').includes('telegram'),
      emailSent: String(deliveryChannel || '').includes('email'),
      user: sanitizeUser(user)
    });
  } catch (e) {
    console.error('Resend subscription error:', e.message);
    res.status(500).json({ error: e.message || 'Could not resend subscription' });
  }
});

app.post('/purchase', async (req, res) => {
  const session = requireSession(req, res, ['user']);
  if (!session) return;
  const lockKey = normalizeEmail(session.email);
  if (activePurchases.has(lockKey)) {
    return res.status(409).json({ error: 'Purchase already processing. Please wait a moment and try again.' });
  }
  activePurchases.add(lockKey);
  const { product, planLabel, price, skey, extraFields, assignCustId, tgChatId, customDays } = req.body;
  if (!product || !planLabel || !skey || !Number(price)) {
    activePurchases.delete(lockKey);
    return res.status(400).json({ error: 'Invalid purchase' });
  }
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.users = Array.isArray(data.users) ? data.users : [];
      data.stock = data.stock || {};
      data.pending = Array.isArray(data.pending) ? data.pending : [];
      data.stockBlocks = data.stockBlocks || {};
      data[RETAIL_STOCK_BLOCKS_KEY] = data[RETAIL_STOCK_BLOCKS_KEY] || {};
      const user = data.users.find(u => normalizeEmail(u.email) === session.email);
      if (!user) return { error: 'User not found', status: 404 };
      if (!userIsReseller(user) && assignCustId !== null && assignCustId !== undefined) {
        return { error: 'Sub-customer purchases are for reseller accounts only.', status: 403 };
      }
      const catalog = getCatalogForUser(data, user);
      const expectedPrice = resolvePurchasePrice(catalog, { skey, customDays: Number(customDays || 0) });
      if (expectedPrice == null || !pricesMatch(expectedPrice, price)) {
        return { error: 'Price has changed. Refresh the store and try again.', status: 400 };
      }
      syncUserContact(user, { tgChatId });
      if (user.banned) return { error: 'Your account has been suspended. Contact support.', status: 403 };
      if (isPlanStockBlocked(data, user, skey, customDays)) {
        return { error: 'This plan is temporarily unavailable.', status: 403 };
      }
      if (isCanvaOwnStockKey(skey)) {
        const customerCanvaEmail = String(extraFields?.customerCanvaEmail || '').trim();
        if (!customerCanvaEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerCanvaEmail)) {
          return { error: 'Please enter a valid Canva email', status: 400 };
        }
      }
      if (Number(user.balance || 0) < Number(price)) return { error: 'Insufficient balance', status: 400 };

      const dateStr = formatBeirutTime();
      const acc = isCanvaOwnStockKey(skey) ? null : pickAvailableAccount(data, skey);
      user.transactions = Array.isArray(user.transactions) ? user.transactions : [];

      if (!acc) {
        user.balance = Number(user.balance || 0) - Number(price);
        const assignedCustomer = assignCustId !== null && assignCustId !== undefined
          ? (user.myCustomers || []).find(c => c.id === assignCustId)
          : null;
        const pendingOrder = initPendingOrder({
          id:'#'+(Math.floor(Math.random()*90000+10000)),
          userEmail:user.email,userName:user.name,userTgChatId:user.tgChatId||'',
          product:product.name,short:product.short,color:product.color,tc:product.tc,
          productId:product.id,plan:planLabel,price:Number(price),skey,date:dateStr,
          ...(assignedCustomer ? { assignCustId, profileName: extraFields?.profileName || assignedCustomer.fname } : {}),
          ...(extraFields||{})
        });
        data.pending.unshift(pendingOrder);
        user.transactions.unshift({type:'purchase',label:'Bought '+product.name+' · '+planLabel,amount:Number(price),balance:user.balance,date:dateStr,pending:true,orderId:pendingOrder.id});
        await writeDbFast(data);
        return { mode: 'pending', data, user, pendingOrder };
      }

      const aliasError = validateNetflixAliasPurchase(data, skey, acc);
      if (aliasError) return { error: aliasError, status: 409 };

      user.balance = Number(user.balance || 0) - Number(price);
      const orderId = '#'+ (Math.floor(Math.random()*90000+10000));
      const assignedCustomer = assignCustId !== null && assignCustId !== undefined
        ? (user.myCustomers||[]).find(c => c.id === assignCustId)
        : null;
      markLinkedStockSold(data.stock, acc, {
        userEmail: user.email,
        userName: user.name,
        orderId,
        assignCustId: assignedCustomer ? assignedCustomer.id : null,
        assignCustName: assignedCustomer ? `${assignedCustomer.fname || ''} ${assignedCustomer.lname || ''}`.trim() : ''
      }, skey);
      const order = {
        id: orderId,
        product:product.name,short:product.short,color:product.color,tc:product.tc,
        productId:product.id,plan:planLabel,price:Number(price),
        email:acc.email,pass:acc.pass,date:dateStr,expiryDate:acc.expiryDate||null,
        ...(acc.phone ? { phone: acc.phone } : {}),
        ...(acc.serviceLink ? { serviceLink: acc.serviceLink } : {}),
        ...(accountProfileName(acc) ? { profileName: accountProfileName(acc) } : {}),
        ...(extraFields||{}),
        ...(acc.profilePin?{profilePin:acc.profilePin}:{}),
        accKey:acc.accKey||'',mainEmail:acc.mainEmail||''
      };
      if (assignedCustomer) {
        order.profileName = order.profileName || assignedCustomer.fname;
        assignedCustomer.subs = Array.isArray(assignedCustomer.subs) ? assignedCustomer.subs : [];
        assignedCustomer.subs.unshift(order);
      } else {
        user.orders = Array.isArray(user.orders) ? user.orders : [];
        user.orders.unshift(order);
      }
      data.pending = (data.pending || []).filter(po => {
        if (normalizeEmail(po.userEmail) !== lockKey) return true;
        const existing = findUserOrderRecord(user, po.id).order;
        return !(existing && existing.email && !existing.pending);
      });
      user.transactions.unshift({type:'purchase',label:'Bought '+product.name+' · '+planLabel,amount:Number(price),balance:user.balance,date:dateStr});
      await writeDbFast(data);
      return { mode: 'fulfilled', data, user, order };
    });
    if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
    if (outcome.mode === 'pending') {
      const { data, user, pendingOrder } = outcome;
      res.json({
        success: true,
        pending: true,
        user: sanitizeUser(user),
        order: pendingOrder,
        ...(session.role === 'admin' ? { data: slimMutationData(session, data, { pending: true }) } : {})
      });
      runAfterResponse(() => notifyPurchasePending(user, product, planLabel, price, assignCustId, pendingOrder, { data }));
      return;
    }
    const { data, user, order } = outcome;
    const userEmail = normalizeEmail(user.email);
    const orderId = order.id;
    res.json({
      success: true,
      pending: false,
      user: sanitizeUser(user),
      order,
      ...(session.role === 'admin' ? { data: slimMutationData(session, data, { pending: true }) } : {})
    });
    runAfterResponse(async () => {
      const deliveryChannel = await notifyPurchaseFulfilled(user, product, planLabel, price, order, assignCustId, { data });
      if (!deliveryChannel) return;
      await enqueueDbWrite(async () => {
        const fresh = await readDbForWrite();
        const liveUser = (fresh.users || []).find(u => normalizeEmail(u.email) === userEmail);
        if (!liveUser) return;
        const { order: liveOrder } = findUserOrderRecord(liveUser, orderId);
        if (liveOrder) stampOrderDelivery(liveOrder, deliveryChannel);
        await writeDbFast(fresh);
      });
    });
  } catch(e) {
    console.error('Purchase error:', e.message);
    res.status(500).json({ error: 'Purchase failed' });
  } finally {
    activePurchases.delete(lockKey);
  }
});

app.post('/customer/topup-request', async (req, res) => {
  const session = requireSession(req, res, ['user']);
  if (!session) return;
  const { amount, label } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.topupreqs = Array.isArray(data.topupreqs) ? data.topupreqs : [];
      data.users = Array.isArray(data.users) ? data.users : [];
      const user = data.users.find(u => normalizeEmail(u.email) === session.email);
      if (!user) return { error: 'User not found', status: 404 };
      const duplicate = data.topupreqs.find(r =>
        normalizeEmail(r.email) === session.email &&
        r.status === 'pending' &&
        Number(r.amount) === amt &&
        Date.now() - Number(r.id || 0) < 3600000
      );
      if (duplicate) {
        return { duplicate: true, request: duplicate, data };
      }
      const reqRow = {
        id: Date.now(),
        name: user.name,
        email: user.email,
        tgChatId: user.tgChatId || '',
        amount: amt,
        label: label || `$${amt}`,
        date: formatBeirutTime(),
        status: 'pending'
      };
      data.topupreqs.unshift(reqRow);
      await writeDbFast(data);
      return { request: reqRow, data, user };
    });
    if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
    if (outcome.duplicate) {
      return res.json({ success: true, duplicate: true, request: outcome.request });
    }
    const { request: reqRow, data, user } = outcome;
    res.json({
      success: true,
      request: reqRow,
      ...(session.role === 'admin' ? { data: slimMutationData(session, data, { topupreqsOnly: true }) } : {})
    });
    runAfterResponse(() => sendTG(
      TG_ADMIN,
      `💳 <b>Topup Request</b>\n\n👤 <b>${user.name}</b>\n📧 ${user.email}\n💵 Amount: <b>${reqRow.label}</b>\n📅 ${reqRow.date}\n\nGo to Admin → Topup Requests to credit after payment.`,
      'HTML'
    ).catch((e) => console.error('Topup admin TG:', e.message)));
  } catch (e) {
    console.error('Topup request error:', e.message);
    res.status(500).json({ error: 'Could not submit top-up request' });
  }
});

app.post('/admin/credit-topup', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { requestId } = req.body || {};
  if (!requestId) return res.status(400).json({ error: 'Request ID required' });
  const lockKey = String(requestId);
  if (activeTopupCredits.has(lockKey)) {
    return res.status(409).json({ error: 'This top-up is already being credited' });
  }
  activeTopupCredits.add(lockKey);
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.topupreqs = Array.isArray(data.topupreqs) ? data.topupreqs : [];
      data.users = Array.isArray(data.users) ? data.users : [];
      const reqRow = data.topupreqs.find(r => String(r.id) === lockKey);
      if (!reqRow) return { error: 'Top-up request not found', status: 404 };
      if (reqRow.status === 'credited') return { alreadyCredited: true, data };
      const user = data.users.find(u => normalizeEmail(u.email) === normalizeEmail(reqRow.email));
      if (!user) return { error: 'User not found: ' + reqRow.email, status: 404 };
      user.balance = Number(user.balance || 0) + Number(reqRow.amount || 0);
      user.transactions = Array.isArray(user.transactions) ? user.transactions : [];
      user.transactions.unshift({
        type: 'topup',
        label: `Wallet top-up — ${reqRow.label}`,
        amount: Number(reqRow.amount),
        balance: user.balance,
        date: formatBeirutTime()
      });
      reqRow.status = 'credited';
      await writeDbFast(data);
      return { data, user, reqRow };
    });
    if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
    if (outcome.alreadyCredited) {
      return res.json({ success: true, alreadyCredited: true, topupreqs: outcome.data.topupreqs || [] });
    }
    const { user, reqRow, data } = outcome;
    res.json({ success: true, user: sanitizeUser(user), topupreqs: data.topupreqs || [] });
    runAfterResponse(async () => {
      const custTgId = String(user.tgChatId || reqRow.tgChatId || '').trim();
      if (custTgId) {
        await sendTG(
          custTgId,
          `💰 <b>Wallet Topped Up!</b>\n\n✅ <b>${reqRow.label}</b> has been added to your wallet.\n💵 New balance: $${Number(user.balance).toFixed(2)}\n\nEnjoy shopping on rashadtech.tv! 🎉`,
          'HTML'
        ).catch((e) => console.error('Topup customer TG:', e.message));
      }
      await sendTopupConfirmationEmail(user, reqRow.amount, reqRow.label, { data, date: formatBeirutTime() });
      await sendTG(
        TG_ADMIN,
        `✅ Credited ${reqRow.label} to ${reqRow.name} (${reqRow.email}) · Balance: $${Number(user.balance).toFixed(2)}${custTgId ? '' : ' · 📧 emailed'}`,
        'HTML'
      ).catch((e) => console.error('Topup credit admin TG:', e.message));
    });
  } catch (e) {
    console.error('Credit topup error:', e.message);
    res.status(500).json({ error: 'Could not credit top-up' });
  } finally {
    activeTopupCredits.delete(lockKey);
  }
});

app.post('/admin/delete-topup', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { requestId } = req.body || {};
  if (!requestId) return res.status(400).json({ error: 'Request ID required' });
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.topupreqs = Array.isArray(data.topupreqs) ? data.topupreqs : [];
      const idx = data.topupreqs.findIndex(r => String(r.id) === String(requestId));
      if (idx < 0) return { error: 'Top-up request not found', status: 404 };
      const reqRow = data.topupreqs[idx];
      data.topupreqs.splice(idx, 1);
      await writeDbFast(data);
      return { data, reqRow };
    });
    if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
    res.json({
      success: true,
      topupreqs: outcome.data.topupreqs || [],
      data: slimMutationData(session, outcome.data, { topupreqsOnly: true })
    });
  } catch (e) {
    console.error('Delete top-up error:', e.message);
    res.status(500).json({ error: 'Could not remove top-up request' });
  }
});

app.post('/customer/product-request', async (req, res) => {
  const session = requireSession(req, res, ['user']);
  if (!session) return;
  const { service, notes } = req.body || {};
  const serviceName = String(service || '').trim();
  if (!serviceName) return res.status(400).json({ error: 'Service name required' });
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.requests = Array.isArray(data.requests) ? data.requests : [];
      data.users = Array.isArray(data.users) ? data.users : [];
      const user = data.users.find(u => normalizeEmail(u.email) === session.email);
      if (!user) return { error: 'User not found', status: 404 };
      const email = user.email;
      const existing = data.requests.find(r =>
        String(r.service || '').toLowerCase() === serviceName.toLowerCase() && !r.resolved
      );
      if (existing) {
        const already = (existing.requesters || []).some(e => normalizeEmail(e) === normalizeEmail(email));
        if (already) return { duplicate: true, request: existing, data };
        existing.requesters = [...(existing.requesters || []), email];
        if (notes) existing.latestNote = String(notes).trim();
        await writeDbFast(data);
        return { data, user, request: existing, voted: true };
      }
      const reqRow = {
        id: Date.now(),
        service: serviceName,
        notes: String(notes || '').trim(),
        latestNote: String(notes || '').trim(),
        requesters: [email],
        resolved: false,
        date: formatBeirutTime()
      };
      data.requests.unshift(reqRow);
      await writeDbFast(data);
      return { data, user, request: reqRow, created: true };
    });
    if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
    if (outcome.duplicate) {
      return res.json({ success: true, duplicate: true, request: outcome.request, requests: outcome.data.requests || [] });
    }
    const { request: reqRow, user, data, created, voted } = outcome;
    res.json({
      success: true,
      created: Boolean(created),
      voted: Boolean(voted),
      request: reqRow,
      requests: data.requests || [],
      data: safeDataForSession(data, session)
    });
    if (created) {
      runAfterResponse(() => sendTG(
        TG_ADMIN,
        `💡 <b>New Product Request</b>\n\n👤 <b>${user.name}</b>\n📧 ${user.email}\n📺 Service: <b>${reqRow.service}</b>${reqRow.latestNote ? `\n📝 Notes: ${reqRow.latestNote}` : ''}`,
        'HTML'
      ).catch((e) => console.error('Product request admin TG:', e.message)));
    }
  } catch (e) {
    console.error('Product request error:', e.message);
    res.status(500).json({ error: 'Could not submit request' });
  }
});

app.post('/admin/resolve-request', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { requestId } = req.body || {};
  if (!requestId) return res.status(400).json({ error: 'Request ID required' });
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.requests = Array.isArray(data.requests) ? data.requests : [];
      const reqRow = data.requests.find(r => String(r.id) === String(requestId));
      if (!reqRow) return { error: 'Request not found', status: 404 };
      if (reqRow.resolved) return { alreadyResolved: true, data, request: reqRow };
      reqRow.resolved = true;
      await writeDbFast(data);
      return { data, request: reqRow };
    });
    if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
    res.json({
      success: true,
      alreadyResolved: Boolean(outcome.alreadyResolved),
      request: outcome.request,
      requests: outcome.data.requests || [],
      data: slimMutationData(session, outcome.data, { requests: true })
    });
  } catch (e) {
    console.error('Resolve request error:', e.message);
    res.status(500).json({ error: 'Could not resolve request' });
  }
});

app.post('/admin/wallet-adjust', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { email, amount, type, notify } = req.body || {};
  const targetEmail = normalizeEmail(email);
  const amt = Number(amount);
  if (!targetEmail || !amt || amt <= 0) return res.status(400).json({ error: 'Valid email and amount required' });
  const mode = type === 'withdraw' ? 'withdraw' : 'deposit';
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.users = Array.isArray(data.users) ? data.users : [];
      const user = data.users.find(u => normalizeEmail(u.email) === targetEmail);
      if (!user) return { error: 'User not found', status: 404 };
      if (mode === 'withdraw' && Number(user.balance || 0) < amt) {
        return { error: 'Amount exceeds balance', status: 400 };
      }
      user.balance = mode === 'withdraw'
        ? Number(user.balance || 0) - amt
        : Number(user.balance || 0) + amt;
      user.transactions = Array.isArray(user.transactions) ? user.transactions : [];
      user.transactions.unshift({
        type: mode === 'withdraw' ? 'withdrawal' : 'topup',
        label: mode === 'withdraw' ? 'Withdrawal by admin' : 'Deposit by admin',
        amount: amt,
        balance: user.balance,
        date: formatBeirutTime()
      });
      await writeDbFast(data);
      return { data, user };
    });
    if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
    const { user, data } = outcome;
    const dateStr = formatBeirutTime();
    if (notify !== false && user.tgChatId) {
      const msg = mode === 'withdraw'
        ? `💰 <b>Wallet Updated</b>\n\n➖ $${amt.toFixed(2)} withdrawn.\n💵 New balance: $${Number(user.balance).toFixed(2)}`
        : `💰 <b>Wallet Topped Up!</b>\n\n✅ $${amt.toFixed(2)} added to your wallet.\n💵 New balance: $${Number(user.balance).toFixed(2)}\n\nEnjoy shopping! 🎉`;
      await sendTG(user.tgChatId, msg, 'HTML').catch(() => {});
    }
    if (mode === 'deposit') {
      runAfterResponse(() => sendTopupConfirmationEmail(user, amt, `$${amt.toFixed(2)}`, { data, date: dateStr }));
    }
    res.json({ success: true, user: sanitizeUser(user), data: safeDataForSession(data, { role: 'admin' }) });
  } catch (e) {
    console.error('Wallet adjust error:', e.message);
    res.status(500).json({ error: 'Could not adjust wallet' });
  }
});

app.post('/purchase-game', async (req, res) => {
  const session = requireSession(req, res, ['user']);
  if (!session) return;
  const lockKey = normalizeEmail(session.email);
  if (activePurchases.has(lockKey)) {
    return res.status(409).json({ error: 'Order already processing. Please wait a moment.' });
  }
  activePurchases.add(lockKey);
  const { product, planLabel, price, playerId, playerPassword, customOrderType, tgChatId, skey, tokens } = req.body || {};
  const orderPrice = Number(price);
  if (!product || !planLabel || !playerId || !orderPrice || orderPrice <= 0) {
    activePurchases.delete(lockKey);
    return res.status(400).json({ error: 'Invalid game order' });
  }
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.users = Array.isArray(data.users) ? data.users : [];
      data.gameorders = Array.isArray(data.gameorders) ? data.gameorders : [];
      const user = data.users.find(u => normalizeEmail(u.email) === session.email);
      if (!user) return { error: 'User not found', status: 404 };
      const catalog = getCatalogForUser(data, user);
      let expectedPrice = null;
      if (customOrderType === 'jawaker') {
        expectedPrice = computeJawakerPrice(catalog, Number(tokens || 0));
      } else if (skey) {
        expectedPrice = resolvePurchasePrice(catalog, { skey });
      }
      if (expectedPrice == null || !pricesMatch(expectedPrice, orderPrice)) {
        return { error: 'Price has changed. Refresh the store and try again.', status: 400 };
      }
      syncUserContact(user, { tgChatId });
      if (user.banned) return { error: 'Your account has been suspended.', status: 403 };
      if (Number(user.balance || 0) < orderPrice) return { error: 'Insufficient balance', status: 400 };
      user.balance = Number(user.balance || 0) - orderPrice;
      const dateStr = formatBeirutTime();
      const orderId = '#' + (Math.floor(Math.random() * 90000 + 10000));
      const order = initGameOrder({
        id: orderId,
        type: customOrderType || 'game',
        product: product.name,
        short: product.short || '',
        color: product.color || '',
        playerId: String(playerId).trim(),
        plan: planLabel,
        price: orderPrice,
        userEmail: user.email,
        userName: user.name,
        userTgChatId: user.tgChatId || '',
        date: dateStr,
        status: 'pending',
        ...(playerPassword ? { playerPassword: String(playerPassword) } : {})
      });
      data.gameorders.unshift(order);
      user.transactions = Array.isArray(user.transactions) ? user.transactions : [];
      user.transactions.unshift({
        type: 'purchase',
        label: `${product.name} · ${planLabel}`,
        amount: orderPrice,
        balance: user.balance,
        date: dateStr,
        pending: true,
        orderId
      });
      await writeDbFast(data);
      return { data, user, order, dateStr };
    });
    if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
    const { data, user, order, dateStr } = outcome;
    const passLine = order.playerPassword ? `\n🔑 Password: <code>${order.playerPassword}</code>` : '';
    const idLabel = order.playerPassword ? 'Username' : 'Player ID';
    if (user.tgChatId) {
      await sendTG(
        user.tgChatId,
        `⏳ <b>Order Received!</b>\n\n🎮 <b>${order.product}</b>\n📋 ${planLabel}\n👤 ${idLabel}: <code>${order.playerId}</code>${passLine}\n💵 $${orderPrice.toFixed(2)}\n\nYour order is being processed. We will notify you here once it's done! 🙏`,
        'HTML'
      ).catch(() => {});
    }
    await sendTG(
      TG_ADMIN,
      `🎮 <b>New Game Order ${order.id}</b>\n\n📦 ${order.product}\n📋 ${planLabel}\n👤 ${idLabel}: <code>${order.playerId}</code>${passLine}\n💵 $${orderPrice.toFixed(2)}\n👤 ${user.name} (${user.email})\n📅 ${dateStr}\n\nGo to Admin → Game Orders to fulfill.`,
      'HTML'
    ).catch(() => {});
    runAfterResponse(() => sendPurchaseReceiptEmail(user, { name: order.product }, planLabel, orderPrice, order, {
      data,
      status: 'pending',
      date: dateStr
    }));
    res.json({
      success: true,
      order,
      user: sanitizeUser(user),
      data: safeDataForSession(data, session)
    });
  } catch (e) {
    console.error('Purchase game error:', e.message);
    res.status(500).json({ error: 'Could not place game order' });
  } finally {
    activePurchases.delete(lockKey);
  }
});

app.post('/admin/stock-add', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { skey, skeys, account, accKey, replicateToNetflixPlans, accounts, requestId } = req.body || {};
  const batch = Array.isArray(accounts) ? accounts : null;
  const keys = replicateToNetflixPlans
    ? netflixOneUserPlanKeys()
    : (Array.isArray(skeys) && skeys.length ? skeys : (skey ? [skey] : []));
  if (batch) {
    if (!batch.length) return res.status(400).json({ error: 'No accounts to add' });
  } else if (!keys.length || !account) {
    return res.status(400).json({ error: 'Plan key and account required' });
  } else if (!isAnghamiStockKey(keys[0]) && !isDisneyOneUserStockKey(keys[0]) && !isCanvaNewStockKey(keys[0]) && !isOsnStockKey(keys[0]) && (!account.email || !account.pass)) {
    return res.status(400).json({ error: 'Plan key and account email/password required' });
  }
  const lockKeys = [];
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.stock = data.stock || {};
      const addedKeys = [];
      const rows = batch || [{ account, accKey, replicateToNetflixPlans: Boolean(replicateToNetflixPlans), skey }];
      for (const row of rows) {
        const rowAccount = row.account || account;
        const validationError = validateStockAccountForAdd(row.skey || keys[0] || '', rowAccount);
        if (validationError) {
          return { error: validationError, status: 400 };
        }
        const rowKeys = row.replicateToNetflixPlans
          ? netflixOneUserPlanKeys()
          : (row.skey ? [row.skey] : keys);
        if (!rowKeys.length || !rowKeys[0]) {
          return { error: 'Plan key required for each account', status: 400 };
        }
        const firstKey = rowKeys[0] || '';
        const sharedKey = row.accKey || accKey || (row.replicateToNetflixPlans || replicateToNetflixPlans
          ? `nfprof__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          : /^shahid__1user__/.test(firstKey)
            ? `shprof__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            : /^disney__1user__/.test(firstKey)
              ? `dsprof__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
              : /^osn__1user__/.test(firstKey)
                ? `osnprof__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
                : `${firstKey}__${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
        const fingerprint = row.requestId || requestId || stockAddFingerprint(rowAccount, rowKeys);
        if (activeStockAdds.has(fingerprint)) {
          return { error: 'This account add is already in progress', status: 409, duplicate: true };
        }
        activeStockAdds.add(fingerprint);
        lockKeys.push(fingerprint);
        const accPayload = {
          used: false,
          accKey: sharedKey,
          email: isAnghamiStockKey(firstKey) ? '' : String(rowAccount.email || '').trim(),
          pass: isAnghamiStockKey(firstKey) || isDisneyOneUserStockKey(firstKey) || isCanvaNewStockKey(firstKey) || isOsnStockKey(firstKey) ? '' : String(rowAccount.pass || '').trim(),
          ...(rowAccount.phone ? { phone: String(rowAccount.phone).trim() } : {}),
          ...(rowAccount.profileName ? { profileName: String(rowAccount.profileName).trim() } : {}),
          ...(rowAccount.serviceLink ? { serviceLink: String(rowAccount.serviceLink).trim() } : {}),
          ...(rowAccount.expiryDate ? { expiryDate: String(rowAccount.expiryDate).trim() } : {}),
          ...(rowAccount.profilePin ? { profilePin: String(rowAccount.profilePin).trim() } : {}),
          ...(rowAccount.mainEmail ? { mainEmail: String(rowAccount.mainEmail).trim() } : {}),
          ...(rowAccount.mainPass ? { mainPass: String(rowAccount.mainPass) } : {})
        };
        for (const key of rowKeys) {
          if (!key) continue;
          if (isNetflixStockKey(key) && !accPayload.email) {
            return { error: 'Netflix stock requires email', status: 400 };
          }
          const aliasError = validateNetflixAliasPurchase(data, key, accPayload);
          if (aliasError) return { error: aliasError, status: 409 };
          if (!Array.isArray(data.stock[key])) data.stock[key] = [];
          if (data.stock[key].some(a => a && a.accKey === accPayload.accKey)) {
            return { error: 'This account is already in stock', status: 409, duplicate: true };
          }
          if (findDuplicateStockAccount(data.stock, key, accPayload)) {
            return { error: 'This account is already in stock for this plan', status: 409, duplicate: true };
          }
          data.stock[key].push({ ...accPayload, accKey: sharedKey });
          addedKeys.push(key);
        }
      }
      await writeJsonBinRaw(data, { backupReason: 'stock-add', lightWrite: true });
      return { data, addedKeys };
    });
    if (outcome.error) {
      return res.status(outcome.status || 400).json({
        error: outcome.error,
        duplicate: Boolean(outcome.duplicate),
        alreadyInStock: Boolean(outcome.duplicate)
      });
    }
    res.json({
      success: true,
      addedKeys: outcome.addedKeys,
      data: safeDataForSession(outcome.data, { role: 'admin' })
    });
  } catch (e) {
    console.error('Stock add error:', e.message);
    res.status(500).json({ error: 'Could not add stock account' });
  } finally {
    lockKeys.forEach((key) => activeStockAdds.delete(key));
  }
});

app.post('/admin/stock-prune-netflix-mirrors', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { skey } = req.body || {};
  if (!skey || !/^netflix__1user__/.test(String(skey))) {
    return res.status(400).json({ error: 'Netflix 1-user plan key required' });
  }
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.stock = data.stock || {};
      const before = countNetflixMirrorCopies(data.stock, skey);
      if (!before) return { data, removed: 0, remaining: 0 };
      const { removed } = pruneNetflixMirrors(data.stock, skey);
      await writeJsonBinRaw(data, { backupReason: 'prune-netflix-mirrors', lightWrite: true });
      return {
        data,
        removed,
        remaining: countNetflixMirrorCopies(data.stock, skey)
      };
    });
    res.json({
      success: true,
      removed: outcome.removed,
      remaining: outcome.remaining,
      data: safeDataForSession(outcome.data, { role: 'admin' })
    });
  } catch (e) {
    console.error('Prune Netflix mirrors error:', e.message);
    res.status(500).json({ error: 'Could not remove duplicate Netflix copies' });
  }
});

app.post('/admin/stock-delete', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { skey, accKey, email } = req.body || {};
  if (!skey || (!accKey && !email)) {
    return res.status(400).json({ error: 'Plan key and account id required' });
  }
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.stock = data.stock || {};
      const targetKey = String(accKey || '');
      const targetEmail = normalizeEmail(email);
      const accounts = Array.isArray(data.stock[skey]) ? data.stock[skey] : [];
      const next = accounts.filter((acc) => {
        if (!acc) return false;
        const match = targetKey
          ? String(acc.accKey || '') === targetKey
          : normalizeEmail(acc.email) === targetEmail;
        return !match;
      });
      const removed = accounts.length - next.length;
      if (!removed) return { error: 'Account not found in stock', status: 404 };
      data.stock[skey] = next;
      await writeJsonBinRaw(data, { backupReason: 'stock-delete', lightWrite: true });
      return { data, removed };
    });
    if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
    res.json({
      success: true,
      removed: outcome.removed,
      data: safeDataForSession(outcome.data, { role: 'admin' })
    });
  } catch (e) {
    console.error('Stock delete error:', e.message);
    res.status(500).json({ error: 'Could not delete stock account' });
  }
});

app.post('/admin/stock-block', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { skey, blocked, tier } = req.body;
  if (!skey) return res.status(400).json({ error: 'Stock key is required' });
  const retailTier = String(tier || 'reseller').toLowerCase() === 'retail';
  const field = retailTier ? RETAIL_STOCK_BLOCKS_KEY : 'stockBlocks';
  try {
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.stockBlocks = data.stockBlocks || {};
      data[RETAIL_STOCK_BLOCKS_KEY] = data[RETAIL_STOCK_BLOCKS_KEY] || {};
      if (blocked) data[field][skey] = { blocked: true, ts: Date.now() };
      else delete data[field][skey];
      await writeJsonBinRaw(data, { backupReason: 'stock-block', lightWrite: true });
      return data;
    });
    res.json({
      success: true,
      tier: retailTier ? 'retail' : 'reseller',
      stockBlocks: outcome.stockBlocks,
      retailStockBlocks: outcome[RETAIL_STOCK_BLOCKS_KEY],
      data: safeDataForSession(outcome, { role: 'admin' })
    });
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
    const outcome = await enqueueDbWrite(async () => {
      const data = await readDbForWrite();
      data.pending = Array.isArray(data.pending) ? data.pending : [];
      data.users = Array.isArray(data.users) ? data.users : [];
      const idx = data.pending.findIndex(o => o.id === orderId);
      if (idx < 0) return { error: 'Pending order not found', status: 404 };
      const order = data.pending[idx];
      const user = data.users.find(u => normalizeEmail(u.email) === normalizeEmail(order.userEmail));
      const existing = user ? findUserOrderRecord(user, order.id).order : null;
      if (existing && existing.email && !existing.pending) {
        data.pending.splice(idx, 1);
        await writeDbFast(data);
        return { error: 'Order was already fulfilled', status: 409 };
      }
      const refund = Number(order.price || 0);
      if (user && refund > 0) {
        user.balance = Number(user.balance || 0) + refund;
        user.transactions = Array.isArray(user.transactions) ? user.transactions : [];
        user.transactions.unshift({
          type: 'refund',
          label: `Refund — canceled ${order.product} · ${order.plan}`,
          amount: refund,
          balance: user.balance,
          date: formatBeirutTime(),
          orderId: order.id
        });
      }
      data.pending.splice(idx, 1);
      await writeDbFast(data);
      return { data, order, user, refund };
    });
    if (outcome.error) return res.status(outcome.status || 400).json({ error: outcome.error });
    const { data, order, user, refund } = outcome;
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
app.get('/admin/incomplete-profiles', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  try {
    const data = await readJsonBinRaw({ fast: true });
    const list = (data.users || []).filter(u => !normalizePhone(u.phone) || !normalizeTgChatId(u.tgChatId));
    res.json({
      success: true,
      count: list.length,
      users: list.map(u => ({
        email: u.email,
        name: u.name || '',
        phone: normalizePhone(u.phone) || '',
        tgChatId: normalizeTgChatId(u.tgChatId) || ''
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not load users' });
  }
});

app.get('/admin/marketing-email-status', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  try {
    const data = await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
    const templateId = resolveMarketingTemplateId(data);
    const provider = getActiveEmailProvider(data);
    const configured = provider === 'resend'
      ? true
      : Boolean(templateId && templateId !== EMAILJS_TEMPLATE_ID);
    const settings = (data && data.siteSettings) || {};
    res.json({
      success: true,
      configured,
      marketingTemplateId: configured ? templateId : '',
      otpTemplateId: EMAILJS_TEMPLATE_ID,
      retailSupportEmail: settings.retailSupportEmail || '',
      resellerSupportEmail: settings.resellerSupportEmail || '',
      ...getEmailDeliverabilityStatus({ setupHint: MARKETING_EMAIL_SETUP_HINT }, data)
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not load email settings' });
  }
});

app.post('/admin/email-settings', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { resendApiKey, emailFromAddress, emailReplyTo, emailFromName, retailSupportEmail, resellerSupportEmail, clearResendKey } = req.body || {};
  try {
    const data = await readJsonBinRaw();
    data.siteSettings = { ...(data.siteSettings || {}) };
    if (clearResendKey) delete data.siteSettings.resendApiKey;
    const nextKey = String(resendApiKey || '').trim();
    if (nextKey && !/^[•.]+/.test(nextKey) && !nextKey.includes('…')) {
      data.siteSettings.resendApiKey = nextKey;
    }
    if (emailFromAddress !== undefined) data.siteSettings.emailFromAddress = String(emailFromAddress || '').trim();
    if (emailReplyTo !== undefined) data.siteSettings.emailReplyTo = String(emailReplyTo || '').trim();
    if (emailFromName !== undefined) data.siteSettings.emailFromName = String(emailFromName || '').trim();
    if (retailSupportEmail !== undefined) data.siteSettings.retailSupportEmail = String(retailSupportEmail || '').trim();
    if (resellerSupportEmail !== undefined) data.siteSettings.resellerSupportEmail = String(resellerSupportEmail || '').trim();
    await writeJsonBinRaw(data);
    res.json({
      success: true,
      settings: {
        emailFromAddress: data.siteSettings.emailFromAddress || DEFAULT_FROM_ADDRESS,
        emailReplyTo: data.siteSettings.emailReplyTo || DEFAULT_REPLY_TO,
        emailFromName: data.siteSettings.emailFromName || 'RashadTech',
        retailSupportEmail: data.siteSettings.retailSupportEmail || '',
        resellerSupportEmail: data.siteSettings.resellerSupportEmail || '',
        hasResendKey: Boolean(data.siteSettings.resendApiKey || process.env.RESEND_API_KEY)
      },
      ...getEmailDeliverabilityStatus({ setupHint: MARKETING_EMAIL_SETUP_HINT }, data)
    });
  } catch (e) {
    console.error('Email settings save error:', e.message);
    res.status(500).json({ error: e.message || 'Could not save email settings' });
  }
});

app.post('/admin/test-email', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const to = normalizeEmail(req.body && req.body.to);
  if (!to) return res.status(400).json({ error: 'Recipient email required' });
  try {
    const data = await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
    if (!isServerEmailConfigured(data)) {
      return res.status(400).json({
        error: 'Email is not configured. Add your Resend API key in Admin → Dashboard first.',
        needsEmailSetup: true
      });
    }
    const marketingTemplateId = resolveMarketingTemplateId(data) || EMAILJS_MARKETING_TEMPLATE_ID;
    const result = await deliverTestEmail({
      email: to,
      name: 'Admin',
      data,
      emailJs: {
        serviceId: EMAILJS_SERVICE_ID,
        otpTemplateId: EMAILJS_TEMPLATE_ID,
        marketingTemplateId,
        publicKey: EMAILJS_PUBLIC_KEY,
        privateKey: EMAILJS_PRIVATE_KEY
      }
    });
    res.json({
      success: true,
      provider: result.provider,
      to,
      message: `Test email sent via ${result.provider}. Check inbox and spam folder.`
    });
  } catch (e) {
    console.error('Test email error:', e.message);
    res.status(500).json({ error: e.message || 'Could not send test email' });
  }
});

app.get('/admin/resend-domain-status', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  try {
    const data = await readJsonBinRaw({ fast: true, skipRecoverWrite: true });
    const domainStatus = await fetchResendDomainStatus(data);
    res.json({ success: true, ...domainStatus });
  } catch (e) {
    console.error('Resend domain status error:', e.message);
    res.status(500).json({ error: e.message || 'Could not check Resend domain' });
  }
});

app.post('/admin/profile-reminders', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { dryRun } = req.body || {};
  const subject = 'Complete your RashadTech profile';
  const message = [
    'Hello,',
    '',
    'Please sign in to rashadtech.tv and open Profile to add:',
    '• Your phone number',
    '• Your Telegram Chat ID (from @userinfobot)',
    '',
    'This helps us deliver subscriptions and support you faster.',
    '',
    'Thank you,',
    'RashadTech Team'
  ].join('\n');
  try {
    const data = await readJsonBinRaw({ fast: true });
    const targets = (data.users || []).filter(u => u.email && (!normalizePhone(u.phone) || !normalizeTgChatId(u.tgChatId)));
    if (dryRun) {
      return res.json({ success: true, dryRun: true, count: targets.length });
    }
    let marketingTemplateId;
    try {
      marketingTemplateId = getActiveEmailProvider(data) === 'resend'
        ? (resolveMarketingTemplateId(data) || EMAILJS_MARKETING_TEMPLATE_ID || 'resend')
        : requireMarketingTemplateId(data);
    } catch (e) {
      return res.status(400).json({ error: e.message, needsMarketingTemplate: true });
    }
    if (!isServerEmailConfigured(data)) {
      return res.json({
        success: true,
        clientEmailRequired: true,
        subject,
        message,
        marketingTemplateId,
        usesDedicatedMarketingTemplate: true,
        total: targets.length,
        targets: targets.map(u => ({ email: u.email, name: u.name || '' }))
      });
    }
    let sent = 0;
    const errors = [];
    for (const user of targets) {
      try {
        await sendUserEmail(user.email, subject, message, user.name, data);
        sent += 1;
        await sleep(350);
      } catch (e) {
        errors.push({ email: user.email, error: e.message });
      }
    }
    res.json({ success: true, sent, total: targets.length, errors });
  } catch (e) {
    console.error('Profile reminders error:', e.message);
    res.status(500).json({ error: e.message || 'Could not send reminders' });
  }
});

app.post('/admin/broadcast-email', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { subject, message, dryRun } = req.body || {};
  const cleanSubject = String(subject || '').trim();
  const cleanMessage = String(message || '').trim();
  if (!cleanSubject || cleanMessage.length < 10) {
    return res.status(400).json({ error: 'Subject and message (min 10 chars) are required' });
  }
  if (cleanMessage.length > 8000) {
    return res.status(400).json({ error: 'Message is too long' });
  }
  try {
    const data = await readJsonBinRaw({ fast: true });
    const targets = (data.users || []).filter(u => u.email);
    if (dryRun) {
      return res.json({ success: true, dryRun: true, count: targets.length });
    }
    let marketingTemplateId;
    try {
      marketingTemplateId = getActiveEmailProvider(data) === 'resend'
        ? (resolveMarketingTemplateId(data) || EMAILJS_MARKETING_TEMPLATE_ID || 'resend')
        : requireMarketingTemplateId(data);
    } catch (e) {
      return res.status(400).json({ error: e.message, needsMarketingTemplate: true });
    }
    if (!isServerEmailConfigured(data)) {
      return res.json({
        success: true,
        clientEmailRequired: true,
        subject: cleanSubject,
        message: cleanMessage,
        marketingTemplateId,
        usesDedicatedMarketingTemplate: true,
        total: targets.length,
        targets: targets.map(u => ({ email: u.email, name: u.name || '' }))
      });
    }
    let sent = 0;
    const errors = [];
    for (const user of targets) {
      try {
        await sendUserEmail(user.email, cleanSubject, cleanMessage, user.name, data);
        sent += 1;
        await sleep(350);
      } catch (e) {
        errors.push({ email: user.email, error: e.message });
      }
    }
    res.json({ success: true, sent, total: targets.length, errors });
  } catch (e) {
    console.error('Broadcast email error:', e.message);
    res.status(500).json({ error: e.message || 'Could not send broadcast' });
  }
});

app.post('/chat/escalate', async (req, res) => {
  const { message, lang, page, customerEmail, customerName, website, audience } = req.body || {};
  if (website) return res.json({ success: true });
  const session = getSession(req);
  const text = String(message || '').trim();
  if (!text || text.length < 3) return res.status(400).json({ error: 'Message required' });
  if (text.length > 2000) return res.status(400).json({ error: 'Message too long' });
  const emailFromBody = normalizeEmail(customerEmail);
  const emailFromMessage = String(text).match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] || '';
  const contactEmail = (session && session.email) || emailFromBody || normalizeEmail(emailFromMessage);
  if (!session && !contactEmail) {
    return res.status(400).json({ error: 'Please sign in or include your email so we can reply.' });
  }
  try {
    const data = await readJsonBinRaw({ fast: true });
    const user = session && session.role === 'user'
      ? (data.users || []).find(u => normalizeEmail(u.email) === session.email)
      : null;
    const tier = user
      ? (userIsReseller(user) ? 'reseller' : 'retail')
      : (audience === 'reseller' ? 'reseller' : 'retail');
    const tierEmoji = tier === 'reseller' ? '🏪' : '🛍';
    const who = customerName || (user && user.name) || contactEmail || 'Store visitor';
    const contact = contactEmail ? `\n📧 <code>${contactEmail}</code>` : '';
    const pageHint = page ? `\n🌐 Page: ${String(page).slice(0, 120)}` : '';
    const langHint = lang ? `\n🗣 Lang: ${String(lang).slice(0, 8)}` : '';
    const inbox = resolveSupportInbox(data, tier);
    await deliverSupportEscalationEmail({
      to: inbox,
      subject: `[${tier === 'reseller' ? 'Reseller' : 'Retail'}] Support — ${who}`,
      message: text,
      customerEmail: contactEmail,
      customerName: who,
      tier,
      data
    }).catch(e => console.error('Support email error:', e.message));
    await sendTG(
      TG_ADMIN,
      `${tierEmoji} <b>${tier === 'reseller' ? 'Reseller' : 'Retail'} support request</b>\n👤 ${who}${contact}${pageHint}${langHint}\n📥 Inbox: <code>${inbox}</code>\n\n💬 <i>${text.replace(/</g, '&lt;').slice(0, 1500)}</i>\n\nReply by email or WhatsApp +96179306701`,
      'HTML'
    ).catch(() => {});
    res.json({ success: true, tier, inbox });
  } catch (e) {
    console.error('Chat escalate error:', e.message);
    res.status(500).json({ error: 'Could not notify support' });
  }
});

app.post('/notify', async (req, res) => {
  const session = requireSession(req, res, ['admin', 'user']);
  if (!session) return;
  const { message, chatId, parse_mode } = req.body;
  try {
    if (session.role === 'user' && chatId) {
      const data = await readJsonBinRaw();
      const user = (data.users || []).find(u => normalizeEmail(u.email) === session.email);
      if (!user) return res.status(403).json({ error: 'Cannot send Telegram messages to this chat.' });
      const stored = normalizeTgChatId(user.tgChatId);
      const requested = normalizeTgChatId(chatId);
      if (stored && stored !== requested) return res.status(403).json({ error: 'Cannot send Telegram messages to this chat.' });
      if (!stored && requested) {
        user.tgChatId = requested;
        await writeDbFast(data);
      }
    }
    const target = chatId || TG_ADMIN;
    await sendTG(target, message, parse_mode);
    res.json({ success: true });
  } catch(e) {
    console.error('Notify error:', e.message);
    const desc = e.telegram && e.telegram.description ? e.telegram.description : e.message;
    res.status(500).json({ error: desc || 'Telegram delivery failed' });
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
      const startMsg = text === '/start' || text.startsWith('/start ');
      const welcome = startMsg
        ? `👋 <b>Welcome to rashadtech.tv!</b>\n\nYour Telegram Chat ID is:\n<b>${chatId}</b>\n\n1. Copy this number\n2. Open rashadtech.tv → Profile\n3. Paste it in <b>Telegram Chat ID</b> and tap Save\n\n✅ Purchases and credentials will be delivered here.`
        : `📱 Your Chat ID: <b>${chatId}</b>\n\nAdd it in Profile on rashadtech.tv to receive purchases here.\n\nSend /start for setup help.`;
      await sendTG(chatId, welcome, 'HTML').catch(e => console.error('Customer bot welcome error:', e.message));
      return res.json({ ok: true });
    }
    if (text.startsWith('/code ')) {
      const parts = text.replace('/code ', '').trim().split(/\s+/);
      let service = 'netflix';
      let key = 'default';
      let code = '';
      if (parts.length === 1 && parts[0].match(/^\d{4,8}$/)) {
        code = parts[0];
      } else if (parts.length === 2 && parts[1].match(/^\d{4,8}$/)) {
        key = parts[0].toLowerCase();
        code = parts[1];
      } else if (parts.length === 3 && SIGNIN_CODE_SERVICES.has(parts[0].toLowerCase()) && parts[2].match(/^\d{4,8}$/)) {
        service = parts[0].toLowerCase();
        key = normalizeEmail(parts[1]) || parts[1].toLowerCase();
        code = parts[2];
      } else {
        await sendTG(chatId, '⚠️ Usage:\n/code 1234\n/code alias@gmail.com 1234\n/code osn alias@gmail.com 1234');
        return res.json({ ok: true });
      }
      if (service === 'osn' && !isValidOsnOtp(code)) {
        await sendTG(chatId, '⚠️ OSN+ codes must be exactly 4 digits.');
        return res.json({ ok: true });
      }
      if (key === 'default') {
        latestCodes[key] = { code, timestamp: Date.now(), service };
      } else {
        storeSignInCode([key], code, service);
      }
      delete notifiedCustomers[scopedSignInCodeKey(key, service) || key];
      await sendTG(chatId, `✅ ${service.toUpperCase()} code <b>${code}</b> saved for ${key === 'default' ? 'all' : `<b>${key}</b>`}`, 'HTML');
    } else if (text === '/clear') {
      latestCodes = {}; notifiedCustomers = {}; Object.keys(notifiedCaptureAlerts).forEach((k) => delete notifiedCaptureAlerts[k]);
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
  const id = String(chatId || '').trim();
  if (!id) throw new Error('Missing Telegram chat ID');
  const body = { chat_id: id, text };
  if (parse_mode) body.parse_mode = parse_mode;
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) {
    const err = new Error(j.description || `Telegram error HTTP ${r.status}`);
    err.telegram = j;
    console.error('sendTG failed:', id, j.description || r.status);
    throw err;
  }
  return j;
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
  await enqueueDbWrite(async () => {
    const data = await readDbForWrite();
    data[GMAIL_MONITORS_KEY] = monitoredEmails;
    await writeDbFast(data, { backupReason: 'gmail-monitor-update' });
  });
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

function findOrderForCodeAuth(data, body) {
  const subEmail = normalizeEmail(body.subEmail);
  if (!subEmail && !body.linkToken) return null;
  if (body.linkToken) {
    try {
      const payload = decodeLinkToken(body.linkToken);
      const owner = normalizeEmail(payload.owner);
      const sub = payload.subscription || {};
      const user = (data.users || []).find(u => normalizeEmail(u.email) === owner);
      if (user && sub.id) {
        const found = findUserOrderRecord(user, sub.id);
        if (found.order) return { order: found.order, user };
      }
    } catch (e) {}
  }
  if (!subEmail) return null;
  for (const user of data.users || []) {
    for (const order of user.orders || []) {
      if (normalizeEmail(order.email) === subEmail) return { order, user };
    }
    for (const customer of user.myCustomers || []) {
      for (const order of customer.subs || []) {
        if (normalizeEmail(order.email) === subEmail) return { order, user };
      }
    }
  }
  return null;
}

function subscriptionPassMatches(order, subPass) {
  if (!order || !subPass) return false;
  const expected = String(order.pass || '').trim();
  if (!expected) return false;
  return expected === String(subPass).trim();
}

function authorizeCodeRequest(req, body, data = {}) {
  const session = getSession(req);
  const codeKey = normalizeEmail(body.codeEmail || body.mainEmail);
  const inboxKey = normalizeEmail(body.inboxEmail || body.mainEmail || body.codeEmail);
  const requested = [codeKey, inboxKey].filter(Boolean);
  const subEmail = normalizeEmail(body.subEmail);
  const subPass = String(body.subPass || '').trim();
  const codeType = String(body.codeType || '').toLowerCase();

  if (session) {
    if (session.role === 'admin') return true;
    const sessionEmail = normalizeEmail(session.email);
    if (sessionEmail && (sessionEmail === subEmail || requested.includes(sessionEmail))) return true;
  }

  if (body.linkToken) {
    try {
      const payload = decodeLinkToken(body.linkToken);
      const sub = payload.subscription || {};
      const subEmails = [sub.email, sub.codeEmail, sub.mainEmail, sub.inboxEmail]
        .map(normalizeEmail).filter(Boolean);
      if (requested.some((email) => subEmails.includes(email))) return true;
      if (isDisneyOneUserSubscription(sub) && String(sub.phone || body.subPhone || '').trim()) return true;
      if (isOsnPasswordlessSubscription(sub) && normalizeEmail(sub.email)) return true;
      if (isCanvaNewSubscription(sub) && normalizeEmail(sub.email)) return true;
    } catch (e) {}
  }
  if (subEmail && subPass) {
    const found = findOrderForCodeAuth(data, body);
    if (found && subscriptionPassMatches(found.order, subPass)) {
      const orderEmail = normalizeEmail(found.order.email);
      if (!requested.length || requested.includes(orderEmail) || requested.includes(subEmail)) return true;
    }
  }
  if (subEmail && !subPass && requested.includes(subEmail) && String(body.subPhone || '').trim()) return true;
  if (subEmail && !subPass && requested.includes(subEmail) && codeType === 'canva') return true;
  if (subEmail && !subPass && requested.includes(subEmail) && codeType === 'osn') return true;
  return false;
}

const SIGNIN_CODE_SERVICES = new Set(['netflix', 'disney', 'canva', 'osn']);

function normalizeCodeService(codeType) {
  const service = String(codeType || 'netflix').toLowerCase();
  return SIGNIN_CODE_SERVICES.has(service) ? service : 'netflix';
}

function scopedSignInCodeKey(key, service) {
  const normalized = normalizeEmail(key) || String(key || '').trim().toLowerCase();
  if (!normalized) return '';
  return `${normalized}::${normalizeCodeService(service)}`;
}

function emailReceivedAt(parsedEmail) {
  const raw = parsedEmail && (parsedEmail.date || (parsedEmail.headers && typeof parsedEmail.headers.get === 'function' && parsedEmail.headers.get('date')));
  const ts = raw ? new Date(raw).getTime() : Date.now();
  return Number.isFinite(ts) ? ts : Date.now();
}

function isSignInCodeFresh(timestamp) {
  return Date.now() - Number(timestamp || 0) <= CODE_TTL_MS;
}

function hasActiveCodeWait(recipientKeys, service) {
  const svc = normalizeCodeService(service);
  return (recipientKeys || []).some((key) => {
    const notifyKey = scopedSignInCodeKey(key, svc);
    if (!notifyKey) return false;
    const waitedAt = notifiedCustomers[notifyKey];
    return waitedAt && Date.now() - waitedAt <= CODE_TTL_MS;
  });
}

function emailMatchesTargets(recipientKeys, targets) {
  if (!Array.isArray(targets) || !targets.length) return true;
  const wanted = new Set(targets.map((key) => normalizeEmail(key)).filter(Boolean));
  return (recipientKeys || []).some((key) => wanted.has(normalizeEmail(key)));
}

function filterRecipientKeys(recipientKeys, targets) {
  if (!Array.isArray(targets) || !targets.length) return recipientKeys || [];
  const wanted = new Set(targets.map((key) => normalizeEmail(key)).filter(Boolean));
  return (recipientKeys || []).filter((key) => wanted.has(normalizeEmail(key)));
}

function shouldAlertCodeCapture(scopedKey, code) {
  const alertKey = `${scopedKey}:${code}`;
  const last = notifiedCaptureAlerts[alertKey];
  if (last && Date.now() - last < CODE_TTL_MS) return false;
  notifiedCaptureAlerts[alertKey] = Date.now();
  return true;
}

function maybeNotifyCapturedCode({ service, inboxEmail, recipientKeys, code, customerWaiting }) {
  if (!customerWaiting) return;
  const svc = normalizeCodeService(service);
  const matchedKey = (recipientKeys || []).find((key) => {
    const scoped = scopedSignInCodeKey(key, svc);
    if (!scoped) return false;
    const waitedAt = notifiedCustomers[scoped];
    return waitedAt && Date.now() - waitedAt <= CODE_TTL_MS;
  });
  if (!matchedKey) return;
  const scoped = scopedSignInCodeKey(matchedKey, svc);
  if (!scoped || !shouldAlertCodeCapture(scoped, code)) return;
  const label = svc === 'osn' ? 'OSN+' : svc.charAt(0).toUpperCase() + svc.slice(1);
  sendTG(
    TG_ADMIN,
    `✅ <b>${label} code ready for waiting customer</b>\n📥 Inbox: <code>${inboxEmail}</code>\n📧 Alias: <code>${matchedKey}</code>\n🔢 Code: <b>${code}</b>`,
    'HTML'
  ).catch(() => {});
}

function storeSignInCode(recipientKeys, code, service, profileName, receivedAt, allowedRecipients) {
  const svc = normalizeCodeService(service);
  const normalizedCode = String(code || '').trim();
  if (svc === 'osn' && !isValidOsnOtp(normalizedCode)) {
    console.warn(`Rejected invalid OSN+ code (must be 4 digits): ${normalizedCode}`);
    return false;
  }
  const ts = Number(receivedAt || Date.now());
  if (!isSignInCodeFresh(ts)) return false;
  const keys = filterRecipientKeys(recipientKeys, allowedRecipients);
  if (!keys.length) return false;
  const entry = { code: normalizedCode, timestamp: ts, service: svc };
  let stored = false;
  const writeEntry = (scoped) => {
    if (!scoped) return;
    const prev = latestCodes[scoped];
    if (prev && prev.timestamp >= ts) return;
    if (prev && prev.code === normalizedCode && prev.timestamp === ts) return;
    latestCodes[scoped] = entry;
    stored = true;
  };
  keys.forEach((key) => writeEntry(scopedSignInCodeKey(key, svc)));
  if (svc === 'netflix' && profileName) {
    writeEntry(scopedSignInCodeKey(String(profileName).toLowerCase(), 'netflix'));
  }
  return stored;
}

function lookupSignInCode(lookupKeys, profileName, codeType) {
  const svc = normalizeCodeService(codeType);
  let best = null;
  for (const candidate of lookupKeys || []) {
    const scoped = scopedSignInCodeKey(candidate, svc);
    const entry = scoped ? latestCodes[scoped] : null;
    if (entry && Date.now() - entry.timestamp <= CODE_TTL_MS) {
      if (!best || entry.timestamp > best.timestamp) best = entry;
    }
  }
  if (best) {
    if (svc === 'osn' && !isValidOsnOtp(best.code)) return null;
    return best;
  }
  if (svc === 'netflix' && profileName) {
    const scoped = scopedSignInCodeKey(String(profileName).toLowerCase(), 'netflix');
    const entry = scoped ? latestCodes[scoped] : null;
    if (entry && Date.now() - entry.timestamp <= CODE_TTL_MS) return entry;
    const legacy = latestCodes[String(profileName).toLowerCase()];
    if (legacy && (!legacy.service || legacy.service === 'netflix') && Date.now() - legacy.timestamp <= CODE_TTL_MS) {
      return legacy;
    }
  }
  return null;
}

// ── CODE ENDPOINTS ─────────────────────────────────────────────────────
app.post('/get-code', async (req, res) => {
  try {
    const data = await readJsonBinRaw().catch(() => ({}));
    if (!authorizeCodeRequest(req, req.body || {}, data)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const intent = String(req.body.intent || 'poll').toLowerCase();
    const isRequest = intent === 'request';
    const { profileName } = req.body;
    let meta = { ...req.body };
    if (meta.linkToken) {
      try {
        const payload = decodeLinkToken(meta.linkToken);
        const enriched = enrichSubscriptionFromLiveOrder(data, payload.subscription, payload.owner);
        meta = {
          ...meta,
          email: meta.subEmail || enriched.email || enriched.codeEmail,
          codeEmail: meta.codeEmail || enriched.codeEmail || enriched.email,
          mainEmail: meta.mainEmail || enriched.mainEmail,
          inboxEmail: meta.inboxEmail || enriched.inboxEmail,
          accKey: meta.accKey || enriched.accKey,
          subPhone: meta.subPhone || enriched.phone
        };
      } catch (e) {}
    }
    const { codeKey, inboxKey } = resolveSignInCodeEmails(data, meta);
    const lookupKeys = uniqueNormalizedEmails([codeKey, inboxKey]);
    const codeType = normalizeCodeService(meta.codeType);
    const name = profileName || 'Unknown';
    const notifyKey = scopedSignInCodeKey(codeKey || lookupKeys[0] || name, codeType) || name;
    let shouldNotifyWaiting = false;
    if (isRequest) {
      shouldNotifyWaiting = !notifiedCustomers[notifyKey] || Date.now() - notifiedCustomers[notifyKey] > CODE_TTL_MS;
      notifiedCustomers[notifyKey] = Date.now();
    }
    if (inboxKey) {
      await loadGmailMonitors();
      const fetchOpts = {
        onlyRecipients: lookupKeys,
        onlyService: codeType,
        waitStartedAt: isRequest ? notifiedCustomers[notifyKey] : 0
      };
      if (monitoredEmails[inboxKey]) {
        await fetchMonitoredInboxes(inboxKey, fetchOpts);
      } else if (!isRequest && lookupKeys.some((candidate) => monitoredEmails[candidate])) {
        const monitoredKey = lookupKeys.find((candidate) => monitoredEmails[candidate]);
        if (monitoredKey) await fetchMonitoredInboxes(monitoredKey, fetchOpts);
      }
    }
    const entry = lookupSignInCode(lookupKeys, profileName, codeType);

    if (!entry) {
      if (isRequest && shouldNotifyWaiting) {
        const monitorHint = inboxKey && !monitoredEmails[inboxKey]
          ? `\n⚠️ Gmail monitoring is not configured for inbox <code>${inboxKey}</code>. Add this Gmail in Admin stock with an app password.`
          : '';
        await sendTG(TG_ADMIN, `🔔 <b>${name}</b> is waiting for a ${codeType.toUpperCase()} sign-in code!${codeKey ? `\n📧 Code email: <code>${codeKey}</code>` : ''}${inboxKey && inboxKey !== codeKey ? `\n📥 Gmail inbox: <code>${inboxKey}</code>` : ''}${monitorHint}\nManual fallback: /code ${codeType} ${codeKey || name} 1234`, 'HTML').catch(() => {});
      }
      return res.json({ success: false, message: 'No code found yet — request a new code on the app, then tap Refresh' });
    }
    if (!isSignInCodeFresh(entry.timestamp)) {
      return res.json({ success: false, message: 'Code expired — request a new code on the app, then tap Refresh' });
    }
    if (isRequest) {
      lookupKeys.forEach((key) => delete notifiedCustomers[scopedSignInCodeKey(key, codeType)]);
    }
    res.json({ success: true, code: entry.code, receivedAt: entry.timestamp });
  } catch (e) {
    console.error('Get-code error:', e.message);
    res.status(500).json({ error: 'Could not fetch sign-in code' });
  }
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
function getImapSettings(email) {
  if (!isGmailAddress(email)) return null;
  return { host: 'imap.gmail.com', port: 993, secure: true };
}

function createImapClient(email, password) {
  const settings = getImapSettings(email);
  if (!settings) throw new Error(`IMAP is not supported for ${email}`);
  return new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: email, pass: password },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    logger: false
  });
}

function createGmailClient(email, password) {
  return createImapClient(email, password);
}

function emailPlainBody(parsedEmail) {
  const subject = String(parsedEmail.subject || '').trim();
  const text = String(parsedEmail.text || '').trim();
  if (text.length > 24) return `${subject}\n${text}`;
  const html = String(parsedEmail.html || '');
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return `${subject}\n${stripped || text}`;
}

function extractSixDigitOtp(body, options = {}) {
  const text = String(body || '');
  if (!text) return null;
  const spacedPatterns = [
    /(?:verification|one[- ]?time|sign[- ]?in|login|otp|passcode|security)\s*(?:code|password)?\s*[:#\-]?\s*((?:\d[\s\-]*){6})\b/i,
    /(?:code|password)\s*[:#\-]?\s*((?:\d[\s\-]*){6})\b/i,
    /\b((?:\d[\s\-]*){6})\b\s*(?:is your|is the|verification|one[- ]?time|sign[- ]?in)/i
  ];
  for (const re of spacedPatterns) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const digits = m[1].replace(/\D/g, '');
    if (digits.length === 6 && (!options.validate || options.validate(digits))) {
      return digits;
    }
  }
  const labeled = text.match(/(?:verification|one[- ]?time|sign[- ]?in|login|otp|passcode|security)\s*(?:code|password)?\s*[:#\-]?\s*(\d{6})\b/i);
  if (labeled && labeled[1] && (!options.validate || options.validate(labeled[1]))) return labeled[1];
  const trailing = text.match(/\b(\d{6})\b\s*(?:is your|is the|verification|one[- ]?time|sign[- ]?in)/i);
  if (trailing && trailing[1] && (!options.validate || options.validate(trailing[1]))) return trailing[1];
  const all = [...text.matchAll(/\b(\d{6})\b/g)]
    .map((m) => m[1])
    .filter((digits) => !options.validate || options.validate(digits));
  return all.length ? all[all.length - 1] : null;
}

function extractNetflixCode(parsedEmail) {
  const from = (parsedEmail.from || '').toString().toLowerCase();
  const body = emailPlainBody(parsedEmail);
  const lower = body.toLowerCase();
  if (/osn|osnplus|osntv/i.test(from)) return null;
  if (!from.includes('netflix') && !lower.includes('netflix')) return null;

  const preferred = body.match(/(?:code|verification|sign[\s-]?in|temporary)[^\d]{0,120}(\d{4})\b/i);
  if (preferred) return { code: preferred[1], customerSafe: true };

  const fallback = body.match(/\b(\d{4})\b/g);
  if (fallback && fallback.length) {
    const code = fallback[fallback.length - 1].replace(/\D/g, '');
    if (code.length === 4) return { code, customerSafe: true };
  }
  return null;
}

function extractDisneyCode(parsedEmail) {
  const from = (parsedEmail.from || '').toString().toLowerCase();
  const body = emailPlainBody(parsedEmail);
  const lower = body.toLowerCase();
  if (!/disney|disneyplus|disneyaccount/i.test(from) && !/disney|disney\+|one[\s-]?time passcode|passcode/i.test(lower)) {
    return null;
  }

  const code = extractSixDigitOtp(body);
  return code ? { code, customerSafe: true } : null;
}

function extractCanvaCode(parsedEmail) {
  const from = (parsedEmail.from || '').toString().toLowerCase();
  const body = emailPlainBody(parsedEmail);
  const lower = body.toLowerCase();
  if (!/canva/i.test(from) && !/canva|verification code|sign[\s-]?in|one[\s-]?time/i.test(lower)) {
    return null;
  }

  const code = extractSixDigitOtp(body);
  if (code) return { code, customerSafe: true };
  const four = body.match(/(?:code|verification)[^\d]{0,80}(\d{4})\b/i);
  return four ? { code: four[1], customerSafe: true } : null;
}

function extractShahidResetLink(parsedEmail) {
  const subject = parsedEmail.subject || '';
  const text = parsedEmail.text || '';
  const html = parsedEmail.html || '';
  const from = (parsedEmail.from || '').toString().toLowerCase();
  const combined = `${subject}\n${text}\n${html}`;
  const lower = combined.toLowerCase();
  if (!from.includes('shahid') && !from.includes('mbc') && !lower.includes('shahid')) return null;
  if (!/reset|password|forgot|كلمة|مرور|تعيين|إعادة/i.test(combined)) return null;

  const urls = combined.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  const shahidUrls = urls
    .map(url => url.replace(/&amp;/g, '&').replace(/[),.]+$/g, ''))
    .filter(url => /shahid|mbc\.net/i.test(url));
  if (!shahidUrls.length) return null;

  const preferred = shahidUrls.find(url => /reset|password|token|verify|confirm|hub\/forget/i.test(url));
  return { link: preferred || shahidUrls[0] };
}

async function fetchShahidResetLinkForOrder(data, order) {
  const { inboxEmail, accountEmail } = resolveShahidInboxEmail(data, order);
  const cacheKey = accountEmail || inboxEmail;
  const cached = latestShahidResetLinks[cacheKey];
  if (cached && Date.now() - cached.timestamp < SHAHID_RESET_TTL_MS) {
    return { success: true, link: cached.link };
  }

  if (!inboxEmail || !isGmailAddress(inboxEmail)) {
    return {
      success: false,
      message: 'Gmail inbox is not configured for this Shahid account. Please contact support on WhatsApp or Telegram.'
    };
  }

  await loadGmailMonitors();
  if (!monitoredEmails[inboxEmail]) {
    return {
      success: false,
      message: 'Gmail monitoring is not set up for this account yet. Please contact support — we will configure the Gmail inbox.'
    };
  }

  await fetchMonitoredInboxes(inboxEmail);
  const refreshed = latestShahidResetLinks[cacheKey];
  if (refreshed && Date.now() - refreshed.timestamp < SHAHID_RESET_TTL_MS) {
    return { success: true, link: refreshed.link };
  }

  if (!notifiedShahidReset[cacheKey] || Date.now() - notifiedShahidReset[cacheKey] > 5 * 60 * 1000) {
    notifiedShahidReset[cacheKey] = Date.now();
    const monitorHint = monitoredEmails[inboxEmail]
      ? ''
      : `\n⚠️ Add Gmail <code>${inboxEmail}</code> in Admin stock with a 16-character app password.`;
    await sendTG(
      TG_ADMIN,
      `🔔 <b>Shahid reset link requested</b>\n📧 Shahid email: <code>${order.email}</code>\n📥 Gmail inbox: <code>${inboxEmail}</code>${monitorHint}\n⚠️ No reset email found yet. Customer should request reset on Shahid first.`,
      'HTML'
    ).catch(() => {});
  }
  return {
    success: false,
    message: 'No reset link found yet. Request password reset on Shahid first, wait 1–2 minutes, then tap GET RESET LINK again.'
  };
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

async function fetchMonitoredInboxes(targetEmail, options = {}) {
  await loadGmailMonitors();
  const targetKey = targetEmail ? normalizeEmail(targetEmail) : null;
  const entries = targetKey
    ? (monitoredEmails[targetKey] ? [[targetKey, monitoredEmails[targetKey]]] : [])
    : Object.entries(monitoredEmails);
  const rescanMs = Number(options.rescanMinutes || 0) > 0 ? Number(options.rescanMinutes) * 60 * 1000 : 0;
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
        const since = new Date(Date.now() - (rescanMs || EMAIL_LOOKBACK_MS));
        const seenUid = rescanMs ? 0 : Number(creds.lastUid || 0);
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

      for (const e of emails) {
        const receivedAt = emailReceivedAt(e);
        if (!isSignInCodeFresh(receivedAt)) continue;
        if (options.waitStartedAt && receivedAt < Number(options.waitStartedAt) - 120000) continue;
        const recipientKeys = collectEmailRecipients(e, email);
        if (!emailMatchesTargets(recipientKeys, options.onlyRecipients)) continue;
        const allowedRecipients = options.onlyRecipients || recipientKeys;
        const onlyService = options.onlyService ? normalizeCodeService(options.onlyService) : null;
        const runOsn = !onlyService || onlyService === 'osn';
        const runNetflix = !onlyService || onlyService === 'netflix';
        const runDisney = !onlyService || onlyService === 'disney';
        const runCanva = !onlyService || onlyService === 'canva';
        const osnResult = runOsn ? extractOsnCodeFromEmail(e, emailPlainBody) : null;
        const netflixResult = runNetflix ? extractNetflixCode(e) : null;
        const disneyResult = runDisney ? extractDisneyCode(e) : null;
        const canvaResult = runCanva ? extractCanvaCode(e) : null;
        if (osnResult && osnResult.customerSafe) {
          const customerWaiting = hasActiveCodeWait(recipientKeys, 'osn');
          if (storeSignInCode(recipientKeys, osnResult.code, 'osn', null, receivedAt, allowedRecipients)) {
            console.log(`📧 OSN+ sign-in code ${osnResult.code} captured for ${email} recipients: ${recipientKeys.join(', ')}`);
            maybeNotifyCapturedCode({ service: 'osn', inboxEmail: email, recipientKeys: allowedRecipients, code: osnResult.code, customerWaiting });
            allowedRecipients.forEach((key) => delete notifiedCustomers[scopedSignInCodeKey(key, 'osn')]);
          }
        } else if (netflixResult && netflixResult.customerSafe) {
          const customerWaiting = hasActiveCodeWait(recipientKeys, 'netflix');
          if (storeSignInCode(recipientKeys, netflixResult.code, 'netflix', null, receivedAt, allowedRecipients)) {
            console.log(`📧 Netflix sign-in code ${netflixResult.code} captured for ${email} recipients: ${recipientKeys.join(', ')}`);
            maybeNotifyCapturedCode({ service: 'netflix', inboxEmail: email, recipientKeys: allowedRecipients, code: netflixResult.code, customerWaiting });
            allowedRecipients.forEach((key) => delete notifiedCustomers[scopedSignInCodeKey(key, 'netflix')]);
          }
        } else if (netflixResult && !netflixResult.customerSafe) {
          console.log(`🔐 Admin-only Netflix security code ${netflixResult.code} captured for ${email} recipients: ${recipientKeys.join(', ')}`);
        } else if (disneyResult && disneyResult.customerSafe) {
          const customerWaiting = hasActiveCodeWait(recipientKeys, 'disney');
          if (storeSignInCode(recipientKeys, disneyResult.code, 'disney', null, receivedAt, allowedRecipients)) {
            console.log(`📧 Disney+ sign-in code ${disneyResult.code} captured for ${email} recipients: ${recipientKeys.join(', ')}`);
            maybeNotifyCapturedCode({ service: 'disney', inboxEmail: email, recipientKeys: allowedRecipients, code: disneyResult.code, customerWaiting });
            allowedRecipients.forEach((key) => delete notifiedCustomers[scopedSignInCodeKey(key, 'disney')]);
          }
        } else if (canvaResult && canvaResult.customerSafe) {
          const customerWaiting = hasActiveCodeWait(recipientKeys, 'canva');
          if (storeSignInCode(recipientKeys, canvaResult.code, 'canva', null, receivedAt, allowedRecipients)) {
            console.log(`📧 Canva sign-in code ${canvaResult.code} captured for ${email} recipients: ${recipientKeys.join(', ')}`);
            maybeNotifyCapturedCode({ service: 'canva', inboxEmail: email, recipientKeys: allowedRecipients, code: canvaResult.code, customerWaiting });
            allowedRecipients.forEach((key) => delete notifiedCustomers[scopedSignInCodeKey(key, 'canva')]);
          }
        }
        if (!onlyService || onlyService === 'shahid') {
          const shahidResult = extractShahidResetLink(e);
          if (shahidResult && shahidResult.link && emailMatchesTargets(recipientKeys, options.onlyRecipients)) {
            const shahidWaiting = filterRecipientKeys(recipientKeys, allowedRecipients).some((key) => notifiedShahidReset[key] && Date.now() - notifiedShahidReset[key] <= SHAHID_RESET_TTL_MS);
            filterRecipientKeys(recipientKeys, allowedRecipients).forEach((key) => {
              latestShahidResetLinks[key] = { link: shahidResult.link, timestamp: receivedAt };
              delete notifiedShahidReset[key];
            });
            console.log(`📧 Shahid reset link captured for ${email} recipients: ${recipientKeys.join(', ')}`);
            if (shahidWaiting) {
              sendTG(TG_ADMIN, `✅ <b>Shahid reset link ready for waiting customer</b>\n📥 Inbox: <code>${email}</code>`, 'HTML').catch(() => {});
            }
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

setInterval(() => fetchMonitoredInboxes(null, { silent: true }), 30000); // Poll every 30 seconds (no Telegram spam)
setInterval(() => {
  syncDbToJsonBin(false).catch(e => console.error('Periodic JSONBin sync error:', e.message));
}, Math.min(JSONBIN_SYNC_INTERVAL_MS, 60 * 1000));

app.post('/setup-gmail', async (req, res) => {
  const session = requireSession(req, res, ['admin']);
  if (!session) return;
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const key = normalizeEmail(email);
  if (!isGmailAddress(key)) {
    return res.status(400).json({
      success: false,
      error: 'Only Gmail addresses are supported. Use the Gmail inbox that receives Netflix codes or Shahid reset emails.'
    });
  }
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
    await sendTG(TG_ADMIN, `📧 Added Gmail monitoring: <code>${key}</code>\nWill capture Netflix, Disney+, Canva, OSN+ sign-in codes and Shahid reset links automatically.`, 'HTML').catch(() => {});
    res.json({ success: true, message: 'Gmail added for Netflix/Disney+ codes and Shahid reset links', gmailConfigured: true, email: key });
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

registerSmsRoutes(app, {
  requireSession,
  readJsonBinRaw,
  writeJsonBinRaw,
  getDbCache: () => dbCache,
  normalizeEmail,
  sanitizeUser,
  safeDataForSession,
  sendTG,
  TG_ADMIN,
  orderIdsMatch
});

let rtEnhancements = null;
rtEnhancements = registerEnhancements(app, {
  requireSession,
  getSession,
  readJsonBinRaw,
  writeJsonBinRaw,
  writeDbFast,
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
  countStockStats,
  sessions,
  SESSION_TTL_MS,
  findUserOrderRecord,
  notifyPurchaseFulfilled,
  pickAvailableAccount,
  enqueueDbWrite,
  slimMutationData,
  readDbForWrite
});

const whatsappBot = registerWhatsAppBot(app, {
  getEnv: (k) => process.env[k],
  rateLimit,
});

function startServerKeepAlive() {
  const base = String(process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const ping = () => fetch(`${base}/ping`, { cache: 'no-store' }).catch(() => {});
  ping();
  setInterval(ping, 10 * 60 * 1000);
}

// ── START ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('rashadtech server running on port ' + PORT);
  startServerKeepAlive();
  setImmediate(async () => {
    try {
      if (rtEnhancements && rtEnhancements.loadPersistedSessions) await rtEnhancements.loadPersistedSessions();
      await loadGmailMonitors();
      syncDbToJsonBin(false).catch(e => console.error('Initial JSONBin sync error:', e.message));
      if (process.env.RENDER_EXTERNAL_URL && TG_TOKEN) {
        const webhookUrl = process.env.RENDER_EXTERNAL_URL + '/telegram';
        const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: webhookUrl })
        });
        const j = await r.json();
        console.log('Webhook:', j.description);
      }
      if (whatsappBot.enabled()) {
        console.log('WhatsApp bot: enabled — webhook', (process.env.RENDER_EXTERNAL_URL || '') + '/whatsapp');
      } else {
        console.log('WhatsApp bot: disabled — set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN on Render');
      }
    } catch (e) {
      console.error('Deferred startup error:', e.message);
    }
  });
});
