'use strict';

// Shared test helpers: temp-dir env for the config / oauth / token files, a require-cache purge,
// and fake req/res objects for handleMcp.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshEnv(tmp) {
  process.env.DASHBOARD_CONFIG_FILE = path.join(tmp, 'config.json');
  process.env.DASHBOARD_OAUTH_FILE = path.join(tmp, '.oauth.json');
  process.env.DASHBOARD_MCP_TOKEN_FILE = path.join(tmp, '.mcp-token');
  process.env.CLAUDE_CREDENTIALS_FILE = path.join(tmp, 'credentials.json');
}

// Drops every lib/ module from the require cache: several of them read their env-driven file paths at load.
function purge() {
  const lib = path.resolve(__dirname, '..', 'lib');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(lib)) delete require.cache[key];
  }
}

function mkTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-test-'));
  freshEnv(dir);
  return dir;
}

function rmTemp(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp gone already */
  }
}

// Stand-in for http.ServerResponse.
class FakeRes {
  constructor() {
    this.statusCode = 0;
    this.headers = {};
    this.body = '';
    this.sent = false;
  }
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers || {};
    return this;
  }
  end(body) {
    this.sent = true;
    this.body = body == null ? '' : String(body);
    return this;
  }
  json() {
    return JSON.parse(this.body);
  }
}

// Stand-in for http.IncomingMessage; `body` (object or string) is replayed to readJson.
function fakeReq({ method = 'POST', headers = {}, body, url = '/mcp', socket = { remoteAddress: '127.0.0.1' } } = {}) {
  const req = { method, headers, url, socket };
  if (body != null) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    req.headers['content-type'] = req.headers['content-type'] || 'application/json';
    req.headers['content-length'] = Buffer.byteLength(text);
  }
  let endListeners = [];
  req.on = (event, listener) => {
    if (event === 'data') {
      if (body != null) {
        const chunk = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        listener(chunk);
      }
    } else if (event === 'end') {
      endListeners.push(listener);
    } else if (event === 'error') {
      endListeners.push(listener);
    }
    return req;
  };
  // 'end' fires on the next microtask, after readJson has registered its listeners.
  Promise.resolve().then(() => endListeners.forEach((fn) => fn()));
  return req;
}

module.exports = { mkTemp, rmTemp, purge, FakeRes, fakeReq };
