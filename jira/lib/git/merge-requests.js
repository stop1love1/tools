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
  'task-epic': 'task branch (-uat) → epic branch',
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

function description({ key, summary, changes, testCases, epicBranch, devBranch, url }) {
  const list = (items, empty) => (items?.length ? items.map((x) => `- ${x}`) : [empty]);
  return [
    '## Summary', '', summary || '', '',
    '## Changes', '', ...list(changes, '- '), '',
    '## Test cases', '', ...(testCases?.length ? testCases.map((x) => `- [ ] ${x}`) : ['- [ ] ']), '',
    '## Checklist', '', ...config.get().git.mrChecklist.map((c) => `- [ ] ${c}`), '',
    '## Related issues / links', '',
    epicBranch && `- Epic: \`${epicBranch}\``,
    devBranch && `- Develop branch: \`${devBranch}\``,
    `- Ticket: ${key}${url ? ` (${url})` : ''}`,
  ]
    .filter((l) => typeof l === 'string')
    .join('\n');
}

// Returns { url, iid, source, target, title, created } for the MR of `kind` for ticket `key` in `repo`.
async function createMergeRequest({ repo, key, kind = 'task-epic', title, summary, changes, testCases, draft = false, epic }) {
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
  // The ticket's first commit subject is already "<KEY>-123: …"; the epic MR is titled after the epic.
  const baseTitle = String(title || '').trim() || (kind === 'epic-uat' ? `${f.epic}: ${summary || 'epic'}` : r.commits?.[0]?.subject || `${key}: ${summary || ''}`.trim());
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

module.exports = { createMergeRequest, MR_KINDS: KINDS };
