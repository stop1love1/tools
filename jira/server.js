#!/usr/bin/env node
'use strict';

// Local Jira dashboard: lists the current user's issues, the Confluence pages
// linked from them, and lets the user move issues through their workflow.
//
// Everything goes through the Atlassian MCP server (see lib/mcp.js).
// Zero dependencies (Node >= 18). The browser only ever talks to 127.0.0.1.
// Settings: config.json, edited from the Settings page (lib/config.js).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnv, httpError, send, sendHtml, readJson } = require('./lib/util');

loadEnv(path.join(__dirname, '.env'));

const config = require('./lib/config');
const auth = require('./lib/auth');
const mcp = require('./lib/mcp');
const issues = require('./lib/issues');
const notifications = require('./lib/notifications');
const { listUsers } = require('./lib/users');
const { openClaudeCode } = require('./lib/editor');
const git = require('./lib/git');
const { handleMcp } = require('./lib/mcp-server');
const { shortPrompt } = require('./lib/prompt');

const PORT = config.startupValue('server.port');
const HOST = '127.0.0.1';
const MAX_PROMPT = 12_000;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

// Browser scripts, in load order (index.html lists the same files).
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(url, req, res) {
  const rel = url.pathname === '/' ? 'tasks.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  const type = TYPES[path.extname(file)];
  if (req.method !== 'GET' || !type || !file.startsWith(PUBLIC + path.sep) || !/^[a-z0-9/_-]+\.[a-z]+$/.test(rel) || !fs.existsSync(file)) {
    return send(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/me') {
    const me = await mcp.callTool('atlassianUserInfo', {});
    const cred = await auth.getCredential();
    return send(res, 200, {
      name: me.nickname || me.name,
      email: me.email,
      site: config.get().jira.siteUrl,
      auth: { source: cred.source, expiresAt: cred.expiresAt || null },
    });
  }

  if (route === 'GET /api/config') return send(res, 200, { ...config.view(), client: config.client() });
  if (route === 'PUT /api/config') {
    const body = await readJson(req);
    if (!body || typeof body.values !== 'object') throw httpError(400, 'Missing values');
    return send(res, 200, { ...config.save(body.values), client: config.client() });
  }
  if (route === 'GET /api/client-config') return send(res, 200, config.client());

  if (route === 'GET /api/users') return send(res, 200, await listUsers());

  // "Start with Claude": the dialog's choices → the prompt for Claude Code in Cursor (lib/prompt.js).
  if (route === 'POST /api/claude/prompt') return send(res, 200, { prompt: shortPrompt((await readJson(req)) || {}) });

  if (url.pathname.startsWith('/api/git/')) return send(res, 200, await git.handle(req, url));

  if (route === 'POST /api/claude-code') {
    const body = await readJson(req);
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT) return send(res, 400, { error: 'Prompt is empty or too long' });
    await openClaudeCode(prompt);
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/notifications') {
    if (url.searchParams.has('fresh')) notifications.invalidate();
    return send(res, 200, await notifications.listNotifications());
  }

  if (route === 'GET /api/issues') {
    const defaultJql = config.get().jira.defaultJql;
    let jql = (url.searchParams.get('jql') || '').trim() || defaultJql;
    // Viewing someone else: the same JQL with currentUser() swapped for their account id.
    const user = url.searchParams.get('user') || '';
    if (user) {
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(user)) return send(res, 400, { error: 'Invalid accountId' });
      jql = jql.replace(/currentUser\(\)/g, `"${user}"`);
    }
    return send(res, 200, { jql, defaultJql, site: config.get().jira.siteUrl, issues: await issues.listIssues(jql) });
  }

  const m = url.pathname.match(/^\/api\/issues\/([^/]+)(\/transitions)?$/);
  if (m && ISSUE_KEY_RE.test(m[1])) {
    const key = m[1];
    if (!m[2] && req.method === 'GET') return send(res, 200, await issues.issueDetail(key));
    if (m[2] && req.method === 'GET') return send(res, 200, { transitions: await issues.listTransitions(key) });
    if (m[2] && req.method === 'POST') {
      const body = await readJson(req);
      if (!body || !/^\d+$/.test(String(body.id))) return send(res, 400, { error: 'Missing transition id' });
      const result = await issues.doTransition(key, body.id);
      notifications.invalidate();
      return send(res, 200, result);
    }
  }

  send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    // Reject DNS-rebinding requests: only answer to our own loopback host names.
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) {
      return send(res, 421, { error: 'Invalid host' });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/oauth/login') return await auth.startLogin(res);
    if (req.method === 'GET' && url.pathname === '/oauth/callback') return await auth.finishLogin(url, res, mcp.resetSession);

    if (url.pathname === '/mcp') return await handleMcp(req, res);

    if (!url.pathname.startsWith('/api/')) return serveStatic(url, req, res);

    // Writes need a custom header, which a cross-site form or fetch cannot send without CORS.
    if (req.method !== 'GET' && req.headers['x-dashboard'] !== '1') return send(res, 403, { error: 'Forbidden' });

    await api(req, res, url);
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    const message = e.name === 'TimeoutError' ? 'Atlassian MCP timed out' : e.message;
    if (req.url.startsWith('/oauth/')) return sendHtml(res, status, message);
    send(res, status, { error: message, login: status === 401, fields: e.fields });
  }
});

server.listen(PORT, HOST, () => {
  const how = auth.hasOwnSession() ? 'own session, auto-refresh' : 'Claude Code token';
  console.log(`Jira dashboard: http://localhost:${PORT}  (${config.get().jira.siteUrl}, via MCP — ${how})`);
});

auth.keepWarm();
