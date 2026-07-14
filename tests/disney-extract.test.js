const assert = require('assert');
const {
  isValidDisneyOtp,
  extractDisneyOtp,
  extractDisneyCode
} = require('../disneyCodeExtract');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

test('accepts valid 6-digit Disney OTP', () => {
  assert.strictEqual(isValidDisneyOtp('123456'), true);
  assert.strictEqual(isValidDisneyOtp('12345'), false);
});

test('extracts spaced Disney passcode', () => {
  const body = 'Your one-time passcode for Disney+\n\n1 2 3 4 5 6\n\nDo not share.';
  assert.strictEqual(extractDisneyOtp(body), '123456');
});

test('extracts Disney code from MyDisney sender', () => {
  const parsed = {
    from: 'MyDisney Account <noreply@account.mydisney.com>',
    subject: 'Your one-time passcode for Disney+',
    text: 'Enter this verification code: 847291'
  };
  const result = extractDisneyCode(parsed, (p) => `${p.subject}\n${p.text}`);
  assert.deepStrictEqual(result, { code: '847291', customerSafe: true });
});

test('extracts Disney code from HTML-heavy email', () => {
  const parsed = {
    from: 'Disney+ <DisneyPlus@email.disneyplus.com>',
    subject: 'Your one-time passcode for Disney+',
    text: '',
    html: '<div><p>Your verification code is</p><h1>9 9 8 8 7 7</h1></div>'
  };
  const result = extractDisneyCode(parsed);
  assert.deepStrictEqual(result, { code: '998877', customerSafe: true });
});

console.log('All Disney extract tests passed');
