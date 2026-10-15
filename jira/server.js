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
const { loadEnv, httpError, send, sendHtml, readJson, ISSUE_KEY_RE } = require('./lib/util');

loadEnv(path.join(__dirname, '.env'));

const config = require('./lib/config');
const auth = require('./lib/auth');
const mcp = require('./lib/mcp');
const issues = require('./lib/issues');
const attachments = require('./lib/attachments');
const notifications = require('./lib/notifications');
const { listUsers } = require('./lib/users');

// Values of the user filter that are not an accountId: every assignee / tasks nobody is assigned to.
const ALL_USERS = '__all__';
const UNASSIGNED = '__unassigned__';
const { openClaudeCode } = require('./lib/editor');
const git = require('./lib/git');
const gitJobs = require('./lib/git/jobs');
const { handleMcp } = require('./lib/mcp-server');
const { getToken, FILE: tokenFile } = require('./lib/mcp-token');
const { shortPrompt } = require('./lib/prompt');

const PORT = config.startupValue('server.port');
const HOST = '127.0.0.1';
const MAX_PROMPT = 12_000;
// Browser scripts, in load order (index.html lists the same files).
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// --- Dev-only live reload (chokidar-based watcher + injected client script), see livereload npm package. ---
// Disable livereload when running from pkg binary (no public/ dir to watch, and port conflicts)
const DEV = process.env.NODE_ENV !== 'production' && !process.pkg;

function startLiveReloadServer() {
  let LiveReloadServer;
  try {
    LiveReloadServer = require('livereload');
  } catch {
    console.warn('Live reload disabled: run `npm install` to get the `livereload` dev dependency.');
    return;
  }
  const lr = LiveReloadServer.createServer({ exts: ['html', 'js', 'css'], delay: 100 });
  lr.watch(PUBLIC);
  console.log('Live reload: watching public/ for changes (livereload server on its own port)');
}

// The livereload npm package only runs the watcher + websocket server; it doesn't serve its own
// client script when we do our own static serving, so wire that one file up ourselves.
const LIVERELOAD_CLIENT = path.join(__dirname, 'node_modules', 'livereload-js', 'dist', 'livereload.js');

function serveStatic(url, req, res) {
  if (DEV && req.method === 'GET' && url.pathname === '/js/livereload.js' && fs.existsSync(LIVERELOAD_CLIENT)) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(LIVERELOAD_CLIENT).pipe(res);
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  const type = TYPES[path.extname(file)];
  if (req.method !== 'GET' || !type || !file.startsWith(PUBLIC + path.sep) || !/^[a-z0-9/_-]+\.[a-z]+$/.test(rel) || !fs.existsSync(file)) {
    if (req.method === 'GET' && url.pathname === '/') console.log(`[debug] root request: rel=${rel}, file=${file}, exists=${fs.existsSync(file)}`);
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

  if (route === 'GET /api/config') return send(res, 200, { ...config.view(), client: config.client(), mcpTokenFile: tokenFile });
  if (route === 'PUT /api/config') {
    const body = await readJson(req);
    if (!body || typeof body.values !== 'object') throw httpError(400, 'Missing values');
    return send(res, 200, { ...config.save(body.values), client: config.client(), mcpTokenFile: tokenFile });
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

  // Viewing someone else: the same JQL with currentUser() swapped for their account id.
  async function forUser(jql) {
    const user = url.searchParams.get('user') || '';
    if (user === ALL_USERS || user === UNASSIGNED) {
      // Everyone / nobody: swap "assignee = currentUser()" for any assignee / no assignee, limited to the projects I work in.
      const { projects } = await listUsers();
      const scope = projects.length ? `project in (${projects.join(',')}) AND ` : '';
      const who = user === ALL_USERS ? 'assignee is not EMPTY' : 'assignee is EMPTY';
      return jql.replace(/assignee\s*=\s*currentUser\(\)/gi, `(${scope}${who})`);
    }
    if (user) {
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(user)) throw httpError(400, 'Invalid accountId');
      return jql.replace(/currentUser\(\)/g, `"${user}"`);
    }
    return jql;
  }

  if (route === 'GET /api/issues') {
    const defaultJql = config.get().jira.defaultJql;
    const jql = await forUser((url.searchParams.get('jql') || '').trim() || defaultJql);
    return send(res, 200, { jql, defaultJql, site: config.get().jira.siteUrl, issues: await issues.listIssues(jql) });
  }

  // Overview trends: everything created or resolved in the window, plus whatever is still open (the backlog at each point).
  if (route === 'GET /api/history') {
    const days = Number(url.searchParams.get('days'));
    if (!Number.isInteger(days) || days < 1 || days > 1830) return send(res, 400, { error: 'days must be 1–1830' });
    const jql = await forUser(`assignee = currentUser() AND (created >= -${days}d OR resolved >= -${days}d OR statusCategory != Done) ORDER BY created DESC`);
    return send(res, 200, { jql, ...(await issues.listHistory(jql, { fresh: url.searchParams.has('fresh') })) });
  }

  const att = url.pathname.match(/^\/api\/attachments\/(\d+)\/([^/]+)$/);
  if (att && req.method === 'GET') return await attachments.streamAttachment(att[1], decodeURIComponent(att[2]), res);

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

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Stop the other process or change server.port in Settings.`);
  else console.error(`Server error: ${e.message}`);
  process.exit(1);
});

// A stray rejection must not take the server (and a running git job) down; log it and keep going.
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason));
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e.stack || e);
  shutdown('uncaughtException', 1);
});

// Graceful stop: refuse new connections, give a running git job time to finish (a kill mid-rebase leaves
// a half-done operation and a scratch worktree behind), then exit.
const SHUTDOWN_WAIT_MS = 60_000;
let shuttingDown = false;
function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const running = gitJobs.runningJobs();
  console.log(`\nShutting down (${reason})${running.length ? `, waiting for ${running.length} git job(s): ${running.map((j) => j.title).join(', ')}` : ''}`);
  server.close();
  server.closeIdleConnections?.();
  const timer = setTimeout(() => {
    console.error(`Git job(s) still running after ${SHUTDOWN_WAIT_MS / 1000}s, exiting anyway.`);
    process.exit(code || 1);
  }, SHUTDOWN_WAIT_MS);
  timer.unref();
  gitJobs.whenIdle().finally(() => process.exit(code));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  const how = auth.hasOwnSession() ? 'own session, auto-refresh' : 'Claude Code token';
  console.log(`Jira dashboard: http://localhost:${PORT}  (${config.get().jira.siteUrl}, via MCP — ${how})`);
  // Create the token file now so there is something to copy into the MCP client config.
  getToken();
  console.log(`MCP write tools need "Authorization: Bearer <token>" — token file: ${tokenFile}`);
  if (DEV) startLiveReloadServer();
});

auth.keepWarm();
