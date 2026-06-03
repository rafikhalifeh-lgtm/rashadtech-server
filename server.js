const express = require('express');
const cors = require('cors');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const app = express();
app.use(cors());
app.use(express.json());

const API_SECRET = process.env.API_SECRET || 'rashadtech2026secret';
let emailAccounts = {};

try {
  if (process.env.EMAIL_ACCOUNTS) {
    emailAccounts = JSON.parse(process.env.EMAIL_ACCOUNTS);
  }
} catch(e) {}

function getImapConfig(email, password) {
  const domain = email.split('@')[1]?.toLowerCase() || '';
  if (domain.includes('outlook.com') || domain.includes('hotmail.com') || domain.includes('live.com')) {
    return { user: email, password, host: 'imap-mail.outlook.com', port: 993, tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 15000, authTimeout: 10000 };
  } else if (domain.includes('yahoo.com') || domain.includes('ymail.com')) {
    return { user: email, password, host: 'imap.mail.yahoo.com', port: 993, tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 15000, authTimeout: 10000 };
  } else if (domain.includes('gmail.com')) {
    return { user: email, password, host: 'imap.gmail.com', port: 993, tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 15000, authTimeout: 10000 };
  }
  return { user: email, password, host: 'imap.' + domain, port: 993, tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 15000, authTimeout: 10000 };
}

app.get('/', (req, res) => {
  res.json({ status: 'rashadtech server running' });
});

app.post('/add-account', (req, res) => {
  const { secret, key, email, password } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  emailAccounts[key] = { email, password };
  res.json({ success: true });
});

app.post('/debug', async (req, res) => {
  const { secret, accountKey } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const account = emailAccounts[accountKey];
  if (!account) return res.status(404).json({ error: 'Account not found', available: Object.keys(emailAccounts) });
  try {
    const emails = await fetchRawEmails(account.email, account.password);
    res.json({ success: true, emails });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/get-code', async (req, res) => {
  const { secret, accountKey } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const account = emailAccounts[accountKey];
  if (!account) return res.status(404).json({ error: 'Account not found' });
  try {
    const code = await fetchLatestCode(account.email, account.password);
    res.json(code ? { success: true, code } : { success: false, message: 'No code found' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function fetchRawEmails(email, password) {
  return new Promise((resolve, reject) => {
    const config = getImapConfig(email, password);
    const imap = new Imap(config);
    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { imap.end(); return reject(err); }
        imap.search(['ALL'], (err, results) => {
          if (err || !results || results.length === 0) { imap.end(); return resolve([]); }
          const toFetch = results.slice(-5);
          const emails = [];
          let processed = 0;
          const fetch = imap.fetch(toFetch, { bodies: '' });
          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(stream, (err, parsed) => {
                processed++;
                if (!err) {
                  emails.push({
                    from: parsed.from?.text,
                    subject: parsed.subject,
                    date: parsed.date,
                    text: (parsed.text || '').substring(0, 500)
                  });
                }
                if (processed === toFetch.length) { imap.end(); resolve(emails); }
              });
            });
          });
          fetch.once('error', () => { imap.end(); resolve(emails); });
        });
      });
    });
    imap.once('error', reject);
    imap.once('end', () => {});
    imap.connect();
  });
}

function fetchLatestCode(email, password) {
  return new Promise((resolve, reject) => {
    const config = getImapConfig(email, password);
    const imap = new Imap(config);
    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { imap.end(); return reject(err); }
        imap.search(['ALL'], (err, results) => {
          if (err || !results || results.length === 0) { imap.end(); return resolve(null); }
          const toFetch = results.slice(-20);
          const codes = [];
          let processed = 0;
          const fetch = imap.fetch(toFetch, { bodies: '' });
          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(stream, (err, parsed) => {
                processed++;
                if (!err) {
                  const text = parsed.text || '';
                  const date = parsed.date ? new Date(parsed.date) : new Date(0);
                  if (text.includes('Enter this code to sign in') || text.includes('The Netflix team')) {
                    const patterns = [
                      /Enter this code to sign in[\s\r\n]+(\d{4,8})[\s\r\n]+Enter the code above/i,
                      /(\d{4,8})[\s\r\n]+Enter the code above/i,
                      /Enter this code to sign in[\s\r\n]+(\d{4,8})/i,
                      /\b(\d{4,8})\b/,
                    ];
                    for (const p of patterns) {
                      const m = text.match(p);
                      if (m) { codes.push({ code: m[1], date }); break; }
                    }
                  }
                }
                if (processed === toFetch.length) {
                  imap.end();
                  if (codes.length === 0) return resolve(null);
                  codes.sort((a, b) => b.date - a.date);
                  resolve(codes[0].code);
                }
              });
            });
          });
          fetch.once('error', () => { imap.end(); resolve(null); });
        });
      });
    });
    imap.once('error', reject);
    imap.once('end', () => {});
    imap.connect();
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('rashadtech server running on port ' + PORT));
