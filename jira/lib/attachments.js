'use strict';

// Streams a Jira attachment through this server so the browser can preview it instead of
// auto-downloading it. Jira's own attachment URLs always send `Content-Disposition: attachment`
// (anti-XSS: a user-uploaded file never renders as a page on Jira's own origin), and they only
// accept a browser session cookie anyway — not the OAuth token the dashboard uses for MCP. So
// this calls the REST API directly with a Jira API token (Basic Auth, JIRA_API_EMAIL / JIRA_API_TOKEN
// in .env — see id.atlassian.com/manage-profile/security/api-tokens) and re-sends the bytes with
// `inline` from our own origin, where that's safe.

const config = require('./config');
const { httpError } = require('./util');

const ATTACHMENT_ID_RE = /^\d+$/;
// Inline-safe types only: SVG/HTML/etc. could run script in the browser if rendered inline.
const INLINE_TYPES = /^(image\/(?!svg)|application\/pdf|text\/plain|audio\/|video\/)/i;

async function streamAttachment(id, filename, res) {
  if (!ATTACHMENT_ID_RE.test(id)) throw httpError(400, 'Invalid attachment id');

  const { siteUrl, apiEmail, apiToken } = config.get().jira;
  if (!apiEmail || !apiToken) {
    throw httpError(501, 'Preview needs JIRA_API_EMAIL and JIRA_API_TOKEN in .env (id.atlassian.com/manage-profile/security/api-tokens)');
  }

  const auth = Buffer.from(`${apiEmail}:${apiToken}`).toString('base64');
  const upstream = await fetch(`${siteUrl}/rest/api/3/attachment/content/${id}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });

  if (upstream.status === 401 || upstream.status === 403) throw httpError(401, 'Jira rejected the API token for attachment access');
  if (upstream.status === 404) throw httpError(404, 'Attachment not found');
  if (!upstream.ok || !upstream.body) throw httpError(502, `Jira returned HTTP ${upstream.status} for this attachment`);

  const type = upstream.headers.get('content-type') || 'application/octet-stream';
  const length = upstream.headers.get('content-length');
  const disposition = INLINE_TYPES.test(type) ? 'inline' : 'attachment';
  const safeName = String(filename || 'file').replace(/[\r\n"]/g, '');

  res.writeHead(200, {
    'Content-Type': type,
    ...(length ? { 'Content-Length': length } : {}),
    'Content-Disposition': `${disposition}; filename="${safeName}"`,
    'Cache-Control': 'private, max-age=300',
    // Belt-and-suspenders: even "inline" HTML/SVG can't execute script from our own origin.
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; media-src 'self'; object-src 'self'",
    'X-Content-Type-Options': 'nosniff',
  });

  try {
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
  } catch {
    // Headers are already sent at this point; just end the response, no JSON error possible.
  }
  res.end();
}

module.exports = { streamAttachment };
