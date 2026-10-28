'use strict';

// Jira issues: the list, one issue's detail, workflow transitions, and the Epic above an issue.

const config = require('./config');
const { callTool, searchAll } = require('./mcp');
const { parseConfluence, confluenceLinks, resolvePages, withPageInfo } = require('./confluence');
const { mapPool } = require('./util');

const base = () => config.get().jira.siteUrl.replace(/\/+$/, '');

function issueFields() {
  const { sprintField, storyPointsField } = config.get().jira;
  return [
    'summary', 'status', 'issuetype', 'priority', 'updated', 'created', 'duedate', 'resolutiondate',
    'parent', 'project', 'description', 'attachment', 'labels', 'fixVersions', sprintField, storyPointsField,
  ];
}

// ---------------------------------------------------------------------------
// DTOs

function statusDto(s) {
  return s ? { id: s.id, name: s.name, category: s.statusCategory?.key || 'indeterminate' } : null;
}

function sprintsIn(f) {
  const sprintValue = f.sprint || f[config.get().jira.sprintField];
  return (Array.isArray(sprintValue) ? sprintValue : sprintValue ? [sprintValue] : []).filter(Boolean);
}

const sprintDto = (s) => ({ id: s.id, name: s.name, state: s.state, startDate: s.startDate || null, endDate: s.endDate || null, completeDate: s.completeDate || null });

// An issue's sprint: the last one it was moved to, by start date (Jira lists them in no set order); a future sprint
// (not started yet) is later than any. Same rule as the client's homeSprintId (public/js/progress.js).
function sprintOf(f) {
  const start = (s) => (s.startDate ? Date.parse(s.startDate) : Infinity);
  const s = sprintsIn(f).reduce((a, b) => (!a || start(b) >= start(a) ? b : a), null);
  return s ? sprintDto(s) : null;
}

function issueDto(issue, docs) {
  const f = issue.fields;
  const { storyPointsField } = config.get().jira;
  const site = base();

  return {
    key: issue.key,
    url: `${site}/browse/${issue.key}`,
    summary: f.summary || '',
    type: { name: f.issuetype?.name || '', subtask: !!f.issuetype?.subtask },
    status: statusDto(f.status),
    priority: f.priority?.name || null,
    project: f.project ? { key: f.project.key, name: f.project.name } : null,
    created: f.created,
    updated: f.updated,
    resolved: f.resolutiondate || null,
    due: f.duedate || null,
    labels: f.labels || [],
    // Empty for a task with no fix version.
    fixVersions: (f.fixVersions || []).map((v) => ({ id: v.id, name: v.name, released: !!v.released, releaseDate: v.releaseDate || null })),
    sprint: sprintOf(f),
    // All of them, so a closed sprint still finds the work that was carried over from it, and with their dates, so
    // the client can tell which one the task was finished in.
    sprintIds: sprintsIn(f).map((s) => s.id),
    sprints: sprintsIn(f).map(sprintDto),
    storyPoints: f[storyPointsField] || null,
    parent: f.parent
      ? {
          key: f.parent.key,
          summary: f.parent.fields?.summary || '',
          type: f.parent.fields?.issuetype?.name || '',
          status: statusDto(f.parent.fields?.status),
        }
      : null,
    docs,
    attachments: (f.attachment || []).map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      mimeType: a.mimeType,
      created: a.created,
      author: a.author?.displayName || '',
      url: `/api/attachments/${a.id}/${encodeURIComponent(a.filename)}`,
    })),
  };
}

function classifyLink(url) {
  if (parseConfluence(url)) return 'confluence';
  if (/\/merge_requests\/\d+|\/pull\/\d+/.test(url)) return 'mr';
  if (/\/commits?\/[0-9a-f]{7,}/.test(url)) return 'commit';
  return 'other';
}

// ---------------------------------------------------------------------------
// History (Overview trends): only the fields the charts need, over a longer window than the task list.

const HISTORY_MAX = 2000;
const HISTORY_TTL = 10 * 60 * 1000;
const historyCache = new Map(); // jql → { at, data }

