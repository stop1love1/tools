'use strict';

// Auto Claude, run by the server: while it is on, every minute it reads my not-started Jira tasks and, when no task is
// in hand, opens the first ticked one in a Claude Code tab in Cursor (prompt prefilled — the user presses Enter there).
// The next task is taken once the current one has moved on in Jira (dev done by default), or when the user skips it.
//
// On the server so it keeps going without a dashboard page: the desktop app in background mode, or `npm start`.
// A task assigned to me later joins the queue on the next tick, ticked. Only the active sprint's tasks are taken.
// State and settings are kept on disk (STATE_FILE); the Tasks page shows and changes them through /api/auto-claude.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const issues = require('./issues');
const { shortPrompt } = require('./prompt');
const { openClaudeCode } = require('./editor');
const { settings: gitSettings } = require('./git/settings');
const { stageOf } = require('../public/js/workflow.js');
const { safeJson, httpError, ISSUE_KEY_RE } = require('./util');

const TICK_MS = 60_000;
const LIST_TTL_MS = 30_000;
const STATE_FILE =
  process.env.DASHBOARD_AUTO_CLAUDE_STATE_FILE || path.join(__dirname.includes('/snapshot/') ? process.cwd() : path.join(__dirname, '..'), '.auto-claude-state.json');

const DEFAULT_CFG = {
  types: ['Story', 'Task', 'Subtask', 'Sub-task', 'Bug'],
  mode: 'implement', // 'implement' (code + MRs) · 'plan'
  mrKinds: ['epic-uat'],
  draft: true,
  moveStatus: true,
  writes: true, // used only when write tools are allowed in Settings → MCP (prompt.validate)
  advance: 'qa', // take the next task once the current one is 'dev' (started) or 'qa' (dev done)
  notes: '',
};
const DEFAULT_STATE = { on: false, cfg: DEFAULT_CFG, current: null, startedAt: null, done: [], skipped: [], excluded: [], seen: [], log: [] };
const STAGE = { todo: 0, dev: 1, qa: 2, done: 3 };
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z]/g, '');
const cap = (list, n = 300) => [...new Set(list)].slice(-n);

let deps = { listIssues: issues.listIssues, open: openClaudeCode, now: () => Date.now() };
let st = null;
let timer = null;
let busy = null; // the tick in progress
let listCache = { at: 0, cfgKey: '', promise: null };

function load() {
  if (st) return st;
  const raw = (fs.existsSync(STATE_FILE) && safeJson(fs.readFileSync(STATE_FILE, 'utf8'))) || {};
  // Only the current settings (older ones on disk, e.g. scope / newTasks, are dropped).
  const cfg = Object.fromEntries(Object.keys(DEFAULT_CFG).map((k) => [k, raw.cfg && Object.hasOwn(raw.cfg, k) ? raw.cfg[k] : DEFAULT_CFG[k]]));
  st = { ...DEFAULT_STATE, ...raw, cfg };
  return st;
}

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(st));
  } catch (e) {
    console.error(`[auto-claude] could not save ${STATE_FILE}: ${e.message}`);
  }
}

function log(text) {
  st.log = [...st.log, { at: new Date(deps.now()).toISOString(), text }].slice(-30);
  console.log(`[auto-claude] ${text}`);
}

// My not-started tasks of the active sprint, of the chosen types, most important first (Jira's order: priority,
// rank). The sprint is the one the dashboard counts the task for (the last it was moved to), as on the Tasks page.
function candidates(cfg = load().cfg, { fresh = false } = {}) {
  const cfgKey = JSON.stringify(cfg.types);
  if (!fresh && listCache.promise && listCache.cfgKey === cfgKey && deps.now() - listCache.at < LIST_TTL_MS) return listCache.promise;
  const jql = 'assignee = currentUser() AND statusCategory = "To Do" AND issuetype != Epic AND sprint in openSprints() ORDER BY priority DESC, Rank ASC';
  const types = new Set(cfg.types.map(norm));
  const promise = deps.listIssues(jql).then((list) =>
    list
      .filter((i) => stageOf(i.status) === 'todo' && !/epic/i.test(i.type?.name || ''))
      .filter((i) => types.has(norm(i.type?.name)))
      .filter((i) => i.sprint?.state === 'active'),
  );
  listCache = { at: deps.now(), cfgKey, promise };
  promise.catch(() => (listCache.promise = null));
  return promise;
}

