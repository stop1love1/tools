'use strict';

// Dashboard settings: defaults (from .env where it has them) overlaid with config.json, which the Settings page
// edits. Modules read get() at call time, so most changes apply without a restart; fields marked `restart` are
// only read at startup.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { httpError, safeJson } = require('./util');

const FILE = process.env.DASHBOARD_CONFIG_FILE || path.join(__dirname, '..', 'config.json');

const MR_CHECKLIST = [
  'MR title is clear and follows team conventions',
  'No debug logs / console noise left behind',
  'TypeScript types updated (no `any` unless justified)',
  'Tests added/updated (or not needed with explanation)',
  'Build packages successfully',
  'Build corresponding app successfully (admin / learner / others)',
  'Translations updated if applicable (e.g. `sites/**/locales/{en,vi}.json`)',
  'Accessibility considered (keyboard navigation, labels, contrast) for UI changes',
  'Error states handled (loading/empty/error)',
  'Security/permissions considered (no sensitive data in logs, correct authz)',
  'Docs updated if needed (README / docs / inline comments)',
];

function defaults() {
  const env = process.env;
  const root = env.LMS_ROOT || path.join(os.homedir(), 'Documents', 'lms');
  return {
    jira: {
      siteUrl: env.JIRA_SITE_URL || 'https://vin3s.atlassian.net',
      defaultJql: env.DEFAULT_JQL || 'assignee = currentUser() AND (statusCategory != Done OR updated >= -14d) ORDER BY updated DESC',
      presets: [
        { label: 'Not done', jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
        { label: 'Updated in last 7 days', jql: 'assignee = currentUser() AND updated >= -7d ORDER BY updated DESC' },
        { label: 'All (90 days)', jql: 'assignee = currentUser() AND updated >= -90d ORDER BY updated DESC' },
        { label: 'Created by me, not done', jql: 'reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
      ],
      storyPointsField: 'customfield_10016',
      sprintField: 'customfield_10020',
      maxIssues: 300,
      notifyDays: 7,
      autoRefreshMinutes: 5,
      apiEmail: env.JIRA_API_EMAIL || '',
      apiToken: env.JIRA_API_TOKEN || '',
    },
    editor: {
      bin: env.EDITOR_BIN || 'cursor',
      uriScheme: env.EDITOR_URI_SCHEME || 'cursor',
    },
    git: {
      root,
      scratchRoot: env.GIT_SCRATCH_ROOT || path.join(path.dirname(root), 'lms-worktrees'),
      repos: [
        { id: 'backend', label: 'Backend', dir: 'backend' },
        { id: 'frontend', label: 'Frontend', dir: 'frontend' },
      ],
      projectKey: 'VLEARN',
      uatBranch: 'uat',
      developBranch: 'develop',
      mainBranch: 'main',
      branchTypes: ['feature', 'bugfix', 'hotfix', 'refactor', 'docs', 'chore', 'test'],
      commitLookbackDays: 180,
      mrLookbackDays: 90,
      backupPruneDays: 14,
      glabBin: env.GLAB_BIN || 'glab',
      mrChecklist: MR_CHECKLIST,
    },
    mcp: {
      enabled: true,
      allowWrites: false,
      allowDestructive: false,
    },
    agent: {
      extraInstructions: [],
    },
    office: {
      qaPeople: [],
      people: {}, // accountId → { gender, role }, set from the office's Team panel (savePerson)
      order: [], // accountIds as dragged in the Team panel: meeting seats and standup turns (saveOrder)
      hours: '08:30-17:30',
      lunch: '12:00-13:00',
      standup: '09:15',
      retro: '16:00',
    },
    server: {
      port: Number(env.PORT) || 4747,
      mcpUrl: env.MCP_SERVER_URL || 'https://mcp.atlassian.com/v1/mcp',
      mcpServerName: env.MCP_SERVER_NAME || 'atlassian',
      credentialsFile: env.CLAUDE_CREDENTIALS_FILE || path.join(os.homedir(), '.claude', '.credentials.json'),
    },
  };
}

// What the Settings page shows and what a save may change. Types: text, url, number, bool, path, lines, presets, repos.
const SCHEMA = [
  { section: 'Jira', fields: [
    { key: 'jira.siteUrl', label: 'Jira site URL', type: 'url', restart: true },
    { key: 'jira.defaultJql', label: 'Default JQL', type: 'text', mono: true, help: 'The first entry of the filter list.' },
    { key: 'jira.presets', label: 'Saved filters', type: 'presets', help: 'Keys 2–9 switch to them.' },
    { key: 'jira.storyPointsField', label: 'Story points field', type: 'text', mono: true, pattern: '^customfield_\\d+$' },
    { key: 'jira.sprintField', label: 'Sprint field', type: 'text', mono: true, pattern: '^(sprint|customfield_\\d+)$' },
    { key: 'jira.maxIssues', label: 'Max issues per load', type: 'number', min: 50, max: 2000 },
    { key: 'jira.notifyDays', label: 'Notifications: days back', type: 'number', min: 1, max: 30 },
    { key: 'jira.autoRefreshMinutes', label: 'Auto refresh (minutes, 0 = off)', type: 'number', min: 0, max: 120 },
  ] },
  { section: 'Editor', fields: [
    { key: 'editor.bin', label: 'Editor command', type: 'path', help: 'Used for "Open in Cursor" and the Claude Code button.' },
    { key: 'editor.uriScheme', label: 'Editor URI scheme', type: 'text', mono: true, pattern: '^[a-z][a-z0-9+.-]*$' },
  ] },
  { section: 'Git flow', fields: [
    { key: 'git.root', label: 'Repos root folder', type: 'path' },
    { key: 'git.repos', label: 'Repositories', type: 'repos', help: 'Folder names under the root folder.' },
    { key: 'git.scratchRoot', label: 'Scratch worktree folder', type: 'path' },
    { key: 'git.projectKey', label: 'Jira project key in branches & commits', type: 'text', mono: true, pattern: '^[A-Z][A-Z0-9_]+$' },
    { key: 'git.uatBranch', label: 'UAT branch', type: 'text', mono: true, pattern: '^[A-Za-z0-9._-]+$', help: 'Epics start from it; task branches end in -<this>.' },
    { key: 'git.developBranch', label: 'Develop branch', type: 'text', mono: true, pattern: '^[A-Za-z0-9._-]+$' },
    { key: 'git.mainBranch', label: 'Main branch', type: 'text', mono: true, pattern: '^[A-Za-z0-9._-]+$' },
    { key: 'git.branchTypes', label: 'Branch types', type: 'lines', mono: true, pattern: '^[a-z]+$' },
    { key: 'git.commitLookbackDays', label: 'Commit lookback (days)', type: 'number', min: 7, max: 1000 },
    { key: 'git.mrLookbackDays', label: 'MR lookback (days)', type: 'number', min: 7, max: 365 },
    { key: 'git.backupPruneDays', label: 'Prune backups older than (days)', type: 'number', min: 1, max: 365 },
    { key: 'git.glabBin', label: 'glab command', type: 'path' },
    { key: 'git.mrChecklist', label: 'MR checklist', type: 'lines' },
  ] },
  { section: 'MCP (for Claude Code, Cursor…)', fields: [
    { key: 'mcp.enabled', label: 'Serve MCP at /mcp', type: 'bool', help: 'AI tools on this machine can read your Jira issues, docs and git flow.' },
    { key: 'mcp.allowWrites', label: 'Allow write tools', type: 'bool', help: 'Changing Jira status and running git steps (branch, commit, push, cherry-pick…). Clients must send the token from .mcp-token as a Bearer header.' },
    { key: 'mcp.allowDestructive', label: 'Allow destructive git steps', type: 'bool', help: 'Also allow force-push, rebase of task / epic branches, undo, deleting branches and pruning backups. Needs "Allow write tools".' },
  ] },
  { section: 'Start with Claude', fields: [
    { key: 'agent.extraInstructions', label: 'Extra instructions in every prompt', type: 'lines', optional: true, help: 'Team conventions, commands to run before committing…' },
  ] },
  { section: 'Overview 3D office', fields: [
    { key: 'office.qaPeople', label: 'QA people', type: 'lines', optional: true, help: 'Jira display names (or account ids), one per line. They sit in the QA room; everyone else in the Dev room. The Team panel in the office sets each person\'s role (Dev, QA, BA, PO, PM).' },
    { key: 'office.hours', label: 'Office hours', type: 'text', mono: true, pattern: '^\\d{1,2}:\\d{2}-\\d{1,2}:\\d{2}$', help: 'Outside them (and at weekends) only people with a Jira update in the last hour stay in the office.' },
    { key: 'office.lunch', label: 'Lunch break', type: 'text', mono: true, pattern: '^\\d{1,2}:\\d{2}-\\d{1,2}:\\d{2}$', help: 'Everyone goes to the pantry.' },
    { key: 'office.standup', label: 'Daily standup', type: 'text', mono: true, pattern: '^\\d{1,2}:\\d{2}$', help: '15 minutes at the sprint board. On the sprint\'s first day: an hour of sprint planning in the meeting room instead.' },
    { key: 'office.retro', label: 'Sprint review & retro', type: 'text', mono: true, pattern: '^\\d{1,2}:\\d{2}$', help: 'An hour in the meeting room on the sprint\'s last day.' },
  ] },
  { section: 'Server', fields: [
    { key: 'server.port', label: 'Port', type: 'number', min: 1024, max: 65535, restart: true },
    { key: 'server.mcpUrl', label: 'Atlassian MCP URL', type: 'url', restart: true },
    { key: 'server.mcpServerName', label: 'MCP server name in Claude Code', type: 'text', restart: true },
    { key: 'server.credentialsFile', label: 'Claude Code credentials file', type: 'path', restart: true },
  ] },
];

const FIELDS = SCHEMA.flatMap((s) => s.fields);

const getAt = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);
function setAt(obj, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  let o = obj;
  for (const p of parts) o = o[p] ??= {};
  o[last] = value;
}

let overrides = {};
let current = null;
let startup = null; // values of `restart` fields as the server started

function load() {
  overrides = fs.existsSync(FILE) ? safeJson(fs.readFileSync(FILE, 'utf8')) || {} : {};
  const base = defaults();
  for (const f of FIELDS) {
    const v = getAt(overrides, f.key);
    if (v !== undefined && !validate(f, v)) setAt(base, f.key, v);
  }
  base.office.people = cleanPeople(overrides.office?.people);
  base.office.order = cleanOrder(overrides.office?.order);
  current = base;
  startup ??= Object.fromEntries(FIELDS.filter((f) => f.restart).map((f) => [f.key, getAt(base, f.key)]));
  return current;
}

const get = () => current || load();

// Returns an error message, or '' when the value fits the field.
function validate(f, v) {
  const re = f.pattern && new RegExp(f.pattern);
  const str = (x) => typeof x === 'string' && x.length <= 2000;
  switch (f.type) {
    case 'bool':
      return typeof v === 'boolean' ? '' : 'must be on or off';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && v >= (f.min ?? -Infinity) && v <= (f.max ?? Infinity) ? '' : `must be a number between ${f.min} and ${f.max}`;
    case 'url':
      try {
        return /^https?:$/.test(new URL(v).protocol) ? '' : 'must be an http(s) URL';
      } catch {
        return 'must be a URL';
      }
    case 'text':
    case 'path':
      if (!str(v) || (!v.trim() && !f.optional)) return 'must not be empty';
      return re && v.trim() && !re.test(v) ? `must match ${f.pattern}` : '';
    case 'lines':
      if (f.optional && Array.isArray(v) && !v.length) return '';
      if (!Array.isArray(v) || !v.length || v.length > 50 || !v.every((x) => str(x) && x.trim())) return 'needs 1–50 non-empty lines';
      return re && !v.every((x) => re.test(x)) ? `each line must match ${f.pattern}` : '';
    case 'presets':
      return Array.isArray(v) && v.length <= 8 && v.every((p) => p && str(p.label) && p.label.trim() && str(p.jql) && p.jql.trim()) ? '' : 'up to 8 filters, each with a label and a JQL';
    case 'repos': {
      const ok =
        Array.isArray(v) &&
        v.length >= 1 &&
        v.length <= 8 &&
        v.every((r) => r && /^[a-z][a-z0-9-]{0,30}$/.test(r.id) && str(r.label) && r.label.trim() && str(r.dir) && /^[^/\\]+$/.test(r.dir) && r.dir !== '..') &&
        new Set(v.map((r) => r.id)).size === v.length;
      return ok ? '' : '1–8 repos, each with a unique lowercase id, a label and a folder name';
    }
    default:
      return 'unknown field';
  }
}

// Saves the given values (key → value); a value equal to its default is dropped from config.json.
function save(values) {
  const errors = {};
  const base = defaults();
  const next = JSON.parse(JSON.stringify(overrides));
  for (const [key, v] of Object.entries(values || {})) {
    const f = FIELDS.find((x) => x.key === key);
    if (!f) continue;
    const err = validate(f, v);
    if (err) errors[key] = `${f.label} ${err}`;
    else if (JSON.stringify(v) === JSON.stringify(getAt(base, key))) deleteAt(next, key);
    else setAt(next, key, v);
  }
  if (Object.keys(errors).length) throw Object.assign(httpError(400, Object.values(errors).join(' · ')), { fields: errors });
  write(next);
  return view();
}

function write(next) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
  load();
  for (const fn of listeners) fn(current);
}

