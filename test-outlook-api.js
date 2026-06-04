// Test Outlook.com REST API access
const https = require('https');

const email = 'rashadtechtvcode@hotmail.com';
const password = 'RashadTech2025!';

// First, let's try basic auth with the Outlook REST API
// Note: Modern Microsoft accounts use OAuth, but some still support basic for legacy apps

const options = {
  hostname: 'outlook.office365.com',
  port: 443,
  path: '/api/v2.0/me/mailfolders/inbox/messages',
  method: 'GET',
  headers: {
    'Authorization': 'Basic ' + Buffer.from(email + ':' + password).toString('base64'),
    'Content-Type': 'application/json'
  }
};

console.log('Testing Outlook REST API...');

const req = https.request(options, (res) => {
  console.log('Status:', res.statusCode);
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Response:', data.substring(0, 500));
  });
});

req.on('error', (e) => {
  console.log('Error:', e.message);
});

req.end();

// Also test IMAP with OAuth2 style (app password)
console.log('\n---\nTrying IMAP connection...');
const Imap = require('imap');
const imap = new Imap({
  user: email,
  password: password,
  host: 'outlook.office365.com',
  port: 993,
  tls: true,
  connTimeout: 15000
});

imap.once('error', (err) => {
  console.log('IMAP Error:', err.message);
  console.log('');
  if (err.message.includes('AUTHENTICATE')) {
    console.log('💡 The password may be incorrect or Microsoft blocked basic auth.');
    console.log('💡 For Microsoft accounts, you may need an App Password instead.');
  }
});

imap.once('ready', () => {
  console.log('✅ IMAP Connected!');
  imap.end();
});

imap.connect();