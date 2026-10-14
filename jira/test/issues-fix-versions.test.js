'use strict';

// listIssues(): fixVersions are requested from Jira and mapped onto each issue; a task without one gets an empty list.

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

test('fixVersions is part of the fields asked from Jira', async () => {
  let asked;
  const issues = setupWith(async (jql, fields) => ((asked = fields), []));
  await issues.listIssues('main');
  assert.ok(asked.includes('fixVersions'));
});

test('a task with fix versions carries them, one without gets an empty list', async () => {
  const issues = setupWith(async () => [
    issue('VLEARN-1', { fixVersions: [{ id: '10', name: 'v1.2.0', released: false, releaseDate: '2026-11-01' }, { id: '11', name: 'v1.1.0', released: true }] }),
    issue('VLEARN-2'),
  ]);
  const out = await issues.listIssues('main');
  assert.deepEqual(out.find((i) => i.key === 'VLEARN-1').fixVersions, [
    { id: '10', name: 'v1.2.0', released: false, releaseDate: '2026-11-01' },
    { id: '11', name: 'v1.1.0', released: true, releaseDate: null },
  ]);
  assert.deepEqual(out.find((i) => i.key === 'VLEARN-2').fixVersions, []);
});
