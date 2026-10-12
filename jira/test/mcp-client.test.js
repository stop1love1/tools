'use strict';

// Tests for the Atlassian MCP client in lib/mcp.js, with global fetch replaced by a mock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mkTemp, rmTemp, purge } = require('./_helpers');

let tmp;
let originalFetch;

test.before(() => {
  tmp = mkTemp();
  purge();
  originalFetch = global.fetch;
});
test.after(() => {
  global.fetch = originalFetch;
  rmTemp(tmp);
});

// Just enough of a fetch Response: status, headers.get, text, json.
function mkRes({ status = 200, headers = {}, body = '' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (headers[k] != null ? String(headers[k]) : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function installFetch(handler) {
  const calls = [];
  global.fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(handler(calls.length - 1, { url, init }));
  };
  return calls;
}

// A valid own OAuth grant, so getCredential needs no network.
function writeOwnCred() {
  const file = path.join(tmp, '.oauth.json');
  fs.writeFileSync(file, JSON.stringify({
    clientId: 'cid',
    accessToken: 'tok',
    refreshToken: 'rt',
    expiresAt: Date.now() + 3600_000,
  }));
}

function loadMcp() {
  // Reload so session state and env-driven paths start fresh.
  delete require.cache[require.resolve('../lib/mcp')];
  delete require.cache[require.resolve('../lib/auth')];
  delete require.cache[require.resolve('../lib/config')];
  return require('../lib/mcp');
}

test('concurrent callTool calls when no session exists open exactly ONE session', async () => {
  writeOwnCred();
  const calls = installFetch((i, { init }) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      return mkRes({ status: 200, headers: { 'mcp-session-id': 'sess-xyz' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) });
    }
    return mkRes({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: '{}' }] } }) });
  });
  const mcp = loadMcp();
  mcp.resetSession();
  const out = await Promise.all(Array.from({ length: 8 }, () => mcp.callTool('getJiraIssue', { issueIdOrKey: 'VLEARN-1' })));
  assert.equal(out.length, 8);
  const initCount = calls.filter((c) => JSON.parse(c.init.body).method === 'initialize').length;
  assert.equal(initCount, 1, 'should call initialize exactly once');
});

test('after initialize, tools/call requests carry the right Mcp-Session-Id and MCP-Protocol-Version headers', async () => {
  writeOwnCred();
  const calls = installFetch((i, { init }) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      return mkRes({ status: 200, headers: { 'mcp-session-id': 's-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-03-26' } }) });
    }
    return mkRes({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: '{}' }] } }) });
  });
  const mcp = loadMcp();
  mcp.resetSession();
  await mcp.callTool('getJiraIssue', { issueIdOrKey: 'VLEARN-1' });
  const toolsCall = calls.filter((c) => JSON.parse(c.init.body).method === 'tools/call')[0];
  assert.ok(toolsCall, 'tools/call should have been made');
  const h = toolsCall.init.headers;
  assert.equal(h['Mcp-Session-Id'], 's-1');
  assert.equal(h['MCP-Protocol-Version'], '2025-03-26');
});

test('a read tool retries on HTTP 503 with exponential backoff then succeeds', async () => {
  writeOwnCred();
  let toolsCallCount = 0;
  installFetch((i, { init }) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      return mkRes({ status: 200, headers: { 'mcp-session-id': 's-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) });
    }
    if (req.method === 'tools/call') {
      toolsCallCount++;
      if (toolsCallCount === 1) return mkRes({ status: 503, body: 'Service Unavailable' });
      return mkRes({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: '{"ok":1}' }] } }) });
    }
    return mkRes({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) });
  });
  const mcp = loadMcp();
  mcp.resetSession();
  const data = await mcp.callTool('getJiraIssue', { issueIdOrKey: 'VLEARN-1' });
  assert.deepEqual(data, { ok: 1 });
  assert.equal(toolsCallCount, 2);
});

