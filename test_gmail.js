const Imap = require('imap');
const { simpleParser } = require('mailparser');

const email = 'techtrassh@gmail.com';
const password = 'fhbn jzgx cdej kuki';

console.log(`Testing Gmail: ${email}`);

const imap = new Imap({
  user: email,
  password: password,
  host: 'imap.gmail.com',
  port: 993,
  tls: true,
  tlsOptions: { servername: 'imap.gmail.com' },
  connTimeout: 15000
});

imap.once('error', (err) => {
  console.log('❌ IMAP Error:', err.message);
  process.exit(1);
});

imap.once('ready', () => {
  console.log('✅ Gmail IMAP connected!');
  imap.end();
});

imap.connect();