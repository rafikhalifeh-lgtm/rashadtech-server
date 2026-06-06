const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const ALLOWED_ORIGINS = new Set([
  'https://rashadtech.tv',
  'https://www.rashadtech.tv',
  'https://rashadtechtv.netlify.app'
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

const API_SECRET = process.env.API_SECRET;
const TG_TOKEN   = process.env.TG_TOKEN;
const TG_ADMIN   = process.env.TG_ADMIN;
const JB_KEY     = process.env.JB_KEY;
const JB_BIN     = process.env.JB_BIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'RkhRkh7979@';
const ADMIN_PIN = process.env.ADMIN_PIN || '7979';
const GMAIL_MONITORS_KEY = 'gmailMonitors';
const BACKUPS_KEY = 'backups';
const LINK_TOKENS_KEY = 'linkTokens';
const CODE_TTL_MS = 15 * 60 * 1000;
const EMAIL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PASSWORD_HASH_PREFIX = 'pbkdf2$';

if (!API_SECRET || !TG_TOKEN || !TG_ADMIN) {
  console.error('❌ Missing required env vars: API_SECRET, TG_TOKEN, TG_ADMIN');
}

let latestCodes = {};
let notifiedCustomers = {};
let monitoredEmails = {}; // { gmailEmail: { user, pass, lastUid, lastCheckedAt } }
let gmailMonitorsLoaded = false;
let sessions = new Map();
let rateBuckets = new Map();

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
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function createSession(role, email) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { role, email: normalizeEmail(email), expiresAt: Date.now() + SESSION_TTL_MS });
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

async function readJsonBinRaw() {
  if (!JB_KEY || !JB_BIN) throw new Error('DB not configured');
  const url = `https://api.jsonbin.io/v3/b/${JB_BIN}/latest`;
  const headerModes = [
    { 'X-Master-Key': JB_KEY, 'X-Bin-Meta': 'false' },
    { 'X-Access-Key': JB_KEY, 'X-Bin-Meta': 'false' }
  ];
  let lastStatus = 0;
  for (const headers of headerModes) {
    const r = await fetch(url, { headers });
    lastStatus = r.status;
    if (r.ok) return await r.json();
    if (r.status !== 401 && r.status !== 403) break;
  }
  throw new Error('JSONBin read failed: ' + lastStatus);
}

async function writeJsonBinRaw(data) {
  if (!JB_KEY || !JB_BIN) throw new Error('DB not configured');
  const nextData = { ...(data || {}) };
  const backupSource = { ...nextData };
  delete backupSource[BACKUPS_KEY];
  delete backupSource[GMAIL_MONITORS_KEY];
  nextData[BACKUPS_KEY] = [
    { ts: Date.now(), data: backupSource },
    ...((nextData[BACKUPS_KEY] || []).slice(0, 9))
  ];
  const url = `https://api.jsonbin.io/v3/b/${JB_BIN}`;
  const headerModes = [
    { 'Content-Type': 'application/json', 'X-Master-Key': JB_KEY, 'X-Bin-Meta': 'false' },
    { 'Content-Type': 'application/json', 'X-Access-Key': JB_KEY, 'X-Bin-Meta': 'false' }
  ];
  let lastStatus = 0;
  for (const headers of headerModes) {
    const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(nextData) });
    lastStatus = r.status;
    if (r.ok) return await r.json();
    if (r.status !== 401 && r.status !== 403) break;
  }
  throw new Error('JSONBin write failed: ' + lastStatus);
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
    pending: [],
    gameorders: []
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
        orders: Array.isArray(incomingUser.orders) ? incomingUser.orders : users[idx].orders,
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

// ── HEALTH ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'rashadtech server running', codes: Object.keys(latestCodes) });
});
app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.use('/auth', rateLimit('auth', 40, 15 * 60 * 1000));
app.use('/get-code', rateLimit('get-code', 30, 5 * 60 * 1000));
app.use('/notify', rateLimit('notify', 60, 5 * 60 * 1000));
app.use('/links', rateLimit('links', 80, 5 * 60 * 1000));

