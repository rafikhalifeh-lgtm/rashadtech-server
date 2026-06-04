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
let outlookAccounts = {}; // { email: { password, lastCheck, lastUid } }

// ── EMAIL POLLING ────────────────────────────────────────────────────────────
async function checkOutlookEmails(email, password) {
  return new Promise((resolve, reject) => {
    try {
      const imap = new Imap({
        user: email,
        password: password,
        host: 'outlook.office365.com',
        port: 993,
        tls: true,
        connTimeout: 15000
      });

      imap.once('error', (err) => {
        console.log(`IMAP error for ${email}:`, err.message);
        resolve(null);
      });

      imap.once('ready', () => {
        console.log(`📬 IMAP connected for ${email}, checking inbox...`);
        imap.openBox('INBOX', true, (err, box) => {
          if (err) {
            console.log(`❌ IMAP open error for ${email}:`, err.message);
            imap.end();
            resolve(null);
            return;
          }
          
          console.log(`📬 Opened inbox for ${email}, total messages: ${box.messages.total}`);

          // Search for Netflix emails from last 2 days
          const twoDaysAgo = new Date();
          twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
          
          imap.search(['ALL', ['SINCE', twoDaysAgo]], (err, results) => {
            if (err || !results || results.length === 0) {
              imap.end();
              resolve(null);
              return;
            }

            const lastUid = outlookAccounts[email]?.lastUid || 0;
            let newMessages = results.filter(uid => uid > lastUid);
            
            // If no new messages but we have results, check the most recent one anyway
            // This handles the case when server restarts
            if (newMessages.length === 0 && results.length > 0) {
              console.log(`📬 No new messages for ${email}, checking last message anyway...`);
              newMessages = [Math.max(...results)];
            }
            
            if (newMessages.length === 0) {
              console.log(`📬 No messages to check for ${email}`);
              imap.end();
              resolve(null);
              return;
            }

            // Get the most recent email
            const latestUid = Math.max(...newMessages);
            console.log(`📬 Checking ${newMessages.length} messages for ${email}, latest UID: ${latestUid}`);
            const fetch = imap.fetch(newMessages, { bodies: '' });
            let foundCode = null;

            fetch.on('message', (msg) => {
              msg.on('body', (stream) => {
                simpleParser(stream, async (err, parsed) => {
                  if (err) return;
                  
                  const from = parsed.from?.text || '';
                  const subject = parsed.subject || '';
                  const body = parsed.text || '';
                  
                  // Check if it's a Netflix verification code email
                  if (from.toLowerCase().includes('netflix') || 
                      subject.toLowerCase().includes('verification') ||
                      subject.toLowerCase().includes('code') ||
                      subject.toLowerCase().includes('sign-in') ||
                      subject.toLowerCase().includes('verify') ||
                      subject.toLowerCase().includes('netflix.com')) {
                    
                    // Extract 4-digit code - Netflix uses 4 digits for verification
                    // Look in body first, then subject
                    let codeMatch = body.match(/\b(\d{4})\b/);
                    
                    // Also try subject in case code is mentioned there
                    if (!codeMatch) {
                      codeMatch = subject.match(/\b(\d{4})\b/);
                    }
                    
                    // Make sure it's not just a random number - check context
                    if (codeMatch) {
                      const code = codeMatch[1];
                      // Verify it's likely a Netflix code (not a phone number or other)
                      // by checking the surrounding text or subject contains netflix/verify
                      const fullText = body + ' ' + subject;
                      if (fullText.toLowerCase().includes('netflix') || 
                          fullText.toLowerCase().includes('verify') ||
                          fullText.toLowerCase().includes('sign')) {
                        foundCode = code;
                      }
                    }
                  }
                });
              });
            });

            fetch.once('end', () => {
              // Save the latest UID for this account
              if (!outlookAccounts[email]) outlookAccounts[email] = {};
              outlookAccounts[email].lastUid = latestUid;
              imap.end();
              if (foundCode) {
                console.log(`✅ CODE FOUND for ${email}: ${foundCode}`);
              } else {
                console.log(`❌ No Netflix code found in ${email} inbox`);
              }
              resolve(foundCode);
            });
          });
        });
      });

      imap.connect();
    } catch (e) {
      console.log(`IMAP setup error: ${e.message}`);
      resolve(null);
    }
  });
}

