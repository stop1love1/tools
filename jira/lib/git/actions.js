'use strict';

// Git flow steps, run as jobs. Follows lms/.cursor/rules/git-workflow.mdc:
//   epic/<KEY>-<epic> (off uat) → <prefix>/<KEY>-<id>-<desc>-uat (off the epic) → task cherry-picked onto the epic (pick-epic)
//   → one MR epic → uat → <prefix>/<KEY>-<id>-<desc>-develop (off develop, cherry-picked) → MR → develop.
//
// Safety:
// - A step runs in the worktree that already has the branch checked out; otherwise in a scratch
//   worktree (<scratch root>/dash-<repo>), so the user's own checkout is never switched under them.
// - Before a branch is rewritten or deleted its tip is saved as refs/dash-backup/<branch>/<time>
//   (instead of hand-made backup/* branches); "Undo" resets to the latest one.
// - Conflicts are left in place to resolve in the editor, then Continue / Skip / Abort from the dashboard.
// Every action gets ctx.s: the git settings as they were when the job started.

const fs = require('node:fs');
const path = require('node:path');
const { BACKUP_NS, git, hookEnv, counts, refs, worktrees, operation, wtState, backupsOf, stamp, stampTime } = require('./exec');
const { ticketIds } = require('./read');
const { resolveEpic } = require('../issues');
const { httpError, tilde } = require('../util');

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

// -------------------------------------------------------------------------
// Helpers

async function ensureClean(dir, what) {
  const st = await wtState(dir);
  if (st.op) throw httpError(409, `${tilde(dir)} is in the middle of a ${st.op} — Continue or Abort it first.`);
  const changed = st.files.filter((f) => f.xy !== '??');
  if (changed.length) throw httpError(409, `${tilde(dir)} has ${changed.length} uncommitted file(s)${what ? ` (${what})` : ''} — commit or stash first.`);
  return st;
}

// The worktree to run a branch step in: wherever the branch is checked out, else the scratch worktree.
async function dirFor(ctx, repo, branch, { createFrom } = {}) {
  const { s } = ctx;
  const cwd = s.repos[repo];
  const wts = await worktrees(cwd);
  const hit = wts.find((w) => w.branch === branch);
  if (hit) {
    await ensureClean(hit.path, branch);
    return hit.path;
  }
  const dir = path.join(s.scratchRoot, `dash-${repo}`);
  if (!wts.some((w) => path.resolve(w.path) === dir)) {
    if (fs.existsSync(dir)) throw httpError(409, `${tilde(dir)} exists but is not a worktree of ${repo}.`);
    fs.mkdirSync(s.scratchRoot, { recursive: true });
    ctx.log(`Creating scratch worktree ${tilde(dir)} so your own checkout is left alone.`);
    await ctx.run(cwd, ['worktree', 'add', '--detach', dir, `origin/${s.uat}`], { noHooks: true, timeout: 600_000 });
  }
  await ensureClean(dir);
  ctx.scratchDir = dir;
  await ctx.run(dir, createFrom ? ['switch', '--no-track', '-c', branch, createFrom] : ['switch', branch], { noHooks: true, timeout: 600_000 });
  return dir;
}

async function backup(ctx, cwd, branch) {
  const sha = (await git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).stdout.trim();
  if (!sha) return null;
  const ref = `${BACKUP_NS}${branch}/${stamp()}`;
  await ctx.run(cwd, ['update-ref', ref, sha]);
  ctx.log(`↳ backed up ${sha.slice(0, 9)} (Undo restores it)`);
  return ref;
}

const fetchOrigin = (ctx, repo) => ctx.run(ctx.s.repos[repo], ['fetch', 'origin', '--prune'], { timeout: 300_000, failMsg: 'git fetch failed (VPN / SSH key?)' });

