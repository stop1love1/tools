'use strict';

// listIssues(): an Epic's childSprints come only from children that are in the list, never from other people's tasks.
// listSprint(): sub-tasks of the sprint come in through their parents.

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

// listSprint(): JQL "sprint in" leaves sub-tasks out, so my sub-tasks updated since a month before the sprint
// started are searched and kept when in it.
test('listSprint adds my sub-tasks in the sprint, and keeps the sprint with its dates', async () => {
  const s = { id: 9, name: 'Sprint 9', state: 'closed', startDate: '2026-09-21T00:00:00Z', endDate: '2026-10-05T00:00:00Z', completeDate: '2026-10-06T00:00:00Z' };
  const seen = [];
  const issues = setupWith(async (jql) => {
    seen.push(jql);
    if (jql === 'ME AND sprint in (9)') return [issue('VLEARN-11', 'Bug', { sprint: [s] })];
    if (jql.startsWith('ME AND issuetype in subTaskIssueTypes()')) {
      return [
        issue('VLEARN-12', 'Subtask', { parent: { key: 'VLEARN-10' }, sprint: [s, sprint(10)] }),
        issue('VLEARN-13', 'Subtask', { parent: { key: 'VLEARN-10' }, sprint: [sprint(10)] }), // only in a later sprint
        issue('VLEARN-14', 'Subtask', { parent: { key: 'VLEARN-10' } }), // in no sprint
      ];
    }
    return [];
  });
  const out = await issues.listSprint(9, (jql) => jql.replace('assignee = currentUser()', 'ME'));
  assert.deepEqual(out.issues.map((i) => i.key), ['VLEARN-11', 'VLEARN-12']);
  assert.deepEqual(out.issues[1].sprintIds, [9, 10]);
  assert.equal(out.sprint.completeDate, s.completeDate);
  assert.ok(seen.includes('ME AND issuetype in subTaskIssueTypes() AND updated >= "2026-08-22"'), seen.join(' | '));
});

test('listSprints searches several sprints together and shares the answer', async () => {
  const a = { id: 1, name: 'Sprint 1', state: 'closed', startDate: '2026-09-01T00:00:00Z' };
  const b = { id: 2, name: 'Sprint 2', state: 'active', startDate: '2026-09-15T00:00:00Z' };
  const seen = [];
  const issues = setupWith(async (jql) => {
    seen.push(jql);
    if (jql === 'ME AND sprint in (1,2)') return [issue('VLEARN-1', 'Story', { sprint: [a] }), issue('VLEARN-2', 'Bug', { sprint: [a, b] })];
    return [];
  });
  const forUser = (jql) => jql.replace('assignee = currentUser()', 'ME');
  const out = await issues.listSprints([2, 1], forUser);
  assert.deepEqual(out.sprints.map((s) => s.id), [1, 2]);
  assert.deepEqual(out.issues.map((i) => i.key), ['VLEARN-1', 'VLEARN-2']);
  const calls = seen.length;
  await issues.listSprints([1, 2], forUser);
  assert.equal(seen.length, calls, 'the second ask is answered from the cache');
});
