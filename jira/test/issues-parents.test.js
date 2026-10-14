'use strict';

// listIssues(): the parents of the listed issues are fetched in batches (one search per 50), not one getJiraIssue each,
// because every MCP call counts against Atlassian's rate limit.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { mkTemp, rmTemp } = require('./_helpers');

let tmp;
test.before(() => {
  tmp = mkTemp();
});
test.after(() => rmTemp(tmp));

function setupWith({ searchAll, callTool }) {
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
    exports: { callTool, searchAll, resetSession: () => {}, toolErrorMessage: (m) => String(m || '') },
  };
  return require('../lib/issues');
}

const parentOf = (key, type = 'Story') => ({ key, fields: { summary: key, issuetype: { name: type } } });
const issue = (key, type, fields = {}) => ({ key, fields: { summary: key, issuetype: { name: type }, status: { name: 'To Do' }, ...fields } });

test('parents outside the list are fetched with one search, not one getJiraIssue each', async () => {
  const searches = [];
  const calls = [];
  const issues = setupWith({
    callTool: async (name, args) => (calls.push({ name, args }), { fields: {} }),
    searchAll: async (jql, fields) => {
      searches.push({ jql, fields });
      if (jql === 'main') return [1, 2, 3].map((n) => issue(`VLEARN-${n}`, 'Task', { parent: parentOf(`VLEARN-${n <= 2 ? 10 : 11}`) }));
      if (jql.startsWith('key in (')) return [issue('VLEARN-10', 'Story', { parent: parentOf('VLEARN-100', 'Epic') }), issue('VLEARN-11', 'Story')];
      return [];
    },
  });
  const out = await issues.listIssues('main');
  const parentSearches = searches.filter((s) => s.jql.startsWith('key in ('));
  assert.equal(parentSearches.length, 1, 'one batched search for both parents');
  assert.equal(parentSearches[0].jql, 'key in (VLEARN-10,VLEARN-11)');
  assert.deepEqual(parentSearches[0].fields, ['description', 'parent']);
  assert.equal(calls.filter((c) => c.name === 'getJiraIssue').length, 0, 'no per-parent calls');
  // The grandparent from the batched result still gives a sub-task its Epic.
  assert.equal(out.find((i) => i.key === 'VLEARN-1').epic.key, 'VLEARN-100');
});

test('more than 50 parents are split into several searches', async () => {
  const searches = [];
  const keys = Array.from({ length: 120 }, (_, i) => `VLEARN-${1000 + i}`);
  const issues = setupWith({
    callTool: async () => ({ fields: {} }),
    searchAll: async (jql) => {
      searches.push(jql);
      if (jql === 'main') return keys.map((k, i) => issue(`VLEARN-${i + 1}`, 'Task', { parent: parentOf(k) }));
      return [];
    },
  });
  await issues.listIssues('main');
  const batches = searches.filter((j) => j.startsWith('key in ('));
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((j) => j.split(',').length), [50, 50, 20]);
});

test('when the batch is rejected (a parent is not visible), it falls back to one call per parent', async () => {
  const calls = [];
  const issues = setupWith({
    callTool: async (name, args) => {
      calls.push(args.issueIdOrKey);
      if (args.issueIdOrKey === 'VLEARN-11') throw new Error('no access');
      return { fields: { description: null } };
    },
    searchAll: async (jql) => {
      if (jql === 'main') return [issue('VLEARN-1', 'Task', { parent: parentOf('VLEARN-10') }), issue('VLEARN-2', 'Task', { parent: parentOf('VLEARN-11') })];
      if (jql.startsWith('key in (')) throw new Error('An issue with key VLEARN-11 does not exist');
      return [];
    },
  });
  const out = await issues.listIssues('main');
  assert.deepEqual(calls.sort(), ['VLEARN-10', 'VLEARN-11']);
  assert.equal(out.length, 2, 'the list still renders');
});
