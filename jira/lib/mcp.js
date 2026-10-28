'use strict';

// MCP client for the Atlassian server (streamable HTTP, JSON-RPC). Its OAuth tokens are only valid
// there, not on the Atlassian REST API, so every Jira / Confluence call goes through callTool().

const config = require('./config');
const { getCredential, LOGIN_HINT } = require('./auth');
const { httpError, safeJson } = require('./util');

const CLIENT_PROTOCOL = '2025-06-18';
const MAX_CONCURRENT = 6; // calls in flight at once: a burst (notifications, epics) must not trip Atlassian's rate limit
const MAX_TRANSIENT_RETRIES = 2;
// Only these can be repeated after a 5xx without risking a double write (transitions, edits).
const READ_ONLY_TOOL = /^(get|search|atlassianUserInfo)/;

let session = null; // { token, id, version }
let opening = null; // { token, promise }: the session being opened, shared by concurrent callers
let rpcId = 0;

const ts = () => new Date().toISOString();
const log = (...args) => console.log(`[${ts()}]`, ...args);
const logError = (...args) => console.error(`[${ts()}]`, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The cloud id the tools take is the site's host name.
const cloudId = () => new URL(config.get().jira.siteUrl).host;

// Concurrency gate. A finishing call hands its slot straight to the next waiter, so the cap is never exceeded.
// Background calls (the notification feed's one per issue) take at most MAX_BACKGROUND slots and only when no other
// call waits, so what a page needs for its numbers never queues behind them.
const MAX_BACKGROUND = 2;
let active = 0;
let activeBackground = 0;
const waiting = [];
const waitingBackground = [];
async function limited(fn, background = false) {
  if (background ? active >= MAX_CONCURRENT || activeBackground >= MAX_BACKGROUND || waiting.length : active >= MAX_CONCURRENT) {
    await new Promise((resolve) => (background ? waitingBackground : waiting).push(resolve));
  } else active++;
  if (background) activeBackground++;
  try {
    return await fn();
  } finally {
    if (background) activeBackground--;
    const next = waiting.shift() || (activeBackground < MAX_BACKGROUND && waitingBackground.shift());
    if (next) next();
    else active--;
  }
}

// sess: { id, version } once the session is open, null for `initialize`.
async function mcpPost(cred, sess, message) {
  const res = await fetch(cred.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cred.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sess?.id ? { 'Mcp-Session-Id': sess.id } : {}),
      ...(sess?.version ? { 'MCP-Protocol-Version': sess.version } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) {
    throw Object.assign(httpError(401, `Atlassian MCP rejected the token. ${LOGIN_HINT}`), { unauthorized: true });
  }
  const text = await res.text();
  if (message.id === undefined) return { res };
  // The reply is either plain JSON or an SSE stream carrying it as a `data:` event.
  const candidates = (res.headers.get('content-type') || '').includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => safeJson(l.slice(5).trim()))
    : [safeJson(text)];
  return { res, reply: candidates.find((m) => m && m.id === message.id) };
}

async function openSession(cred) {
  log(`[mcp] opening session (cred source: ${cred.source})`);
  const { res, reply } = await mcpPost(cred, null, {
    id: ++rpcId,
    method: 'initialize',
    params: { protocolVersion: CLIENT_PROTOCOL, capabilities: {}, clientInfo: { name: 'jira-dashboard', version: '1.0.0' } },
  });
  if (!res.ok || !reply || reply.error) {
    logError(`[mcp] initialize failed: HTTP ${res.status}${reply?.error ? ` — ${reply.error.message}` : ''}`);
    throw httpError(502, `Could not start an MCP session (HTTP ${res.status})`);
  }
  const id = res.headers.get('mcp-session-id');
  const version = reply.result?.protocolVersion || CLIENT_PROTOCOL; // what the server agreed to
  await mcpPost(cred, { id, version }, { method: 'notifications/initialized' });
  session = { token: cred.token, id, version };
  log(`[mcp] session opened (id: ${id}, protocol ${version})`);
  return session;
}

// Single-flight: callers that arrive while a session is being opened share it instead of opening their own.
function ensureSession(cred) {
  if (session && session.token === cred.token) return Promise.resolve(session);
  if (opening && opening.token === cred.token) return opening.promise;
  const promise = openSession(cred).finally(() => {
    if (opening?.promise === promise) opening = null;
  });
  opening = { token: cred.token, promise };
  return promise;
}

