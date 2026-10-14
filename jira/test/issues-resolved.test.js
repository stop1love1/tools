'use strict';

// listIssues(): resolutiondate is requested from Jira and exposed as `resolved` (null while the task is open).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { mkTemp, rmTemp } = require('./_helpers');

let tmp;
test.before(() => {
  tmp = mkTemp();
});
test.after(() => rmTemp(tmp));

function setupWith(searchAll) {
  const libDir = path.resolve(__dirname, '..', 'lib') + path.sep;
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
    exports: { callTool: async () => ({ fields: {} }), searchAll, resetSession: () => {}, toolErrorMessage: (m) => String(m || '') },
  };
  return require('../lib/issues');
}

const issue = (key, fields = {}) => ({ key, fields: { summary: key, issuetype: { name: 'Task' }, status: { name: 'To Do' }, ...fields } });

test('resolutiondate is part of the fields asked from Jira', async () => {
  let asked;
  const issues = setupWith(async (jql, fields) => ((asked = fields), []));
  await issues.listIssues('main');
  assert.ok(asked.includes('resolutiondate'));
});

test('a resolved task carries its resolution date, an open one gets null', async () => {
  const issues = setupWith(async () => [
    issue('VLEARN-1', { resolutiondate: '2026-10-12T04:30:00.000+0700' }),
    issue('VLEARN-2', { resolutiondate: null }),
    issue('VLEARN-3'),
  ]);
  const out = await issues.listIssues('main');
  assert.equal(out.find((i) => i.key === 'VLEARN-1').resolved, '2026-10-12T04:30:00.000+0700');
  assert.equal(out.find((i) => i.key === 'VLEARN-2').resolved, null);
  assert.equal(out.find((i) => i.key === 'VLEARN-3').resolved, null);
});
