'use strict';

// Git plumbing: running git and reading refs, worktrees and working-tree state.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { settings } = require('./settings');
const { httpError } = require('../util');

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
const BACKUP_NS = 'refs/dash-backup/';

function git(cwd, args, { input, timeout = 120_000, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      { cwd, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...GIT_ENV, ...env } },
      (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: !!err?.killed }),
    );
    if (input != null) child.stdin.end(input);
  });
}

async function out(cwd, args) {
  const r = await git(cwd, args);
  if (r.code) throw httpError(500, `git ${args[0]}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  return r.stdout.trim();
}

// Frontend hooks run yarn, whose .yarnrc.yml needs VSF_APP_TOKEN; dev.sh exports it, `npm start` does not.
const hookEnvCache = new Map(); // root → env
function hookEnv() {
  if (process.env.VSF_APP_TOKEN) return {};
  const root = settings().root;
  if (!hookEnvCache.has(root)) {
    try {
      const m = fs.readFileSync(path.join(root, 'dev.sh'), 'utf8').match(/^export VSF_APP_TOKEN="?([^"\n]*)"?/m);
      hookEnvCache.set(root, m ? { VSF_APP_TOKEN: m[1] } : {});
    } catch {
      hookEnvCache.set(root, {});
    }
  }
  return hookEnvCache.get(root);
}

const counts = async (cwd, a, b) => {
  const r = await git(cwd, ['rev-list', '--left-right', '--count', `${a}...${b}`]);
  if (r.code) return null;
  const [onlyA, onlyB] = r.stdout.trim().split(/\s+/).map(Number);
  return { onlyA, onlyB };
};

// Would merging `source` into `target` conflict? The merge GitLab does for an MR, simulated in memory (no worktree
// touched). → { files } when it conflicts, null when clean, undefined when it can't tell (bad ref, old git, timeout).
async function mergeConflicts(cwd, target, source) {
  const r = await git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, source], { timeout: 60_000 });
  // Exit 1 is also used for errors (a missing ref): only a result that starts with the merged tree id is a conflict.
  const [tree, ...files] = r.stdout.split('\n');
  if (r.timedOut || (r.code !== 0 && r.code !== 1) || !/^[0-9a-f]{40,64}$/.test(tree)) return undefined;
  if (r.code === 0) return null;
  // Then one conflicted path per line (a path can repeat, one line per stage).
  return { files: [...new Set(files.filter(Boolean))] };
}

async function refs(cwd) {
  const text = await out(cwd, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:track,nobracket)',
    'refs/heads',
    'refs/remotes/origin',
  ]);
  const local = new Map();
  const remote = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const [ref, sha, date, upstream, track] = line.split('\0');
    if (ref.startsWith('refs/heads/')) local.set(ref.slice(11), { sha, date: Number(date), upstream, gone: track === 'gone' });
    else if (ref !== 'refs/remotes/origin/HEAD') remote.set(ref.slice(20), { sha, date: Number(date) });
  }
  return { local, remote };
}

async function worktrees(cwd) {
  const text = await out(cwd, ['worktree', 'list', '--porcelain']);
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const w = {};
      for (const line of block.split('\n')) {
        const i = line.indexOf(' ');
        w[i < 0 ? line : line.slice(0, i)] = i < 0 ? true : line.slice(i + 1);
      }
      return {
        path: w.worktree,
        branch: typeof w.branch === 'string' ? w.branch.replace(/^refs\/heads\//, '') : null,
        prunable: !!w.prunable,
        scratch: path.basename(w.worktree || '').startsWith('dash-'),
      };
    });
}

async function operation(dir) {
  const has = async (p) => fs.existsSync(path.resolve(dir, await out(dir, ['rev-parse', '--git-path', p])));
  if ((await has('rebase-merge')) || (await has('rebase-apply'))) return 'rebase';
  // `sequencer` alone = a multi-commit cherry-pick stopped by an error rather than a conflict.
  if ((await has('CHERRY_PICK_HEAD')) || (await has('sequencer'))) return 'cherry-pick';
  if (await has('MERGE_HEAD')) return 'merge';
  return null;
}

// Branch, upstream divergence and changed files of one worktree (porcelain v2, NUL separated).
async function wtState(dir) {
  const r = await git(dir, ['status', '--porcelain=v2', '--branch', '-z']);
  if (r.code) throw httpError(500, `git status (${dir}): ${r.stderr.trim()}`);
  const st = { dir, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const f = e.split(' ');
    if (e.startsWith('# branch.head ')) st.branch = e.slice(14) === '(detached)' ? null : e.slice(14);
    else if (e.startsWith('# branch.upstream ')) st.upstream = e.slice(18);
    else if (e.startsWith('# branch.ab ')) [st.ahead, st.behind] = [Number(f[2]), -Number(f[3])];
    else if (e[0] === '1') st.files.push({ xy: f[1], path: f.slice(8).join(' ') });
    else if (e[0] === '2') st.files.push({ xy: f[1], path: f.slice(9).join(' '), from: parts[++i] });
    else if (e[0] === 'u') st.files.push({ xy: f[1], path: f.slice(10).join(' '), conflict: true });
    else if (e[0] === '?') st.files.push({ xy: '??', path: e.slice(2) });
  }
  st.op = await operation(dir);
  return st;
}

async function webUrl(cwd) {
  const u = (await git(cwd, ['remote', 'get-url', 'origin'])).stdout.trim();
  const m =
    u.match(/^git@([^:]+):(.+?)(?:\.git)?$/) ||
    u.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?$/) ||
    u.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `https://${m[1]}/${m[2]}` : null;
}

function fetchedAt(cwd) {
  try {
    return fs.statSync(path.join(cwd, '.git', 'FETCH_HEAD')).mtimeMs;
  } catch {
    return null;
  }
}

async function backupsOf(cwd, branch) {
  const text = (await git(cwd, ['for-each-ref', '--sort=-refname', '--format=%(refname)%00%(objectname:short)', `${BACKUP_NS}${branch}/`])).stdout;
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, sha] = l.split('\0');
      return { ref, sha, at: stampTime(ref) };
    });
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
}

// refs/dash-backup/<branch>/20260929T101500[-undo] → epoch ms
function stampTime(ref) {
  const m = ref.match(/\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:-undo)?$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

module.exports = { BACKUP_NS, git, out, hookEnv, counts, mergeConflicts, refs, worktrees, operation, wtState, webUrl, fetchedAt, backupsOf, stamp, stampTime };
