const Imap = require('imap');
const { simpleParser } = require('mailparser');

const email = 'rafikhalifeh718@outlook.com';
const password = 'geogfwqbnjybrbps';

console.log(`🔌 Connecting to Outlook for ${email}...`);

// Try with explicit basic auth
const imap = new Imap({
  user: email,
  password: password,
  host: 'imap-mail.outlook.com',
  port: 993,
  tls: true,
  connTimeout: 30000,
  authTimeout: 30000
});

imap.once('error', (err) => {
  console.log(`❌ IMAP Error: ${err.message}`);
  process.exit(1);
});

imap.once('ready', () => {
  console.log(`✅ IMAP Connected!`);
  
  imap.openBox('INBOX', true, (err, box) => {
    if (err) {
      console.log(`❌ OpenBox Error: ${err.message}`);
      imap.end();
      return;
    }
    
    console.log(`📬 Inbox opened. Total messages: ${box.messages.total}`);
    
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    
    imap.search(['ALL', ['SINCE', twoDaysAgo]], (err, results) => {
      if (err || !results || results.length === 0) {
        console.log(`📭 No messages found in last 2 days`);
        imap.end();
        return;
      }
      
      console.log(`📬 Found ${results.length} messages in last 2 days`);
      
      const lastMessages = results.slice(-5);
      console.log(`📧 Checking last ${lastMessages.length} messages...`);
      
      const fetch = imap.fetch(lastMessages, { bodies: '' });
      
      fetch.on('message', (msg) => {
        msg.on('body', (stream) => {
          simpleParser(stream, (err, parsed) => {
            if (err) return;
            
            console.log(`\n--- Email ---`);
            console.log(`From: ${parsed.from?.text || 'unknown'}`);
            console.log(`Subject: ${parsed.subject || 'no subject'}`);
            
            const body = parsed.text || '';
            const codeMatch = body.match(/\b(\d{4})\b/);
            if (codeMatch) {
              console.log(`🔑 Found 4-digit: ${codeMatch[1]}`);
            }
          });
        });
      });
      
      fetch.once('end', () => {
        console.log(`\n✅ Done`);
        imap.end();
      });
    });
  });
});

imap.connect();