test('a read tool retries on HTTP 429 with Retry-After', async () => {
  writeOwnCred();
  let toolsCallCount = 0;
  let waitedMs = 0;
  const realSetTimeout = setTimeout;
  global.setTimeout = (fn, ms, ...rest) => { if (typeof ms === 'number' && ms > 0) waitedMs += ms; return realSetTimeout(fn, 0, ...rest); };
  try {
    installFetch((i, { init }) => {
      const req = JSON.parse(init.body);
      if (req.method === 'initialize') {
        return mkRes({ status: 200, headers: { 'mcp-session-id': 's-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) });
      }
      if (req.method === 'tools/call') {
        toolsCallCount++;
        if (toolsCallCount === 1) return mkRes({ status: 429, headers: { 'retry-after': '0' }, body: '{}' });
        return mkRes({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: '{"ok":2}' }] } }) });
      }
      return mkRes({ status: 200, body: '{}' });
    });
    const mcp = loadMcp();
    mcp.resetSession();
    const data = await mcp.callTool('getJiraIssue', { issueIdOrKey: 'VLEARN-1' });
    assert.deepEqual(data, { ok: 2 });
    assert.equal(toolsCallCount, 2);
    // Retry-After: 0 is ignored, so the wait is the first backoff step (500 ms + up to 250 ms jitter).
    assert.ok(waitedMs <= 1100, `waited ${waitedMs} ms`);
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test('a write tool is NOT retried on HTTP 503', async () => {
  writeOwnCred();
  let toolsCallCount = 0;
  installFetch((i, { init }) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      return mkRes({ status: 200, headers: { 'mcp-session-id': 's-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) });
    }
    if (req.method === 'tools/call') {
      toolsCallCount++;
      return mkRes({ status: 503, body: 'Service Unavailable' });
    }
    return mkRes({ status: 200, body: '{}' });
  });
  const mcp = loadMcp();
  mcp.resetSession();
  await assert.rejects(
    () => mcp.callTool('transitionJiraIssue', { issueIdOrKey: 'VLEARN-1', transition: '11' }),
    /HTTP 503|MCP .* failed/i,
  );
  assert.equal(toolsCallCount, 1, 'write tool not retried');
});

test('a 404 on tools/call reopens a session once and succeeds', async () => {
  writeOwnCred();
  let toolsCallCount = 0;
  let initCount = 0;
  installFetch((i, { init }) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      initCount++;
      return mkRes({ status: 200, headers: { 'mcp-session-id': 's-' + initCount }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) });
    }
    if (req.method === 'tools/call') {
      toolsCallCount++;
      if (toolsCallCount === 1) return mkRes({ status: 404, body: '' });
      return mkRes({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: '{"after":true}' }] } }) });
    }
    return mkRes({ status: 200, body: '{}' });
  });
  const mcp = loadMcp();
  mcp.resetSession();
  const data = await mcp.callTool('getJiraIssue', { issueIdOrKey: 'VLEARN-1' });
  assert.deepEqual(data, { after: true });
  assert.equal(initCount, 2, 'session reopened exactly once');
});

test('concurrency cap: with 20 simultaneous calls and an in-flight tracker, max in-flight never exceeds 6', async () => {
  writeOwnCred();
  let inFlight = 0;
  let max = 0;
  installFetch((i, { init }) => {
    inFlight++;
    max = Math.max(max, inFlight);
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight--;
          resolve(mkRes({ status: 200, headers: { 'mcp-session-id': 's-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) }));
        }, 5);
      });
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight--;
        resolve(mkRes({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: '{}' }] } }) }));
      }, 20);
    });
  });
  const mcp = loadMcp();
  mcp.resetSession();
  await Promise.all(Array.from({ length: 20 }, () => mcp.callTool('getJiraIssue', { issueIdOrKey: 'VLEARN-1' })));
  assert.ok(max <= 6, 'max in-flight was ' + max);
  assert.ok(max >= 2, 'expected some parallelism');
});

test('searchAll throws when the tool result is plain text', async () => {
  writeOwnCred();
  installFetch((i, { init }) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      return mkRes({ status: 200, headers: { 'mcp-session-id': 's-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) });
    }
    if (req.method === 'tools/call' && req.params?.name === 'searchJiraIssuesUsingJql') {
      return mkRes({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'no JSON here' }] } }) });
    }
    return mkRes({ status: 200, body: '{}' });
  });
  const mcp = loadMcp();
  mcp.resetSession();
  await assert.rejects(
    () => mcp.searchAll('assignee = me', ['summary']),
    /Unexpected reply from searchJiraIssuesUsingJql/,
  );
});

