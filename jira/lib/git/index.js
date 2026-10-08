'use strict';

// Routes under /api/git/ for the git flow of the configured repos (Settings → Git flow).

const { settings } = require('./settings');
const { flow, epicView, overview, branches } = require('./read');
const { mrs, clearMrs } = require('./mrs');
const { startJob, getJob, listJobs } = require('./jobs');
const { ACTIONS, TITLES, KEY_RE, knownDir } = require('./actions');
const { openFolder } = require('../editor');
const { sprintsOf } = require('../issues');
const config = require('../config');
const { httpError, readJson } = require('../util');

// Repo paths may have changed: MRs cached per repo id would belong to another repo.
config.onChange(clearMrs);

async function handle(req, url) {
  const p = url.pathname.slice('/api/git'.length);
  const s = settings();
  const repoParam = (r) => {
    if (!Object.hasOwn(s.repos, r)) throw httpError(400, `repo must be one of: ${Object.keys(s.repos).join(', ')}`);
    return r;
  };

  if (req.method === 'GET' && p === '/overview') return overview();
  if (req.method === 'GET' && p === '/branches') return branches(repoParam(url.searchParams.get('repo')));
  if (req.method === 'GET' && p === '/flow') {
    const k = url.searchParams.get('key') || '';
    const epic = url.searchParams.get('epic') || '';
    if (!KEY_RE.test(k) || (epic && !KEY_RE.test(epic))) throw httpError(400, 'Invalid issue key');
    // pin=<repo>:<branch>: the task branch the user chose when the ticket has several.
    const pins = {};
    for (const v of url.searchParams.getAll('pin')) {
      const i = v.indexOf(':');
      if (i > 0) pins[repoParam(v.slice(0, i))] = v.slice(i + 1);
    }
    return flow(k, epic || null, pins);
  }
  if (req.method === 'GET' && p === '/epic') {
    const k = url.searchParams.get('key') || '';
    if (!KEY_RE.test(k)) throw httpError(400, 'Invalid epic key');
    return epicView(k);
  }
  if (req.method === 'GET' && p === '/mrs') return mrs(repoParam(url.searchParams.get('repo')), url.searchParams.has('fresh'));
  if (req.method === 'GET' && p === '/branch-sprints') {
    const keys = url.searchParams.getAll('key');
    if (keys.length > 300 || !keys.every((k) => KEY_RE.test(k))) throw httpError(400, 'Invalid issue keys');
    return { sprints: Object.fromEntries(await sprintsOf(keys)) };
  }
  if (req.method === 'GET' && p === '/jobs') return { jobs: listJobs() };
  const jm = p.match(/^\/jobs\/([0-9a-f-]{36})$/);
  if (req.method === 'GET' && jm) {
    const job = getJob(jm[1]);
    if (!job) throw httpError(404, 'Job not found');
    return { ...job };
  }
  if (req.method === 'POST' && p === '/open') {
    const body = (await readJson(req)) || {};
    openFolder((await knownDir(s, repoParam(body.repo), body.dir)).path);
    return { ok: true };
  }
  if (req.method === 'POST' && p === '/action') return { id: startAction((await readJson(req)) || {}).id };
  throw httpError(404, 'Not found');
}

// Queues one git flow step as a job (see actions.js); returns the job.
function startAction(body) {
  const s = settings();
  const run = ACTIONS[body.action];
  if (!run || !Object.hasOwn(ACTIONS, body.action)) throw httpError(400, `Invalid action. One of: ${Object.keys(ACTIONS).join(', ')}`);
  const start = body.action === 'start-task';
  const repo = start && !body.repo ? Object.keys(s.repos)[0] : body.repo;
  if (!Object.hasOwn(s.repos, repo)) throw httpError(400, `repo must be one of: ${Object.keys(s.repos).join(', ')}`);
  const where = start && Array.isArray(body.repos) ? body.repos.join(' + ') : repo;
  return startJob(`${TITLES[body.action]} · ${where}`, repo, s.repos[repo], (ctx) => ((ctx.s = s), run(ctx, { ...body, repo })));
}

module.exports = { handle, startAction, actionNames: Object.keys(ACTIONS) };
