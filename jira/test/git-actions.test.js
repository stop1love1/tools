'use strict';

// lib/git/actions.js end to end: real repos in the temp dir (a bare "origin" + the dashboard's checkout), jobs run
// through startAction exactly as POST /api/git/action does. No mocks: this is the code that rebases, cherry-picks and pushes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mkTemp, rmTemp, purge } = require('./_helpers');

let tmp;
let origin;
let repo; // the dashboard's checkout of "backend"
let other; // a second clone, to move origin ahead
let api;
let gitJobs;
const savedEnv = {};

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const commitAll = (dir, msg) => (sh(dir, 'add', '-A'), sh(dir, 'commit', '-q', '-m', msg));

// Runs an action as a job and waits for it to settle.
async function run(body) {
  const job = api.startAction({ repo: 'backend', ...body });
  const deadline = Date.now() + 30_000;
  while (job.status === 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(job.status, 'running', `job "${job.title}" did not finish`);
  return job;
}

test.before(() => {
  tmp = mkTemp();
  // Isolate git from the developer's own config (identity, signing, hooks) and give it a fixed identity.
  for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) savedEnv[k] = process.env[k];
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = uat\n');
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  const root = path.join(tmp, 'root');
  origin = path.join(tmp, 'origin.git');
  repo = path.join(root, 'backend');
  other = path.join(tmp, 'other');
  fs.mkdirSync(root);
  sh(tmp, 'init', '-q', '--bare', origin);
  sh(tmp, 'clone', '-q', origin, repo);
  write(repo, 'x.txt', 'base\n');
  commitAll(repo, 'init');
  sh(repo, 'push', '-q', 'origin', 'uat');
  sh(tmp, 'clone', '-q', origin, other);

  fs.writeFileSync(
    path.join(tmp, 'config.json'),
    JSON.stringify({ git: { root, scratchRoot: path.join(tmp, 'scratch'), repos: [{ id: 'backend', label: 'Backend', dir: 'backend' }] } }),
  );
  purge();
  api = require('../lib/git');
  gitJobs = require('../lib/git/jobs');
});

test.after(async () => {
  await gitJobs?.whenIdle();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTemp(tmp);
});

test('startAction rejects unknown actions and repos before queueing a job', () => {
  assert.throws(() => api.startAction({ action: 'rm-rf', repo: 'backend' }), { status: 400 });
  assert.throws(() => api.startAction({ action: 'toString', repo: 'backend' }), { status: 400 });
  assert.throws(() => api.startAction({ action: 'fetch', repo: 'nope' }), { status: 400 });
});

test('push refuses protected branches and bad branch names', async () => {
  for (const branch of ['uat', 'develop', 'main', 'release/1.0']) {
    const job = await run({ action: 'push', branch });
    assert.equal(job.status, 'error', branch);
    assert.match(job.error, /Never push straight to/, branch);
  }
  const bad = await run({ action: 'push', branch: 'a/../b' });
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /Invalid branch name/);
});

test('task branch names must carry the -uat suffix and the team naming', async () => {
  for (const branch of ['feature/VLEARN-123-add-export', 'feature/add-export-uat', 'feature/VLEARN-123-Add-Export-uat']) {
    const job = await run({ action: 'create-task', epic: 'VLEARN-100', branch });
    assert.equal(job.status, 'error', branch);
    assert.match(job.error, /Branch names must look like/, branch);
  }
});

const originHas = (ref) => {
  try {
    return !!sh(origin, 'rev-parse', '--verify', '-q', ref);
  } catch {
    return false;
  }
};