// Poll all outlook accounts every 10 seconds (reduced from 30 for faster detection)
setInterval(async () => {
  for (const [email, data] of Object.entries(outlookAccounts)) {
    const code = await checkOutlookEmails(email, data.password);
    if (code) {
      // Save the code keyed by the Outlook email (not profile name)
      // This ensures code only goes to the subscription linked to this email
      const key = email.toLowerCase();
      latestCodes[key] = { code, timestamp: Date.now(), source: 'outlook', email: email };
      console.log(`📧 Netflix code found for ${email}: ${code}`);
      await sendTG(TG_ADMIN, `✅ <b>Auto-Code Captured</b>\n📧 Email: ${email}\n🔑 Code: <b>${code}</b>\n📱 Will auto-deliver to this account's subscription`, 'HTML');
    }
  }
}, 10000);

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

// ── OUTLOOK EMAIL SYNC ──────────────────────────────────────────────────
app.post('/sync-outlook', async (req, res) => {
  const { secret, email, password } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  
  if (email && password) {
    outlookAccounts[email.toLowerCase()] = {
      password,
      lastCheck: Date.now(),
      lastUid: 0
    };
    console.log(`📧 Added outlook account for monitoring: ${email}`);
    
    // Immediately check for codes
    const code = await checkOutlookEmails(email, password);
    if (code) {
      latestCodes[email.toLowerCase()] = { code, timestamp: Date.now(), source: 'outlook' };
      await sendTG(TG_ADMIN, `✅ <b>First Code Captured!</b>\n📧 ${email}\n🔑 Code: <b>${code}</b>`, 'HTML');
    }
  }
  
  res.json({ success: true, monitoredAccounts: Object.keys(outlookAccounts) });
});

// ── TELEGRAM PROXY ──────────────────────────────────────────────────────
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
      latestCodes[key] = { code, timestamp: Date.now(), source: 'telegram' };
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
          return `• ${k}: <b>${v.code}</b> (${age}s ago) ${v.source ? `📧 ${v.source}` : ''}${age > 900 ? ' ❌ EXPIRED' : ''}`;
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
  const { secret, profileName, accountEmail } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  
  // Key by the Outlook email - code is ONLY available for the exact email that received it
  let key = null;
  let entry = null;
  
  if (accountEmail) {
    // Try exact email match first
    key = accountEmail.toLowerCase();
    entry = latestCodes[key];
  }
  
  if (!entry && profileName) {
    // Also check if profile name matches an email
    key = profileName.toLowerCase();
    entry = latestCodes[key];
  }
  
  if (!entry) {
    // No code found for this specific email - do NOT fallback to default
    const name = profileName || accountEmail || 'Unknown';
    if (!notifiedCustomers[key] || Date.now() - notifiedCustomers[key] > 5*60*1000) {
      notifiedCustomers[key] = Date.now();
      await sendTG(TG_ADMIN, `🔔 <b>${name}</b> requested sign-in code but no code received yet.\n📧 Check the Outlook inbox for Netflix verification code.`, 'HTML');
    }
    return res.json({ success: false, message: 'No code available yet. Please wait for Netflix email.' });
  }
  
  // Check if code expired (15 minutes)
  if (Date.now() - entry.timestamp > 15*60*1000) {
    delete latestCodes[key]; // Clean up expired code
    return res.json({ success: false, message: 'Code expired. Request a new one from Netflix.' });
  }
  
  await sendTG(TG_ADMIN, `👀 <b>${profileName || accountEmail}</b> viewed code: ${entry.code}`, 'HTML');
  res.json({ success: true, code: entry.code });
});

app.post('/set-code', (req, res) => {
  const { secret, code, profileName, accountEmail } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  let key = profileName ? profileName.toLowerCase() : (accountEmail ? accountEmail.toLowerCase() : 'default');
  latestCodes[key] = { code, timestamp: Date.now(), source: 'manual' };
  res.json({ success: true });
});

app.post('/add-account', (req, res) => res.json({ success: true }));

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
