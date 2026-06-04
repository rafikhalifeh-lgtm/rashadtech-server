const Imap = require('imap');
const { simpleParser } = require('mailparser');

const email = 'rafikhalifeh718@outlook.com';
const password = 'RkhRkh79';

console.log(`🔌 Connecting to Outlook for ${email}...`);
console.log(`🔑 Password length: ${password.length}`);

const imap = new Imap({
  user: email,
  password: password,
  host: 'outlook.office365.com',
  port: 993,
  tls: true
});

imap.once('error', (err) => {
  console.log(`\n❌ IMAP Error: ${err.message}`);
  process.exit(1);
});

imap.once('ready', () => {
  console.log('✅ IMAP Connected!');
  imap.openBox('INBOX', true, (err, box) => {
    if (err) { console.log(`❌ ${err.message}`); imap.end(); return; }
    console.log(`📬 Inbox: ${box.messages.total} messages`);
    
    const since = new Date();
    since.setDate(since.getDate() - 2);
    
    imap.search(['ALL', ['SINCE', since]], (err, results) => {
      if (err || !results?.length) { console.log('📭 No messages'); imap.end(); return; }
      console.log(`📬 Found ${results.length} messages`);
      
      const last5 = results.slice(-5);
      const fetch = imap.fetch(last5, { bodies: '' });
      
      fetch.on('message', (msg) => {
        msg.on('body', (stream) => {
          simpleParser(stream, (err, parsed) => {
            if (err) return;
            console.log(`\n📧 From: ${parsed.from?.text}`);
            console.log(`   Subject: ${parsed.subject}`);
            const m = (parsed.text || '').match(/\b(\d{4})\b/);
            if (m) console.log(`   🔑 Code: ${m[1]}`);
          });
        });
      });
      
      fetch.once('end', () => { console.log('\n✅ Done'); imap.end(); });
    });
  });
});

imap.connect();
