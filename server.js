const express = require('express');
const cors = require('cors');
const Imap = require('imap').Imap;
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

if (!API_SECRET || !TG_TOKEN || !TG_ADMIN) {
  console.error('❌ Missing required env vars: API_SECRET, TG_TOKEN, TG_ADMIN');
}

let latestCodes = {};
let notifiedCustomers = {};

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
    const r = await fetch(`https://api.jsonbin.io/v3/b/${JB_BIN}/latest`, {
      headers: { 'X-Master-Key': JB_KEY, 'X-Bin-Meta': 'false' }
    });
    if (!r.ok) throw new Error('JSONBin read failed: ' + r.status);
    const data = await r.json();
    res.json({ success: true, data });
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
    const r = await fetch(`https://api.jsonbin.io/v3/b/${JB_BIN}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JB_KEY, 'X-Bin-Meta': 'false' },
      body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error('JSONBin write failed: ' + r.status);
    const result = await r.json();
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

// ── CODE ENDPOINTS ─────────────────────────────────────────────────────
app.post('/get-code', async (req, res) => {
  const { secret, profileName, mainEmail } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  
  // Priority: mainEmail > profileName > default
  const key = mainEmail ? mainEmail.toLowerCase() : (profileName ? profileName.toLowerCase() : 'default');
  const entry = latestCodes[key] || (mainEmail ? null : latestCodes['default']);
  
  if (!entry) {
    const name = profileName || 'Unknown';
    if (!notifiedCustomers[key] || Date.now() - notifiedCustomers[key] > 5*60*1000) {
      notifiedCustomers[key] = Date.now();
      await sendTG(TG_ADMIN, `🔔 <b>${name}</b> is waiting for a sign-in code!\nSend: /code ${name} 1234`, 'HTML');
    }
    return res.json({ success: false, message: 'No code found yet — check back in a moment' });
  }
  if (Date.now() - entry.timestamp > 15*60*1000) return res.json({ success: false, message: 'Code expired' });
  await sendTG(TG_ADMIN, `👀 <b>${profileName || 'Unknown'}</b> viewed code: ${entry.code}`, 'HTML');
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
let monitoredEmails = {}; // { gmailEmail: { user, pass, lastUid } }

async function fetchNetflixCodes() {
  for (const [email, creds] of Object.entries(monitoredEmails)) {
    try {
      const imap = new Imap({
        user: creds.user,
        password: creds.pass,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 15000
      });

      await new Promise((resolve, reject) => {
        imap.once('ready', resolve);
        imap.once('error', reject);
        imap.connect();
      });

      const emails = await new Promise((resolve) => {
        imap.openBox('INBOX', true, (err, box) => {
          if (err) { imap.end(); resolve([]); return; }
          imap.search(['UNSEEN', ['SINCE', new Date(Date.now() - 86400000).toISOString()]], (err, results) => {
            if (err || !results || !results.length) { imap.end(); resolve([]); return; }
            const fetch = imap.fetch(results, { bodies: '' });
            const parsed = [];
            fetch.on('message', (msg) => {
              msg.on('body', (stream) => {
                simpleParser(stream, (err, p) => { if (!err && p) parsed.push(p); });
              });
            });
            fetch.once('end', () => { imap.end(); resolve(parsed); });
            fetch.once('error', () => { imap.end(); resolve([]); });
          });
        });
      });

      // Extract 4-digit Netflix codes from emails
      for (const e of emails) {
        const text = (e.subject || '') + ' ' + (e.text || '');
        const from = (e.from || '').toString().toLowerCase();
        
        // Check if from Netflix
        if (from.includes('netflix') || text.includes('netflix')) {
          // Look for 4-digit code
          const match = text.match(/\b(\d{4})\b/);
          if (match) {
            const code = match[1];
            const key = email.toLowerCase();
            latestCodes[key] = { code, timestamp: Date.now() };
            delete notifiedCustomers[key];
            console.log(`📧 Netflix code ${code} captured for ${email}`);
            await sendTG(TG_ADMIN, `✅ <b>Netflix Code Captured!</b>\n📧 Email: ${email}\n🔢 Code: <b>${code}</b>`, 'HTML');
          }
        }
      }
    } catch(e) { console.log('IMAP error for', email, e.message); }
  }
}

setInterval(fetchNetflixCodes, 30000); // Poll every 30 seconds

app.post('/setup-gmail', async (req, res) => {
  const { secret, email, password } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  
  monitoredEmails[email] = { user: email, pass: password, lastUid: 0 };
  await sendTG(TG_ADMIN, `📧 Added Gmail monitoring: ${email}\nWill capture Netflix codes automatically.`, 'HTML');
  res.json({ success: true, message: 'Gmail added for Netflix code monitoring', gmailConfigured: true, email });
});

app.get('/monitored-emails', (req, res) => {
  res.json({ success: true, emails: Object.keys(monitoredEmails) });
});

// ── START ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('rashadtech server running on port ' + PORT);
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
