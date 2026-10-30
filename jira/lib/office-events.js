'use strict';

// The 3D office's activity: what the team did today, as one timeline of events with who did it, to whom and on which
// ticket. From Jira (status changes, assignments, priority, comments: the changelog of the sprint's tasks updated in
// the window) and GitLab (pushes, merge requests, reviews, pipelines of the repos in Settings → Git flow).
//
// Event: { id, at, src: 'jira'|'gitlab', kind, actor: { id, name }, target: { id, name } | null, key, summary, text, ... }
// kinds: status (from, to, cat), assign, priority (to), comment (mentions), push (count, ref), mr-open (iid),
//        mr-approve, mr-comment, mr-merge (branch, uat), pipeline (status: failed, or success after a failure; ref)

const config = require('./config');
const { callTool } = require('./mcp');
const { mapPool } = require('./util');
const { listTeamSprint } = require('./team');
const { settings } = require('./git/settings');
const { webUrl } = require('./git/exec');
const { glabApi } = require('./git/mrs');

const KEY_RE = /\b[A-Z][A-Z0-9_]+-\d+\b/;
const str = (v) => (typeof v === 'string' && v ? v : null);
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
// "Nguyễn Văn Huy - (huynv111)", "Phan Đăng Lưu [VSF-PN]", "Cù Huy Toàn (VSF-QTVHG)" → the name alone, and the handles
// in the suffix (a GitLab username often is one).
const baseName = (n) => String(n || '').split(/\s+-\s+|\s*[([]/)[0].trim();
const handles = (n) => (String(n || '').match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) || []).map((x) => x.toLowerCase());

function adfText(node) {
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(adfText).join('');
  if (node.type === 'mention') return node.attrs?.text || '@';
  if (typeof node.text === 'string') return node.text;
  const inner = adfText(node.content);
  return ['paragraph', 'heading', 'listItem'].includes(node.type) ? inner + ' ' : inner;
}
function mentionIds(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) node.forEach((n) => mentionIds(n, out));
  else {
    if (node.type === 'mention' && node.attrs?.id) out.add(node.attrs.id);
    mentionIds(node.content, out);
  }
  return out;
}
const oneLine = (s, n = 240) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// GitLab people → team members: the username set in the Team panel, else a handle in the Jira name, else the same
// name without accents.
function personMatcher(members, people = {}) {
  const byGitlab = new Map(), byHandle = new Map(), byName = new Map();
  for (const m of members) {
    const who = { id: m.accountId, name: m.name };
    const gl = people[m.accountId]?.gitlab;
    if (gl) byGitlab.set(gl.toLowerCase(), who);
    for (const h of handles(m.name.slice(baseName(m.name).length))) if (!byHandle.has(h)) byHandle.set(h, who);
    byName.set(fold(baseName(m.name)), who);
  }
  return (u) => {
    if (!u) return null;
    const un = String(u.username || '').toLowerCase();
    return byGitlab.get(un) || byHandle.get(un) || byHandle.get(un.replace(/^[a-z]+\./, '')) || byName.get(fold(baseName(u.name))) || { id: null, name: baseName(u.name) || u.username || '' };
  };
}

// ---- Jira: the changelog and comments of the sprint's tasks updated in the window ----
const perIssue = new Map(); // key → { updated, events } while `updated` is unchanged

function jiraIssueEvents(key, j, assignee) {
  const summary = j.fields?.summary || '';
  const base = { src: 'jira', key, summary };
  const target = assignee ? { id: assignee.accountId, name: assignee.displayName || '' } : null;
  const events = [];
  for (const h of j.changelog?.histories || []) {
    const actor = { id: h.author?.accountId || null, name: h.author?.displayName || '' };
    for (const it of h.items || []) {
      const id = `jira:${key}:h${h.id}:${it.field}`;
      if (it.field === 'status') events.push({ ...base, id, at: h.created, kind: 'status', actor, target, from: str(it.fromString), to: str(it.toString), text: `${str(it.fromString) || '—'} → ${str(it.toString) || '—'}` });
      else if (it.field === 'assignee' && str(it.to)) events.push({ ...base, id, at: h.created, kind: 'assign', actor, target: { id: it.to, name: str(it.toString) || '' }, from: str(it.from), text: `assigned to ${str(it.toString) || ''}` });
      else if (it.field === 'priority') events.push({ ...base, id, at: h.created, kind: 'priority', actor, target, to: str(it.toString), text: `priority ${str(it.fromString) || '—'} → ${str(it.toString) || '—'}` });
    }
  }
  for (const c of j.fields?.comment?.comments || []) {
    events.push({ ...base, id: `jira:${key}:c${c.id}`, at: c.created, kind: 'comment', actor: { id: c.author?.accountId || null, name: c.author?.displayName || '' }, target, mentions: [...mentionIds(c.body)], text: oneLine(adfText(c.body)) });
  }
  return events;
}

