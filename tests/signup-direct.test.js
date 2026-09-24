'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = serverSrc.indexOf('const SIGNUP_DIRECT_MARKER');
const end = serverSrc.indexOf('function deriveSignupName');
assert.ok(start > 0 && end > start, 'signup direct helpers must exist');

const helpers = vm.runInNewContext(`${serverSrc.slice(start, end)}\n({ stripSignupDirectMarker, signupDirectRequested })`);

test('email marker is removed and requests direct signup', () => {
  const email = 'tester@$13@gmail.com';
  assert.equal(helpers.signupDirectRequested(email, '+96179000000'), true);
  assert.equal(helpers.stripSignupDirectMarker(email), 'tester@gmail.com');
});

test('marker at the end of a phone requests direct signup and is removed', () => {
  const phone = '+96179000000@$13';
  assert.equal(helpers.signupDirectRequested('tester@gmail.com', phone), true);
  assert.equal(helpers.stripSignupDirectMarker(phone), '+96179000000');
});

test('marker anywhere in a phone skips verification', () => {
  assert.equal(helpers.signupDirectRequested('tester@gmail.com', '+961@$1379000000'), true);
  assert.equal(helpers.stripSignupDirectMarker('+961@$1379000000'), '+96179000000');
});

test('a normal signup still requires verification', () => {
  assert.equal(helpers.signupDirectRequested('tester@gmail.com', '+96179000000'), false);
});

test('signup route stores the cleaned email and phone', () => {
  const route = serverSrc.slice(serverSrc.indexOf("app.post('/auth/signup'"), serverSrc.indexOf("app.post('/auth/reset-start'"));
  assert.match(route, /signupDirectRequested\(email, phone\)/);
  assert.match(route, /stripSignupDirectMarker\(email\)/);
  assert.match(route, /stripSignupDirectMarker\(phone\)/);
  assert.match(route, /if \(!direct && !verifyOtp\(signupOtps, cleanEmail, otp\)\)/);
  assert.doesNotMatch(route, /directSignup|skipVerify|testAccount/);
});
