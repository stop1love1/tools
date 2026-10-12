'use strict';

// Tests for the resolveEpic cache (TTL) in lib/issues.js, with lib/mcp.callTool stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTemp, rmTemp } = require('./_helpers');

let tmp;
test.before(() => {
  tmp = mkTemp();
});
test.after(() => rmTemp(tmp));

function setupWith(toolHandler) {
  const libDir = require('node:path').resolve(__dirname, '..', 'lib') + require('node:path').sep;
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(libDir)) delete require.cache[k];
  }
  require.cache[require.resolve('../lib/auth')] = {
    exports: {
      getCredential: async () => ({ token: 't', url: 'http://example/mcp', expiresAt: Date.now() + 60 * 60_000, source: 'own' }),
      LOGIN_HINT: '',
      startLogin: () => {},
      finishLogin: () => {},
      keepWarm: () => {},
      hasOwnSession: () => true,
    },
  };
  require.cache[require.resolve('../lib/mcp')] = {
    exports: {
      callTool: toolHandler,
      searchAll: async () => [],
      resetSession: () => {},
      toolErrorMessage: (m) => String(m || ''),
    },
  };
  return require('../lib/issues');
}

test('resolveEpic caches and does not refetch within the TTL', async () => {
  let calls = [];
  const issues = setupWith((name, args) => {
    calls.push({ name, args });
    const k = args.issueIdOrKey;
    if (k === 'VLEARN-1') {
      return { fields: { summary: 'a', issuetype: { name: 'Task' }, parent: { key: 'VLEARN-EPIC', fields: { issuetype: { name: 'Epic' } } } } };
    }
    return { fields: { summary: 'epic', issuetype: { name: 'Epic' } } };
  });
  const epic1 = await issues.resolveEpic('VLEARN-1');
  assert.equal(epic1, 'VLEARN-EPIC');
  assert.ok(calls.length > 0);
  const firstCount = calls.length;
  const epic2 = await issues.resolveEpic('VLEARN-1');
  assert.equal(epic2, 'VLEARN-EPIC');
  assert.equal(calls.length, firstCount, 'second call served from cache');
});

test('resolveEpic refetches after the TTL (10 minutes)', async () => {
  let calls = [];
  const issues = setupWith((name, args) => {
    calls.push({ name, args });
    const k = args.issueIdOrKey;
    if (k === 'VLEARN-2') {
      return { fields: { summary: 'a', issuetype: { name: 'Task' }, parent: { key: 'VLEARN-2-EPIC', fields: { issuetype: { name: 'Epic' } } } } };
    }
    return { fields: { summary: 'epic', issuetype: { name: 'Epic' } } };
  });
  const realNow = Date.now;
  const base = realNow();
  try {
    Date.now = () => base;
    await issues.resolveEpic('VLEARN-2');
    const first = calls.length;
    // Past the 10-minute TTL.
    Date.now = () => base + 10 * 60_000 + 1;
    await issues.resolveEpic('VLEARN-2');
    assert.ok(calls.length > first, 'cache expired and refetched');
  } finally {
    Date.now = realNow;
  }
});
