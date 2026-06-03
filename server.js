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
  res.json({ status: 'rashadtech server running', hasCode: !!latestCodes['default'] });
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
      const code = text.replace('/code ', '').trim();
      if (code.match(/^\d{4,8}$/)) {
        latestCodes['default'] = { code, timestamp: Date.now() };
        await sendTG(chatId, `✅ Code saved: <b>${code}</b>\nCustomers can now get it from their subscription link.`);
      } else {
        await sendTG(chatId, '⚠️ Invalid code. Use: /code 1234');
      }
    } else if (text === '/clear') {
      latestCodes = {};
      await sendTG(chatId, '✅ Code cleared');
    } else if (text === '/status') {
      const entry = latestCodes['default'];
      if (entry) {
        const age = Math.round((Date.now() - entry.timestamp) / 1000);
        await sendTG(chatId, `📋 Current code: <b>${entry.code}</b>\nAge: ${age} seconds`);
      } else {
        await sendTG(chatId, '📋 No code stored');
      }
    } else {
      await sendTG(chatId, '📖 Commands:\n/code 1234 — save sign-in code\n/status — check current code\n/clear — clear code');
    }

    res.json({ ok: true });
  } catch(e) {
    console.error('Telegram webhook error:', e.message);
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

app.post('/get-code', (req, res) => {
  const { secret } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const entry = latestCodes['default'];
  if (!entry) return res.json({ success: false, message: 'No code yet' });
  if (Date.now() - entry.timestamp > 15 * 60 * 1000) return res.json({ success: false, message: 'Code expired' });
  res.json({ success: true, code: entry.code });
});

app.post('/set-code', (req, res) => {
  const { secret, code } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  latestCodes['default'] = { code, timestamp: Date.now() };
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
