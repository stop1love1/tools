'use strict';

// Credentials for the Atlassian MCP server.
//
// Preferred: the dashboard's own OAuth grant (one browser login via /oauth/login),
// kept in .oauth.json and refreshed automatically. Fallback: the access token
// Claude Code holds for the same MCP server, used read-only and never refreshed
// here — refresh tokens rotate, so refreshing Claude Code's grant would log it out.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { httpError, sendHtml, safeJson } = require('./util');

const OAUTH_FILE = process.env.DASHBOARD_OAUTH_FILE || 
  (process.pkg
    ? path.join(process.cwd(), '.oauth.json')
    : path.join(__dirname, '..', '.oauth.json'));
const LOGIN_HINT = 'Sign in to Atlassian (key button) to give the dashboard its own auto-refreshing session.';

// Read once: changing these needs a restart (the OAuth client is registered for this redirect URI).
const MCP_URL = config.startupValue('server.mcpUrl');
const OAUTH_ISSUER = (process.env.MCP_OAUTH_ISSUER || new URL(MCP_URL).origin).replace(/\/+$/, '');
const PORT = config.startupValue('server.port');
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;

let claudeCache = { mtimeMs: -1, cred: null };

function readClaudeCredential() {
  const file = config.startupValue('server.credentialsFile');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw httpError(401, `Not signed in. ${LOGIN_HINT}`);
  }
  if (stat.mtimeMs !== claudeCache.mtimeMs) {
    const data = safeJson(fs.readFileSync(file, 'utf8')) || {};
    const name = config.startupValue('server.mcpServerName');
    const entry = Object.values(data.mcpOAuth || {}).find((e) => e && e.serverName === name && e.accessToken);
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

// onSignedIn: lets the MCP client drop its session opened with the previous token.
async function finishLogin(url, res, onSignedIn) {
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
  onSignedIn?.();
  res.writeHead(302, { Location: '/' });
  res.end();
}

// Keep our own grant warm so it never lapses while the server runs.
function keepWarm() {
  setInterval(() => {
    const own = readOwn();
    if (own?.refreshToken && own.expiresAt - 30 * 60_000 < Date.now()) {
      refreshOwn().catch((e) => console.warn(`[oauth] Refresh failed: ${e.message}`));
    }
  }, 10 * 60_000).unref();
}

const hasOwnSession = () => !!readOwn()?.refreshToken;

module.exports = { getCredential, startLogin, finishLogin, keepWarm, hasOwnSession, LOGIN_HINT };
