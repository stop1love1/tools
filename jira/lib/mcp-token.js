'use strict';

// Bearer token that guards the MCP write tools served at /mcp.
//
// Anything on this machine can reach 127.0.0.1, so "loopback only" is not enough once a tool can commit,
// push or move a Jira issue. The token lives in a 0600 file next to the OAuth grant; read-only tools
// stay open, write tools need `Authorization: Bearer <token>`.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = process.env.DASHBOARD_MCP_TOKEN_FILE || path.join(__dirname, '..', '.mcp-token');
const TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

// { token, mtimeMs }: re-read when the file changes, so deleting or replacing it while the server runs takes effect.
let cached = null;

function getToken() {
  try {
    const { mtimeMs } = fs.statSync(FILE);
    if (cached && cached.mtimeMs === mtimeMs) return cached.token;
    const existing = fs.readFileSync(FILE, 'utf8').trim();
    if (TOKEN_RE.test(existing)) {
      cached = { token: existing, mtimeMs };
      return existing;
    }
  } catch {
    // Missing or unreadable: create a new one below.
  }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(FILE, token + '\n', { mode: 0o600 });
  fs.chmodSync(FILE, 0o600);
  cached = { token, mtimeMs: fs.statSync(FILE).mtimeMs };
  return token;
}

// True when the request carries the right bearer token (constant-time comparison).
function isAuthorized(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const wanted = Buffer.from(getToken());
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

module.exports = { getToken, isAuthorized, FILE };
