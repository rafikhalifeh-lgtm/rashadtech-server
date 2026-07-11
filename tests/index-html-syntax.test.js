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