async function jiraEvents(tasks, since) {
  const recent = tasks.filter((t) => t.updated && Date.parse(t.updated) >= since).slice(0, 80);
  await mapPool(recent, 4, async (t) => {
    const hit = perIssue.get(t.key);
    if (hit && hit.updated === t.updated) return;
    try {
      const j = await callTool('getJiraIssue', { issueIdOrKey: t.key, fields: ['summary', 'comment', 'assignee'], expand: 'changelog', responseContentFormat: 'adf' }, { background: true });
      perIssue.set(t.key, { updated: t.updated, events: jiraIssueEvents(t.key, j, j.fields?.assignee) });
    } catch {
      // Skipped this round; the next poll tries again.
    }
  });
  return recent.flatMap((t) => perIssue.get(t.key)?.events || []);
}

// ---- GitLab: events, merge requests (reviewers) and pipelines of each repo ----
const glCache = new Map(); // repo → { at, day, promise }

async function repoActivity(dir, sinceDay) {
  const { glab } = settings();
  const web = await webUrl(dir);
  if (!web) return null;
  const u = new URL(web), p = encodeURIComponent(u.pathname.slice(1));
  const after = new Date(Date.parse(sinceDay) - 86_400_000).toISOString().slice(0, 10); // `after` is exclusive
  const [events, mrs, pipes] = await Promise.all([
    glabApi(glab, u.host, `projects/${p}/events?after=${after}&per_page=100`),
    glabApi(glab, u.host, `projects/${p}/merge_requests?state=all&updated_after=${sinceDay}&per_page=100`),
    glabApi(glab, u.host, `projects/${p}/pipelines?updated_after=${sinceDay}&per_page=100`),
  ]);
  return { web, events, mrs, pipes };
}

