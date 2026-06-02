bash

cat /home/claude/rashadtech-server/server.js
Output

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
} catch(e) {
  console.log('No email accounts configured yet');
}

// Detect email provider and return IMAP settings
function getImapConfig(email, password) {
  const domain = email.split('@')[1]?.toLowerCase() || '';
  
  if (domain.includes('gmail.com')) {
    return {
      user: email,
      password: password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000
    };
  } else if (domain.includes('outlook.com') || domain.includes('hotmail.com') || domain.includes('live.com')) {
    return {
      user: email,
      password: password,
      host: 'imap-mail.outlook.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000
    };
  } else if (domain.includes('yahoo.com')) {
    return {
      user: email,
      password: password,
      host: 'imap.mail.yahoo.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000
    };
  } else {
    // Generic fallback
    return {
      user: email,
      password: password,
      host: 'imap.' + domain,
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000
    };
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'rashadtech server running', accounts: Object.keys(emailAccounts).length });
});

app.post('/add-account', (req, res) => {
  const { secret, key, email, password } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  emailAccounts[key] = { email, password };
  res.json({ success: true, message: `Account ${key} added` });
});

app.post('/get-code', async (req, res) => {
  const { secret, accountKey, codeType } = req.body;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const account = emailAccounts[accountKey];
  if (!account) return res.status(404).json({ error: 'Account not found' });
  try {
    const code = await fetchEmailCode(account.email, account.password, codeType || 'netflix');
    if (code) {
      res.json({ success: true, code });
    } else {
      res.json({ success: false, message: 'No code found yet' });
    }
  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function fetchEmailCode(email, password, codeType) {
  return new Promise((resolve, reject) => {
    const config = getImapConfig(email, password);
    const imap = new Imap(config);

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) { imap.end(); return reject(err); }

        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
        
        // Search by sender based on service type
        const senderMap = {
          netflix: 'netflix.com',
          shahid: 'shahid.net',
          osn: 'osn.com',
          disney: 'disneyplus.com',
          spotify: 'spotify.com'
        };
        const sender = senderMap[codeType] || codeType;
        
        imap.search(['ALL', ['FROM', sender], ['SINCE', tenMinutesAgo]], (err, results) => {
          if (err || !results || results.length === 0) {
            imap.end();
            return resolve(null);
          }

          const latest = results[results.length - 1];
          const fetch = imap.fetch(latest, { bodies: '' });
          
          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(stream, (err, parsed) => {
                if (err) { imap.end(); return resolve(null); }
                
                const text = (parsed.text || '') + (parsed.html || '');
                let code = null;
                
                const patterns = [
                  /(\d{6})\s*is your Netflix sign.in code/i,
                  /sign.in code[:\s]+(\d{6})/i,
                  /your code is[:\s]+(\d{6})/i,
                  /verification code[:\s]+(\d{6})/i,
                  /one.time code[:\s]+(\d{6})/i,
                  /\b([0-9]{6})\b/,
                ];
                
                for (const pattern of patterns) {
                  const match = text.match(pattern);
                  if (match) { code = match[1]; break; }
                }

                imap.end();
                resolve(code);
              });
            });
          });

          fetch.once('error', () => { imap.end(); resolve(null); });
        });
      });
    });

    imap.once('error', (err) => reject(err));
    imap.once('end', () => {});
    imap.connect();
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`rashadtech server running on port ${PORT}`));
