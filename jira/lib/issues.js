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
    'summary', 'status', 'issuetype', 'priority', 'updated', 'created', 'duedate',
    'parent', 'project', 'description', 'attachment', 'labels', sprintField, storyPointsField,
  ];
}

// ---------------------------------------------------------------------------
// DTOs

function statusDto(s) {
  return s ? { id: s.id, name: s.name, category: s.statusCategory?.key || 'indeterminate' } : null;
}

// An issue's sprint: the active one if it was carried over several, else the latest.
function sprintOf(f) {
  const sprintValue = f.sprint || f[config.get().jira.sprintField];
  const sprints = Array.isArray(sprintValue) ? sprintValue : sprintValue ? [sprintValue] : [];
  const s = sprints.find((x) => x && x.state === 'active') || sprints[sprints.length - 1] || null;
  return s ? { id: s.id, name: s.name, state: s.state } : null;
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
    due: f.duedate || null,
    labels: f.labels || [],
    sprint: sprintOf(f),
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
// List

async function listIssues(jql) {
  const issues = await searchAll(jql, issueFields());
  const byKey = new Map(issues.map((i) => [i.key, i]));

  // Sub-tasks rarely carry their own PRD link; inherit the parent's Confluence links.
  const parentKeys = [...new Set(issues.map((i) => i.fields.parent?.key).filter((k) => k && !byKey.has(k)))];
  const parentDesc = new Map();
  const parentFields = new Map(); // parent key → fields (its own parent tells a sub-task's Epic)
  await mapPool(parentKeys, 4, async (key) => {
    try {
      const p = await callTool('getJiraIssue', { issueIdOrKey: key, fields: ['description', 'parent'], responseContentFormat: 'adf' });
      parentDesc.set(key, p.fields?.description);
      parentFields.set(key, p.fields || {});
    } catch {
      // Parent not visible to this user: skip its links.
    }
  });
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
// sprints of their children (anyone's, not just the listed ones): epic key → [sprint], one search per 50 epics.
async function childSprintsOf(issues) {
  const epics = issues.filter((i) => /epic/i.test(i.fields.issuetype?.name || '') && !sprintOf(i.fields)).map((i) => i.key);
  const out = new Map();
  for (let n = 0; n < epics.length; n += 50) {
    const keys = epics.slice(n, n + 50);
    try {
      const children = await searchAll(`parent in (${keys.join(',')}) AND sprint is not EMPTY`, ['parent', config.get().jira.sprintField]);
      for (const c of children) {
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
  const issue = await callTool('getJiraIssue', { issueIdOrKey: key, fields: ['status'] });
  return { status: statusDto(issue.fields.status) };
}

// ---------------------------------------------------------------------------
// The epic branch of the git flow follows the parent Epic on Jira; a ticket without one is its own epic.

const epicCache = new Map();
const summaryCache = new Map(); // ticket → summary, filled while resolving epics

async function resolveEpic(key) {
  if (epicCache.has(key)) return epicCache.get(key);
  let epic = key;
  let cur = key;
  for (let depth = 0; depth < 3 && cur; depth++) {
    const j = await callTool('getJiraIssue', { issueIdOrKey: cur, fields: ['parent', 'issuetype', 'summary'] });
    if (j.fields?.summary) summaryCache.set(cur, j.fields.summary);
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
  epicCache.set(key, epic);
  return epic;
}

const ticketSummary = (key) => summaryCache.get(key);

module.exports = { listIssues, issueDetail, listTransitions, doTransition, resolveEpic, ticketSummary };
