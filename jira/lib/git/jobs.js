'use strict';

// Git jobs: one runs at a time; each keeps a log of the commands it ran and their output.

const path = require('node:path');
const crypto = require('node:crypto');
const { git, operation } = require('./exec');
const { tilde } = require('../util');

const jobs = new Map();
let queue = Promise.resolve();

// home: the repo's own checkout — commands run elsewhere (a worktree) say where in the log.
function startJob(title, repo, home, fn) {
  const job = { id: crypto.randomUUID(), title, repo, status: 'running', log: [], result: null, error: null, startedAt: Date.now(), endedAt: null };
  jobs.set(job.id, job);
  for (const id of [...jobs.keys()].slice(0, Math.max(0, jobs.size - 40))) jobs.delete(id);
  const ctx = {
    log: (text) => void job.log.push(text),
    // Runs git and records the command + its output in the job log; throws on failure unless allowFail.
    async run(cwd, args, opts = {}) {
      const full = opts.noHooks ? ['-c', 'core.hooksPath=/dev/null', ...args] : args;
      const where = path.resolve(cwd) === path.resolve(home) ? '' : `   (${tilde(cwd)})`;
      job.log.push(`$ git ${args.join(' ')}${where}`);
      const r = await git(cwd, full, opts);
      const text = (r.stdout + (r.stdout && r.stderr ? '\n' : '') + r.stderr).trim();
      if (text) job.log.push(text.length > 8000 ? '…' + text.slice(-8000) : text);
      if (r.timedOut) job.log.push('(timeout)');
      if (r.code && !opts.allowFail) throw new Error(opts.failMsg || `git ${args[0]} failed (exit ${r.code})`);
      return r;
    },
  };
  queue = queue
    .then(() => fn(ctx).finally(() => releaseScratch(ctx)))
    .then(
      (result) => {
        job.result = result || null;
        job.status = result?.conflict ? 'conflict' : 'ok';
      },
      (e) => {
        job.status = 'error';
        job.error = e.message;
      },
    )
    .finally(() => (job.endedAt = Date.now()));
  return job;
}

// Detach the scratch worktree after a job so it doesn't hold the branch (git allows a branch in one worktree only).
// Left alone while a conflict is pending there.
async function releaseScratch(ctx) {
  const dir = ctx.scratchDir;
  if (!dir || (await operation(dir).catch(() => 'unknown'))) return;
  await git(dir, ['-c', 'core.hooksPath=/dev/null', 'switch', '--detach', '-q']);
}

const getJob = (id) => jobs.get(id);
const listJobs = () => [...jobs.values()].reverse().map(({ log, ...j }) => j);

module.exports = { startJob, getJob, listJobs };
