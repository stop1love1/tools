'use strict';

// listNotifications(): an issue whose `updated` did not change since the last refresh is not fetched again
// (every getJiraIssue counts against Atlassian's rate limit); its earlier events are reused.

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
  return require('../lib/notifications');
}

const ME = 'me-id';
const now = () => new Date().toISOString();

// An issue with one comment from someone else.
const jiraIssue = (key, commentId) => ({
  fields: {
    summary: key,
    issuetype: { name: 'Task' },
    comment: { comments: [{ id: commentId, created: now(), author: { accountId: 'other', displayName: 'Other' }, body: { type: 'doc', content: [] } }] },
  },
  changelog: { histories: [] },
});

function harness(updatedOf) {
  const fetched = [];
  const mod = setupWith({
    searchAll: async () => ['VLEARN-1', 'VLEARN-2'].map((key) => ({ key, fields: { summary: key, updated: updatedOf(key) } })),
    callTool: async (name, args) => {
      if (name === 'atlassianUserInfo') return { account_id: ME };
      fetched.push(args.issueIdOrKey);
      return jiraIssue(args.issueIdOrKey, `c-${args.issueIdOrKey}-${fetched.length}`);
    },
  });
  return { mod, fetched };
}

test('an unchanged issue is not fetched again and keeps its events', async () => {
  const { mod, fetched } = harness(() => '2026-10-14T01:00:00.000+0000');
  const first = await mod.listNotifications();
  assert.deepEqual(fetched.sort(), ['VLEARN-1', 'VLEARN-2']);
  assert.equal(first.events.length, 2);

  mod.invalidate();
  const second = await mod.listNotifications();
  assert.equal(fetched.length, 2, 'no getJiraIssue on the second refresh');
  assert.deepEqual(second.events.map((e) => e.id).sort(), first.events.map((e) => e.id).sort());
});

test('only the issue whose `updated` changed is fetched again', async () => {
  let u2 = '2026-10-14T01:00:00.000+0000';
  const { mod, fetched } = harness((key) => (key === 'VLEARN-2' ? u2 : '2026-10-14T01:00:00.000+0000'));
  await mod.listNotifications();
  fetched.length = 0;

  u2 = '2026-10-14T02:00:00.000+0000';
  mod.invalidate();
  await mod.listNotifications();
  assert.deepEqual(fetched, ['VLEARN-2']);
});

test('without an `updated` value the issue is always fetched', async () => {
  const { mod, fetched } = harness(() => undefined);
  await mod.listNotifications();
  fetched.length = 0;
  mod.invalidate();
  await mod.listNotifications();
  assert.deepEqual(fetched.sort(), ['VLEARN-1', 'VLEARN-2']);
});

test('the 60 second cache still answers without any call', async () => {
  const { mod, fetched } = harness(() => '2026-10-14T01:00:00.000+0000');
  await mod.listNotifications();
  const before = fetched.length;
  await mod.listNotifications();
  assert.equal(fetched.length, before);
});
