'use strict';

// Creating merge requests the team way: standard title ("<KEY>-123: …") and description template (summary,
// changes, test cases, checklist from Settings, links), through glab's stored login. An MR that already exists
// for the same source → target is returned instead of failing.

const { execFile } = require('node:child_process');
const config = require('../config');
const { settings } = require('./settings');
const { webUrl } = require('./exec');
const { flow } = require('./read');
const { clearMrs } = require('./mrs');
const { httpError } = require('../util');

// kind → which branch goes into which, from the ticket's git flow.
const KINDS = {
  'task-epic': 'task branch (-uat) → epic branch (legacy: prefer pick-epic)',
  'epic-uat': 'epic branch → uat',
  develop: 'develop branch (-develop) → develop',
};

function glab(args) {
  const bin = settings().glab;
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(JSON.parse(String(stdout) || 'null'));
      const text = String(stderr || stdout || err.message).trim();
      reject(Object.assign(httpError(502, err.code === 'ENOENT' ? `${bin} not found` : /timeout|dial tcp/i.test(text) ? 'GitLab not reachable (VPN?)' : text.split('\n').pop()), { text }));
    });
  });
}

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);

// Which configured checklist item an entry means: its 1-based number, or its text (exact, else a unique substring).
function checklistIndex(items, ref) {
  const fail = (why) => httpError(400, `Checklist item ${JSON.stringify(ref)} ${why}. Items:\n${items.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    const n = Number(ref);
    if (n < 1 || n > items.length) throw fail('is out of range');
    return n - 1;
  }
  const needle = oneLine(ref).toLowerCase();
  if (!needle) throw fail('is empty');
  const exact = items.findIndex((c) => c.toLowerCase() === needle);
  if (exact >= 0) return exact;
  const hits = items.map((c, i) => (c.toLowerCase().includes(needle) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) throw fail(hits.length ? 'matches several items' : 'matches no item');
  return hits[0];
}

// The Checklist section: the configured items, each ticked "- [x] item — note" when the caller reports it as really
// checked (entries: [{ item, checked?: true, note }]); every other item stays "- [ ]".
function checklistLines(entries) {
  const items = config.get().git.mrChecklist;
  const given = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const i = checklistIndex(items, e?.item);
    const note = oneLine(e?.note);
    const checked = e?.checked !== false;
    if (checked && !note) throw httpError(400, `Checklist item "${items[i]}" is ticked without a note — say in a few words what was checked.`);
    given.set(i, { checked, note });
  }
  return items.map((c, i) => {
    const g = given.get(i);
    return g?.checked ? `- [x] ${c} — ${g.note}` : `- [ ] ${c}${g?.note ? ` — ${g.note}` : ''}`;
  });
}

// Test cases stay "- [ ]" unless the caller says it really ran them: { text, checked: true, note: what was called / tried }.
function testCaseLines(testCases) {
  return (testCases || []).map((t) => {
    if (typeof t === 'string') return `- [ ] ${t}`;
    const text = oneLine(t?.text);
    if (!text) throw httpError(400, 'A test case needs a "text".');
    if (!t.checked) return `- [ ] ${text}`;
    const note = oneLine(t.note);
    if (!note) throw httpError(400, `Test case "${text}" is ticked without a note — say which API call or manual test proved it.`);
    return `- [x] ${text} — ${note}`;
  });
}

function description({ key, summary, changes, testCases, checklist, epicBranch, devBranch, url }) {
  const list = (items, empty) => (items?.length ? items.map((x) => `- ${x}`) : [empty]);
  const cases = testCaseLines(testCases);
  return [
    '## Summary', '', summary || '', '',
    '## Changes', '', ...list(changes, '- '), '',
    '## Test cases', '', ...(cases.length ? cases : ['- [ ] ']), '',
    '## Checklist', '', ...checklistLines(checklist), '',
    '## Related issues / links', '',
    epicBranch && `- Epic: \`${epicBranch}\``,
    devBranch && `- Develop branch: \`${devBranch}\``,
    `- Ticket: ${key}${url ? ` (${url})` : ''}`,
  ]
    .filter((l) => typeof l === 'string')
    .join('\n');
}