// Where the task in hand stands: still mine and not far enough along → keep waiting.
async function finished(key, cfg) {
  const [i] = await deps.listIssues(`key = ${key} AND assignee = currentUser()`).catch(() => [null]);
  if (i === null) return false; // Jira unreachable: don't move on
  if (!i) return true; // no longer mine
  return STAGE[stageOf(i.status)] >= STAGE[cfg.advance];
}

// The repos a ticket is about, from its summary's leading tags ([FE], BE:, FE/BE…). Same rule as guessRepos in
// public/js/git/start.js: no tag → the frontend repo.
function guessRepos(summary) {
  const repos = Object.keys(gitSettings().repos);
  const TAGS = { fe: 'front', frontend: 'front', be: 'back', backend: 'back' };
  const picked = [];
  let rest = summary || '';
  for (let n = 0; n < 3; n++) {
    const m = rest.match(/^\s*(?:\[([^\]]*)\]|([A-Za-z]+(?:\s*[/+&]\s*[A-Za-z]+)*)(\s*[:,\-–|]|\s|$))/);
    if (!m) break;
    const bracketed = m[1] !== undefined;
    const names = (bracketed ? m[1] : m[2]).split(/[^A-Za-z]+/).filter(Boolean);
    const bareWord = !bracketed && !/[:,\-–|]/.test(m[3]);
    if (!names.length || !names.every((x) => TAGS[x.toLowerCase()]) || (bareWord && names.some((x) => x !== x.toUpperCase()))) break;
    for (const x of names) {
      const repo = repos.find((r) => r.startsWith(TAGS[x.toLowerCase()]));
      if (repo && !picked.includes(repo)) picked.push(repo);
    }
    rest = rest.slice(m[0].length);
  }
  return picked.length ? picked : [repos.find((r) => r.startsWith('front')) || repos[0]].filter(Boolean);
}

async function open(issue, cfg = load().cfg) {
  const prompt = shortPrompt({
    key: issue.key,
    repos: guessRepos(issue.summary),
    mode: cfg.mode,
    mrKinds: cfg.mode === 'plan' ? [] : cfg.mrKinds,
    draft: cfg.draft,
    moveStatus: cfg.moveStatus,
    writes: cfg.writes,
    notes: cfg.notes,
  });
  await deps.open(prompt);
}

// New tasks since the last look (they join the queue ticked): remembered as seen, and logged.
function noteNew(list) {
  const seen = new Set(st.seen);
  const fresh = list.filter((i) => !seen.has(i.key));
  if (!fresh.length) return;
  // The first look only learns what is there; a task is "new" when it shows up after that.
  if (st.seen.length) log(`New task${fresh.length > 1 ? 's' : ''}: ${fresh.map((i) => i.key).join(', ')}`);
  st.seen = cap([...st.seen, ...fresh.map((i) => i.key)], 1000);
}

const queueOf = (list) => {
  const skip = new Set([...st.done, ...st.skipped, ...st.excluded, st.current].filter(Boolean));
  return list.filter((i) => !skip.has(i.key));
};

async function tick({ fresh = false } = {}) {
  if (busy) return busy;
  busy = (async () => {
    load();
    if (!st.on) return;
    try {
      const list = await candidates(st.cfg, { fresh: true });
      noteNew(list);
      if (st.current && !(await finished(st.current, st.cfg))) return save();
      if (st.current) {
        log(`${st.current} moved on — taking the next task`);
        st.done = cap([...st.done, st.current]);
        st.current = null;
      }
      const next = queueOf(list)[0];
      if (!next) return save();
      st.current = next.key;
      st.startedAt = new Date(deps.now()).toISOString();
      save();
      try {
        await open(next);
        log(`Opened ${next.key} in Claude Code`);
      } catch (e) {
        log(`Could not open ${next.key}: ${e.message}`);
      }
      save();
    } catch (e) {
      if (fresh) throw e;
      console.error(`[auto-claude] ${e.message}`);
    }
  })().finally(() => (busy = null));
  return busy;
}