// The office's people: gender (the character's look) and role (which room they work in).
const PERSON = {
  gender: ['male', 'female'],
  role: ['dev', 'qa', 'ba', 'po', 'pm'],
};
const ACCOUNT_RE = /^[A-Za-z0-9:_-]{1,128}$/;
// Keeps the known values only; a person with nothing set is dropped.
function cleanPerson(p) {
  const out = {};
  for (const [k, allowed] of Object.entries(PERSON)) if (allowed.includes(p?.[k])) out[k] = p[k];
  return Object.keys(out).length ? out : null;
}
function cleanPeople(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [id, p] of Object.entries(v).slice(0, 500)) {
    const c = ACCOUNT_RE.test(id) && cleanPerson(p);
    if (c) out[id] = c;
  }
  return out;
}
// Sets one person's profile (unknown or empty values clear that field) and returns everyone's.
function savePerson(id, profile) {
  if (!ACCOUNT_RE.test(id || '')) throw httpError(400, 'Invalid accountId');
  for (const [k, allowed] of Object.entries(PERSON)) {
    const val = profile?.[k];
    if (val != null && val !== '' && !allowed.includes(val)) throw httpError(400, `Unknown ${k}: ${val}`);
  }
  get(); // overrides are read on first use
  const next = JSON.parse(JSON.stringify(overrides));
  const people = cleanPeople(next.office?.people);
  const p = cleanPerson(profile);
  if (p) people[id] = p; else delete people[id];
  if (Object.keys(people).length) setAt(next, 'office.people', people); else deleteAt(next, 'office.people');
  write(next);
  return current.office.people;
}
const cleanOrder = (v) => (Array.isArray(v) ? [...new Set(v.filter((id) => typeof id === 'string' && ACCOUNT_RE.test(id)))].slice(0, 500) : []);
// The Team panel's order, top first.
function saveOrder(ids) {
  if (!Array.isArray(ids)) throw httpError(400, 'order must be a list of accountIds');
  get(); // overrides are read on first use
  const next = JSON.parse(JSON.stringify(overrides));
  const order = cleanOrder(ids);
  if (order.length) setAt(next, 'office.order', order); else deleteAt(next, 'office.order');
  write(next);
  return current.office.order;
}

