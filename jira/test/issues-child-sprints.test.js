'use strict';

// listIssues(): an Epic's childSprints come only from children that are in the list, never from other people's tasks.

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
    exports: {
      callTool: async () => ({ fields: {} }),
      searchAll,
      resetSession: () => {},
      toolErrorMessage: (m) => String(m || ''),
    },
  };
  return require('../lib/issues');
}

const epicParent = { key: 'VLEARN-100', fields: { summary: 'Epic', issuetype: { name: 'Epic' } } };
const sprint = (id) => ({ id, name: `Sprint ${id}`, state: 'active' });
const issue = (key, type, fields = {}) => ({ key, fields: { summary: key, issuetype: { name: type }, status: { name: 'To Do' }, ...fields } });

test('an Epic takes the sprints of its listed children only, not of other people\'s tasks', async () => {
  const mine = issue('VLEARN-1', 'Task', { parent: epicParent, sprint: sprint(1) });
  const epic = issue('VLEARN-100', 'Epic');
  const issues = setupWith(async (jql) => {
    if (jql === 'main') return [epic, mine];
    if (jql.startsWith('parent in (VLEARN-100)')) {
      return [
        issue('VLEARN-1', 'Task', { parent: epicParent, sprint: sprint(1) }),
        issue('VLEARN-2', 'Task', { parent: epicParent, sprint: sprint(2) }), // someone else's, not in the list
      ];
    }
    return [];
  });
  const out = await issues.listIssues('main');
  assert.deepEqual(out.find((i) => i.key === 'VLEARN-100').childSprints.map((s) => s.id), [1]);
});

test('an Epic with no listed child in a sprint gets no childSprints', async () => {
  const epic = issue('VLEARN-100', 'Epic');
  const issues = setupWith(async (jql) => {
    if (jql === 'main') return [epic];
    if (jql.startsWith('parent in (VLEARN-100)')) return [issue('VLEARN-2', 'Task', { parent: epicParent, sprint: sprint(2) })];
    return [];
  });
  const out = await issues.listIssues('main');
  assert.equal(out.find((i) => i.key === 'VLEARN-100').childSprints, undefined);
});