// What the Tasks page shows: the state, and the candidates (each with whether it is ticked).
async function view() {
  load();
  let list = [];
  let error = null;
  try {
    list = await candidates(st.cfg);
  } catch (e) {
    error = e.message;
  }
  const queue = new Set(queueOf(list).map((i) => i.key));
  const done = new Set([...st.done, ...st.skipped]);
  return {
    on: st.on,
    cfg: st.cfg,
    current: st.current,
    startedAt: st.startedAt,
    done: st.done.length,
    skipped: st.skipped.length,
    log: st.log.slice(-8).reverse(),
    error,
    candidates: list
      .filter((i) => i.key !== st.current && !done.has(i.key))
      .map((i) => ({
        key: i.key,
        summary: i.summary,
        type: i.type?.name || '',
        status: i.status,
        sprints: (i.sprints || []).map((s) => ({ name: s.name, state: s.state })),
        parent: i.parent,
        ticked: queue.has(i.key),
      })),
  };
}

const CFG_KEYS = Object.keys(DEFAULT_CFG);
function cleanCfg(input) {
  const c = { ...load().cfg };
  for (const k of CFG_KEYS) if (input && Object.hasOwn(input, k)) c[k] = input[k];
  c.mode = c.mode === 'plan' ? 'plan' : 'implement';
  c.advance = c.advance === 'dev' ? 'dev' : 'qa';
  c.types = Array.isArray(c.types) ? c.types.map(String).slice(0, 20) : DEFAULT_CFG.types;
  c.mrKinds = Array.isArray(c.mrKinds) ? c.mrKinds.map(String).slice(0, 5) : DEFAULT_CFG.mrKinds;
  for (const k of ['draft', 'moveStatus', 'writes']) c[k] = !!c[k];
  c.notes = String(c.notes || '').slice(0, 4000);
  return c;
}

const keyOf = (k) => {
  const key = String(k || '').toUpperCase();
  if (!ISSUE_KEY_RE.test(key)) throw httpError(400, 'Invalid issue key');
  return key;
};

// POST /api/auto-claude: { cfg?, on?, tick?: { key, on } | { all: [keys], on }, skip?, reopen?, forget? } → view().
async function update(body = {}) {
  load();
  if (body.cfg) {
    st.cfg = cleanCfg(body.cfg);
    listCache.promise = null;
  }
  if (body.tick) {
    const keys = Array.isArray(body.tick.all) ? body.tick.all.map(keyOf) : [keyOf(body.tick.key)];
    st.excluded = body.tick.on ? st.excluded.filter((k) => !keys.includes(k)) : cap([...st.excluded, ...keys]);
  }
  if (body.forget) {
    st.done = [];
    st.skipped = [];
  }
  if (body.skip && st.current) {
    log(`Skipped ${st.current}`);
    st.skipped = cap([...st.skipped, st.current]);
    st.current = null;
  }
  if (typeof body.on === 'boolean' && body.on !== st.on) {
    st.on = body.on;
    log(body.on ? 'Turned on' : 'Turned off');
  }
  save();
  if (body.reopen && st.current) {
    const [i] = await deps.listIssues(`key = ${st.current}`);
    if (!i) throw httpError(404, `${st.current} not found`);
    await open(i);
    log(`Opened ${st.current} again`);
    save();
  }
  if (st.on && (body.on || body.skip || body.cfg || body.tick)) await tick({ fresh: true }).catch((e) => log(`Jira: ${e.message}`));
  return view();
}

function start() {
  load();
  clearInterval(timer);
  timer = setInterval(() => tick(), TICK_MS);
  timer.unref?.();
  if (st.on) setTimeout(() => tick(), 5_000).unref?.();
}

module.exports = { start, tick, view, update, guessRepos, STATE_FILE, _setDeps: (d) => ((deps = { ...deps, ...d }), (st = null), (listCache = { at: 0, cfgKey: '', promise: null })) };
