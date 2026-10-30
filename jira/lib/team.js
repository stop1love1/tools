'use strict';

// The whole team's work in one sprint, for the Overview's 3D office: every assignee's tasks with what decides where
// they stand there (status, priority, type, due date, last update). The same tasks as the task list's sprint view:
// JQL "sprint in" leaves sub-tasks out (they carry their parent's sprint but aren't indexed by it), so they are
// searched on their own and kept when in the sprint, as fetchSprints in issues.js does for one person.

const config = require('./config');
const { searchAll, userInfo } = require('./mcp');
const { listUsers } = require('./users');

const TEAM_MAX = 1000;
const SUBTASKS_MAX = 2000;
const SUBTASK_MARGIN_DAYS = 30; // being put in a sprint updates a sub-task: they were updated since a little before it started
const TTL = 60_000; // the office polls; a minute keeps that to one search per minute however many windows are open
const cache = new Map(); // sprint id or 'open' → { at, promise }

const sprintsOf = (f) => [].concat(f[config.get().jira.sprintField] || []).filter(Boolean);

// The sprint the office is about: the one asked for, else the active sprint most of the found tasks are in (open
// sprints of several teams can come back together).
function pickSprint(raw, sprintId) {
  const seen = new Map();
  for (const i of raw) {
    for (const s of sprintsOf(i.fields)) {
      const e = seen.get(s.id) || { s, n: 0 };
      e.n++;
      seen.set(s.id, e);
    }
  }
  if (sprintId) return seen.get(sprintId)?.s || null;
  return [...seen.values()].filter((e) => e.s.state === 'active').sort((a, b) => b.n - a.n)[0]?.s || null;
}

// Search results → one entry per assignee with their tasks in the sprint. `me` is always there (the player), and
// `qa` (display names or account ids from Settings) puts people in the QA room.
// The Epic above an issue, as the task list finds it (epicOf in issues.js): its parent (Task/Story → Epic) or its
// grandparent (Sub-task → Story → Epic). `parents`: key → fields of parents that are not in `raw`.
const isEpicNode = (n) => /epic/i.test(n?.fields?.issuetype?.name || '');
function epicOf(f, byKey) {
  if (/epic/i.test(f.issuetype?.name || '') || !f.parent) return null;
  const node = isEpicNode(f.parent) ? f.parent : byKey.get(f.parent.key)?.parent;
  return node && isEpicNode(node) ? { key: node.key, summary: node.fields?.summary || '' } : null;
}

function groupTeam(raw, { me, meName, qa = [], sprintId = null, parents = new Map() }) {
  const { storyPointsField } = config.get().jira;
  const sprint = pickSprint(raw, sprintId);
  const qaSet = new Set(qa.map((x) => x.trim().toLowerCase()).filter(Boolean));
  const people = new Map(), byKey = new Map([...parents, ...raw.map((i) => [i.key, i.fields])]);
  for (const { key, fields: f } of raw) {
    const a = f.assignee;
    if (!a?.accountId) continue; // Epics put in the sprint count too, as in the task list
    if (sprint && !sprintsOf(f).some((s) => s.id === sprint.id)) continue;
    const p = people.get(a.accountId) || { accountId: a.accountId, name: a.displayName || a.accountId, tasks: [] };
    p.tasks.push({
      key,
      summary: f.summary || '',
      type: f.issuetype?.name || '',
      subtask: !!f.issuetype?.subtask,
      parent: f.parent?.key || null,
      status: { name: f.status?.name || '', category: f.status?.statusCategory?.key || 'indeterminate' },
      priority: f.priority?.name || null,
      due: f.duedate || null,
      updated: f.updated || null,
      storyPoints: f[storyPointsField] || null,
      epic: epicOf(f, byKey),
    });
    people.set(a.accountId, p);
  }
  if (me && !people.has(me)) people.set(me, { accountId: me, name: meName || 'Me', tasks: [] });
  const role = (p) => (qaSet.has(p.name.toLowerCase()) || qaSet.has(p.accountId.toLowerCase()) ? 'qa' : 'dev');
  return {
    sprint: sprint ? { id: sprint.id, name: sprint.name, state: sprint.state, startDate: sprint.startDate || null, endDate: sprint.endDate || null } : null,
    members: [...people.values()]
      .map((p) => ({ ...p, me: p.accountId === me, role: role(p) }))
      .sort((a, b) => b.me - a.me || a.name.localeCompare(b.name, 'vi')),
  };
}

