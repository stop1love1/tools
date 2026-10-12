'use strict';

// Tests for the /mcp JSON-RPC handler in lib/mcp-server.js. Issues, git and MR modules are stubbed,
// so these cover the RPC layer, the token check, write / destructive gating, annotations and truncation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mkTemp, rmTemp, purge, FakeRes, fakeReq } = require('./_helpers');

let tmp;

test.before(() => {
  tmp = mkTemp();
  purge();
});

test.after(() => rmTemp(tmp));

async function call(handle, req) {
  const res = new FakeRes();
  await handle(req, res);
  return res;
}

function loadServer(opts) {
  opts = opts || {};
  const allowWrites = !!opts.allowWrites;
  const allowDestructive = !!opts.allowDestructive;
  const disabled = !!opts.disabled;

  const cfg = { mcp: { enabled: !disabled, allowWrites, allowDestructive } };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
  purge();

  const issuesStub = {
    listIssues: async () => [],
    issueDetail: async (key) => ({
      issue: {
        key,
        url: `https://example/browse/${key}`,
        summary: 'stubbed',
        type: { name: 'Task', subtask: false },
        status: { id: '1', name: 'Open', category: 'indeterminate' },
        priority: 'Medium',
        project: null,
        created: '2024-01-01',
        updated: '2024-01-02',
        due: null,
        labels: [],
        sprint: null,
        storyPoints: null,
        parent: null,
        docs: [],
        attachments: [{ id: 1, filename: 'a.png', size: 10, mimeType: 'image/png', created: 'now', author: 'me', url: '/api/attachments/1/a.png' }],
      },
      assignee: null, reporter: null, children: [], comments: [], descriptionHtml: '', confluence: [], links: [],
    }),
    listTransitions: async () => [],
    doTransition: async () => ({ status: { name: 'Done' } }),
    resolveEpic: async (k) => k,
    ticketSummary: () => '',
    sprintsOf: async () => new Map(),
  };
  require.cache[require.resolve('../lib/issues')] = { exports: issuesStub };

  const gitStub = {
    _jobs: new Map(),
    actionNames: ['fetch'],
    startAction: (body) => {
      const id = 'job-' + Math.random().toString(36).slice(2, 10);
      gitStub._jobs.set(id, { id, title: 'fetch', status: 'ok', result: null, error: null, log: [] });
      return { id };
    },
  };
  require.cache[require.resolve('../lib/git')] = { exports: gitStub };

  const jobsStub = {
    getJob: (id) => gitStub._jobs.get(id) || { id, title: 'fetch', status: 'ok', result: null, error: null, log: [] },
    listJobs: () => [],
    startJob: () => ({}),
  };
  require.cache[require.resolve('../lib/git/jobs')] = { exports: jobsStub };

  const notificationsStub = {
    listNotifications: async () => ({ days: 7, events: [] }),
    invalidate: () => {},
  };
  require.cache[require.resolve('../lib/notifications')] = { exports: notificationsStub };

  const gitReadStub = {
    overview: async () => ({ repos: {} }),
    flow: async (key) => ({ key, epic: key, repos: {} }),
    epicView: async (key) => ({ key, repos: {} }),
    branches: async (repo) => ({ repo, branches: [], backups: { total: 0, old: 0, days: 14 } }),
  };
  require.cache[require.resolve('../lib/git/read')] = { exports: gitReadStub };

  const mrStub = {
    createMergeRequest: async () => ({ url: 'https://x', iid: 1, source: 's', target: 't', title: 't', created: true }),
    MR_KINDS: { 'task-epic': 1, 'epic-uat': 2, develop: 3 },
  };
  require.cache[require.resolve('../lib/git/merge-requests')] = { exports: mrStub };

  const { handleMcp } = require('../lib/mcp-server');
  return { handleMcp, gitStub, issuesStub };
}

function readToken() {
  return fs.readFileSync(path.join(tmp, '.mcp-token'), 'utf8').trim();
}

function makeToken() {
  return require('../lib/mcp-token').getToken();
}

test('initialize returns a protocol version and serverInfo', async () => {
  const { handleMcp } = loadServer();
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } }));
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, 1);
  assert.equal(body.result.protocolVersion, '2025-06-18');
  assert.equal(body.result.serverInfo.name, 'jira-dashboard');
});

test('initialize falls back to the first supported protocol when given an unknown one', async () => {
  const { handleMcp } = loadServer();
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '9999-01-01' } } }));
  assert.equal(res.json().result.protocolVersion, '2025-06-18');
});

test('ping responds with empty result', async () => {
  const { handleMcp } = loadServer();
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 3, method: 'ping' } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().result, {});
});

test('unknown method with id returns -32601', async () => {
  const { handleMcp } = loadServer();
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 4, method: 'no/such/method' } }));
  const body = res.json();
  assert.equal(body.error.code, -32601);
});