// Returns { url, iid, source, target, title, created } for the MR of `kind` for ticket `key` in `repo`.
async function createMergeRequest({ repo, key, kind = 'epic-uat', title, summary, changes, testCases, checklist, draft = false, epic }) {
  const s = settings();
  if (!Object.hasOwn(s.repos, repo)) throw httpError(400, `repo must be one of: ${Object.keys(s.repos).join(', ')}`);
  if (!KINDS[kind]) throw httpError(400, `kind must be one of: ${Object.keys(KINDS).join(', ')}`);
  const f = await flow(key, epic || null);
  const r = f.repos[repo];
  if (r.error) throw httpError(500, r.error);

  const [source, target] =
    kind === 'task-epic' ? [r.uat?.name, r.epic.name] : kind === 'epic-uat' ? [r.epic.name, s.uat] : [r.develop?.name, s.develop];
  if (!source) throw httpError(409, `No ${kind === 'develop' ? `-${s.develop}` : `-${s.uat}`} branch for ${key} in ${repo} yet.`);
  const branch = kind === 'task-epic' ? r.uat : kind === 'develop' ? r.develop : r.epic;
  if (!branch?.remote) throw httpError(409, `${source} is not on origin — push it first.`);
  if (kind !== 'epic-uat' && branch.sync?.onlyA > 0) throw httpError(409, `${source} has ${branch.sync.onlyA} commit(s) not pushed — push first.`);

  const web = await webUrl(s.repos[repo]);
  if (!web) throw httpError(400, 'origin is not a GitLab repository');
  const u = new URL(web);
  const project = `projects/${encodeURIComponent(u.pathname.slice(1))}`;
  // Same title on every MR of the ticket: its first commit subject, already "<KEY>-123: …". Without commits
  // (e.g. an epic with no commits of its own) fall back to "<KEY>: <summary>".
  const baseTitle =
    String(title || '').trim() ||
    r.commits?.[0]?.subject ||
    (kind === 'epic-uat' ? `${f.epic}: ${summary || 'epic'}` : `${key}: ${summary || ''}`.trim());
  const fullTitle = `${draft ? 'Draft: ' : ''}${baseTitle.replace(/^Draft:\s*/i, '')}`;

  const existing = async () => {
    const q = `${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(source)}&target_branch=${encodeURIComponent(target)}`;
    const [m] = await glab(['api', '--hostname', u.host, q]);
    return m && { url: m.web_url, iid: m.iid, source, target, title: m.title, created: false };
  };
  const found = await existing();
  if (found) return found;

  const body = description({
    key,
    summary,
    changes,
    testCases,
    checklist,
    epicBranch: r.epic.name,
    devBranch: kind === 'task-epic' ? s.toDevelop(source) : kind === 'develop' ? source : null,
    url: `${config.get().jira.siteUrl.replace(/\/+$/, '')}/browse/${key}`,
  });
  try {
    const m = await glab([
      'api', '--hostname', u.host, '--method', 'POST', `${project}/merge_requests`,
      '-f', `source_branch=${source}`, '-f', `target_branch=${target}`, '-f', `title=${fullTitle}`, '-f', `description=${body}`,
      '-f', 'remove_source_branch=false',
    ]);
    clearMrs();
    return { url: m.web_url, iid: m.iid, source, target, title: m.title, created: true };
  } catch (e) {
    // Created meanwhile (409 "Another open merge request already exists").
    if (/already exists/i.test(e.text || e.message)) {
      const again = await existing();
      if (again) return again;
    }
    throw e;
  }
}

module.exports = { createMergeRequest, MR_KINDS: KINDS, description };
