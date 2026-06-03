const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_SECRET = process.env.API_SECRET || 'rashadtech2026secret';
let latestCodes = {};
let emailAccounts = {};

try { if (process.env.EMAIL_ACCOUNTS) emailAccounts = JSON.parse(process.env.EMAIL_ACCOUNTS); } catch(e) {}

function extractNetflixCode(text) {
  if (!text) return null;
  const patterns = [
    /Enter this code to sign in[\s\r\n]+(\d{4,8})[\s\r\n]+Enter the code above/i,
    /(\d{4,8})[\s\r\n]+Enter the code above/i,
    /Enter this code to sign in[\s\r\n]+(\d{4,8})/i,
    /sign.in code[:\s]+(\d{4,8})/i,
    /your code[:\s]+(\d{4,8})/i,
    /\b(\d{4,8})\b/,
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1]; }
  return null;
}

app.get('/', (req, res) => res.json({ status: 'rashadtech server running' }));

app.post('/webhook/email', (req, res) => {
  try {
    const body = req.body;
    const text = body.text || body.body || body.content || body.html || JSON.stringify(body);
    const from = (body.from || body.sender || '').toLowerCase();
    const subject = (body.subject || '').toLowerCase();
    const isNetflix = from.includes('netflix') || subject.includes('netflix') || subject.includes('sign in') || text.includes('Enter this code to sign in') || text.includes('The Netflix team');
    if (isNetflix) {
      const code = extractNetflixCode(text);
      if (code) {
        latestCodes['default'] = { code, timestamp: Date.now() };
        if (body.to) latestCodes[body.to.toLowerCase()] = { code, timestamp: Date.now() };
        console.log('Netflix code stored:', code);
        return res.json({ success: true, code });
      }
    }
    res.json({ success: false, message: 'No Netflix code found' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/set-code', (req, res) => {
  const { secret, code, email } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const key = email ? email.toLowerCase() : 'default';
  latestCodes[key] = { code, timestamp: Date.now() };
  res.json({ success: true });
});

app.post('/get-code', (req, res) => {
  const { secret } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const entry = latestCodes['default'];
  if (!entry) return res.json({ success: false, message: 'No code found' });
  if (Date.now() - entry.timestamp > 15 * 60 * 1000) return res.json({ success: false, message: 'Code expired' });
  res.json({ success: true, code: entry.code });
});

app.post('/add-account', (req, res) => {
  const { secret, key, email, password } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  emailAccounts[key] = { email, password };
  res.json({ success: true });
});

app.get('/debug-inbox', (req, res) => res.json({ codes: latestCodes }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('rashadtech server running on port ' + PORT));
