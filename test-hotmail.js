const Imap = require('imap');

const testAccount = {
  user: 'rashadtechtvcode@hotmail.com',
  password: 'RashadTech2025!'
};

console.log('Testing Hotmail IMAP connection...');

const imap = new Imap({
  user: testAccount.user,
  password: testAccount.password,
  host: 'outlook.office365.com',
  port: 993,
  tls: true,
  connTimeout: 15000
});

imap.once('error', (err) => {
  console.log('IMAP Error:', err.message);
});

imap.once('ready', () => {
  console.log('✅ IMAP Connected successfully!');
  console.log('📧 rashadtechtvcode@hotmail.com supports IMAP!');
  imap.end();
});

imap.connect();