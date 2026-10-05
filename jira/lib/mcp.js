'use strict';

// MCP client for the Atlassian server (streamable HTTP, JSON-RPC). Its OAuth tokens are only valid
// there, not on the Atlassian REST API, so every Jira / Confluence call goes through callTool().

const config = require('./config');
const { getCredential, LOGIN_HINT } = require('./auth');
const { httpError, safeJson } = require('./util');

let session = null; // { token, id }
let rpcId = 0;

const ts = () => new Date().toISOString();
const log = (...args) => console.log(`[${ts()}]`, ...args);
const logError = (...args) => console.error(`[${ts()}]`, ...args);

// The cloud id the tools take is the site's host name.
const cloudId = () => new URL(config.get().jira.siteUrl).host;

async function mcpPost(cred, sessionId, message) {
  const res = await fetch(cred.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cred.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
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
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jira-dashboard', version: '1.0.0' } },
  });
  if (!res.ok || !reply || reply.error) {
    logError(`[mcp] initialize failed: HTTP ${res.status}${reply?.error ? ` — ${reply.error.message}` : ''}`);
    throw httpError(502, `Could not start an MCP session (HTTP ${res.status})`);
  }
  const id = res.headers.get('mcp-session-id');
  await mcpPost(cred, id, { method: 'notifications/initialized' });
  session = { token: cred.token, id };
  log(`[mcp] session opened (id: ${id})`);
  return id;
}

async function callTool(name, args) {
  let cred = await getCredential();
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    let res, reply;
    try {
      const sessionId = session && session.token === cred.token ? session.id : await openSession(cred);
      log(`[mcp] -> tools/call ${name}${attempt ? ` (attempt ${attempt + 1})` : ''}`);
      ({ res, reply } = await mcpPost(cred, sessionId, {
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: { cloudId: cloudId(), ...args } },
      }));
    } catch (e) {
      logError(`[mcp] <- ${name} threw after ${Date.now() - started}ms: ${e.message}`);
      // Our own token was revoked or expired early: refresh once and retry.
      if (e.unauthorized && cred.source === 'own' && attempt === 0) {
        log('[mcp] token unauthorized, refreshing and retrying once');
        cred = await getCredential({ forceRefresh: true });
        continue;
      }
      throw e;
    }
    // 404 = the server dropped our session; start a new one once.
    if (res.status === 404 && attempt === 0) {
      log('[mcp] session dropped by server (404), opening a new one');
      session = null;
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

async function searchAll(jql, fields) {
  const max = config.get().jira.maxIssues;
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
    // ADF responses use the raw REST shape ({issues: [], nextPageToken}); markdown ones use {issues: {nodes, pageInfo}}.
    const page = data.issues || [];
    out.push(...(Array.isArray(page) ? page : page.nodes || []));
    nextPageToken = data.nextPageToken || (page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null);
  } while (nextPageToken && out.length < max);
  return out;
}

const resetSession = () => void (session = null);

module.exports = { callTool, searchAll, resetSession };
