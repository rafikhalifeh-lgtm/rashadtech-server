const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// â”€â”€ SECRETS: set these as Environment Variables on Render.com â”€â”€
// API_SECRET, TG_TOKEN, TG_ADMIN, JB_KEY, JB_BIN
const API_SECRET = process.env.API_SECRET;
const TG_TOKEN   = process.env.TG_TOKEN;
const TG_ADMIN   = process.env.TG_ADMIN;
const JB_KEY     = process.env.JB_KEY;
const JB_BIN     = process.env.JB_BIN;

if (!API_SECRET || !TG_TOKEN || !TG_ADMIN) {
  console.error('âŒ Missing required env vars: API_SECRET, TG_TOKEN, TG_ADMIN');
}

let latestCodes = {};
let notifiedCustomers = {};

// â”€â”€ HEALTH / KEEP-ALIVE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/', (req, res) => {
  res.json({ status: 'rashadtech server running', codes: Object.keys(latestCodes) });
});

app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// â”€â”€ JSONBIN PROXY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Keeps JB_KEY and JB_BIN off the frontend entirely

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
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JB_KEY,
        'X-Bin-Meta': 'false'
      },
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

// â”€â”€ TELEGRAM BOT WEBHOOK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post('/telegram', async (req, res) => {
  try {
    const update = req.body;
    const msg = update.message;
    if (!msg) return res.json({ ok: true });
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    if (chatId !== TG_ADMIN) {
      await sendTG(chatId, 'âŒ Unauthorized');
      return res.json({ ok: true });
    }
    if (text.startsWith('/code ')) {
      const parts = text.replace('/code ', '').trim().split(' ');
      let key = 'default';
      let code = '';
      if (parts.length === 1 && parts[0].match(/^\d{4,8}$/)) {
        code = parts[0];
      } else if (parts.length === 2 && parts[1].match(/^\d{4,8}$/)) {
        key = parts[0].toLowerCase();
        code = parts[1];
      } else {
        await sendTG(chatId, 'âš ï¸ Usage:\n/code 1234 (for all)\n/code Ali 1234 (for specific customer)');
        return res.json({ ok: true });
      }
      latestCodes[key] = { code, timestamp: Date.now() };
      delete notifiedCustomers[key];
      const target = key === 'default' ? 'all customers' : `<b>${key}</b>`;
      await sendTG(chatId, `âœ… Code <b>${code}</b> saved for ${target}`);
    } else if (text === '/clear') {
      latestCodes = {};
      notifiedCustomers = {};
      await sendTG(chatId, 'âœ… All codes cleared');
    } else if (text.startsWith('/clear ')) {
      const key = text.replace('/clear ', '').trim().toLowerCase();
      delete latestCodes[key];
      delete notifiedCustomers[key];
      await sendTG(chatId, `âœ… Code cleared for ${key}`);
    } else if (text === '/status') {
      if (Object.keys(latestCodes).length === 0) {
        await sendTG(chatId, 'ðŸ“‹ No codes stored');
      } else {
        const lines = Object.entries(latestCodes).map(([k, v]) => {
          const age = Math.round((Date.now() - v.timestamp) / 1000);
          const expired = age > 900 ? ' âŒ EXPIRED' : '';
          return `â€¢ ${k}: <b>${v.code}</b> (${age}s ago)${expired}`;
        });
        await sendTG(chatId, 'ðŸ“‹ Stored codes:\n' + lines.join('\n'));
      }
    } else {
      await sendTG(chatId, "ðŸ“– Commands:\n/code 1234 â€” save code for all\n/code Ali 1234 â€” save code for Ali\n/status â€” check all codes\n/clear â€” clear all codes\n/clear Ali â€” clear Ali's code");
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('Telegram error:', e.message);
    res.json({ ok: true });
  }
});

async function sendTG(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// â”€â”€ CODE ENDPOINTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post('/get-code', async (req, res) => {
  const { secret, profileName } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const key = profileName ? profileName.toLowerCase() : 'default';
  const entry = latestCodes[key] || latestCodes['default'];
  if (!entry) {
    const name = profileName || 'Unknown';
    if (!notifiedCustomers[key] || Date.now() - notifiedCustomers[key] > 5 * 60 * 1000) {
      notifiedCustomers[key] = Date.now();
      await sendTG(TG_ADMIN, `ðŸ”” <b>${name}</b> is waiting for a sign-in code!\n\nSend it with:\n/code ${name} 1234`);
    }
    return res.json({ success: false, message: 'Code requested â€” check Telegram' });
  }
  if (Date.now() - entry.timestamp > 15 * 60 * 1000) {
    return res.json({ success: false, message: 'Code expired' });
  }
  const name = profileName || 'Unknown';
  await sendTG(TG_ADMIN, `ðŸ‘€ <b>${name}</b> viewed the sign-in code: ${entry.code}`);
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

// â”€â”€ START â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('rashadtech server running on port ' + PORT);
  try {
    const webhookUrl = process.env.RENDER_EXTERNAL_URL + '/telegram';
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const j = await r.json();
    console.log('Telegram webhook:', j.description);
  } catch(e) {
    console.log('Webhook setup error:', e.message);
  }
});