// Seconds from a Retry-After header, else exponential backoff with jitter (0.5 s, 1 s, …).
function backoffMs(res, n) {
  const after = Number(res?.headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return Math.min(after, 10) * 1000;
  return 500 * 2 ** n + Math.floor(Math.random() * 250);
}

async function run(name, args) {
  let cred = await getCredential();
  const readOnly = READ_ONLY_TOOL.test(name);
  let refreshed = false;
  let reopened = false;
  let transient = 0;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    let sess, res, reply;
    try {
      sess = await ensureSession(cred);
      log(`[mcp] -> tools/call ${name}${attempt ? ` (attempt ${attempt + 1})` : ''}`);
      ({ res, reply } = await mcpPost(cred, sess, {
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: { cloudId: cloudId(), ...args } },
      }));
    } catch (e) {
      logError(`[mcp] <- ${name} threw after ${Date.now() - started}ms: ${e.message}`);
      // Our own token was revoked or expired early: refresh once and retry.
      if (e.unauthorized && cred.source === 'own' && !refreshed) {
        refreshed = true;
        log('[mcp] token unauthorized, refreshing and retrying once');
        cred = await getCredential({ forceRefresh: true });
        continue;
      }
      // Network failure or timeout (no HTTP status): safe to repeat only for reads.
      if (!e.status && readOnly && transient < MAX_TRANSIENT_RETRIES) {
        await sleep(backoffMs(null, transient++));
        continue;
      }
      throw e;
    }
    // 404 = the server dropped our session; start a new one once (without discarding a newer session another call opened).
    if (res.status === 404 && !reopened) {
      reopened = true;
      log('[mcp] session dropped by server (404), opening a new one');
      if (session === sess) session = null;
      continue;
    }
    // Rate limit or server hiccup: back off and repeat reads; a write may already have been applied, so it is not repeated.
    if ((res.status === 429 || res.status >= 500) && readOnly && transient < MAX_TRANSIENT_RETRIES) {
      const wait = backoffMs(res, transient++);
      logError(`[mcp] <- ${name} HTTP ${res.status}, retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok || !reply) {
      logError(`[mcp] <- ${name} failed with HTTP ${res.status} (${Date.now() - started}ms)`);
      throw httpError(502, `MCP ${name} failed with HTTP ${res.status}`);
    }
    if (reply.error) {
      logError(`[mcp] <- ${name} returned RPC error: ${reply.error.message || JSON.stringify(reply.error)}`);
      throw httpError(502, reply.error.message || `MCP ${name} failed`);
    }
    const text = (reply.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const data = safeJson(text);
    if (reply.result?.isError || data?.error === true) {
      logError(`[mcp] <- ${name} tool error: ${data?.message ?? text}`);
      throw httpError(400, toolErrorMessage(data?.message ?? text));
    }
    log(`[mcp] <- ${name} ok (${Date.now() - started}ms)`);
    return data ?? text;
  }
}

// Every Jira / Confluence call goes through here, at most MAX_CONCURRENT at a time (`background`: see limited()).
const callTool = (name, args, { background = false } = {}) => limited(() => run(name, args), background);

// Tool errors wrap Jira's error JSON inside a message string, e.g.
// "Failed to search issues: Bad Request. {"errorMessages":[...]}".
function toolErrorMessage(message) {
  const raw = String(message || 'Unknown error');
  const start = raw.indexOf('{');
  const inner = start >= 0 ? safeJson(raw.slice(start)) : null;
  if (!inner) return raw;
  const parts = [...(inner.errorMessages || []), ...Object.values(inner.errors || {})].filter(Boolean);
  return parts.length ? parts.join(' · ') : raw;
}

async function searchAll(jql, fields, max = config.get().jira.maxIssues) {
  const out = [];
  let nextPageToken;
  do {
    const data = await callTool('searchJiraIssuesUsingJql', {
      jql,
      fields,
      maxResults: 100,
      responseContentFormat: 'adf',
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    // A plain-text reply means the tool did not return search JSON: fail loudly instead of looking like "no issues".
    if (!data || typeof data !== 'object' || !('issues' in data)) {
      throw httpError(502, `Unexpected reply from searchJiraIssuesUsingJql: ${String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 200)}`);
    }
    // ADF responses use the raw REST shape ({issues: [], nextPageToken}); markdown ones use {issues: {nodes, pageInfo}}.
    const page = data.issues || [];
    out.push(...(Array.isArray(page) ? page : page.nodes || []));
    nextPageToken = data.nextPageToken || (page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null);
  } while (nextPageToken && out.length < max);
  return out;
}

const resetSession = () => {
  session = null;
  opening = null;
  me = null;
};

// The signed-in user. /api/me, the user list and notifications all ask for it on page load, and each call
// takes ~2s, so share one in-flight call and keep the answer for the same credential.
const ME_TTL_MS = 10 * 60_000;
let me = null; // { token, at, promise }
async function userInfo() {
  const { token } = await getCredential();
  if (me && me.token === token && Date.now() - me.at < ME_TTL_MS) return me.promise;
  const entry = { token, at: Date.now(), promise: callTool('atlassianUserInfo', {}) };
  me = entry;
  entry.promise.catch(() => {
    if (me === entry) me = null;
  });
  return entry.promise;
}

// Open the MCP session at startup instead of on the first page request (initialize takes ~1.5s).
async function warmUp() {
  try {
    await ensureSession(await getCredential());
  } catch (e) {
    log(`[mcp] warm-up skipped: ${e.message}`);
  }
}

module.exports = { callTool, searchAll, userInfo, warmUp, resetSession, toolErrorMessage };
