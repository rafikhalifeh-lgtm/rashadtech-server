const express = require('express');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_SECRET = process.env.API_SECRET;
const TG_TOKEN   = process.env.TG_TOKEN;
const TG_ADMIN   = process.env.TG_ADMIN;
const JB_KEY     = process.env.JB_KEY;
const JB_BIN     = process.env.JB_BIN;
const GMAIL_MONITORS_KEY = 'gmailMonitors';
const CODE_TTL_MS = 15 * 60 * 1000;
const EMAIL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

if (!API_SECRET || !TG_TOKEN || !TG_ADMIN) {
  console.error('❌ Missing required env vars: API_SECRET, TG_TOKEN, TG_ADMIN');
}

let latestCodes = {};
let notifiedCustomers = {};
let monitoredEmails = {}; // { gmailEmail: { user, pass, lastUid, lastCheckedAt } }
let gmailMonitorsLoaded = false;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeGmailPassword(password) {
  // Google displays app passwords in groups; IMAP auth expects the raw 16 chars.
  return String(password || '').replace(/\s+/g, '');
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
  const r = await fetch(`https://api.jsonbin.io/v3/b/${JB_BIN}/latest`, {
    headers: { 'X-Master-Key': JB_KEY, 'X-Bin-Meta': 'false' }
  });
  if (!r.ok) throw new Error('JSONBin read failed: ' + r.status);
  return await r.json();
}

async function writeJsonBinRaw(data) {
  if (!JB_KEY || !JB_BIN) throw new Error('DB not configured');
  const r = await fetch(`https://api.jsonbin.io/v3/b/${JB_BIN}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JB_KEY, 'X-Bin-Meta': 'false' },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error('JSONBin write failed: ' + r.status);
  return await r.json();
}

function stripPrivateData(data) {
  const publicData = { ...(data || {}) };
  delete publicData[GMAIL_MONITORS_KEY];
  return publicData;
}

// ── HEALTH ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'rashadtech server running', codes: Object.keys(latestCodes) });
});
app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ── JSONBIN PROXY ──────────────────────────────────────────────────────
app.post('/db/read', async (req, res) => {
  const { secret } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!JB_KEY || !JB_BIN) return res.status(500).json({ error: 'DB not configured' });
  try {
    const data = await readJsonBinRaw();
    res.json({ success: true, data: stripPrivateData(data) });
  } catch(e) {
    console.error('DB read error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/db/write', async (req, res) => {
  const { secret, data } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!JB_KEY || !JB_BIN) return res.status(500).json({ error: 'DB not configured' });
  try {
    const existing = await readJsonBinRaw().catch(() => ({}));
    const nextData = { ...(data || {}) };
    if (existing && existing[GMAIL_MONITORS_KEY]) {
      nextData[GMAIL_MONITORS_KEY] = existing[GMAIL_MONITORS_KEY];
    }
    const result = await writeJsonBinRaw(nextData);
    res.json({ success: true, result });
  } catch(e) {
    console.error('DB write error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TELEGRAM PROXY (NEW — keeps TG_TOKEN off the frontend) ─────────────
app.post('/notify', async (req, res) => {
  const { secret, message, chatId, parse_mode } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
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
  const { secret, profileName, mainEmail } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  
  // Priority: mainEmail > profileName > default
  const key = mainEmail ? normalizeEmail(mainEmail) : (profileName ? profileName.toLowerCase() : 'default');
  if (mainEmail) {
    await loadGmailMonitors();
    if (monitoredEmails[key]) {
      await fetchNetflixCodes(key);
    }
  }
  const entry = latestCodes[key] || (mainEmail ? null : latestCodes['default']);
  
  if (!entry) {
    const name = profileName || 'Unknown';
    if (!notifiedCustomers[key] || Date.now() - notifiedCustomers[key] > 5*60*1000) {
      notifiedCustomers[key] = Date.now();
      const monitorHint = mainEmail && !monitoredEmails[key]
        ? `\n⚠️ Gmail monitoring is not configured for <code>${key}</code>. Add this Gmail in Admin stock with an app password.`
        : '';
      await sendTG(TG_ADMIN, `🔔 <b>${name}</b> is waiting for a sign-in code!${mainEmail ? `\n📧 Main email: <code>${key}</code>` : ''}${monitorHint}\nManual fallback: /code ${mainEmail ? key : name} 1234`, 'HTML').catch(() => {});
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
          const key = normalizeEmail(email);
          if (result.customerSafe) {
            latestCodes[key] = { code: result.code, timestamp: Date.now() };
            delete notifiedCustomers[key];
            console.log(`📧 Netflix sign-in code ${result.code} captured for ${email}`);
            await sendTG(TG_ADMIN, `✅ <b>Netflix Sign-in Code Captured</b>\n📧 Email: ${email}\n🔢 Code: <b>${result.code}</b>`, 'HTML').catch(() => {});
          } else {
            console.log(`🔐 Admin-only Netflix security code ${result.code} captured for ${email}`);
            await sendTG(TG_ADMIN, `🔐 <b>Netflix Security Code Captured — ADMIN ONLY</b>\n📧 Email: ${email}\n🔢 Code: <b>${result.code}</b>\n\nNot shown on customer subscription links.`, 'HTML').catch(() => {});
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
  const { secret, email, password } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
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
    const lastUid = await getInboxMaxUid(key, appPassword);
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
  const secret = req.query.secret;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
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