test('ensure-epic creates epic/<key> on origin from uat, and reuses it the second time', async () => {
  const first = await run({ action: 'ensure-epic', epic: 'VLEARN-100' });
  assert.equal(first.status, 'ok', first.error);
  assert.ok(originHas('refs/heads/epic/VLEARN-100'));
  assert.equal(sh(origin, 'rev-parse', 'refs/heads/epic/VLEARN-100'), sh(origin, 'rev-parse', 'refs/heads/uat'));
  const again = await run({ action: 'ensure-epic', epic: 'VLEARN-100' });
  assert.equal(again.status, 'ok', again.error);
  assert.ok(again.log.some((l) => /already exists on origin/.test(l)));
});

test('ensure-epic rejects an invalid epic key', async () => {
  const job = await run({ action: 'ensure-epic', epic: 'not a key' });
  assert.equal(job.status, 'error');
  assert.match(job.error, /Invalid epic key/);
});

test('start-task branches off the epic and checks it out; starting again just reports it', async () => {
  const branch = 'feature/VLEARN-123-add-export-uat';
  const job = await run({ action: 'start-task', repos: ['backend'], epic: 'VLEARN-100', branch });
  assert.equal(job.status, 'ok', job.error);
  assert.deepEqual(job.result, { branch, repos: ['backend'], epic: 'VLEARN-100' });
  assert.equal(sh(repo, 'branch', '--show-current'), branch);
  const again = await run({ action: 'start-task', repos: ['backend'], epic: 'VLEARN-100', branch });
  assert.equal(again.status, 'ok', again.error);
  assert.ok(again.log.some((l) => /Already on/.test(l)));
});

const BRANCH = 'feature/VLEARN-123-add-export-uat';

test('commit validates the message format and the ticket of the current branch', async () => {
  write(repo, 'y.txt', 'y\n');
  const bad = await run({ action: 'commit', message: 'add y', files: ['y.txt'] });
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /must look like "VLEARN-123/);
  const wrongTicket = await run({ action: 'commit', message: 'VLEARN-999: add y', files: ['y.txt'] });
  assert.equal(wrongTicket.status, 'error');
  assert.match(wrongTicket.error, /needs messages starting with "VLEARN-123: "/);
  const noFiles = await run({ action: 'commit', message: 'VLEARN-123: add y', files: ['not-changed.txt'] });
  assert.equal(noFiles.status, 'error');
  assert.match(noFiles.error, /No file selected/);
});

test('commit commits only the selected files', async () => {
  write(repo, 'z.txt', 'z\n');
  const job = await run({ action: 'commit', message: 'VLEARN-123: add y', files: ['y.txt'] });
  assert.equal(job.status, 'ok', job.error);
  assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'VLEARN-123: add y');
  assert.equal(sh(repo, 'show', '--name-only', '--format=', 'HEAD'), 'y.txt');
  assert.match(sh(repo, 'status', '--porcelain'), /\?\? z\.txt/);
  fs.rmSync(path.join(repo, 'z.txt'));
});

test('push sends the branch to origin without force', async () => {
  const job = await run({ action: 'push', branch: BRANCH });
  assert.equal(job.status, 'ok', job.error);
  assert.equal(sh(origin, 'rev-parse', `refs/heads/${BRANCH}`), sh(repo, 'rev-parse', 'HEAD'));
});

test('sync-task rebases the task onto the moved epic and force-pushes with a backup', async () => {
  sh(other, 'fetch', '-q', 'origin');
  sh(other, 'checkout', '-q', '-B', 'epic/VLEARN-100', 'origin/epic/VLEARN-100');
  write(other, 'epic-only.txt', 'from the epic\n');
  commitAll(other, 'VLEARN-1: epic moves on');
  sh(other, 'push', '-q', 'origin', 'epic/VLEARN-100');
  const before = sh(repo, 'rev-parse', 'HEAD');

  const job = await run({ action: 'sync-task', epic: 'VLEARN-100', branch: BRANCH });
  assert.equal(job.status, 'ok', job.error);
  const after = sh(repo, 'rev-parse', 'HEAD');
  assert.notEqual(after, before, 'the branch was rewritten');
  assert.equal(sh(repo, 'merge-base', '--is-ancestor', 'origin/epic/VLEARN-100', 'HEAD') || 'ok', 'ok');
  assert.equal(sh(origin, 'rev-parse', `refs/heads/${BRANCH}`), after, 'origin got the rebased branch');
  const backups = sh(repo, 'for-each-ref', '--format=%(objectname)', `refs/dash-backup/${BRANCH}/`).split('\n').filter(Boolean);
  assert.deepEqual(backups, [before], 'the old tip is kept as a backup ref');
});

