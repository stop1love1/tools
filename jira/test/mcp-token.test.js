'use strict';

// Tests for lib/mcp-token.js — bearer token that guards write MCP tools.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mkTemp, rmTemp, purge } = require('./_helpers');

let tmp;
test.before(() => {
  tmp = mkTemp();
  purge();
});
test.after(() => rmTemp(tmp));

const load = () => require('../lib/mcp-token');

test('getToken creates a 0600 file with the expected shape', () => {
  const { getToken, FILE } = load();
  const token = getToken();
  assert.match(token, /^[A-Za-z0-9_-]{32,}$/);
  assert.ok(fs.existsSync(FILE));
  const stat = fs.statSync(FILE);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(FILE, 'utf8').trim(), token);
});

test('getToken returns the same value across calls', () => {
  const { getToken } = load();
  const a = getToken();
  const b = getToken();
  assert.equal(a, b);
});

test('getToken survives a module reload (cached value stays valid)', () => {
  const m1 = require('../lib/mcp-token');
  const t1 = m1.getToken();
  delete require.cache[require.resolve('../lib/mcp-token')];
  const m2 = require('../lib/mcp-token');
  const t2 = m2.getToken();
  assert.equal(t1, t2);
});

test('isAuthorized accepts the right Bearer token', () => {
  const { getToken, isAuthorized } = load();
  const token = getToken();
  const req = { headers: { authorization: `Bearer ${token}` } };
  assert.equal(isAuthorized(req), true);
});

test('isAuthorized rejects a missing Authorization header', () => {
  const { isAuthorized } = load();
  assert.equal(isAuthorized({ headers: {} }), false);
});

test('isAuthorized rejects a wrong token', () => {
  const { getToken, isAuthorized } = load();
  const real = getToken();
  const wrong = real.replace(/[A-Z]/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.notEqual(wrong, real);
  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${wrong}` } }), false);
});

test('isAuthorized rejects a token of different length', () => {
  const { getToken, isAuthorized } = load();
  const real = getToken();
  const shorter = real.slice(0, real.length - 4);
  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${shorter}` } }), false);
  const longer = real + 'AAAA';
  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${longer}` } }), false);
});

test('getToken issues a new token after the file is deleted while running', () => {
  const { getToken, isAuthorized, FILE } = load();
  const before = getToken();
  fs.rmSync(FILE);
  const after = getToken();
  assert.notEqual(after, before);
  assert.equal(fs.readFileSync(FILE, 'utf8').trim(), after);
  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${before}` } }), false);
  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${after}` } }), true);
});

test('getToken regenerates when the file holds an invalid token', () => {
  const { getToken, FILE } = load();
  fs.writeFileSync(FILE, 'short\n', { mode: 0o600 });
  const token = getToken();
  assert.match(token, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(fs.readFileSync(FILE, 'utf8').trim(), token);
});

test('FILE points at DASHBOARD_MCP_TOKEN_FILE when set', () => {
  assert.equal(load().FILE, path.join(tmp, '.mcp-token'));
});
