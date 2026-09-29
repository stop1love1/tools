#!/usr/bin/env node
'use strict';

// Local Jira dashboard: lists the current user's issues, the Confluence pages
// linked from them, and lets the user move issues through their workflow.
//
// Everything goes through the Atlassian MCP server (mcp.atlassian.com); its
// OAuth tokens are only valid there, not on the Atlassian REST API.
// Zero dependencies (Node >= 18). The browser only ever talks to 127.0.0.1.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createGitApi } = require('./git');

loadEnv(path.join(__dirname, '.env'));

const BASE = (process.env.JIRA_SITE_URL || 'https://vin3s.atlassian.net').replace(/\/+$/, '');
const SITE_HOST = new URL(BASE).host;
const CLOUD_ID = SITE_HOST;
const MCP_URL = process.env.MCP_SERVER_URL || 'https://mcp.atlassian.com/v1/mcp';
const OAUTH_ISSUER = (process.env.MCP_OAUTH_ISSUER || new URL(MCP_URL).origin).replace(/\/+$/, '');
const OAUTH_FILE = process.env.DASHBOARD_OAUTH_FILE || path.join(__dirname, '.oauth.json');
const CREDENTIALS_FILE = process.env.CLAUDE_CREDENTIALS_FILE || path.join(os.homedir(), '.claude', '.credentials.json');
const MCP_SERVER_NAME = process.env.MCP_SERVER_NAME || 'atlassian';
const PORT = Number(process.env.PORT) || 4747;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
// Claude Code's editor extension opens a new tab with a prefilled prompt for <scheme>://anthropic.claude-code/open?prompt=…
const EDITOR_URI_SCHEME = process.env.EDITOR_URI_SCHEME || 'cursor';
const EDITOR_BIN = process.env.EDITOR_BIN || 'cursor';
const MAX_PROMPT = 12_000;
const HOST = '127.0.0.1';
const DEFAULT_JQL =
  process.env.DEFAULT_JQL ||
  'assignee = currentUser() AND (statusCategory != Done OR updated >= -14d) ORDER BY updated DESC';

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const MAX_ISSUES = 300;
const ISSUE_FIELDS = [
  'summary', 'status', 'issuetype', 'priority', 'updated', 'created', 'duedate',
  'parent', 'project', 'description', 'attachment', 'labels', 'customfield_10020',
  'customfield_10016', // Story Points
];
const LOGIN_HINT = 'Sign in to Atlassian (key button) to give the dashboard its own auto-refreshing session.';

// ---------------------------------------------------------------------------
// Credentials
//
// Preferred: the dashboard's own OAuth grant (one browser login via /oauth/login),
// kept in .oauth.json and refreshed automatically. Fallback: the access token
// Claude Code holds for the same MCP server, used read-only and never refreshed
// here — refresh tokens rotate, so refreshing Claude Code's grant would log it out.

let claudeCache = { mtimeMs: -1, cred: null };

function readClaudeCredential() {
  let stat;
  try {
    stat = fs.statSync(CREDENTIALS_FILE);
  } catch {
    throw httpError(401, `Not signed in. ${LOGIN_HINT}`);
  }
  if (stat.mtimeMs !== claudeCache.mtimeMs) {
    const data = safeJson(fs.readFileSync(CREDENTIALS_FILE, 'utf8')) || {};
    const entry = Object.values(data.mcpOAuth || {}).find((e) => e && e.serverName === MCP_SERVER_NAME && e.accessToken);
    claudeCache = {
      mtimeMs: stat.mtimeMs,
      cred: entry ? { token: entry.accessToken, url: entry.serverUrl, expiresAt: entry.expiresAt || 0, source: 'claude' } : null,
    };
  }
  const cred = claudeCache.cred;
  if (!cred) throw httpError(401, `Not signed in. ${LOGIN_HINT}`);
  if (cred.expiresAt && cred.expiresAt < Date.now()) {
    throw httpError(401, `Claude Code's MCP token expired at ${new Date(cred.expiresAt).toLocaleString('en-US')}. ${LOGIN_HINT}`);
  }
  return cred;
}

