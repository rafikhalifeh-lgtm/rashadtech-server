const assert = require('assert');
const {
  isValidOsnOtp,
  isLikelyOsnPhoneFragment,
  extractOsnOtp,
  extractOsnCode
} = require('../osnCodeExtract');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

test('accepts valid 4-digit OTP', () => {
  assert.strictEqual(isValidOsnOtp('1234'), true);
  assert.strictEqual(isValidOsnOtp('12'), false);
  assert.strictEqual(isValidOsnOtp('123456'), false);
});

test('rejects phone-like fragments', () => {
  assert.strictEqual(isLikelyOsnPhoneFragment('5550', 'call us at 5550'), true);
  assert.strictEqual(isLikelyOsnPhoneFragment('5550', 'verification code: 5550'), false);
});

test('extracts labeled OSN OTP', () => {
  const body = 'Your OSN+ verification code is 4821. Do not share it.';
  assert.strictEqual(extractOsnOtp(body), '4821');
});

test('rejects boilerplate phone 5550 in OSN email', () => {
  const body = 'OSN+ support line 5550. Your sign-in code: 7392';
  assert.strictEqual(extractOsnOtp(body), '7392');
});

test('extractOsnCode from parsed email', () => {
  const parsed = {
    from: 'noreply@osnplus.com',
    text: 'Your one-time code is 9012'
  };
  const result = extractOsnCode(parsed, (p) => p.text);
  assert.deepStrictEqual(result, { code: '9012', customerSafe: true });
});

console.log('All OSN extract tests passed');