test('notification (no id) responds with 202 and no body', async () => {
  const { handleMcp } = loadServer();
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', method: 'notifications/initialized' } }));
  assert.equal(res.statusCode, 202);
  assert.equal(res.body, '');
});

test('tools/list: read tools are readOnlyHint=true; with allowWrites=false write tools are absent', async () => {
  const { handleMcp } = loadServer({ allowWrites: false });
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 5, method: 'tools/list' } }));
  const tools = res.json().result.tools;
  const names = tools.map((t) => t.name);
  assert.ok(!names.includes('transition_issue'));
  assert.ok(!names.includes('create_merge_request'));
  assert.ok(!names.includes('run_git_action'));
  const listIssues = tools.find((t) => t.name === 'list_issues');
  assert.equal(listIssues.annotations.readOnlyHint, true);
});

test('tools/list: allowWrites=true exposes writes with the right hints', async () => {
  const { handleMcp } = loadServer({ allowWrites: true });
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 6, method: 'tools/list' } }));
  const tools = res.json().result.tools;
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('transition_issue'));
  assert.ok(names.includes('create_merge_request'));
  assert.ok(names.includes('run_git_action'));
  const runGit = tools.find((t) => t.name === 'run_git_action');
  assert.equal(runGit.annotations.readOnlyHint, false);
  assert.equal(runGit.annotations.destructiveHint, true);
  assert.ok(names.includes('list_git_jobs'));
  assert.equal(tools.find((t) => t.name === 'list_git_jobs').annotations.readOnlyHint, true);
});

test('tools/call on a write tool without Bearer returns JSON-RPC error code -32001', async () => {
  const { handleMcp } = loadServer({ allowWrites: true });
  makeToken();
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'transition_issue', arguments: { key: 'VLEARN-1', transition: 'Done' } } } }));
  const body = res.json();
  assert.equal(body.error.code, -32001);
});

test('tools/call with the right Bearer on a write tool proceeds past the token check', async () => {
  const { handleMcp } = loadServer({ allowWrites: true });
  const token = makeToken();
  const res = await call(handleMcp, fakeReq({ headers: { authorization: 'Bearer ' + token }, body: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'transition_issue', arguments: { key: 'VLEARN-1', transition: 'Done' } } } }));
  const body = res.json();
  assert.equal(body.error, undefined, JSON.stringify(body));
  const text = body.result.content.map((c) => c.text).join('');
  assert.ok(text.includes('VLEARN-1'));
});

test('run_git_action undo is refused with a 403-style error when allowDestructive=false', async () => {
  const { handleMcp } = loadServer({ allowWrites: true, allowDestructive: false });
  const token = makeToken();
  const res = await call(handleMcp, fakeReq({ headers: { authorization: 'Bearer ' + token }, body: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'run_git_action', arguments: { action: 'undo' } } } }));
  const body = res.json();
  assert.ok(!body.error);
  const text = body.result.content.map((c) => c.text).join('');
  assert.match(text, /Error: /);
  assert.match(text, /Allow destructive/i);
  assert.ok(body.result.isError);
});

test('run_git_action with force=true push is also refused when allowDestructive=false', async () => {
  const { handleMcp } = loadServer({ allowWrites: true, allowDestructive: false });
  const token = makeToken();
  const res = await call(handleMcp, fakeReq({ headers: { authorization: 'Bearer ' + token }, body: { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'run_git_action', arguments: { action: 'push', params: { force: true } } } } }));
  const body = res.json();
  const text = body.result.content.map((c) => c.text).join('');
  assert.match(text, /Allow destructive/i);
});

test('run_git_action fetch (non-destructive) is allowed when allowDestructive=false', async () => {
  const { handleMcp, gitStub } = loadServer({ allowWrites: true, allowDestructive: false });
  const token = makeToken();
  let startCalled = false;
  const orig = gitStub.startAction;
  gitStub.startAction = (body) => { startCalled = true; return orig(body); };
  const res = await call(handleMcp, fakeReq({ headers: { authorization: 'Bearer ' + token }, body: { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'run_git_action', arguments: { action: 'fetch', repo: 'backend' } } } }));
  const body = res.json();
  assert.equal(body.error, undefined, JSON.stringify(body));
  assert.equal(startCalled, true);
});

test('batch containing null / number / object-without-method returns -32600 entries', async () => {
  const { handleMcp } = loadServer();
  const res = await call(handleMcp, fakeReq({ body: [null, 42, { id: 5 }] }));
  const replies = res.json();
  assert.ok(Array.isArray(replies));
  assert.equal(replies.length, 3);
  for (const r of replies) {
    assert.equal(r.jsonrpc, '2.0');
    assert.equal(r.error.code, -32600);
  }
  assert.equal(replies[2].id, 5);
});