function readOwn() {
  try {
    return JSON.parse(fs.readFileSync(OAUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeOwn(data) {
  const tmp = OAUTH_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, OAUTH_FILE);
  return data;
}

let metaPromise = null;

function oauthMeta() {
  metaPromise ??= fetch(`${OAUTH_ISSUER}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(15_000) }).then(
    (r) => (r.ok ? r.json() : Promise.reject(httpError(502, `Could not read OAuth metadata (HTTP ${r.status})`))),
  );
  metaPromise.catch(() => (metaPromise = null));
  return metaPromise;
}

async function tokenRequest(params) {
  const meta = await oauthMeta();
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const status = res.status === 400 || res.status === 401 ? 401 : 502;
    throw Object.assign(httpError(status, data.error_description || data.error || `OAuth HTTP ${res.status}`), { oauthError: data.error });
  }
  return data;
}

function storeTokens(clientId, data, previousRefreshToken) {
  return writeOwn({
    clientId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previousRefreshToken,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  });
}

let refreshing = null;

// Single-flight: concurrent requests share one refresh so the rotated token isn't spent twice.
function refreshOwn() {
  refreshing ??= (async () => {
    const own = readOwn();
    try {
      const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: own.refreshToken, client_id: own.clientId });
      return storeTokens(own.clientId, data, own.refreshToken);
    } catch (e) {
      if (e.oauthError === 'invalid_grant' || e.oauthError === 'invalid_client') {
        writeOwn(e.oauthError === 'invalid_client' ? {} : { clientId: own.clientId });
        console.warn('[oauth] The dashboard session is no longer valid; sign in again.');
      }
      throw e;
    }
  })().finally(() => (refreshing = null));
  return refreshing;
}

async function getCredential({ forceRefresh = false } = {}) {
  let own = readOwn();
  if (own?.refreshToken) {
    if (forceRefresh || !own.accessToken || own.expiresAt - 120_000 < Date.now()) {
      try {
        own = await refreshOwn();
      } catch (e) {
        if (e.status !== 401) throw e;
        own = null; // grant revoked: fall back to Claude Code's token
      }
    }
    if (own?.accessToken) return { token: own.accessToken, url: MCP_URL, expiresAt: own.expiresAt, source: 'own' };
  }
  return readClaudeCredential();
}

// --- browser login (OAuth 2.1 authorization code + PKCE, dynamic client registration)

const pendingLogins = new Map(); // state -> { verifier, createdAt }

async function startLogin(res) {
  const meta = await oauthMeta();
  let own = readOwn() || {};
  if (!own.clientId) {
    const r = await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'LMS Jira dashboard',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const reg = await r.json().catch(() => ({}));
    if (!r.ok || !reg.client_id) throw httpError(502, `Could not register the OAuth client (HTTP ${r.status})`);
    own = writeOwn({ clientId: reg.client_id });
  }
  for (const [s, p] of pendingLogins) if (Date.now() - p.createdAt > 10 * 60_000) pendingLogins.delete(s);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  pendingLogins.set(state, { verifier, createdAt: Date.now() });
  const url = new URL(meta.authorization_endpoint);
  const params = {
    response_type: 'code',
    client_id: own.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  res.writeHead(302, { Location: url.href });
  res.end();
}

async function finishLogin(url, res) {
  const state = url.searchParams.get('state') || '';
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);
  const error = url.searchParams.get('error');
  if (error) return sendHtml(res, 400, `Sign-in cancelled: ${url.searchParams.get('error_description') || error}`);
  if (!pending) return sendHtml(res, 400, 'The sign-in session is invalid or older than 10 minutes. Please try again.');
  const own = readOwn() || {};
  try {
    const data = await tokenRequest({
      grant_type: 'authorization_code',
      code: url.searchParams.get('code') || '',
      redirect_uri: REDIRECT_URI,
      client_id: own.clientId,
      code_verifier: pending.verifier,
    });
    storeTokens(own.clientId, data);
  } catch (e) {
    if (e.oauthError === 'invalid_client') writeOwn({});
    return sendHtml(res, 502, `Could not get a token: ${e.message}`);
  }
  session = null;
  res.writeHead(302, { Location: '/' });
  res.end();
}

// ---------------------------------------------------------------------------
// MCP client (streamable HTTP, JSON-RPC)

let session = null; // { token, id }
let rpcId = 0;

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
  const { res, reply } = await mcpPost(cred, null, {
    id: ++rpcId,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jira-dashboard', version: '1.0.0' } },
  });
  if (!res.ok || !reply || reply.error) throw httpError(502, `Could not start an MCP session (HTTP ${res.status})`);
  const id = res.headers.get('mcp-session-id');
  await mcpPost(cred, id, { method: 'notifications/initialized' });
  session = { token: cred.token, id };
  return id;
}

async function callTool(name, args) {
  let cred = await getCredential();
  for (let attempt = 0; ; attempt++) {
    let res, reply;
    try {
      const sessionId = session && session.token === cred.token ? session.id : await openSession(cred);
      ({ res, reply } = await mcpPost(cred, sessionId, {
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: { cloudId: CLOUD_ID, ...args } },
      }));
    } catch (e) {
      // Our own token was revoked or expired early: refresh once and retry.
      if (e.unauthorized && cred.source === 'own' && attempt === 0) {
        cred = await getCredential({ forceRefresh: true });
        continue;
      }
      throw e;
    }
    // 404 = the server dropped our session; start a new one once.
    if (res.status === 404 && attempt === 0) {
      session = null;
      continue;
    }
    if (!res.ok || !reply) throw httpError(502, `MCP ${name} failed with HTTP ${res.status}`);
    if (reply.error) throw httpError(502, reply.error.message || `MCP ${name} failed`);
    const text = (reply.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const data = safeJson(text);
    if (reply.result?.isError || data?.error === true) throw httpError(400, toolErrorMessage(data?.message ?? text));
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
  } while (nextPageToken && out.length < MAX_ISSUES);
  return out;
}

// ---------------------------------------------------------------------------
// Confluence links

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

// Walks an ADF document and collects every URL (smart links, link marks, bare text).
function collectUrls(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) collectUrls(n, out);
    return out;
  }
  if (node.attrs && typeof node.attrs.url === 'string') out.add(node.attrs.url);
  for (const m of node.marks || []) {
    if (m.attrs && typeof m.attrs.href === 'string') out.add(m.attrs.href);
  }
  if (typeof node.text === 'string') for (const u of node.text.match(URL_RE) || []) out.add(u);
  if (node.content) collectUrls(node.content, out);
  return out;
}

// Returns { url, pageId } for a Confluence URL on this site, otherwise null.
function parseConfluence(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.host !== SITE_HOST || !u.pathname.startsWith('/wiki/')) return null;
  const tiny = u.pathname.match(/^\/wiki\/x\/([A-Za-z0-9_-]+)/);
  const byPath = u.pathname.match(/\/pages\/(\d+)/);
  const pageId = tiny ? decodeTinyLink(tiny[1]) : byPath ? byPath[1] : u.searchParams.get('pageId');
  return { url: u.href, pageId: pageId || null };
}

// Confluence short links (/wiki/x/<tiny>) are the page id, little-endian, base64 encoded.
function decodeTinyLink(tiny) {
  const b64 = tiny.replace(/-/g, '/').replace(/_/g, '+');
  const buf = Buffer.from(b64.padEnd(Math.ceil(b64.length / 4) * 4, 'A'), 'base64');
  let id = 0n;
  for (let i = buf.length - 1; i >= 0; i--) id = (id << 8n) | BigInt(buf[i]);
  return id > 0n ? id.toString() : null;
}

function confluenceLinks(description) {
  const seen = new Map();
  for (const url of collectUrls(description)) {
    const link = parseConfluence(url);
    if (link && !seen.has(link.pageId || link.url)) seen.set(link.pageId || link.url, link);
  }
  return [...seen.values()];
}

// pageId -> { title, url } (null = looked up but not visible to this user)
const pageCache = new Map();

async function resolvePages(ids) {
  const missing = [...new Set(ids.filter((id) => id && /^\d+$/.test(id)))].filter((id) => !pageCache.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const data = await callTool('searchConfluenceUsingCql', { cql: `id in (${chunk.join(',')})`, limit: 250 });
      for (const r of data.results || []) {
        const c = r.content || r;
        if (!c.id) continue;
        const webui = c._links?.webui || r.url;
        pageCache.set(String(c.id), { title: c.title || r.title, url: webui ? BASE + '/wiki' + webui : null });
      }
      for (const id of chunk) if (!pageCache.has(id)) pageCache.set(id, null);
    } catch (e) {
      console.warn(`[confluence] Could not load page titles: ${e.message}`);
    }
  }
}

function withPageInfo(link, from) {
  const page = link.pageId ? pageCache.get(link.pageId) : null;
  return { pageId: link.pageId, url: page?.url || link.url, title: page?.title || null, from };
}

// ---------------------------------------------------------------------------
// DTOs

function statusDto(s) {
  return s ? { id: s.id, name: s.name, category: s.statusCategory?.key || 'indeterminate' } : null;
}

function issueDto(issue, docs) {
  const f = issue.fields;
  
  // The sprint field is either 'sprint' or a custom field (usually customfield_10020)
  const sprintField = f.sprint || f.customfield_10020;
  const sprints = Array.isArray(sprintField) ? sprintField : sprintField ? [sprintField] : [];
  const activeSprint = sprints.find(s => s && s.state === 'active') || sprints[sprints.length - 1] || null;
  
  // Story Points field (customfield_10016 is common, but may vary)
  const storyPoints = f.customfield_10016 || null;
  
  return {
    key: issue.key,
    url: `${BASE}/browse/${issue.key}`,
    summary: f.summary || '',
    type: { name: f.issuetype?.name || '', subtask: !!f.issuetype?.subtask },
    status: statusDto(f.status),
    priority: f.priority?.name || null,
    project: f.project ? { key: f.project.key, name: f.project.name } : null,
    created: f.created,
    updated: f.updated,
    due: f.duedate || null,
    labels: f.labels || [],
    sprint: activeSprint ? { id: activeSprint.id, name: activeSprint.name, state: activeSprint.state } : null,
    storyPoints,
    parent: f.parent
      ? {
          key: f.parent.key,
          summary: f.parent.fields?.summary || '',
          type: f.parent.fields?.issuetype?.name || '',
          status: statusDto(f.parent.fields?.status),
        }
      : null,
    docs,
    attachments: (f.attachment || []).map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      mimeType: a.mimeType,
      created: a.created,
      author: a.author?.displayName || '',
      url: `${BASE}/secure/attachment/${a.id}/${encodeURIComponent(a.filename)}`,
    })),
  };
}

function classifyLink(url) {
  if (parseConfluence(url)) return 'confluence';
  if (/\/merge_requests\/\d+|\/pull\/\d+/.test(url)) return 'mr';
  if (/\/commits?\/[0-9a-f]{7,}/.test(url)) return 'commit';
  return 'other';
}

// ---------------------------------------------------------------------------
// Handlers

async function listIssues(jql) {
  const issues = await searchAll(jql, ISSUE_FIELDS);
  const byKey = new Map(issues.map((i) => [i.key, i]));

  // Sub-tasks rarely carry their own PRD link; inherit the parent's Confluence links.
  const parentKeys = [...new Set(issues.map((i) => i.fields.parent?.key).filter((k) => k && !byKey.has(k)))];
  const parentDesc = new Map();
  const parentFields = new Map(); // parent key → fields (its own parent tells a sub-task's Epic)
  await mapPool(parentKeys, 4, async (key) => {
    try {
      const p = await callTool('getJiraIssue', { issueIdOrKey: key, fields: ['description', 'parent'], responseContentFormat: 'adf' });
      parentDesc.set(key, p.fields?.description);
      parentFields.set(key, p.fields || {});
    } catch {
      // Parent not visible to this user: skip its links.
    }
  });
  for (const [key, issue] of byKey) {
    parentDesc.set(key, issue.fields.description);
    parentFields.set(key, issue.fields);
  }

  const ownLinks = new Map(issues.map((i) => [i.key, confluenceLinks(i.fields.description)]));
  const parentLinks = new Map([...parentDesc].map(([k, d]) => [k, ownLinks.get(k) || confluenceLinks(d)]));

  const allLinks = [...ownLinks.values(), ...parentLinks.values()].flat();
  await resolvePages(allLinks.map((l) => l.pageId));

  return issues.map((issue) => {
    const pk = issue.fields.parent?.key;
    const dto = issueDto(issue, mergeDocs(issue.key, ownLinks.get(issue.key), pk, (pk && parentLinks.get(pk)) || []));
    dto.epic = epicOf(issue, parentFields);
    return dto;
  });
}

// The Epic above an issue: its parent (Task/Story → Epic) or its grandparent (Sub-task → Story → Epic).
// The epic branch of the git flow is named after it.
function epicOf(issue, parentFields) {
  const isEpic = (n) => /epic/i.test(n?.fields?.issuetype?.name || '');
  const dto = (n) => ({ key: n.key, summary: n.fields?.summary || '', status: statusDto(n.fields?.status) });
  if (/epic/i.test(issue.fields.issuetype?.name || '')) return null;
  const p = issue.fields.parent;
  if (!p) return null;
  if (isEpic(p)) return dto(p);
  const gp = parentFields.get(p.key)?.parent;
  return gp && isEpic(gp) ? dto(gp) : null;
}

// An issue's docs: its own Confluence links first, then the ones inherited from its parent.
function mergeDocs(key, own, parentKey, inherited) {
  const docs = new Map();
  for (const l of own) docs.set(l.pageId || l.url, withPageInfo(l, key));
  for (const l of inherited) if (!docs.has(l.pageId || l.url)) docs.set(l.pageId || l.url, withPageInfo(l, parentKey));
  return [...docs.values()];
}

const DETAIL_FIELDS = [...ISSUE_FIELDS, 'comment', 'assignee', 'reporter'];

async function issueDetail(key) {
  const [issue, remote, children] = await Promise.all([
    callTool('getJiraIssue', { issueIdOrKey: key, fields: DETAIL_FIELDS, expand: 'renderedFields', responseContentFormat: 'adf' }),
    callTool('getJiraIssueRemoteIssueLinks', { issueIdOrKey: key }).catch(() => []),
    searchAll(`parent = ${key} ORDER BY created ASC`, ['summary', 'status', 'issuetype', 'assignee']).catch(() => []),
  ]);
  const f = issue.fields;

  let inherited = [];
  if (f.parent?.key) {
    try {
      const p = await callTool('getJiraIssue', { issueIdOrKey: f.parent.key, fields: ['description'], responseContentFormat: 'adf' });
      inherited = confluenceLinks(p.fields?.description);
    } catch {
      // Parent not visible: no inherited docs.
    }
  }
  const own = confluenceLinks(f.description);

  // Rendered comments carry HTML bodies but display-formatted dates; take dates from the raw list.
  const raw = f.comment?.comments || [];
  const rendered = issue.renderedFields?.comment?.comments || [];
  const comments = raw.map((c, i) => ({
    id: c.id,
    author: c.author?.displayName || '',
    created: c.created,
    html: typeof rendered[i]?.body === 'string' ? rendered[i].body : '',
  }));

  const links = (Array.isArray(remote) ? remote : [])
    .filter((l) => l.object?.url)
    .map((l) => ({
      kind: classifyLink(l.object.url),
      title: l.object.title || l.object.url,
      url: l.object.url,
      source: l.object.icon?.title || l.application?.name || '',
    }));

  const confluence = links.filter((l) => l.kind === 'confluence').map((l) => ({ ...parseConfluence(l.url), fallback: l.title }));
  await resolvePages([...own, ...inherited, ...confluence].map((c) => c.pageId));

  return {
    issue: issueDto(issue, mergeDocs(key, own, f.parent?.key, inherited)),
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    children: children.map((c) => ({
      key: c.key,
      summary: c.fields.summary || '',
      type: c.fields.issuetype?.name || '',
      status: statusDto(c.fields.status),
      assignee: c.fields.assignee?.displayName || null,
    })),
    comments,
    descriptionHtml: issue.renderedFields?.description || '',
    confluence: confluence.map((c) => {
      const info = withPageInfo(c, key);
      return { ...info, title: info.title || c.fallback };
    }),
    links: links.filter((l) => l.kind !== 'confluence'),
  };
}

// ---------------------------------------------------------------------------
// Notifications
//
// Jira's bell feed has no public/MCP API, so this rebuilds it: other people's
// changes and comments on issues I'm assigned to, reported or watch.

const NOTIFY_DAYS = 7;
const NOTIFY_JQL = `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -${NOTIFY_DAYS}d ORDER BY updated DESC`;
let notifyCache = { at: 0, data: null };

// Changelog items expose `toString`/`fromString` as data; guard against the prototype method.
const str = (v) => (typeof v === 'string' && v ? v : null);

function describeChange(item) {
  const from = str(item.fromString);
  const to = str(item.toString);
  switch (item.field) {
    case 'status':
      return { kind: 'status', text: `changed status ${from || '—'} → ${to || '—'}` };
    case 'assignee':
      return { kind: 'assign', text: to ? `assigned to ${to}` : 'unassigned' };
    case 'description':
      return { kind: 'edit', text: 'edited the description' };
    case 'summary':
      return { kind: 'edit', text: `renamed to “${to || ''}”` };
    case 'priority':
      return { kind: 'edit', text: `changed priority ${from || '—'} → ${to || '—'}` };
    case 'duedate':
      return { kind: 'edit', text: `changed due date ${from || '—'} → ${to || '—'}` };
    case 'Attachment':
      return { kind: 'edit', text: to ? `attached ${to}` : `removed ${from || ''}` };
    case 'IssueParentAssociation':
      return { kind: 'edit', text: `changed parent to ${to || '—'}` };
    case 'Sprint':
      return { kind: 'edit', text: `moved to sprint ${to || '—'}` };
    case 'Story point estimate':
      return { kind: 'edit', text: `changed story points ${from || '—'} → ${to || '—'}` };
    case 'resolution':
    case 'Rank':
    case 'Workflow':
    case 'RemoteWorkItemLink': // GitLab commit/MR auto-links
      return null; // noise that accompanies other changes
    default:
      return { kind: 'edit', text: `edited ${item.field}` };
  }
}

function adfText(node) {
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(adfText).join('');
  if (node.type === 'mention') return node.attrs?.text || '@';
  if (typeof node.text === 'string') return node.text;
  const inner = adfText(node.content);
  return ['paragraph', 'heading', 'listItem'].includes(node.type) ? inner + ' ' : inner;
}

function mentions(node, accountId) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((n) => mentions(n, accountId));
  return (node.type === 'mention' && node.attrs?.id === accountId) || mentions(node.content, accountId);
}

async function listNotifications() {
  if (notifyCache.data && Date.now() - notifyCache.at < 60_000) return notifyCache.data;
  const me = await callTool('atlassianUserInfo', {});
  const recent = (await searchAll(NOTIFY_JQL, ['summary'])).slice(0, 25);
  const since = Date.now() - NOTIFY_DAYS * 86_400_000;
  const events = [];
  await mapPool(recent, 4, async ({ key }) => {
    let j;
    try {
      j = await callTool('getJiraIssue', { issueIdOrKey: key, fields: ['summary', 'issuetype', 'comment'], expand: 'changelog', responseContentFormat: 'adf' });
    } catch {
      return;
    }
    const issue = { key, summary: j.fields?.summary || '', type: j.fields?.issuetype?.name || '' };
    for (const hst of j.changelog?.histories || []) {
      if (hst.author?.accountId === me.account_id || Date.parse(hst.created) < since) continue;
      for (const item of hst.items || []) {
        const change = describeChange(item);
        if (change) events.push({ id: `${key}:h${hst.id}:${item.field}`, at: hst.created, author: hst.author?.displayName || '', issue, ...change });
      }
    }
    for (const c of j.fields?.comment?.comments || []) {
      if (c.author?.accountId === me.account_id || Date.parse(c.created) < since) continue;
      events.push({
        id: `${key}:c${c.id}`,
        at: c.created,
        author: c.author?.displayName || '',
        issue,
        kind: 'comment',
        text: adfText(c.body).replace(/\s+/g, ' ').trim().slice(0, 240),
        mention: mentions(c.body, me.account_id),
      });
    }
  });
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  notifyCache = { at: Date.now(), data: { days: NOTIFY_DAYS, events: events.slice(0, 150) } };
  return notifyCache.data;
}

// ---------------------------------------------------------------------------
// People to switch the view to: assignees active in the projects I work in.

let usersCache = { at: 0, data: null };

async function listUsers() {
  if (usersCache.data && Date.now() - usersCache.at < 10 * 60_000) return usersCache.data;
  const me = await callTool('atlassianUserInfo', {});
  const mine = await searchAll('assignee = currentUser() AND updated >= -90d ORDER BY updated DESC', ['project']);
  const projects = [...new Set(mine.map((i) => i.fields.project?.key).filter(Boolean))];
  const counts = new Map();
  if (projects.length) {
    const jql = `project in (${projects.join(',')}) AND assignee is not EMPTY AND updated >= -60d ORDER BY updated DESC`;
    for (const i of await searchAll(jql, ['assignee'])) {
      const a = i.fields.assignee;
      if (!a?.accountId) continue;
      const entry = counts.get(a.accountId) || { accountId: a.accountId, name: a.displayName || a.accountId, count: 0 };
      entry.count++;
      counts.set(a.accountId, entry);
    }
  }
  const users = [...counts.values()]
    .filter((u) => u.accountId !== me.account_id)
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  usersCache = { at: Date.now(), data: { me: me.account_id, projects, users } };
  return usersCache.data;
}

// Passes a cursor:// URL to the running editor via its CLI (`cursor --open-url`), which forwards it
// to the open window and exits. Not xdg-open: the desktop may have no cursor:// handler registered.
// ELECTRON_RUN_AS_NODE (set when launched from an editor extension) would turn the CLI into plain Node.
function openInEditor(url) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(EDITOR_BIN, ['--open-url', url], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    // A CLI that starts a fresh editor instead of forwarding never exits; treat that as opened.
    const timer = setTimeout(() => {
      child.unref();
      resolve();
    }, 15_000);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(httpError(500, `Could not run "${EDITOR_BIN}" (${e.code || e.message}). Set EDITOR_BIN in .env to the cursor command.`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const last = stderr.trim().split('\n').filter((l) => !/^\[\d+:/.test(l)).pop() || '';
      reject(httpError(500, `${EDITOR_BIN} --open-url failed (exit ${code}) ${last}`.trim()));
    });
  });
}

async function listTransitions(key) {
  const data = await callTool('getTransitionsForJiraIssue', { issueIdOrKey: key });
  return (data.transitions || []).map((t) => ({ id: t.id, name: t.name, to: statusDto(t.to) }));
}

async function doTransition(key, id) {
  await callTool('transitionJiraIssue', { issueIdOrKey: key, transition: { id: String(id) } });
  notifyCache.at = 0;
  const issue = await callTool('getJiraIssue', { issueIdOrKey: key, fields: ['status'] });
  return { status: statusDto(issue.fields.status) };
}

// ---------------------------------------------------------------------------
// Git flow (lms backend/frontend). The epic branch follows the parent Epic on Jira; a ticket without one is its own epic.

const epicCache = new Map();
const summaryCache = new Map(); // ticket → summary, filled while resolving epics

async function resolveEpic(key) {
  if (epicCache.has(key)) return epicCache.get(key);
  let epic = key;
  let cur = key;
  for (let depth = 0; depth < 3 && cur; depth++) {
    const j = await callTool('getJiraIssue', { issueIdOrKey: cur, fields: ['parent', 'issuetype', 'summary'] });
    if (j.fields?.summary) summaryCache.set(cur, j.fields.summary);
    if (/epic/i.test(j.fields?.issuetype?.name || '')) {
      epic = cur;
      break;
    }
    const p = j.fields?.parent;
    if (p && /epic/i.test(p.fields?.issuetype?.name || '')) {
      epic = p.key;
      break;
    }
    cur = p?.key;
  }
  epicCache.set(key, epic);
  return epic;
}

const gitApi = createGitApi({ httpError, readJson, resolveEpic, ticketSummary: (key) => summaryCache.get(key), editorBin: EDITOR_BIN });

// ---------------------------------------------------------------------------
// HTTP server

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/git.js': ['git.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  try {
    // Reject DNS-rebinding requests: only answer to our own loopback host names.
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) {
      return send(res, 421, { error: 'Invalid host' });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/oauth/login') return await startLogin(res);
    if (req.method === 'GET' && url.pathname === '/oauth/callback') return await finishLogin(url, res);

    if (!url.pathname.startsWith('/api/')) {
      const entry = STATIC[url.pathname];
      if (!entry || req.method !== 'GET') return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(__dirname, 'public', entry[0])).pipe(res);
    }

    // Writes need a custom header, which a cross-site form or fetch cannot send without CORS.
    if (req.method !== 'GET' && req.headers['x-dashboard'] !== '1') return send(res, 403, { error: 'Forbidden' });

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const me = await callTool('atlassianUserInfo', {});
      const cred = await getCredential();
      return send(res, 200, {
        name: me.nickname || me.name,
        email: me.email,
        site: BASE,
        auth: { source: cred.source, expiresAt: cred.expiresAt || null },
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/users') return send(res, 200, await listUsers());

    if (url.pathname.startsWith('/api/git/')) return send(res, 200, await gitApi(req, url));

    if (req.method === 'POST' && url.pathname === '/api/claude-code') {
      const body = await readJson(req);
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt || prompt.length > MAX_PROMPT) return send(res, 400, { error: 'Prompt is empty or too long' });
      await openInEditor(`${EDITOR_URI_SCHEME}://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/notifications') {
      if (url.searchParams.has('fresh')) notifyCache.at = 0;
      return send(res, 200, await listNotifications());
    }

    if (req.method === 'GET' && url.pathname === '/api/issues') {
      let jql = (url.searchParams.get('jql') || '').trim() || DEFAULT_JQL;
      // Viewing someone else: the same JQL with currentUser() swapped for their account id.
      const user = url.searchParams.get('user') || '';
      if (user) {
        if (!/^[A-Za-z0-9:_-]{1,128}$/.test(user)) return send(res, 400, { error: 'Invalid accountId' });
        jql = jql.replace(/currentUser\(\)/g, `"${user}"`);
      }
      const issues = await listIssues(jql);
      return send(res, 200, { jql, defaultJql: DEFAULT_JQL, site: BASE, issues });
    }

    const m = url.pathname.match(/^\/api\/issues\/([^/]+)(\/transitions)?$/);
    if (m && ISSUE_KEY_RE.test(m[1])) {
      const key = m[1];
      if (!m[2] && req.method === 'GET') return send(res, 200, await issueDetail(key));
      if (m[2] && req.method === 'GET') return send(res, 200, { transitions: await listTransitions(key) });
      if (m[2] && req.method === 'POST') {
        const body = await readJson(req);
        if (!body || !/^\d+$/.test(String(body.id))) return send(res, 400, { error: 'Missing transition id' });
        return send(res, 200, await doTransition(key, body.id));
      }
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    const message = e.name === 'TimeoutError' ? 'Atlassian MCP timed out' : e.message;
    if (req.url.startsWith('/oauth/')) return sendHtml(res, status, message);
    send(res, status, { error: message, login: status === 401 });
  }
});

server.listen(PORT, HOST, () => {
  const own = readOwn();
  const auth = own?.refreshToken ? 'own session, auto-refresh' : 'Claude Code token';
  console.log(`Jira dashboard: http://localhost:${PORT}  (${BASE}, via MCP — ${auth})`);
});

// Keep our own grant warm so it never lapses while the server runs.
setInterval(() => {
  const own = readOwn();
  if (own?.refreshToken && own.expiresAt - 30 * 60_000 < Date.now()) {
    refreshOwn().catch((e) => console.warn(`[oauth] Refresh failed: ${e.message}`));
  }
}, 10 * 60_000).unref();

// ---------------------------------------------------------------------------
// Helpers

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, message) {
  const esc = String(message).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Jira dashboard</title>` +
      `<body style="font:15px system-ui;max-width:560px;margin:15vh auto;padding:0 16px">` +
      `<p>${esc}</p><p><a href="/oauth/login">Try signing in again</a> · <a href="/">Back to the dashboard</a></p></body>`,
  );
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64_000) {
        reject(httpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(safeJson(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function mapPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
