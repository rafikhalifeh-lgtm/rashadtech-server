const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PHONE_COUNTRIES,
  matchPhoneDialCode,
  phoneCountryOptionsHtml
} = require('../phoneCountries');

test('PHONE_COUNTRIES includes Lebanon and has many entries', () => {
  assert.ok(PHONE_COUNTRIES.length >= 200);
  assert.ok(PHONE_COUNTRIES.some(c => c.code === '+961' && /Lebanon/i.test(c.name)));
});

test('matchPhoneDialCode splits Lebanon number', () => {
  assert.deepEqual(matchPhoneDialCode('+961 79 123 456'), { code: '+961', local: '79123456' });
});

test('matchPhoneDialCode splits UK number with +44', () => {
  assert.deepEqual(matchPhoneDialCode('+447911123456'), { code: '+44', local: '7911123456' });
});

test('matchPhoneDialCode splits American Samoa +1684', () => {
  assert.deepEqual(matchPhoneDialCode('+16841234567'), { code: '+1684', local: '1234567' });
});

test('phoneCountryOptionsHtml marks selected code', () => {
  const html = phoneCountryOptionsHtml('+961');
  assert.match(html, /value="\+961" selected/);
  assert.match(html, /Lebanon/);
});
