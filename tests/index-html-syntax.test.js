'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const indexPath = path.join(__dirname, '..', 'index.html');

function extractInlineScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html must contain one inline <script> block');
  return match[1];
}

test('staff login is a single form and submits from the password field', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  assert.equal(html.includes('Backup admin'), false);
  assert.equal(html.includes('id="admin2-pass"'), false);
  assert.equal(html.includes('doAdmin2Login'), false);
  assert.match(html, /id="admin-login-form"/);
  assert.match(html, /id="admin-pass"[^>]*onkeydown="if\(event\.key==='Enter'\)\{event\.preventDefault\(\);doAdminLogin\(\);\}"/);
});

test('index.html inline JavaScript parses without syntax errors', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  const js = extractInlineScript(html);
  const tmp = path.join(__dirname, '.index-inline.js');
  fs.writeFileSync(tmp, js);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});