function deleteAt(obj, key) {
  const parts = key.split('.');
  const last = parts.pop();
  const parent = parts.reduce((o, k) => o?.[k], obj);
  if (parent) delete parent[last];
  if (parent && !Object.keys(parent).length && parts.length) deleteAt(obj, parts.join('.'));
}

// Everything the Settings page needs.
function view() {
  const cfg = get();
  const base = defaults();
  return {
    file: FILE,
    schema: SCHEMA,
    values: Object.fromEntries(FIELDS.map((f) => [f.key, getAt(cfg, f.key)])),
    defaults: Object.fromEntries(FIELDS.map((f) => [f.key, getAt(base, f.key)])),
    pendingRestart: FIELDS.filter((f) => f.restart && JSON.stringify(getAt(cfg, f.key)) !== JSON.stringify(startup[f.key])).map((f) => f.key),
  };
}

// The subset the browser uses at runtime (no local paths).
function client() {
  const { jira, git, mcp } = get();
  return {
    agent: { mcp: mcp.enabled, writes: mcp.allowWrites },
    jira: { defaultJql: jira.defaultJql, presets: jira.presets, autoRefreshMinutes: jira.autoRefreshMinutes },
    git: {
      repos: git.repos.map(({ id, label }) => ({ id, label })),
      projectKey: git.projectKey,
      uat: git.uatBranch,
      develop: git.developBranch,
      main: git.mainBranch,
      branchTypes: git.branchTypes,
      backupPruneDays: git.backupPruneDays,
      mrChecklist: git.mrChecklist,
    },
  };
}

const listeners = [];
const onChange = (fn) => listeners.push(fn);

module.exports = { get, load, save, savePerson, saveOrder, view, client, onChange, startupValue: (key) => (get(), startup[key]) };