function gitlabRepoEvents(repo, act, who, uat) {
  const out = [], mrByIid = new Map(act.mrs.map((m) => [m.iid, m])), lastPush = new Map(); // ref → actor
  const keyOf = (...xs) => xs.map((x) => String(x || '').match(KEY_RE)?.[0]).find(Boolean) || null;
  for (const e of [...act.events].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const actor = who(e.author), base = { src: 'gitlab', repo, at: e.created_at, actor };
    const mr = e.target_type === 'MergeRequest' ? mrByIid.get(e.target_iid) : e.note?.noteable_type === 'MergeRequest' ? mrByIid.get(e.note.noteable_iid) : null;
    const mrBase = mr && { iid: mr.iid, key: keyOf(mr.title, mr.source_branch), summary: mr.title, url: mr.web_url, target: who(mr.author) };
    if (e.push_data) {
      const pd = e.push_data, n = pd.commit_count || 0;
      if (!n || pd.ref_type !== 'branch') continue;
      lastPush.set(pd.ref, actor);
      // A new branch's push counts every commit it was cut from: say "new branch" instead.
      const created = pd.action === 'created';
      out.push({ ...base, id: `gl:${repo}:e${e.id}`, kind: 'push', count: n, created, ref: pd.ref, key: keyOf(pd.ref, pd.commit_title), summary: oneLine(pd.commit_title, 120), target: null, text: created ? `pushed new branch ${pd.ref}` : `pushed ${n} commit${n > 1 ? 's' : ''} to ${pd.ref}` });
    } else if (mr && e.action_name === 'opened') {
      const reviewers = (mr.reviewers || []).map(who).filter(Boolean);
      out.push({ ...base, ...mrBase, id: `gl:${repo}:e${e.id}`, kind: 'mr-open', target: reviewers[0] || null, reviewers, text: `opened MR !${mr.iid} → ${mr.target_branch}` });
    } else if (mr && e.action_name === 'approved') {
      out.push({ ...base, ...mrBase, id: `gl:${repo}:e${e.id}`, kind: 'mr-approve', text: `approved MR !${mr.iid}` });
    } else if (mr && e.action_name === 'accepted') {
      out.push({ ...base, ...mrBase, id: `gl:${repo}:e${e.id}`, kind: 'mr-merge', branch: mr.target_branch, uat: mr.target_branch === uat, text: `merged MR !${mr.iid} → ${mr.target_branch}` });
    } else if (mr && e.action_name?.startsWith('commented') && !e.note?.system) {
      out.push({ ...base, ...mrBase, id: `gl:${repo}:e${e.id}`, kind: 'mr-comment', text: oneLine(e.note?.body) });
    }
  }
  // Pipelines: a failure, and the first success after one on the same ref (routine greens would drown the rest).
  // A merge request's pipeline runs on refs/merge-requests/<iid>/head|merge: its author and ticket are the MR's.
  const lastStatus = new Map();
  for (const p of [...act.pipes].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))) {
    if (p.status !== 'success' && p.status !== 'failed') continue;
    const was = lastStatus.get(p.ref); lastStatus.set(p.ref, p.status);
    if (p.status === 'success' && was !== 'failed') continue;
    const iid = Number((p.ref.match(/^refs\/merge-requests\/(\d+)\//) || [])[1]);
    const mr = iid ? mrByIid.get(iid) : act.mrs.find((m) => m.source_branch === p.ref);
    const branch = mr ? mr.source_branch : p.ref;
    const actor = lastPush.get(branch) || (mr ? who(mr.author) : { id: null, name: '' });
    out.push({ src: 'gitlab', repo, id: `gl:${repo}:p${p.id}:${p.status}`, at: p.updated_at, kind: 'pipeline', status: p.status, fixed: p.status === 'success', ref: branch, iid: mr?.iid || null, actor, target: null, key: keyOf(branch, mr?.title), url: p.web_url, text: p.status === 'failed' ? `pipeline failed on ${branch}` : `pipeline fixed on ${branch}` });
  }
  return out;
}

async function gitlabEvents(who, since) {
  const s = settings(), sinceDay = new Date(since).toISOString();
  const out = [], errors = [], ci = [];
  await Promise.all(Object.entries(s.repos).map(async ([repo, dir]) => {
    let hit = glCache.get(repo);
    if (!hit || hit.day !== sinceDay || Date.now() - hit.at > (hit.failed ? 30_000 : 45_000)) {
      hit = { at: Date.now(), day: sinceDay, promise: repoActivity(dir, sinceDay) };
      hit.promise.catch(() => (hit.failed = true));
      glCache.set(repo, hit);
    }
    try {
      const act = await hit.promise;
      if (!act) return;
      out.push(...gitlabRepoEvents(repo, act, who, s.uat));
      const last = act.pipes.filter((p) => p.status === 'success' || p.status === 'failed').sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
      if (last) ci.push({ repo, status: last.status, at: last.updated_at });
    } catch (e) {
      errors.push(`${repo}: ${e.message}`);
    }
  }));
  return { events: out, ci, error: errors.join(' · ') || null };
}

// `since`: ms; at most two days back. Jira and GitLab load side by side; one failing leaves the other.
async function listOfficeEvents({ sprintId = null, since }) {
  const from = Math.max(Number(since) || 0, Date.now() - 2 * 86_400_000);
  const team = await listTeamSprint({ sprintId });
  const tasks = team.members.flatMap((m) => m.tasks);
  const who = personMatcher(team.members, config.get().office.people);
  const [jira, gitlab] = await Promise.all([
    jiraEvents(tasks, from).then((events) => ({ events, error: null }), (e) => ({ events: [], error: e.message })),
    gitlabEvents(who, from).catch((e) => ({ events: [], ci: [], error: e.message })),
  ]);
  const events = [...jira.events, ...gitlab.events].filter((e) => Date.parse(e.at) >= from).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // ci: each repo's latest finished pipeline (the Dev room's build lamp).
  return { since: new Date(from).toISOString(), events, ci: gitlab.ci, sources: { jira: jira.error || 'ok', gitlab: gitlab.error || 'ok' } };
}

module.exports = { listOfficeEvents, personMatcher, jiraIssueEvents, gitlabRepoEvents };