const remoteHas = async (ctx, repo, branch) => !!(await git(ctx.s.repos[repo], ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`])).stdout.trim();
const localHas = async (ctx, repo, branch) => !!(await git(ctx.s.repos[repo], ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).stdout.trim();

// Leaving a branch with uncommitted work: stash it under a message that says which branch it belongs to…
const STASH_MSG = (from, to) => `dashboard: ${from || 'detached'} before ${to}`;
async function stashFor(ctx, cwd, st, to) {
  await ctx.run(cwd, ['stash', 'push', '--include-untracked', '-m', STASH_MSG(st.branch, to)]);
  ctx.log(`↳ changes on ${st.branch} stashed — they come back when you switch to it from the dashboard.`);
}

// …and put it back when the dashboard switches to that branch again. A pop that fails keeps the stash (Workspace tab).
async function restoreStash(ctx, cwd, branch) {
  const list = (await git(cwd, ['stash', 'list', '--format=%gd%x00%s'])).stdout.split('\n').filter(Boolean);
  // `git stash list` shows the message as "On <branch>: <message>".
  const hit = list.map((l) => l.split('\0')).find(([, subject]) => subject?.includes(`: ${STASH_MSG(branch, '')}`));
  if (!hit) return;
  const r = await ctx.run(cwd, ['stash', 'pop', hit[0]], { allowFail: true });
  if (!r.code) return ctx.log(`↳ restored your earlier uncommitted changes on ${branch}.`);
  const files = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
  ctx.log(
    files.length
      ? `⚠ Re-applying ${hit[0]} conflicted in ${files.join(', ')} — fix them in the editor; the stash is kept until you drop it.`
      : `⚠ Could not re-apply ${hit[0]} (${hit[1]}) — it is kept; pop it from the Workspace tab.`,
  );
}

// Creates epic/<key> on origin from the tip of origin/<uat>.
const createEpic = (ctx, repo, epicName) =>
  ctx.run(ctx.s.repos[repo], ['push', 'origin', `refs/remotes/origin/${ctx.s.uat}:refs/heads/${epicName}`], { timeout: 300_000 });

// The push a step still owes once its conflict is resolved: worktree dir → { repo, branch, force, lease, epic }.
// Continue / Skip do it when the rebase / cherry-pick completes; Abort drops it. Lost on restart (the log then says to push).
const pendingPush = new Map();

// After a failed rebase / cherry-pick: leave the conflict for the user (remembering `then`, the push to do after it), or rethrow.
async function conflictOr(e, dir, then) {
  const op = await operation(dir);
  if (!op) throw e;
  if (then) pendingPush.set(path.resolve(dir), then);
  const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
  return { conflict: true, op, dir, files };
}

// The rebase / cherry-pick in dir just completed: do the push its step was going to do.
async function finishPending(ctx, repo, dir, op) {
  const p = pendingPush.get(path.resolve(dir));
  pendingPush.delete(path.resolve(dir));
  if (!p || p.repo !== repo) return ctx.log(`${op} finished. Push to update origin.`);
  ctx.log(`${op} finished — pushing ${p.branch}.`);
  await push(ctx, repo, p.branch, p);
  if (p.epic) ctx.log('⚠ Tell the team: open task branches need a rebase onto the epic.');
}

async function push(ctx, repo, branch, { force = false, lease } = {}) {
  const args = ['push', '-u'];
  if (force) args.push(lease ? `--force-with-lease=${branch}:${lease}` : '--force-with-lease');
  args.push('origin', branch);
  await ctx.run(ctx.s.repos[repo], args, {
    timeout: 300_000,
    failMsg: force ? 'Push failed — origin has new commits; fetch and try again.' : 'Push rejected — the local branch diverged from origin (rebase first?).',
  });
}

// Rebase a task branch onto `onto` and push it (force-with-lease when it's on origin). A conflict is left to resolve;
// Continue then does the push.
async function rebaseAndPush(ctx, repo, branch, onto) {
  const dir = await dirFor(ctx, repo, branch);
  if (await remoteHas(ctx, repo, branch)) {
    const c = await counts(dir, branch, `origin/${branch}`);
    if (c?.onlyB && !c.onlyA) await ctx.run(dir, ['merge', '--ff-only', `origin/${branch}`]);
    else if (c?.onlyB) ctx.log(`⚠ Local and origin/${branch} diverged — keeping the local version.`);
  }
  await backup(ctx, dir, branch);
  const force = await remoteHas(ctx, repo, branch);
  try {
    await ctx.run(dir, ['rebase', onto], { noHooks: true, timeout: 600_000 });
  } catch (e) {
    return conflictOr(e, dir, { repo, branch, force });
  }
  await push(ctx, repo, branch, { force });
  return { dir };
}

// -------------------------------------------------------------------------
// Validation

function issueKey(k) {
  if (typeof k !== 'string' || !KEY_RE.test(k)) throw httpError(400, 'Invalid epic key.');
  return k;
}

function anyBranch(b) {
  if (typeof b !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(b) || b.includes('..') || b.endsWith('.lock') || b.endsWith('/')) {
    throw httpError(400, `Invalid branch name: ${b}`);
  }
  return b;
}

// New branches must carry the suffix; `existing` also accepts an older suffix-less task branch on the uat track.
function taskBranch(s, b, suffix, { existing = false } = {}) {
  anyBranch(b);
  const legacyOk = existing && suffix === s.uat && s.taskMatch(b)?.legacy;
  if (!s.branchRe.test(b) || !(b.endsWith(`-${suffix}`) || legacyOk)) {
    throw httpError(400, `Branch names must look like feature|bugfix/${s.key}-<id>-<description>-${suffix} (lowercase, ASCII).`);
  }
  return b;
}

async function knownDir(s, repo, dir) {
  const wts = await worktrees(s.repos[repo]);
  const hit = wts.find((w) => path.resolve(w.path) === path.resolve(String(dir || s.repos[repo])));
  if (!hit) throw httpError(400, 'That worktree does not belong to this repo.');
  return hit;
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// -------------------------------------------------------------------------
// Steps

const ACTIONS = {
  async fetch(ctx, { repo }) {
    await fetchOrigin(ctx, repo);
  },

  async 'ensure-epic'(ctx, { repo, epic }) {
    const name = `epic/${issueKey(epic)}`;
    await fetchOrigin(ctx, repo);
    if (await remoteHas(ctx, repo, name)) return ctx.log(`${name} already exists on origin — reusing it.`);
    await createEpic(ctx, repo, name);
    ctx.log(`Created ${name} from origin/${ctx.s.uat}.`);
  },

  async 'create-task'(ctx, { repo, epic, branch }) {
    const { s } = ctx;
    branch = taskBranch(s, branch, s.uat);
    const epicName = `epic/${issueKey(epic)}`;
    await fetchOrigin(ctx, repo);
    if ((await localHas(ctx, repo, branch)) || (await remoteHas(ctx, repo, branch))) throw httpError(409, `${branch} already exists.`);
    if (!(await remoteHas(ctx, repo, epicName))) {
      await createEpic(ctx, repo, epicName);
      ctx.log(`${epicName} did not exist → created from origin/${s.uat}.`);
    }
    const cwd = s.repos[repo];
    const main = await wtState(cwd);
    if (!main.op && !main.files.some((f) => f.xy !== '??')) {
      await ctx.run(cwd, ['switch', '--no-track', '-c', branch, `origin/${epicName}`]);
      ctx.log(`Checked out ${branch} in ${tilde(cwd)}.`);
    } else {
      await ctx.run(cwd, ['branch', '--no-track', branch, `origin/${epicName}`]);
      ctx.log(`${tilde(cwd)} has uncommitted changes, so the branch was created but not checked out.`);
    }
  },

  // One click to start coding a ticket, in one or both repos: epic (created off uat if missing) → task branch off
  // the epic → uncommitted work stashed → checked out. Starting again on an existing branch just switches to it.
  async 'start-task'(ctx, { repos, key: ticket, epic, branch, stash }) {
    const { s } = ctx;
    branch = taskBranch(s, branch, s.uat, { existing: true });
    const legacy = s.taskMatch(branch).legacy;
    const list = (Array.isArray(repos) ? repos : []).filter((r) => Object.hasOwn(s.repos, r));
    if (!list.length) throw httpError(400, 'Pick at least one repo.');
    const epicKey = issueKey(epic || (await resolveEpic(issueKey(ticket)).catch(() => ticket)));
    const epicName = `epic/${epicKey}`;
    ctx.log(`Epic: ${epicName}`);
    const done = [];
    for (const repo of list) {
      const cwd = s.repos[repo];
      ctx.log(`\n── ${repo} ──`);
      await fetchOrigin(ctx, repo);
      const exists = (await localHas(ctx, repo, branch)) || (await remoteHas(ctx, repo, branch));
      if (legacy && !exists) throw httpError(400, `${branch} is not in ${repo}; new branches need the -${s.uat} suffix.`);
      if (!exists && !(await remoteHas(ctx, repo, epicName))) {
        await createEpic(ctx, repo, epicName);
        ctx.log(`${epicName} did not exist → created from origin/${s.uat}.`);
      }
      const wt = (await worktrees(cwd)).find((w) => w.branch === branch);
      if (wt && path.resolve(wt.path) !== path.resolve(cwd)) throw httpError(409, `${branch} is checked out at ${tilde(wt.path)}.`);
      const st = await wtState(cwd);
      if (st.op) throw httpError(409, `${tilde(cwd)} is in the middle of a ${st.op} — finish it first.`);
      if (st.branch === branch) {
        ctx.log(`Already on ${branch}.`);
        done.push(repo);
        continue;
      }
      if (st.files.some((f) => f.xy !== '??')) {
        if (!stash) throw httpError(409, `${tilde(cwd)} has uncommitted changes on ${st.branch} — enable "stash" or commit first.`);
        await stashFor(ctx, cwd, st, branch);
      }
      await ctx.run(cwd, exists ? ['switch', branch] : ['switch', '--no-track', '-c', branch, `origin/${epicName}`], { timeout: 600_000 });
      if (exists) await restoreStash(ctx, cwd, branch);
      done.push(repo);
    }
    ctx.log(`\nReady to code on ${branch} (${done.join(', ')}). Commit as "${branch.match(s.ticketRe)[0]}: <what changed, in English>".`);
    return { branch, repos: done, epic: epicKey };
  },

  async 'stash-pop'(ctx, { repo, ref }) {
    if (typeof ref !== 'string' || !/^stash@\{\d+\}$/.test(ref)) throw httpError(400, 'Invalid stash.');
    const cwd = ctx.s.repos[repo];
    try {
      await ctx.run(cwd, ['stash', 'pop', ref]);
    } catch (e) {
      const files = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
      if (!files.length) throw e;
      ctx.log('Pop hit a conflict — the stash is kept; fix the files, then commit or `git checkout -- <file>`.');
      throw new Error(`Conflict while popping: ${files.join(', ')}`);
    }
  },

  async checkout(ctx, { repo, branch, stash }) {
    branch = anyBranch(branch);
    const cwd = ctx.s.repos[repo];
    const wt = (await worktrees(cwd)).find((w) => w.branch === branch);
    if (wt) throw httpError(409, `${branch} is checked out at ${tilde(wt.path)}.`);
    const st = await wtState(cwd);
    if (stash && !st.op && st.files.some((f) => f.xy !== '??')) await stashFor(ctx, cwd, st, branch);
    else await ensureClean(cwd, 'checkout');
    await ctx.run(cwd, ['switch', branch], { timeout: 600_000 });
    await restoreStash(ctx, cwd, branch);
  },

  // skip: ids of pre-commit hooks to skip (passed as SKIP=a,b), for a hook that fails for reasons unrelated to this change
  // (e.g. npm-audit / trivy-fs failing on the whole repo's dependencies).
  async commit(ctx, { repo, message, files, push: andPush, skip }) {
    const { s } = ctx;
    const cwd = s.repos[repo];
    const skipHooks = (Array.isArray(skip) ? skip : typeof skip === 'string' ? skip.split(/[\s,]+/) : []).filter(Boolean);
    if (!skipHooks.every((x) => typeof x === 'string' && /^[\w.-]+$/.test(x))) throw httpError(400, 'skip must be hook ids (letters, digits, - _ .), e.g. ["npm-audit", "trivy-fs"].');
    message = typeof message === 'string' ? message.trim() : '';
    if (!new RegExp(`^${s.key}-\\d+: \\S`).test(message)) throw httpError(400, `The commit message must look like "${s.key}-123: <what changed, in English>".`);
    const st = await wtState(cwd);
    if (st.op) throw httpError(409, `A ${st.op} is in progress — finish it before committing.`);
    const branchTicket = (st.branch || '').match(s.ticketRe)?.[0];
    if (branchTicket && !message.startsWith(branchTicket + ':')) throw httpError(400, `Branch ${st.branch} needs messages starting with "${branchTicket}: ".`);
    const known = new Set(st.files.map((f) => f.path));
    const pick = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && known.has(f)) : [];
    if (!pick.length) throw httpError(400, 'No file selected.');
    const skipStaged = st.files.filter((f) => !pick.includes(f.path) && f.xy[0] !== '.' && f.xy !== '??').map((f) => f.path);
    if (skipStaged.length) await ctx.run(cwd, ['restore', '--staged', '--', ...skipStaged]);
    await ctx.run(cwd, ['add', '-A', '--', ...pick]);
    ctx.log(`Committing (hooks: lint-staged, typecheck, gitleaks… may take a few minutes)${skipHooks.length ? ` — skipping hooks: ${skipHooks.join(', ')}` : ''}`);
    const skipEnv = [process.env.SKIP, ...skipHooks].filter(Boolean).join(',');
    await ctx.run(cwd, ['commit', '-m', message], {
      timeout: 30 * 60_000,
      env: { ...hookEnv(), ...(skipEnv ? { SKIP: skipEnv } : {}) },
      // Say which hook failed instead of a bare "see the log": the tail of the hook output goes into the job error.
      failMsg: (r, text) => {
        const tail = text.split('\n').filter(Boolean).slice(-15).join('\n');
        return [
          r.timedOut ? 'Commit timed out waiting for the pre-commit hooks.' : 'Commit rejected by a pre-commit hook.',
          tail && `Hook output (last lines):\n${tail}`,
          'If a hook fails for reasons unrelated to this change, retry with skip: ["<hook-id>"].',
        ]
          .filter(Boolean)
          .join('\n');
      },
    });
    if (!andPush || !st.branch) return;
    if (s.isProtected(st.branch)) return ctx.log(`Not pushing ${st.branch} (main branch).`);
    await push(ctx, repo, st.branch).catch((e) => {
      throw new Error(`Committed, but the push failed: ${e.message}`);
    });
  },

  async push(ctx, { repo, branch, force }) {
    branch = anyBranch(branch);
    if (ctx.s.isProtected(branch)) throw httpError(400, `Never push straight to ${branch}.`);
    await push(ctx, repo, branch, { force: !!force });
  },

  // Rebase the task onto the tip of its epic and force-push it (rule step 3).
  async 'sync-task'(ctx, { repo, epic, branch }) {
    branch = taskBranch(ctx.s, branch, ctx.s.uat, { existing: true });
    const epicName = `epic/${issueKey(epic)}`;
    await fetchOrigin(ctx, repo);
    if (!(await remoteHas(ctx, repo, epicName))) throw httpError(409, `${epicName} is not on origin.`);
    return rebaseAndPush(ctx, repo, branch, `origin/${epicName}`);
  },

  // The -develop branch conflicts with develop (its MR can't merge): rebase it onto develop and force-push it.
  async 'sync-develop'(ctx, { repo, branch }) {
    branch = taskBranch(ctx.s, branch, ctx.s.develop);
    await fetchOrigin(ctx, repo);
    return rebaseAndPush(ctx, repo, branch, `origin/${ctx.s.develop}`);
  },

  // Epic fell behind uat: rebase it keeping each task's merge commit, then force-push (rule step 5).
  async 'rebase-epic'(ctx, { repo, epic }) {
    const { s } = ctx;
    const name = `epic/${issueKey(epic)}`;
    await fetchOrigin(ctx, repo);
    if (!(await remoteHas(ctx, repo, name))) throw httpError(409, `${name} is not on origin.`);
    const lease = (await git(s.repos[repo], ['rev-parse', `origin/${name}`])).stdout.trim();
    const dir = await dirFor(ctx, repo, name);
    const c = await counts(dir, name, `origin/${name}`);
    if (c?.onlyA) throw httpError(409, `Local ${name} has ${c.onlyA} commit(s) not on origin — check them before rebasing a shared epic.`);
    if (c?.onlyB) await ctx.run(dir, ['merge', '--ff-only', `origin/${name}`]);
    await backup(ctx, dir, name);
    try {
      await ctx.run(dir, ['rebase', '--rebase-merges', `origin/${s.uat}`], { noHooks: true, timeout: 600_000 });
    } catch (e) {
      return conflictOr(e, dir, { repo, branch: name, force: true, lease, epic: true });
    }
    await push(ctx, repo, name, { force: true, lease });
    ctx.log('⚠ Tell the team: open task branches need a rebase onto the epic.');
    return { dir };
  },

  // Cherry-pick the task's regular commits onto the -develop branch (rule "Develop track").
  async 'pick-develop'(ctx, { repo, branch, shas }) {
    const { s } = ctx;
    branch = taskBranch(s, branch, s.develop);
    if (!Array.isArray(shas) || !shas.length || shas.length > 100 || !shas.every((x) => SHA_RE.test(x))) throw httpError(400, 'Invalid commit list.');
    await fetchOrigin(ctx, repo);
    // The rule picks regular commits only; a merge commit would stop cherry-pick with a fatal error.
    // A -develop branch carries its own tickets only (never another task's or another epic's commits).
    const own = ticketIds(s, branch);
    const regular = [];
    const foreign = [];
    for (const sha of shas) {
      const [parentLine, subject] = (await git(s.repos[repo], ['log', '-1', '--format=%P%x00%s', sha])).stdout.trim().split('\0');
      const id = subject?.match(s.subjectRe)?.[2];
      if (parentLine.split(' ').length > 1) ctx.log(`Skipping merge commit ${sha.slice(0, 9)}.`);
      else if (id && own.length && !own.includes(id)) foreign.push(`${sha.slice(0, 9)} ${subject}`);
      else regular.push(sha);
    }
    if (foreign.length) throw httpError(400, `These commits belong to other tickets than ${branch}:\n${foreign.join('\n')}`);
    if (!regular.length) throw httpError(400, 'No regular commits to cherry-pick.');
    const exists = (await localHas(ctx, repo, branch)) || (await remoteHas(ctx, repo, branch));
    const dir = exists ? await dirFor(ctx, repo, branch) : await dirFor(ctx, repo, branch, { createFrom: `origin/${s.develop}` });
    if (exists && (await remoteHas(ctx, repo, branch))) {
      const c = await counts(dir, branch, `origin/${branch}`);
      if (c?.onlyB && !c.onlyA) await ctx.run(dir, ['merge', '--ff-only', `origin/${branch}`]);
    }
    await backup(ctx, dir, branch);
    try {
      await ctx.run(dir, ['cherry-pick', ...regular], { noHooks: true, timeout: 600_000 });
    } catch (e) {
      return conflictOr(e, dir, { repo, branch }).catch(async (err) => {
        // Not a conflict (e.g. bad commit): don't leave a half-done sequence behind.
        await git(dir, ['cherry-pick', '--quit']);
        throw err;
      });
    }
    await push(ctx, repo, branch);
    return { dir };
  },

  // No merge rights on the epic MR: cherry-pick the task's regular commits straight onto the epic and push
  // (fast-forward only — the epic is shared, so a conflict here means rebase the task first, not force-push the epic).
  async 'pick-epic'(ctx, { repo, epic, branch, shas }) {
    const { s } = ctx;
    branch = taskBranch(s, branch, s.uat, { existing: true });
    const epicName = `epic/${issueKey(epic)}`;
    if (!Array.isArray(shas) || !shas.length || shas.length > 100 || !shas.every((x) => SHA_RE.test(x))) throw httpError(400, 'Invalid commit list.');
    await fetchOrigin(ctx, repo);
    if (!(await remoteHas(ctx, repo, epicName))) throw httpError(409, `${epicName} is not on origin.`);
    // Only this task's own regular (non-merge) commits — never another ticket's or another epic's.
    const own = ticketIds(s, branch);
    const regular = [];
    const foreign = [];
    for (const sha of shas) {
      const [parentLine, subject] = (await git(s.repos[repo], ['log', '-1', '--format=%P%x00%s', sha])).stdout.trim().split('\0');
      const id = subject?.match(s.subjectRe)?.[2];
      if (parentLine.split(' ').length > 1) ctx.log(`Skipping merge commit ${sha.slice(0, 9)}.`);
      else if (id && own.length && !own.includes(id)) foreign.push(`${sha.slice(0, 9)} ${subject}`);
      else regular.push(sha);
    }
    if (foreign.length) throw httpError(400, `These commits belong to other tickets than ${branch}:\n${foreign.join('\n')}`);
    if (!regular.length) throw httpError(400, 'No regular commits to cherry-pick.');
    const dir = await dirFor(ctx, repo, epicName);
    const c = await counts(dir, epicName, `origin/${epicName}`);
    if (c?.onlyA) throw httpError(409, `Local ${epicName} has ${c.onlyA} commit(s) not on origin — the epic is shared, check them first.`);
    if (c?.onlyB) await ctx.run(dir, ['merge', '--ff-only', `origin/${epicName}`]);
    await backup(ctx, dir, epicName);
    try {
      await ctx.run(dir, ['cherry-pick', ...regular], { noHooks: true, timeout: 600_000 });
    } catch (e) {
      return conflictOr(e, dir, { repo, branch: epicName }).catch(async (err) => {
        await git(dir, ['cherry-pick', '--quit']);
        throw err;
      });
    }
    // Fast-forward only: the epic is shared, so if origin moved on, fetch + retry rather than force-push over others' work.
    await ctx.run(dir, ['push', 'origin', `${epicName}:${epicName}`], {
      timeout: 300_000,
      failMsg: `Push rejected — ${epicName} moved on origin since the cherry-pick. Fetch and try again.`,
    });
    // Check: no "+" line left means every commit of the task is on the epic (the push updated origin/<epic> here).
    const check = await ctx.run(dir, ['cherry', `origin/${epicName}`, `origin/${branch}`], { allowFail: true });
    const notInEpic = check.code ? null : check.stdout.split('\n').filter((l) => l.startsWith('+')).length;
    if (notInEpic === null) ctx.log(`Could not run git cherry (is origin/${branch} pushed?).`);
    else if (notInEpic) ctx.log(`⚠ ${notInEpic} commit(s) of ${branch} are not on ${epicName} yet (the "+" lines above).`);
    else ctx.log(`✓ git cherry: every commit of ${branch} is on ${epicName}.`);
    return { dir, notInEpic };
  },

  async continue(ctx, { repo, dir }) {
    const wt = await knownDir(ctx.s, repo, dir);
    dir = wt.path;
    if (wt.scratch) ctx.scratchDir = dir;
    const op = await operation(dir);
    if (!op || op === 'merge') throw httpError(409, 'No rebase or cherry-pick in progress here.');
    const unmerged = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    const marked = unmerged.filter((f) => /^(<{7}|>{7}) /m.test(safeRead(path.join(dir, f))));
    if (marked.length) throw httpError(409, `Conflict markers are still in: ${marked.join(', ')}`);
    if (unmerged.length) await ctx.run(dir, ['add', '--', ...unmerged]);
    try {
      await ctx.run(dir, [op, '--continue'], { noHooks: true, timeout: 600_000 });
    } catch (e) {
      return conflictOr(e, dir);
    }
    await finishPending(ctx, repo, dir, op);
    return { dir };
  },

  async skip(ctx, { repo, dir }) {
    const wt = await knownDir(ctx.s, repo, dir);
    dir = wt.path;
    if (wt.scratch) ctx.scratchDir = dir;
    const op = await operation(dir);
    if (op !== 'rebase' && op !== 'cherry-pick') throw httpError(409, 'No rebase or cherry-pick in progress here.');
    try {
      await ctx.run(dir, [op, '--skip'], { noHooks: true, timeout: 600_000 });
    } catch (e) {
      return conflictOr(e, dir);
    }
    await finishPending(ctx, repo, dir, op);
    return { dir };
  },

  async abort(ctx, { repo, dir }) {
    const wt = await knownDir(ctx.s, repo, dir);
    dir = wt.path;
    if (wt.scratch) ctx.scratchDir = dir;
    const op = await operation(dir);
    if (!op) throw httpError(409, 'Nothing in progress here.');
    await ctx.run(dir, [op, '--abort'], { noHooks: true });
    pendingPush.delete(path.resolve(dir));
  },

  // Put a branch back to its latest dashboard backup (the current tip is backed up first).
  async undo(ctx, { repo, branch }) {
    branch = anyBranch(branch);
    const cwd = ctx.s.repos[repo];
    const [latest] = await backupsOf(cwd, branch);
    if (!latest) throw httpError(404, `No backup for ${branch}.`);
    const wt = (await worktrees(cwd)).find((w) => w.branch === branch);
    if (wt) await ensureClean(wt.path, branch);
    const current = (await git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).stdout.trim();
    if (current) await ctx.run(cwd, ['update-ref', `${BACKUP_NS}${branch}/${stamp()}-undo`, current]);
    if (wt) {
      await ctx.run(wt.path, ['reset', '--hard', latest.ref]);
    } else {
      await ctx.run(cwd, ['branch', '-f', branch, latest.ref]);
    }
    await ctx.run(cwd, ['update-ref', '-d', latest.ref]);
    ctx.log(`${branch} is back at ${latest.sha}. If it was pushed, force-push to update origin.`);
  },

  async 'delete-branches'(ctx, { repo, branches: names }) {
    if (!Array.isArray(names) || !names.length) throw httpError(400, 'No branch selected.');
    const cwd = ctx.s.repos[repo];
    const wts = await worktrees(cwd);
    // Only branches already in origin/<uat> may go (plus backup/* and branches whose origin copy is gone).
    const merged = new Set((await git(cwd, ['branch', '--format=%(refname:short)', '--merged', `origin/${ctx.s.uat}`])).stdout.split('\n').filter(Boolean));
    const { local } = await refs(cwd);
    for (const raw of names) {
      const branch = anyBranch(raw);
      if (ctx.s.isProtected(branch)) {
        ctx.log(`Skipping ${branch} (main branch).`);
        continue;
      }
      if (!merged.has(branch) && !branch.startsWith('backup/') && !local.get(branch)?.gone) {
        ctx.log(`Skipping ${branch} (not merged into ${ctx.s.uat}).`);
        continue;
      }
      const wt = wts.find((w) => w.branch === branch);
      if (wt) {
        ctx.log(`Skipping ${branch} (checked out at ${tilde(wt.path)}).`);
        continue;
      }
      await backup(ctx, cwd, branch);
      await ctx.run(cwd, ['branch', '-D', branch], { allowFail: true });
    }
  },

  async 'prune-backups'(ctx, { repo, days }) {
    const cwd = ctx.s.repos[repo];
    const limit = Date.now() - Math.max(1, Number(days) || 14) * 86_400_000;
    const list = (await git(cwd, ['for-each-ref', '--format=%(refname)', BACKUP_NS])).stdout.split('\n').filter(Boolean);
    const old = list.filter((r) => stampTime(r) < limit);
    if (!old.length) return ctx.log('No backups older than the limit.');
    await ctx.run(cwd, ['update-ref', '--stdin'], { input: old.map((r) => `delete ${r}\n`).join('') });
    ctx.log(`Deleted ${old.length} backup ref(s).`);
  },
};

const TITLES = {
  fetch: 'Fetch',
  'ensure-epic': 'Create epic',
  'create-task': 'Create task branch',
  'start-task': 'Start task',
  'stash-pop': 'Pop stash',
  checkout: 'Checkout',
  commit: 'Commit',
  push: 'Push',
  'sync-task': 'Rebase task onto epic',
  'sync-develop': 'Rebase onto develop',
  'rebase-epic': 'Rebase epic',
  'pick-epic': 'Cherry-pick to epic',
  'pick-develop': 'Cherry-pick to develop',
  continue: 'Continue',
  skip: 'Skip commit',
  abort: 'Abort',
  undo: 'Undo',
  'delete-branches': 'Delete branches',
  'prune-backups': 'Prune backups',
};

module.exports = { ACTIONS, TITLES, KEY_RE, knownDir };