test('searchAll returns the issues for the ADF shape {issues:[...]}', async () => {
  writeOwnCred();
  installFetch((i, { init }) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      return mkRes({ status: 200, headers: { 'mcp-session-id': 's-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) });
    }
    if (req.method === 'tools/call' && req.params?.name === 'searchJiraIssuesUsingJql') {
      const body = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify({ issues: [{ id: '1' }, { id: '2' }] }) }] } });
      return mkRes({ status: 200, body });
    }
    return mkRes({ status: 200, body: '{}' });
  });
  const mcp = loadMcp();
  mcp.resetSession();
  const out = await mcp.searchAll('assignee = me', ['summary']);
  assert.equal(out.length, 2);
});

test('searchAll flattens the markdown shape {issues:{nodes:[...]}}', async () => {
  writeOwnCred();
  installFetch((i, { init }) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      return mkRes({ status: 200, headers: { 'mcp-session-id': 's-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) });
    }
    if (req.method === 'tools/call' && req.params?.name === 'searchJiraIssuesUsingJql') {
      const body = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify({ issues: { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } }) }] } });
      return mkRes({ status: 200, body });
    }
    return mkRes({ status: 200, body: '{}' });
  });
  const mcp = loadMcp();
  mcp.resetSession();
  const out = await mcp.searchAll('assignee = me', ['summary']);
  assert.equal(out.length, 3);
});

test('searchAll stops at config.jira.maxIssues', async () => {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ jira: { maxIssues: 60 } }));
  writeOwnCred();
  let pageCount = 0;
  installFetch((i, { init }) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      return mkRes({ status: 200, headers: { 'mcp-session-id': 's-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) });
    }
    if (req.method === 'tools/call' && req.params?.name === 'searchJiraIssuesUsingJql') {
      pageCount++;
      // Always another page: only maxIssues ends the loop.
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ issues: [{ id: pageCount * 5 }, { id: pageCount * 5 + 1 }, { id: pageCount * 5 + 2 }, { id: pageCount * 5 + 3 }, { id: pageCount * 5 + 4 }], nextPageToken: 'tok-' + pageCount }) }] },
      });
      return mkRes({ status: 200, body });
    }
    return mkRes({ status: 200, body: '{}' });
  });
  const mcp = loadMcp();
  mcp.resetSession();
  const out = await mcp.searchAll('assignee = me', ['summary']);
  assert.equal(out.length, 60, 'should stop exactly at maxIssues');
  assert.ok(pageCount <= 12, 'should not have paged more than 12 times');
});

test('toolErrorMessage extracts errorMessages/errors from the embedded JSON', () => {
  const mcp = loadMcp();
  const got = mcp.toolErrorMessage('Failed to search issues: Bad Request. {"errorMessages":["x is required","y must be a number"],"errors":{"z":"bad value"}}');
  assert.equal(got, 'x is required · y must be a number · bad value');
});

test('toolErrorMessage returns the raw text when there is no embedded JSON', () => {
  const mcp = loadMcp();
  assert.equal(mcp.toolErrorMessage('Some plain error'), 'Some plain error');
});

test('searchJiraIssuesUsingJql reply via SSE `data:` event is parsed', async () => {
  writeOwnCred();
  installFetch((i, { init }) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      return mkRes({ status: 200, headers: { 'mcp-session-id': 's-1', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) });
    }
    if (req.method === 'tools/call') {
      const sse = 'event: message\n\n' + 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: '{"sse":true}' }] } });
      return mkRes({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse });
    }
    return mkRes({ status: 200, body: '{}' });
  });
  const mcp = loadMcp();
  mcp.resetSession();
  const data = await mcp.callTool('getJiraIssue', { issueIdOrKey: 'VLEARN-1' });
  assert.deepEqual(data, { sse: true });
});
