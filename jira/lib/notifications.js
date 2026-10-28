'use strict';

// Notifications
//
// Jira's bell feed has no public/MCP API, so this rebuilds it: other people's
// changes and comments on issues I'm assigned to, reported or watch.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { callTool, searchAll, userInfo } = require('./mcp');
const { mapPool, safeJson } = require('./util');

let cache = { at: 0, data: null };
// key → { updated, accountId, events }: what the last getJiraIssue of an issue produced, reused while its `updated` is unchanged.
// Kept on disk too: Jira's search can't return changelogs, so a cold start would otherwise pay one getJiraIssue for
// each of the recent issues again. Next to .mcp-token (beside the binary when packaged).
const PER_ISSUE_FILE = process.env.DASHBOARD_NOTIFY_CACHE_FILE || path.join(__dirname.includes('/snapshot/') ? process.cwd() : path.join(__dirname, '..'), '.notifications-cache.json');
const perIssue = new Map(Object.entries((fs.existsSync(PER_ISSUE_FILE) && safeJson(fs.readFileSync(PER_ISSUE_FILE, 'utf8'))) || {}));

function savePerIssue() {
  try {
    const tmp = PER_ISSUE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(perIssue)), { mode: 0o600 });
    fs.renameSync(tmp, PER_ISSUE_FILE);
  } catch {
    // Only a cache: the next cold start fetches again.
  }
}

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
  if (cache.data && Date.now() - cache.at < 60_000) return cache.data;
  const days = config.get().jira.notifyDays;
  const jql = `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -${days}d ORDER BY updated DESC`;
  const me = await userInfo();
  const recent = (await searchAll(jql, ['summary', 'updated'])).slice(0, 25);
  const since = Date.now() - days * 86_400_000;
  let changed = false;
  await mapPool(recent, 4, async ({ key, fields }) => {
    // Unchanged since the last refresh (same `updated`): keep its events instead of paying a getJiraIssue for them.
    const updated = fields?.updated || null;
    const hit = perIssue.get(key);
    if (hit && updated && hit.updated === updated && hit.accountId === me.account_id) return;
    let j;
    try {
      j = await callTool('getJiraIssue', { issueIdOrKey: key, fields: ['summary', 'issuetype', 'comment'], expand: 'changelog', responseContentFormat: 'adf' }, { background: true });
    } catch {
      return;
    }
    const events = []; // all of this issue's events: the notify window is applied when the lists are merged below
    const issue = { key, summary: j.fields?.summary || '', type: j.fields?.issuetype?.name || '' };
    for (const hst of j.changelog?.histories || []) {
      if (hst.author?.accountId === me.account_id) continue;
      for (const item of hst.items || []) {
        const change = describeChange(item);
        if (change) events.push({ id: `${key}:h${hst.id}:${item.field}`, at: hst.created, author: hst.author?.displayName || '', issue, ...change });
      }
    }
    for (const c of j.fields?.comment?.comments || []) {
      if (c.author?.accountId === me.account_id) continue;
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
    perIssue.set(key, { updated, accountId: me.account_id, events });
    changed = true;
  });
  // Merge the per-issue events (fresh or reused) of the issues in this window; forget issues that dropped out of it.
  const keep = new Set(recent.map((r) => r.key));
  for (const k of [...perIssue.keys()]) if (!keep.has(k)) (perIssue.delete(k), (changed = true));
  if (changed) savePerIssue();
  const events = recent.flatMap(({ key }) => perIssue.get(key)?.events || []).filter((e) => Date.parse(e.at) >= since);
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  cache = { at: Date.now(), data: { days, events: events.slice(0, 150) } };
  return cache.data;
}

const invalidate = () => void (cache.at = 0);

module.exports = { listNotifications, invalidate };