test('empty array batch -> parse error -32700', async () => {
  const { handleMcp } = loadServer();
  const res = await call(handleMcp, fakeReq({ body: [] }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, -32700);
});

test('invalid JSON body -> parse error -32700', async () => {
  const { handleMcp } = loadServer();
  const res = await call(handleMcp, fakeReq({ body: 'not-json' }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, -32700);
});

test('disallowed Origin -> 403', async () => {
  const { handleMcp } = loadServer();
  const res = await call(handleMcp, fakeReq({ headers: { origin: 'http://localhost:1' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } }));
  assert.equal(res.statusCode, 403);
});

test('allowed Origin (http://localhost:<server.port>) passes the check', async () => {
  const { handleMcp } = loadServer();
  const config = require('../lib/config');
  const port = config.startupValue('server.port');
  const res = await call(handleMcp, fakeReq({ headers: { origin: 'http://localhost:' + port }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } }));
  assert.equal(res.statusCode, 200);
});

test('non-POST -> 405 with Allow header', async () => {
  const { handleMcp } = loadServer();
  const res = await call(handleMcp, fakeReq({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'POST');
});

test('wrong Content-Type -> 415', async () => {
  const { handleMcp } = loadServer();
  const req = fakeReq({ headers: { 'content-type': 'text/plain' }, body: 'hi' });
  const res = await call(handleMcp, req);
  assert.equal(res.statusCode, 415);
});

test('MCP disabled -> 404', async () => {
  const { handleMcp } = loadServer({ disabled: true });
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 1, method: 'ping' } }));
  assert.equal(res.statusCode, 404);
});

test('get_issue returns attachment URLs as absolute http://localhost:<port>/api/attachments/...', async () => {
  const { handleMcp } = loadServer({ allowWrites: true });
  const config = require('../lib/config');
  const port = config.startupValue('server.port');
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_issue', arguments: { key: 'VLEARN-1' } } } }));
  const body = res.json();
  const text = body.result.content.map((c) => c.text).join('');
  assert.match(text, new RegExp('http://localhost:' + port + '/api/attachments/'));
});

test('render truncates a tool result longer than 60000 chars', async () => {
  const { handleMcp } = loadServer();
  const gitReadMod = require('../lib/git/read');
  gitReadMod.overview = async () => ({ long: 'a'.repeat(70_000) });
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'git_overview' } } }));
  const text = res.json().result.content.map((c) => c.text).join('');
  assert.ok(text.includes('truncated'), 'should include the truncation note');
});

test('list_issues sets truncated=true when more rows than limit exist', async () => {
  const { handleMcp } = loadServer();
  const issuesMod = require('../lib/issues');
  const dummy = [];
  for (let i = 0; i < 250; i++) {
    dummy.push({
      key: 'X-' + i,
      url: 'https://example/X-' + i,
      summary: 'a',
      type: { name: 't', subtask: false },
      status: { id: '1', name: 'o', category: 'indeterminate' },
      priority: 'p',
      project: null,
      created: '2024-01-01',
      updated: '2024-01-02',
      due: null,
      labels: [],
      sprint: null,
      storyPoints: null,
      parent: null,
      docs: [],
      attachments: [],
    });
  }
  issuesMod.listIssues = async () => dummy;
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_issues', arguments: { limit: 100 } } } }));
  const text = res.json().result.content.map((c) => c.text).join('');
  const parsed = JSON.parse(text);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.issues.length, 100);
});

test('get_git_job and list_git_jobs need the token even though they are read-only', async () => {
  const { handleMcp } = loadServer({ allowWrites: false });
  const token = makeToken();
  for (const [name, args] of [['get_git_job', { id: 'abc' }], ['list_git_jobs', {}]]) {
    const denied = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }));
    assert.equal(denied.json().error.code, -32001, `${name} without token`);
    const allowed = await call(handleMcp, fakeReq({ headers: { authorization: 'Bearer ' + token }, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } } }));
    assert.equal(allowed.json().error, undefined, `${name} with token`);
  }
});

test('run_git_action push without force is not gated by allowDestructive', async () => {
  const { handleMcp } = loadServer({ allowWrites: true, allowDestructive: false });
  const token = makeToken();
  const res = await call(handleMcp, fakeReq({ headers: { authorization: 'Bearer ' + token }, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_git_action', arguments: { action: 'push', repo: 'backend', params: { branch: 'x', force: false } } } } }));
  const text = res.json().result.content.map((c) => c.text).join('');
  assert.doesNotMatch(text, /Allow destructive/i);
});

test('prompts/get returns the start prompt; unknown name returns -32602', async () => {
  const { handleMcp } = loadServer();
  const res = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'start', arguments: { key: 'VLEARN-1' } } } }));
  assert.equal(res.json().error, undefined);
  const res2 = await call(handleMcp, fakeReq({ body: { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'no-such-prompt' } } }));
  assert.equal(res2.json().error.code, -32602);
});