// ── JSONBIN PROXY ──────────────────────────────────────────────────────
app.post('/db/read', async (req, res) => {
  const session = requireSession(req, res, ['admin', 'user']);
  if (!session) return;
  if (!JB_KEY || !JB_BIN) return res.status(500).json({ error: 'DB not configured' });
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
  if (!JB_KEY || !JB_BIN) return res.status(500).json({ error: 'DB not configured' });
  try {
    const existing = await readJsonBinRaw().catch(() => ({}));
    let nextData;
    if (session.role === 'admin') {
      nextData = preserveSensitiveFields(existing, data || {});
    } else {
      nextData = mergeUserWrite(existing, data || {}, session);
    }
    const result = await writeJsonBinRaw(nextData);
    res.json({ success: true, result });
  } catch(e) {
    console.error('DB write error:', e.message);
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: 'Login failed' });
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

app.post('/auth/signup', async (req, res) => {
  const { name, email, password, tgChatId } = req.body;
  const cleanEmail = normalizeEmail(email);
  if (!name || !cleanEmail || !password || password.length < 6) return res.status(400).json({ error: 'Invalid signup data' });
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
    res.status(500).json({ error: 'Signup failed' });
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
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.post('/auth/reset-password', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) return res.status(400).json({ error: 'Invalid password' });
  try {
    const data = await readJsonBinRaw();
    const user = (data.users || []).find(u => normalizeEmail(u.email) === normalizeEmail(email));
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.pass = hashPassword(password);
    await writeJsonBinRaw(data);
    res.json({ success: true });
  } catch(e) {
    console.error('Reset password error:', e.message);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

app.post('/auth/logout', (req, res) => {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) sessions.delete(match[1]);
  res.json({ success: true });
});

app.post('/auth/logout-all', (req, res) => {
  const session = requireSession(req, res, ['admin', 'user']);
  if (!session) return;
  for (const [token, item] of sessions.entries()) {
    if (session.role === 'admin' || (item.role === 'user' && item.email === session.email)) sessions.delete(token);
  }
  res.json({ success: true });
});

app.post('/links/create', async (req, res) => {
  const session = requireSession(req, res, ['admin', 'user']);
  if (!session) return;
  const { subscription } = req.body;
  if (!subscription || !subscription.email || !subscription.pass) return res.status(400).json({ error: 'Invalid subscription link data' });
  try {
    const data = await readJsonBinRaw();
    data[LINK_TOKENS_KEY] = data[LINK_TOKENS_KEY] || {};
    const token = crypto.randomBytes(24).toString('hex');
    data[LINK_TOKENS_KEY][token] = {
      subscription,
      owner: session.email,
      createdAt: Date.now(),
      expiresAt: Date.now() + LINK_TTL_MS
    };
    await writeJsonBinRaw(data);
    res.json({ success: true, token, url: `https://rashadtech.tv?t=${token}` });
  } catch(e) {
    console.error('Create link error:', e.message);
    res.status(500).json({ error: 'Could not create subscription link' });
  }
});

app.get('/links/:token', async (req, res) => {
  try {
    const data = await readJsonBinRaw();
    const entry = data[LINK_TOKENS_KEY] && data[LINK_TOKENS_KEY][req.params.token];
    if (!entry || Date.now() > Number(entry.expiresAt || 0)) return res.status(404).json({ error: 'Subscription link not found or expired' });
    res.json({ success: true, subscription: entry.subscription });
  } catch(e) {
    console.error('Read link error:', e.message);
    res.status(500).json({ error: 'Could not load subscription link' });
  }
});

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
    user.balance = Number(user.balance || 0) - Number(price);
    user.transactions = Array.isArray(user.transactions) ? user.transactions : [];

    if (!acc) {
      const pendingOrder = {
        id:'#'+(Math.floor(Math.random()*90000+10000)),
        userEmail:user.email,userName:user.name,userTgChatId:user.tgChatId||'',
        product:product.name,short:product.short,color:product.color,tc:product.tc,
        productId:product.id,plan:planLabel,price:Number(price),skey,date:dateStr,
        ...(extraFields||{})
      };
      data.pending.unshift(pendingOrder);
      user.transactions.unshift({type:'purchase',label:'Bought '+product.name+' · '+planLabel,amount:Number(price),balance:user.balance,date:dateStr});
      await writeJsonBinRaw(data);
      return res.json({ success:true, pending:true, user:sanitizeUser(user), order:pendingOrder, data:safeDataForSession(data, session) });
    }

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
        customer.subs.push(order);
      } else {
        user.orders = Array.isArray(user.orders) ? user.orders : [];
        user.orders.unshift(order);
      }
    } else {
      user.orders = Array.isArray(user.orders) ? user.orders : [];
      user.orders.unshift(order);
      user.transactions.unshift({type:'purchase',label:'Bought '+product.name+' · '+planLabel,amount:Number(price),balance:user.balance,date:dateStr});
    }
    await writeJsonBinRaw(data);
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

// ── TELEGRAM PROXY (NEW — keeps TG_TOKEN off the frontend) ─────────────
app.post('/notify', async (req, res) => {
  const session = requireSession(req, res, ['admin', 'user']);
  if (!session) return;
  const { message, chatId, parse_mode } = req.body;
  try {
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
  if (!JB_KEY || !JB_BIN) {
    gmailMonitorsLoaded = true;
    return monitoredEmails;
  }
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
  if (!JB_KEY || !JB_BIN) return;
  const data = await readJsonBinRaw();
  data[GMAIL_MONITORS_KEY] = monitoredEmails;
  await writeJsonBinRaw(data);
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
      lastUid: creds.lastUid || 0,
      lastCheckedAt: creds.lastCheckedAt || null
    }))
  });
});

// ── START ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('rashadtech server running on port ' + PORT);
  await loadGmailMonitors();
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
