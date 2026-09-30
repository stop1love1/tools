'use strict';

// Confluence pages linked from issue descriptions: find the links, resolve page titles.

const config = require('./config');
const { callTool } = require('./mcp');

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
const base = () => config.get().jira.siteUrl.replace(/\/+$/, '');

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
  if (u.host !== new URL(base()).host || !u.pathname.startsWith('/wiki/')) return null;
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
        pageCache.set(String(c.id), { title: c.title || r.title, url: webui ? base() + '/wiki' + webui : null });
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

module.exports = { parseConfluence, confluenceLinks, resolvePages, withPageInfo };
