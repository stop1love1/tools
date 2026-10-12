'use strict';

// Tests for ISSUE_KEY_RE in lib/util.js.

const test = require('node:test');
const assert = require('node:assert/strict');

test('ISSUE_KEY_RE accepts VLEARN-123 and similar', () => {
  const { ISSUE_KEY_RE } = require('../lib/util');
  assert.ok(ISSUE_KEY_RE.test('VLEARN-123'));
  assert.ok(ISSUE_KEY_RE.test('ABC-1'));
  assert.ok(ISSUE_KEY_RE.test('PROJ_KEY-99999'));
});

test('ISSUE_KEY_RE rejects lowercase, no number, spaces, and other shapes', () => {
  const { ISSUE_KEY_RE } = require('../lib/util');
  const bad = ['vlearn-123', 'VLEARN-', 'VLEARN', 'VLEARN 123', 'VLEARN-12A', '12345', '-', '', 'VLEARN-12 ', ' VLEARN-12'];
  for (const s of bad) assert.equal(ISSUE_KEY_RE.test(s), false, `expected ${JSON.stringify(s)} to be rejected`);
});