test('pick-epic cherry-picks the task commits onto the epic and pushes fast-forward', async () => {
  const sha = sh(repo, 'rev-parse', 'HEAD');
  const job = await run({ action: 'pick-epic', epic: 'VLEARN-100', branch: BRANCH, shas: [sha] });
  assert.equal(job.status, 'ok', job.error);
  assert.equal(job.result.notInEpic, 0, 'git cherry finds every task commit on the epic');
  assert.equal(sh(origin, 'log', '-1', '--format=%s', 'refs/heads/epic/VLEARN-100'), 'VLEARN-123: add y');
});

test('pick-epic refuses a commit that belongs to another ticket', async () => {
  const foreign = sh(origin, 'rev-parse', 'refs/heads/epic/VLEARN-100~1'); // "VLEARN-1: epic moves on"
  const job = await run({ action: 'pick-epic', epic: 'VLEARN-100', branch: BRANCH, shas: [foreign] });
  assert.equal(job.status, 'error');
  assert.match(job.error, /belong to other tickets/);
  const bad = await run({ action: 'pick-epic', epic: 'VLEARN-100', branch: BRANCH, shas: ['not-a-sha'] });
  assert.match(bad.error, /Invalid commit list/);
});

test('undo restores the latest backup and keeps the replaced tip as an -undo ref', async () => {
  const ns = `refs/dash-backup/${BRANCH}/`;
  const [saved] = sh(repo, 'for-each-ref', '--format=%(objectname)', ns).split('\n').filter(Boolean);
  const replaced = sh(repo, 'rev-parse', 'HEAD');
  assert.ok(saved && saved !== replaced, 'sync-task left a backup of the old tip');
  const job = await run({ action: 'undo', branch: BRANCH });
  assert.equal(job.status, 'ok', job.error);
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), saved);
  const refs = sh(repo, 'for-each-ref', '--format=%(refname) %(objectname)', ns).split('\n').filter(Boolean);
  assert.equal(refs.length, 1, 'the used backup is consumed');
  assert.match(refs[0], new RegExp(`-undo ${replaced}$`));
  const none = await run({ action: 'undo', branch: 'feature/VLEARN-777-nothing-uat' });
  assert.equal(none.status, 'error');
  assert.match(none.error, /No backup/);
});

// A task and its epic both change x.txt, so rebasing the task onto the epic conflicts.
const CONFLICT = 'feature/VLEARN-201-conflict-uat';

async function setUpConflict() {
  const start = await run({ action: 'start-task', repos: ['backend'], epic: 'VLEARN-200', branch: CONFLICT });
  assert.equal(start.status, 'ok', start.error);
  write(repo, 'x.txt', 'task\n');
  assert.equal((await run({ action: 'commit', message: 'VLEARN-201: task change', files: ['x.txt'] })).status, 'ok');
  assert.equal((await run({ action: 'push', branch: CONFLICT })).status, 'ok');
  sh(other, 'fetch', '-q', 'origin');
  sh(other, 'checkout', '-q', '-B', 'epic/VLEARN-200', 'origin/epic/VLEARN-200');
  write(other, 'x.txt', 'epic\n');
  commitAll(other, 'VLEARN-2: epic edits x');
  sh(other, 'push', '-q', 'origin', 'epic/VLEARN-200');
}