async function fetchTeam(sprintId) {
  const [{ projects }, info] = await Promise.all([listUsers(), userInfo()]);
  const { sprintField, storyPointsField } = config.get().jira;
  const scope = projects.length ? `project in (${projects.join(',')}) AND ` : '';
  const jql = `${sprintId ? `sprint = ${sprintId}` : `${scope}sprint in openSprints()`} ORDER BY updated DESC`;
  const fields = ['summary', 'status', 'issuetype', 'priority', 'duedate', 'updated', 'assignee', 'parent', sprintField, storyPointsField];
  const top = await searchAll(jql, fields, TEAM_MAX);
  const sprint = pickSprint(top, sprintId);
  let subs = [];
  if (sprint) {
    const projs = [...new Set(top.map((i) => i.key.split('-')[0]))];
    const start = Date.parse(sprint.startDate);
    const day = new Date((Number.isFinite(start) ? start : Date.now()) - SUBTASK_MARGIN_DAYS * 86_400_000).toISOString().slice(0, 10);
    const found = await searchAll(`project in (${projs.join(',')}) AND issuetype in subTaskIssueTypes() AND assignee is not EMPTY AND updated >= "${day}"`, fields, SUBTASKS_MAX);
    subs = found.filter((i) => sprintsOf(i.fields).some((x) => x.id === sprint.id));
  }
  const seen = new Set(top.map((i) => i.key));
  const raw = [...top, ...subs.filter((i) => !seen.has(i.key))];
  // A sub-task's Epic is its parent's parent: look up the parents the searches didn't bring, 50 keys per search.
  const have = new Set(raw.map((i) => i.key)), parents = new Map();
  const missing = [...new Set(raw.filter((i) => i.fields.parent && !isEpicNode(i.fields.parent)).map((i) => i.fields.parent.key))].filter((k) => !have.has(k));
  for (let n = 0; n < missing.length; n += 50) {
    try {
      for (const p of await searchAll(`key in (${missing.slice(n, n + 50).join(',')})`, ['parent'])) parents.set(p.key, p.fields || {});
    } catch {
      // One key out of view rejects the batch: those sub-tasks just show no Epic.
    }
  }
  return {
    jql,
    truncated: top.length >= TEAM_MAX,
    ...groupTeam(raw, { me: info.account_id, meName: info.nickname || info.name, qa: config.get().office.qaPeople, sprintId, parents }),
  };
}

// What the office's Team panel and Settings set: each person's gender and a role that wins over the QA people list,
// the team's order (meeting seats, standup turns) and the day's schedule. Applied on every answer, cached or not,
// so a change shows on the next load.
const withProfiles = (team, { people = {}, order = [], hours, lunch, standup, retro } = {}) => ({
  ...team,
  members: team.members.map((m) => {
    const p = people[m.accountId] || {};
    return { ...m, role: p.role || m.role, gender: p.gender || null, gitlab: p.gitlab || null };
  }),
  order,
  schedule: { hours, lunch, standup, retro },
});

// `sprintId`: a sprint picked on the Overview; none = the team's active sprint. `fresh` skips the cache.
function listTeamSprint({ sprintId = null, fresh = false } = {}) {
  const key = sprintId || 'open';
  const hit = cache.get(key);
  const profiles = (team) => withProfiles(team, config.get().office);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.promise.then(profiles);
  const promise = fetchTeam(sprintId);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.get(key)?.promise === promise && cache.delete(key));
  return promise.then(profiles);
}

module.exports = { listTeamSprint, groupTeam, withProfiles };
