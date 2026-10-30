'use strict';

// The whole team's work in one sprint, for the Overview's 3D office: every assignee's tasks with what decides where
// they stand there (status, priority, type, due date, last update). Sub-tasks stay out: JQL "sprint in" never
// returns them (see fetchSprints in issues.js), and the office shows people by their sprint tasks.

const config = require('./config');
const { searchAll, userInfo } = require('./mcp');
const { listUsers } = require('./users');

const TEAM_MAX = 500;
const TTL = 60_000; // the office polls; a minute keeps that to one search per minute however many windows are open
const cache = new Map(); // sprint id or 'open' → { at, promise }

const isEpic = (f) => /epic/i.test(f.issuetype?.name || '');
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
function groupTeam(raw, { me, meName, qa = [], sprintId = null }) {
  const { storyPointsField } = config.get().jira;
  const sprint = pickSprint(raw, sprintId);
  const qaSet = new Set(qa.map((x) => x.trim().toLowerCase()).filter(Boolean));
  const people = new Map();
  for (const { key, fields: f } of raw) {
    const a = f.assignee;
    if (!a?.accountId || isEpic(f)) continue;
    if (sprint && !sprintsOf(f).some((s) => s.id === sprint.id)) continue;
    const p = people.get(a.accountId) || { accountId: a.accountId, name: a.displayName || a.accountId, tasks: [] };
    p.tasks.push({
      key,
      summary: f.summary || '',
      type: f.issuetype?.name || '',
      status: { name: f.status?.name || '', category: f.status?.statusCategory?.key || 'indeterminate' },
      priority: f.priority?.name || null,
      due: f.duedate || null,
      updated: f.updated || null,
      storyPoints: f[storyPointsField] || null,
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
  const fields = ['summary', 'status', 'issuetype', 'priority', 'duedate', 'updated', 'assignee', sprintField, storyPointsField];
  const raw = await searchAll(jql, fields, TEAM_MAX);
  return {
    jql,
    truncated: raw.length >= TEAM_MAX,
    ...groupTeam(raw, { me: info.account_id, meName: info.nickname || info.name, qa: config.get().office.qaPeople, sprintId }),
  };
}

// `sprintId`: a sprint picked on the Overview; none = the team's active sprint. `fresh` skips the cache.
function listTeamSprint({ sprintId = null, fresh = false } = {}) {
  const key = sprintId || 'open';
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.promise;
  const promise = fetchTeam(sprintId);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.get(key)?.promise === promise && cache.delete(key));
  return promise;
}

module.exports = { listTeamSprint, groupTeam };