test('sync-task stops on a conflict and abort puts the branch back', async () => {
  await setUpConflict();
  const before = sh(repo, 'rev-parse', 'HEAD');
  const job = await run({ action: 'sync-task', epic: 'VLEARN-200', branch: CONFLICT });
  assert.equal(job.status, 'conflict');
  assert.deepEqual({ conflict: job.result.conflict, op: job.result.op, files: job.result.files }, { conflict: true, op: 'rebase', files: ['x.txt'] });
  const abort = await run({ action: 'abort' });
  assert.equal(abort.status, 'ok', abort.error);
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), before);
  assert.equal(sh(repo, 'status', '--porcelain'), '');
});

test('continue refuses leftover conflict markers, then finishes the rebase and pushes once they are fixed', async () => {
  const job = await run({ action: 'sync-task', epic: 'VLEARN-200', branch: CONFLICT });
  assert.equal(job.status, 'conflict');
  const stuck = await run({ action: 'continue' });
  assert.equal(stuck.status, 'error');
  assert.match(stuck.error, /Conflict markers are still in: x\.txt/);
  write(repo, 'x.txt', 'merged\n');
  const done = await run({ action: 'continue' });
  assert.equal(done.status, 'ok', done.error);
  assert.ok(done.log.some((l) => /pushing/.test(l)), 'the push owed by sync-task ran');
  assert.equal(sh(origin, 'rev-parse', `refs/heads/${CONFLICT}`), sh(repo, 'rev-parse', 'HEAD'));
  assert.equal(sh(repo, 'show', 'HEAD:x.txt'), 'merged');
  const idle = await run({ action: 'continue' });
  assert.match(idle.error, /No rebase or cherry-pick in progress/);
});

const localBranches = () => sh(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);

test('delete-branches removes only branches already in origin/uat, never protected or unmerged ones, and backs them up', async () => {
  const merged = 'feature/VLEARN-300-merged-uat';
  const unmerged = 'feature/VLEARN-301-unmerged-uat';
  sh(repo, 'branch', merged, 'origin/uat');
  sh(repo, 'branch', unmerged, CONFLICT); // has a commit that is not in uat
  const tip = sh(repo, 'rev-parse', merged);

  const job = await run({ action: 'delete-branches', branches: [merged, unmerged, 'uat'] });
  assert.equal(job.status, 'ok', job.error);
  assert.ok(!localBranches().includes(merged), 'merged branch deleted');
  assert.ok(localBranches().includes(unmerged), 'unmerged branch kept');
  assert.ok(localBranches().includes('uat'), 'protected branch kept');
  assert.ok(job.log.some((l) => l.includes(`Skipping ${unmerged} (not merged into uat)`)));
  assert.ok(job.log.some((l) => l.includes('Skipping uat (main branch)')));
  assert.equal(sh(repo, 'for-each-ref', '--format=%(objectname)', `refs/dash-backup/${merged}/`), tip, 'tip saved before deleting');

  const empty = await run({ action: 'delete-branches', branches: [] });
  assert.equal(empty.status, 'error');
  assert.match(empty.error, /No branch selected/);
});

test('delete-branches skips a branch that is checked out', async () => {
  const job = await run({ action: 'delete-branches', branches: [CONFLICT] });
  assert.equal(job.status, 'ok', job.error);
  assert.ok(localBranches().includes(CONFLICT));
});

test('prune-backups deletes only backup refs older than the limit', async () => {
  const sha = sh(repo, 'rev-parse', 'HEAD');
  const old = 'refs/dash-backup/prune-me/20200101T000000';
  const fresh = `refs/dash-backup/prune-me/${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}`;
  sh(repo, 'update-ref', old, sha);
  sh(repo, 'update-ref', fresh, sha);
  const job = await run({ action: 'prune-backups', days: 14 });
  assert.equal(job.status, 'ok', job.error);
  const left = sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/dash-backup/prune-me/').split('\n').filter(Boolean);
  assert.deepEqual(left, [fresh]);
});
