const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_SECRET = process.env.API_SECRET || 'rashadtech2026secret';
const TG_TOKEN = process.env.TG_TOKEN || '8761505457:AAEsL3r6rN29VTBd-cDuufrYHt1TFbW3uFs';
const TG_ADMIN = process.env.TG_ADMIN || '1703712641';

let latestCodes = {};

app.get('/', (req, res) => {
  res.json({ status: 'rashadtech server running', codes: Object.keys(latestCodes) });
});

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
      let key = 'default';
      let code = '';
      if (parts.length === 1 && parts[0].match(/^\d{4,8}$/)) {
        code = parts[0];
      } else if (parts.length === 2 && parts[1].match(/^\d{4,8}$/)) {
        key = parts[0].toLowerCase();
        code = parts[1];
      } else {
        await sendTG(chatId, '⚠️ Usage:\n/code 1234 (for all)\n/code Ali 1234 (for specific customer)');
        return res.json({ ok: true });
      }
      latestCodes[key] = { code, timestamp: Date.now() };
      const target = key === 'default' ? 'all customers' : `<b>${key}</b>`;
      await sendTG(chatId, `✅ Code <b>${code}</b> saved for ${target}`);
    }
    else if (text === '/clear') {
      latestCodes = {};
      await sendTG(chatId, '✅ All codes cleared');
    }
    else if (text.startsWith('/clear ')) {
      const key = text.replace('/clear ', '').trim().toLowerCase();
      delete latestCodes[key];
      await sendTG(chatId, `✅ Code cleared for ${key}`);
    }
    else if (text === '/status') {
      if (Object.keys(latestCodes).length === 0) {
        await sendTG(chatId, '📋 No codes stored');
      } else {
        const lines = Object.entries(latestCodes).map(([k, v]) => {
          const age = Math.round((Date.now() - v.timestamp) / 1000);
          const expired = age > 900 ? ' ❌ EXPIRED' : '';
          return `• ${k}: <b>${v.code}</b> (${age}s ago)${expired}`;
        });
        await sendTG(chatId, '📋 Stored codes:\n' + lines.join('\n'));
      }
    }
    else {
      await sendTG(chatId, '📖 Commands:\n/code 1234 — save code for all\n/code Ali 1234 — save code for Ali\n/status — check all codes\n/clear — clear all codes\n/clear Ali — clear Ali\'s code');
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

app.post('/get-code', async (req, res) => {
  const { secret, profileName } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const key = profileName ? profileName.toLowerCase() : 'default';
  const entry = latestCodes[key] || latestCodes['default'];

  if (!entry) {
    const name = profileName || 'Unknown';
    await sendTG(TG_ADMIN, `🔔 <b>${name}</b> is waiting for a sign-in code!\n\nSend it with:\n/code ${name} 1234`);
    return res.json({ success: false, message: 'Code requested — check Telegram' });
  }

  if (Date.now() - entry.timestamp > 15 * 60 * 1000) {
    return res.json({ success: false, message: 'Code expired' });
  }

  const name = profileName || 'Unknown';
  await sendTG(TG_ADMIN, `👀 <b>${name}</b> viewed the sign-in code: ${entry.code}`);

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
