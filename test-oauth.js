const https = require('https');

const auth = Buffer.from('rafikhalifeh718@outlook.com:RkhRkh79').toString('base64');

const options = {
  hostname: 'outlook.office365.com',
  port: 443,
  path: '/api/v2.0/Me/Messages?$top=5',
  method: 'GET',
  headers: {
    'Authorization': 'Basic ' + auth,
    'Accept': 'application/json'
  }
};

console.log('🔌 Testing Outlook REST API...');

const req = https.request(options, (res) => {
  console.log(`📊 Status: ${res.statusCode}`);
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log(body.substring(0, 1000));
  });
});

req.on('error', (e) => console.log(`❌ Error: ${e.message}`));
req.end();
