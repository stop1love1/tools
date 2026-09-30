'use strict';

// Small helpers shared by the server modules.

const fs = require('node:fs');
const os = require('node:os');

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

function tilde(p) {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// Jira-rendered HTML → readable plain text for a model.
function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => (text.replace(/<[^>]+>/g, '').trim() === href ? href : `${text} (${href})`))
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/h\d|\/tr|\/pre|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { httpError, send, sendHtml, readJson, safeJson, mapPool, loadEnv, tilde, escapeRe, htmlToText };
