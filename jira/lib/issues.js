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

async function listIssues(jql) {
  return issueList(await searchAll(jql, issueFields()));
}

// Everything in one sprint, closed ones too: the default JQL only keeps recently updated work, so the overview of
// an older sprint would miss most of what was done in it. JQL "sprint = N" leaves sub-tasks out (they only inherit
// the sprint from their parent), so those are fetched by parent. `forUser` maps "assignee = currentUser()" to the viewed user.
const SPRINT_PARENTS_MAX = 1000;

// One sprint costs a dozen searches, and the pages ask for every sprint they list on each load and auto-refresh:
// keep the answer a while (a closed sprint barely changes) and share a call in flight. Longer than the 5-minute
// auto-refresh, or each one would miss; the open and recent work comes fresh from the task list anyway. A transition
// or a refresh by hand (`fresh`) skips it.
const SPRINT_TTL = { active: 15 * 60_000, closed: 60 * 60_000 };
const sprintCache = new Map(); // `${id}|${viewed user}` → { at, ttl, promise }

function listSprint(id, forUser, { fresh = false } = {}) {
  const key = `${id}|${forUser('assignee = currentUser()')}`;
  const hit = sprintCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const entry = { at: Date.now(), ttl: SPRINT_TTL.active, promise: fetchSprint(id, forUser) };
  sprintCache.set(key, entry);
  entry.promise.then(
    (data) => data.sprint?.state === 'closed' && (entry.ttl = SPRINT_TTL.closed),
    () => sprintCache.get(key) === entry && sprintCache.delete(key),
  );
  return entry.promise;
}

async function fetchSprint(id, forUser) {
  const fields = issueFields();
  const raw = await searchAll(forUser(`assignee = currentUser() AND sprint = ${id}`), fields);
  const seen = new Set(raw.map((i) => i.key));
  const parents = (await searchAll(`sprint = ${id} AND issuetype not in subTaskIssueTypes()`, ['issuetype'], SPRINT_PARENTS_MAX)).map((i) => i.key);
  for (let n = 0; n < parents.length; n += 50) {
    const subs = await searchAll(forUser(`assignee = currentUser() AND parent in (${parents.slice(n, n + 50).join(',')})`), fields);
    for (const s of subs) if (!seen.has(s.key) && sprintsIn(s.fields).some((x) => x.id === id)) (seen.add(s.key), raw.push(s));
  }
  const found = raw.flatMap((i) => sprintsIn(i.fields)).find((s) => s.id === id);
  return { sprint: found ? sprintDto(found) : null, issues: await issueList(raw) };
}

async function issueList(issues) {
  const byKey = new Map(issues.map((i) => [i.key, i]));

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

  const childSprints = await childSprintsOf(issues);

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

module.exports = { listIssues, listSprint, listHistory, issueDetail, listTransitions, doTransition, resolveEpic, ticketSummary, sprintsOf };