async function listHistory(jql, { fresh = false } = {}) {
  const hit = historyCache.get(jql);
  if (!fresh && hit && Date.now() - hit.at < HISTORY_TTL) return hit.data;
  const { storyPointsField } = config.get().jira;
  const raw = await searchAll(jql, ['issuetype', 'status', 'created', 'updated', 'resolutiondate', 'duedate', storyPointsField], HISTORY_MAX);
  const data = {
    truncated: raw.length >= HISTORY_MAX,
    issues: raw.map(({ key, fields: f }) => ({
      key,
      type: { name: f.issuetype?.name || '' },
      status: statusDto(f.status),
      created: f.created,
      updated: f.updated,
      resolved: f.resolutiondate || null,
      due: f.duedate || null,
      storyPoints: f[storyPointsField] || null,
    })),
  };
  historyCache.set(jql, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------------------
// List

// `prefetchSprints` (the viewed user's mapper): the pages will then ask for every task of the list's sprints (state.js
// loadSprintTasks, the same ids as its sprintScope()). Start that search as soon as the list's own search is back,
// with the sprints' dates in hand, so it runs alongside the rest of this one (listSprints shares it when asked).
async function listIssues(jql, { prefetchSprints } = {}) {
  const raw = await searchAll(jql, issueFields());
  if (prefetchSprints) {
    const sprints = new Map(raw.map((i) => sprintOf(i.fields)).filter(Boolean).map((s) => [s.id, s]));
    if (sprints.size) listSprints([...sprints.keys()], prefetchSprints, { known: [...sprints.values()] }).catch(() => {});
  }
  return issueList(raw);
}

// Everything in some sprints, closed ones too: the default JQL only keeps recently updated work, so the overview of
// an older sprint would miss most of what was done in it. `forUser` maps "assignee = currentUser()" to the viewed user.
const SPRINT_SUBTASKS_MAX = 2000;
// Sub-tasks are searched by `updated` from this long before the earliest of the sprints started (see fetchSprints).
const SUBTASK_MARGIN_DAYS = 30;
const SUBTASK_FALLBACK_DAYS = 120; // when no sprint date is known

// The sprints are asked for on each load and auto-refresh: keep the answer a while (a closed sprint barely changes)
// and share a call in flight. Longer than the 5-minute auto-refresh, or each one would miss; the open and recent work
// comes fresh from the task list anyway. A transition or a refresh by hand (`fresh`) skips it.
const SPRINT_TTL = { active: 15 * 60_000, closed: 60 * 60_000 };
const sprintCache = new Map(); // `${ids}|${viewed user}` → { at, ttl, promise }

// `known`: sprint objects with their dates, when the caller has them (the sub-task search then needn't wait for them).
function listSprints(ids, forUser, { fresh = false, known = [] } = {}) {
  ids = [...new Set(ids)].sort((a, b) => a - b);
  const key = `${ids.join(',')}|${forUser('assignee = currentUser()')}`;
  const hit = sprintCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const entry = { at: Date.now(), ttl: SPRINT_TTL.active, promise: fetchSprints(ids, forUser, known) };
  sprintCache.set(key, entry);
  entry.promise.then(
    (data) => data.sprints.length && data.sprints.every((s) => s.state === 'closed') && (entry.ttl = SPRINT_TTL.closed),
    () => sprintCache.get(key) === entry && sprintCache.delete(key),
  );
  return entry.promise;
}

// One sprint, for the Overview of it.
async function listSprint(id, forUser, opts) {
  const { sprints, issues } = await listSprints([id], forUser, opts);
  return { sprint: sprints[0] || null, issues };
}

// Two searches for any number of sprints. JQL "sprint in" leaves sub-tasks out (they carry their parent's sprints but
// are not indexed by them), so the viewed user's sub-tasks are searched on their own and kept when in the sprints.
// Being put in a sprint (when planned, or carried over with the parent) updates a sub-task, so the ones in these
// sprints were all updated since a little before the earliest of them started.
async function fetchSprints(ids, forUser, known = []) {
  const fields = issueFields();
  const inSprints = (i) => sprintsIn(i.fields).some((s) => ids.includes(s.id));
  const searchSubs = (sprints) => {
    const starts = sprints.filter((s) => ids.includes(s.id)).map((s) => Date.parse(s.startDate)).filter(Number.isFinite);
    const since = starts.length ? Math.min(...starts) - SUBTASK_MARGIN_DAYS * 86_400_000 : Date.now() - SUBTASK_FALLBACK_DAYS * 86_400_000;
    const day = new Date(since).toISOString().slice(0, 10);
    return searchAll(forUser(`assignee = currentUser() AND issuetype in subTaskIssueTypes() AND updated >= "${day}"`), fields, SPRINT_SUBTASKS_MAX);
  };
  // With every sprint's date known, both searches run at once; else the sub-tasks wait for the dates the first brings.
  const dated = ids.every((id) => known.some((s) => s.id === id && s.startDate));
  const topSearch = searchAll(forUser(`assignee = currentUser() AND sprint in (${ids.join(',')})`), fields, SPRINT_SUBTASKS_MAX);
  const subsSearch = dated ? searchSubs(known) : null;
  subsSearch?.catch(() => {}); // awaited below; if the first search fails it never is, and must not go unhandled
  const top = await topSearch;
  const found = new Map(top.flatMap((i) => sprintsIn(i.fields)).filter((s) => ids.includes(s.id)).map((s) => [s.id, s]));
  const subs = await (subsSearch || searchSubs([...found.values()]));
  const raw = new Map(top.map((i) => [i.key, i]));
  for (const s of subs) if (!raw.has(s.key) && inSprints(s)) raw.set(s.key, s);
  for (const i of raw.values()) for (const s of sprintsIn(i.fields)) if (ids.includes(s.id) && !found.has(s.id)) found.set(s.id, s);
  return { sprints: ids.map((id) => found.get(id)).filter(Boolean).map(sprintDto), issues: await issueList([...raw.values()]) };
}

async function issueList(issues) {
  const byKey = new Map(issues.map((i) => [i.key, i]));
  // Independent of the parents' lookup below: run alongside it.
  const childSprintsSearch = childSprintsOf(issues);

  // Sub-tasks rarely carry their own PRD link; inherit the parent's Confluence links.
  const parentKeys = [...new Set(issues.map((i) => i.fields.parent?.key).filter((k) => k && !byKey.has(k)))];
  const parentDesc = new Map();
  const parentFields = new Map(); // parent key → fields (its own parent tells a sub-task's Epic)
  // One search per 50 parents instead of one getJiraIssue each: every call counts against Atlassian's rate limit.
  for (let n = 0; n < parentKeys.length; n += 50) {
    const chunk = parentKeys.slice(n, n + 50);
    try {
      for (const p of await searchAll(`key in (${chunk.join(',')})`, ['description', 'parent'])) {
        parentDesc.set(p.key, p.fields?.description);
        parentFields.set(p.key, p.fields || {});
      }
    } catch {
      // JQL rejects the whole batch when one key is not visible to this user: fall back to one call per parent.
      await mapPool(chunk, 4, async (key) => {
        try {
          const p = await callTool('getJiraIssue', { issueIdOrKey: key, fields: ['description', 'parent'], responseContentFormat: 'adf' });
          parentDesc.set(key, p.fields?.description);
          parentFields.set(key, p.fields || {});
        } catch {
          // Parent not visible to this user: skip its links.
        }
      });
    }
  }
  for (const [key, issue] of byKey) {
    parentDesc.set(key, issue.fields.description);
    parentFields.set(key, issue.fields);
  }

  const ownLinks = new Map(issues.map((i) => [i.key, confluenceLinks(i.fields.description)]));
  const parentLinks = new Map([...parentDesc].map(([k, d]) => [k, ownLinks.get(k) || confluenceLinks(d)]));

  const allLinks = [...ownLinks.values(), ...parentLinks.values()].flat();
  await resolvePages(allLinks.map((l) => l.pageId));

  const childSprints = await childSprintsSearch;

  return issues.map((issue) => {
    const pk = issue.fields.parent?.key;
    const dto = issueDto(issue, mergeDocs(issue.key, ownLinks.get(issue.key), pk, (pk && parentLinks.get(pk)) || []));
    dto.epic = epicOf(issue, parentFields);
    if (childSprints.has(issue.key)) dto.childSprints = childSprints.get(issue.key);
    return dto;
  });
}

// Epics are never put in a sprint on Jira, so the sprint filter would always drop them. Look up the
// sprints of their children that are in the list (so only the viewed user's own tasks, never someone else's):
// epic key → [sprint], one search per 50 epics.
async function childSprintsOf(issues) {
  const epics = issues.filter((i) => /epic/i.test(i.fields.issuetype?.name || '') && !sprintOf(i.fields)).map((i) => i.key);
  const listed = new Set(issues.map((i) => i.key));
  const out = new Map();
  for (let n = 0; n < epics.length; n += 50) {
    const keys = epics.slice(n, n + 50);
    try {
      const children = await searchAll(`parent in (${keys.join(',')}) AND sprint is not EMPTY`, ['parent', config.get().jira.sprintField]);
      for (const c of children) {
        if (!listed.has(c.key)) continue;
        const s = sprintOf(c.fields);
        const pk = c.fields.parent?.key;
        if (!s || !pk) continue;
        if (!out.has(pk)) out.set(pk, []);
        if (!out.get(pk).some((x) => x.id === s.id)) out.get(pk).push(s);
      }
    } catch {
      // Children not searchable: those epics just keep no sprint.
    }
  }
  return out;
}

// The Epic above an issue: its parent (Task/Story → Epic) or its grandparent (Sub-task → Story → Epic).
// The epic branch of the git flow is named after it.
function epicOf(issue, parentFields) {
  const isEpic = (n) => /epic/i.test(n?.fields?.issuetype?.name || '');
  const dto = (n) => ({ key: n.key, summary: n.fields?.summary || '', status: statusDto(n.fields?.status) });
  if (/epic/i.test(issue.fields.issuetype?.name || '')) return null;
  const p = issue.fields.parent;
  if (!p) return null;
  if (isEpic(p)) return dto(p);
  const gp = parentFields.get(p.key)?.parent;
  return gp && isEpic(gp) ? dto(gp) : null;
}

// An issue's docs: its own Confluence links first, then the ones inherited from its parent.
function mergeDocs(key, own, parentKey, inherited) {
  const docs = new Map();
  for (const l of own) docs.set(l.pageId || l.url, withPageInfo(l, key));
  for (const l of inherited) if (!docs.has(l.pageId || l.url)) docs.set(l.pageId || l.url, withPageInfo(l, parentKey));
  return [...docs.values()];
}

// ---------------------------------------------------------------------------
// Detail

async function issueDetail(key) {
  const [issue, remote, children] = await Promise.all([
    callTool('getJiraIssue', { issueIdOrKey: key, fields: [...issueFields(), 'comment', 'assignee', 'reporter'], expand: 'renderedFields', responseContentFormat: 'adf' }),
    callTool('getJiraIssueRemoteIssueLinks', { issueIdOrKey: key }).catch(() => []),
    searchAll(`parent = ${key} ORDER BY created ASC`, ['summary', 'status', 'issuetype', 'assignee']).catch(() => []),
  ]);
  const f = issue.fields;

  let inherited = [];
  if (f.parent?.key) {
    try {
      const p = await callTool('getJiraIssue', { issueIdOrKey: f.parent.key, fields: ['description'], responseContentFormat: 'adf' });
      inherited = confluenceLinks(p.fields?.description);
    } catch {
      // Parent not visible: no inherited docs.
    }
  }
  const own = confluenceLinks(f.description);

  // Rendered comments carry HTML bodies but display-formatted dates; take dates from the raw list.
  const raw = f.comment?.comments || [];
  const rendered = issue.renderedFields?.comment?.comments || [];
  const comments = raw.map((c, i) => ({
    id: c.id,
    author: c.author?.displayName || '',
    created: c.created,
    html: typeof rendered[i]?.body === 'string' ? rendered[i].body : '',
  }));

  const links = (Array.isArray(remote) ? remote : [])
    .filter((l) => l.object?.url)
    .map((l) => ({
      kind: classifyLink(l.object.url),
      title: l.object.title || l.object.url,
      url: l.object.url,
      source: l.object.icon?.title || l.application?.name || '',
    }));

  const confluence = links.filter((l) => l.kind === 'confluence').map((l) => ({ ...parseConfluence(l.url), fallback: l.title }));
  await resolvePages([...own, ...inherited, ...confluence].map((c) => c.pageId));

  return {
    issue: issueDto(issue, mergeDocs(key, own, f.parent?.key, inherited)),
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    children: children.map((c) => ({
      key: c.key,
      summary: c.fields.summary || '',
      type: c.fields.issuetype?.name || '',
      status: statusDto(c.fields.status),
      assignee: c.fields.assignee?.displayName || null,
    })),
    comments,
    descriptionHtml: issue.renderedFields?.description || '',
    confluence: confluence.map((c) => {
      const info = withPageInfo(c, key);
      return { ...info, title: info.title || c.fallback };
    }),
    links: links.filter((l) => l.kind !== 'confluence'),
  };
}

// ---------------------------------------------------------------------------
// Workflow

async function listTransitions(key) {
  const data = await callTool('getTransitionsForJiraIssue', { issueIdOrKey: key });
  return (data.transitions || []).map((t) => ({ id: t.id, name: t.name, to: statusDto(t.to) }));
}

async function doTransition(key, id) {
  await callTool('transitionJiraIssue', { issueIdOrKey: key, transition: { id: String(id) } });
  sprintCache.clear(); // the sprint numbers must follow the move at once
  const issue = await callTool('getJiraIssue', { issueIdOrKey: key, fields: ['status'] });
  return { status: statusDto(issue.fields.status) };
}

// ---------------------------------------------------------------------------
// The epic branch of the git flow follows the parent Epic on Jira; a ticket without one is its own epic.

// Both caches expire: the parent Epic can change on Jira while the server keeps running.
const CACHE_TTL = 10 * 60_000;
const CACHE_MAX = 500;
const epicCache = new Map(); // ticket → { value, at }
const summaryCache = new Map(); // ticket → { value, at }, filled while resolving epics

function cacheGet(cache, key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(cache, key, value) {
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
  // Maps iterate in insertion order, so the first key is the oldest.
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function resolveEpic(key) {
  const cached = cacheGet(epicCache, key);
  if (cached !== undefined) return cached;
  let epic = key;
  let cur = key;
  for (let depth = 0; depth < 3 && cur; depth++) {
    const j = await callTool('getJiraIssue', { issueIdOrKey: cur, fields: ['parent', 'issuetype', 'summary'] });
    if (j.fields?.summary) cacheSet(summaryCache, cur, j.fields.summary);
    if (/epic/i.test(j.fields?.issuetype?.name || '')) {
      epic = cur;
      break;
    }
    const p = j.fields?.parent;
    if (p && /epic/i.test(p.fields?.issuetype?.name || '')) {
      epic = p.key;
      break;
    }
    cur = p?.key;
  }
  cacheSet(epicCache, key, epic);
  return epic;
}

const ticketSummary = (key) => cacheGet(summaryCache, key);

// Sprint of a set of tickets by key, regardless of the default JQL (closed/old tickets a branch
// still names are often outside it). Used by the workspace branch cleanup's sprint filter.
async function sprintsOf(keys) {
  const out = new Map();
  const todo = [...new Set(keys)].filter(Boolean);
  for (let n = 0; n < todo.length; n += 50) {
    const chunk = todo.slice(n, n + 50);
    try {
      const issues = await searchAll(`key in (${chunk.join(',')})`, [config.get().jira.sprintField]);
      for (const i of issues) out.set(i.key, sprintOf(i.fields));
    } catch {
      // A key no longer visible (deleted/no access): just leave it without a sprint.
    }
  }
  return out;
}

module.exports = { listIssues, listSprint, listSprints, listHistory, issueDetail, listTransitions, doTransition, resolveEpic, ticketSummary, sprintsOf };
