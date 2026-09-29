'use strict';

// Git flow for the LMS repos (backend + frontend), following lms/.cursor/rules/git-workflow.mdc:
//   epic/VLEARN-<epic> (off uat) → <prefix>/VLEARN-<id>-<desc>-uat (off the epic) → MR task → epic
//   → one MR epic → uat → <prefix>/VLEARN-<id>-<desc>-develop (off develop, cherry-picked) → MR → develop.
//
// Safety:
// - A step runs in the worktree that already has the branch checked out; otherwise in a scratch
//   worktree (lms-worktrees/dash-<repo>), so the user's own checkout is never switched under them.
// - Before a branch is rewritten or deleted its tip is saved as refs/dash-backup/<branch>/<time>
//   (instead of hand-made backup/* branches); "Undo" resets to the latest one.
// - Conflicts are left in place to resolve in the editor, then Continue / Skip / Abort from the dashboard.
// - Only one git job runs at a time.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const LMS_ROOT = process.env.LMS_ROOT || path.join(os.homedir(), 'Documents', 'lms');
const REPOS = { backend: path.join(LMS_ROOT, 'backend'), frontend: path.join(LMS_ROOT, 'frontend') };
const SCRATCH_ROOT = process.env.GIT_SCRATCH_ROOT || path.join(path.dirname(LMS_ROOT), 'lms-worktrees');
const BACKUP_NS = 'refs/dash-backup/';
const SINCE = '--since=180.days'; // how far back a ticket's commits are looked up

// Same pattern as the frontend commit-msg hook.
const BRANCH_RE = /^(epic|feature|bugfix|hotfix|refactor|docs|chore|test)\/VLEARN-[0-9]+(-[a-z0-9._-]+)?$/;
const TASK_RE = /^(feature|bugfix|hotfix|refactor|docs|chore|test)\/VLEARN-(\d+(?:-\d+)*)-(.+)-(uat|develop)$/;
const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
const GLAB_BIN = process.env.GLAB_BIN || 'glab';
const MR_DAYS = 90; // MRs updated within this window are matched to branches

function createGitApi({ httpError, readJson, resolveEpic, ticketSummary = () => null, editorBin }) {
  // -------------------------------------------------------------------------
  // Plumbing

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
  let hookEnvCache = null;
  function hookEnv() {
    if (process.env.VSF_APP_TOKEN) return {};
    if (!hookEnvCache) {
      try {
        const m = fs.readFileSync(path.join(LMS_ROOT, 'dev.sh'), 'utf8').match(/^export VSF_APP_TOKEN="?([^"\n]*)"?/m);
        hookEnvCache = m ? { VSF_APP_TOKEN: m[1] } : {};
      } catch {
        hookEnvCache = {};
      }
    }
    return hookEnvCache;
  }

  const counts = async (cwd, a, b) => {
    const r = await git(cwd, ['rev-list', '--left-right', '--count', `${a}...${b}`]);
    if (r.code) return null;
    const [onlyA, onlyB] = r.stdout.trim().split(/\s+/).map(Number);
    return { onlyA, onlyB };
  };

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

  const ticketIds = (branch) => {
    const m = branch.match(TASK_RE);
    return m ? m[2].split('-') : [];
  };

  // Commits whose subject starts with one of the tickets ("VLEARN-123: …"), oldest first.
  async function ticketCommits(cwd, revs, ids) {
    if (!revs.length || !ids.length) return [];
    const r = await git(cwd, [
      'log', '--no-merges', '--reverse', '-E', SINCE, '--format=%H%x00%s%x00%cI',
      ...ids.flatMap((id) => ['--grep', `^VLEARN-${id}:`]), ...revs, '--',
    ]);
    return r.stdout.split('\n').filter(Boolean).map((l) => {
      const [sha, subject, date] = l.split('\0');
      return { sha, subject, date };
    });
  }

  // Cherry-picks get new SHAs; match them by patch id (same diff) or, after a conflict, by subject.
  async function patchIds(cwd, shas) {
    const map = new Map();
    if (!shas.length) return map;
    const show = await git(cwd, ['show', '--no-color', '--format=commit %H', '-p', ...shas]);
    const pid = await git(cwd, ['patch-id', '--stable'], { input: show.stdout });
    for (const line of pid.stdout.split('\n').filter(Boolean)) {
      const [id, sha] = line.split(' ');
      map.set(sha, id);
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Read: where a ticket stands in the flow, per repo

  async function repoFlow(repo, key, epicKey) {
    const cwd = REPOS[repo];
    const num = key.split('-')[1];
    const [{ local, remote }, wts, web, main] = await Promise.all([refs(cwd), worktrees(cwd), webUrl(cwd), wtState(cwd)]);
    const exists = (b) => ({ local: local.has(b), remote: remote.has(b), worktree: wts.find((w) => w.branch === b)?.path || null });
    const tipOf = (b) => (local.has(b) ? `refs/heads/${b}` : remote.has(b) ? `origin/${b}` : null);
    const date = (b) => Math.max(local.get(b)?.date || 0, remote.get(b)?.date || 0);
    const all = [...new Set([...local.keys(), ...remote.keys()])];
    const forTicket = (suffix) =>
      all
        .filter((b) => {
          const m = b.match(TASK_RE);
          return m && m[4] === suffix && m[2].split('-').includes(num);
        })
        .sort((a, b) => (b === main.branch) - (a === main.branch) || date(b) - date(a));

    const flow = { repo, web, dir: cwd, current: main.branch, dirty: main.files.filter((f) => f.xy !== '??').length, op: main.op, fetchedAt: fetchedAt(cwd) };
    const live = wts.filter((w) => !w.prunable && fs.existsSync(w.path));
    flow.conflicts = (await Promise.all(live.map(async (w) => ({ dir: w.path, branch: w.branch, op: await operation(w.path).catch(() => null) })))).filter((w) => w.op);

    // 1. Epic
    const epicName = `epic/${epicKey}`;
    const epicRef = remote.has(epicName) ? `origin/${epicName}` : local.has(epicName) ? `refs/heads/${epicName}` : null;
    flow.epic = { name: epicName, ...exists(epicName) };
    if (epicRef) {
      const [vsUat, merged] = await Promise.all([
        counts(cwd, epicRef, 'origin/uat'),
        git(cwd, ['log', 'origin/uat', '--first-parent', '--merges', SINCE, '-n1', '-F', '--format=%h%x00%s', '--grep', `'${epicName}'`]),
      ]);
      flow.epic.pending = vsUat?.onlyA ?? null; // commits the epic → uat MR still has to bring
      flow.epic.behindUat = vsUat?.onlyB ?? null;
      const [sha, subject] = merged.stdout.trim().split('\0');
      flow.epic.mergedToUat = sha ? { sha, subject } : null;
      if (local.has(epicName) && remote.has(epicName)) flow.epic.sync = await counts(cwd, `refs/heads/${epicName}`, `origin/${epicName}`);
    }

    // 2–4. Task branch off the epic
    const uats = forTicket('uat');
    const uatName = uats[0] || null;
    flow.uat = uatName ? { name: uatName, ...exists(uatName), others: uats.slice(1) } : null;
    const ids = uatName ? ticketIds(uatName) : [num];
    if (flow.uat) {
      const tip = tipOf(uatName);
      if (local.has(uatName) && remote.has(uatName)) flow.uat.sync = await counts(cwd, `refs/heads/${uatName}`, `origin/${uatName}`);
      if (epicRef) {
        const c = await counts(cwd, tip, epicRef);
        flow.uat.aheadEpic = c?.onlyA ?? null;
        flow.uat.behindEpic = c?.onlyB ?? null;
        const m = await git(cwd, ['log', epicRef, '--first-parent', '--merges', SINCE, '-n1', '-F', '--format=%h%x00%s%x00%cI', '--grep', `'${uatName}'`]);
        const [sha, subject, at] = m.stdout.trim().split('\0');
        flow.uat.mergedToEpic = sha ? { sha, subject, at } : null;
      }
      flow.uat.backups = await backupsOf(cwd, uatName);
    }
    flow.epic.backups = await backupsOf(cwd, epicName);

    // 5–6. Develop branch: which of the task's commits are already picked
    const devName = uatName ? uatName.replace(/-uat$/, '-develop') : forTicket('develop')[0] || null;
    const devTip = devName && tipOf(devName);
    flow.develop = devName ? { name: devName, ...exists(devName), backups: await backupsOf(cwd, devName) } : null;
    if (flow.develop && local.has(devName) && remote.has(devName)) flow.develop.sync = await counts(cwd, `refs/heads/${devName}`, `origin/${devName}`);

    const source = [uatName && tipOf(uatName), epicRef].filter(Boolean);
    const taskCommits = (await ticketCommits(cwd, source.slice(0, 1), ids)).slice(-100);
    const [onBranch, onDevelop, onEpic, onUat] = await Promise.all([
      devTip ? ticketCommits(cwd, [devTip], ids) : [],
      ticketCommits(cwd, ['origin/develop'], ids),
      epicRef && source[0] !== epicRef ? ticketCommits(cwd, [epicRef], ids) : [],
      ticketCommits(cwd, ['origin/uat'], ids),
    ]);
    const pids = await patchIds(cwd, [...taskCommits, ...onBranch, ...onDevelop, ...onEpic, ...onUat].map((c) => c.sha));
    const index = (list) => ({ subjects: new Set(list.map((c) => c.subject)), pids: new Set(list.map((c) => pids.get(c.sha)).filter(Boolean)) });
    const inBranch = index(onBranch);
    const inDevelop = index(onDevelop);
    const inEpic = index(onEpic);
    const inUat = index(onUat);
    const has = (ix, c) => ix.pids.has(pids.get(c.sha)) || ix.subjects.has(c.subject);
    flow.commits = taskCommits.map((c) => ({
      sha: c.sha,
      short: c.sha.slice(0, 9),
      subject: c.subject,
      date: c.date,
      inDevelop: has(inDevelop, c),
      inUat: has(inUat, c),
      picked: has(inBranch, c) || has(inDevelop, c),
    }));
    // Which epics already carry this ticket's commits — Jira's parent Epic isn't always the branch that was used.
    const epicBranches = [...remote.keys()].filter((b) => /^epic\/[A-Z][A-Z0-9_]+-\d+$/.test(b));
    const grep = ids.flatMap((id) => ['--grep', `^VLEARN-${id}:`]);
    flow.epicsWithTicket = (
      await Promise.all(
        epicBranches.map(async (b) => {
          const r = await git(cwd, ['log', '--no-merges', '-E', SINCE, '-n1', '--format=%H', ...grep, `origin/${b}`, '--']);
          return r.stdout.trim() ? b.slice(5) : null;
        }),
      )
    ).filter(Boolean);
    // The task's changes reached the epic without the task → epic merge commit: it can't be reverted in one step.
    if (flow.uat && !flow.uat.mergedToEpic && taskCommits.length) {
      flow.uat.onEpicWithoutMerge = taskCommits.filter((c) => has(inEpic, c)).length;
    }

    // Commits on a branch that aren't this ticket's: branched off the wrong base (develop ↔ uat), or a wrong message.
    const ticketRe = new RegExp(`^VLEARN-(${ids.join('|')}):`);
    if (flow.uat) flow.uat.foreign = await foreignCommits(cwd, tipOf(uatName), [epicRef, 'origin/uat'].filter(Boolean), ticketRe);
    if (flow.develop && devTip) flow.develop.foreign = await foreignCommits(cwd, devTip, ['origin/develop'], ticketRe);
    return flow;
  }

  // Non-merge commits on `tip` missing from `bases` whose subject isn't the ticket's. Subjects already on a base
  // (e.g. after the epic was rebased and got new SHAs) don't count.
  async function foreignCommits(cwd, tip, bases, ticketRe) {
    const r = await git(cwd, ['log', '--no-merges', '--format=%h%x00%s', '-n', '200', tip, ...bases.map((b) => '^' + b), '--']);
    const candidates = r.stdout.split('\n').filter(Boolean).map((l) => l.split('\0')).filter(([, subj]) => !ticketRe.test(subj));
    if (!candidates.length) return [];
    const known = new Set((await git(cwd, ['log', '--no-merges', SINCE, '--format=%s', ...bases, '--'])).stdout.split('\n'));
    return candidates.filter(([, subj]) => !known.has(subj)).slice(0, 20).map(([sha, subject]) => ({ sha, subject }));
  }

  // -------------------------------------------------------------------------
  // Read: what an epic branch carries — its own first-parent chain back to uat, each task merge expanded.

  async function epicView(key) {
    const entries = await Promise.all(Object.keys(REPOS).map(async (r) => [r, await repoEpic(r, key).catch((e) => ({ repo: r, error: e.message }))]));
    return { key, repos: Object.fromEntries(entries) };
  }

  async function repoEpic(repo, key) {
    const cwd = REPOS[repo];
    const name = `epic/${key}`;
    const [{ local, remote }, web] = await Promise.all([refs(cwd), webUrl(cwd)]);
    const out = { repo, web, name, exists: remote.has(name), fetchedAt: fetchedAt(cwd) };
    if (!out.exists) return out;
    const ref = `origin/${name}`;
    const lines = async (args) => (await git(cwd, args)).stdout.split('\n').filter(Boolean);
    const [vsUat, uatFirst, inUat, devSubjects] = await Promise.all([
      counts(cwd, ref, 'origin/uat'),
      lines(['rev-list', '--first-parent', SINCE, 'origin/uat']).then((l) => new Set(l)),
      lines(['rev-list', SINCE, 'origin/uat']).then((l) => new Set(l)),
      lines(['log', '--no-merges', SINCE, '--format=%s', 'origin/develop']).then((l) => new Set(l)),
    ]);
    out.pending = vsUat?.onlyA ?? null;
    out.behindUat = vsUat?.onlyB ?? null;
    // Last time GitLab merged this epic into uat ("Merge branch 'epic/X' into 'uat'").
    const [mSha, mDate, mSubject] = (await git(cwd, ['log', 'origin/uat', '--first-parent', '--merges', SINCE, '-n1', '-F', '--format=%h%x00%cI%x00%s', '--grep', `'${name}'`])).stdout.trim().split('\0');
    out.mergedToUat = mSha ? { sha: mSha, date: mDate, subject: mSubject } : null;

    const FMT = '--format=%H%x00%P%x00%s%x00%an%x00%cI';
    const parse = (l) => {
      const [sha, parents, subject, author, date] = l.split('\0');
      return {
        sha,
        short: sha.slice(0, 9),
        parents: parents.split(' ').filter(Boolean),
        subject,
        author,
        date,
        ticket: subject.match(/^(VLEARN-\d+):/)?.[1] || null,
        inUat: inUat.has(sha),
        inDevelop: devSubjects.has(subject),
      };
    };
    // The epic's own history: follow first parents until the uat commit it was branched from (or rebased onto).
    const chain = [];
    for (const l of await lines(['log', '--first-parent', '-n', '400', FMT, ref])) {
      const c = parse(l);
      if (uatFirst.has(c.sha)) break;
      chain.push(c);
    }
    chain.reverse();
    const groups = [];
    for (const c of chain) {
      if (c.parents.length > 1) {
        const commits = (await lines(['log', '--no-merges', '--reverse', FMT, `${c.parents[0]}..${c.parents[1]}`])).map(parse);
        const branch = c.subject.match(/^Merge branch '([^']+)'/)?.[1] || null;
        groups.push({ kind: 'merge', merge: { sha: c.short, subject: c.subject, date: c.date, author: c.author }, branch, commits: commits.map(strip) });
      } else {
        let g = groups[groups.length - 1];
        if (g?.kind !== 'direct') groups.push((g = { kind: 'direct', commits: [] }));
        g.commits.push(strip(c));
      }
    }
    // Each ticket's existing task branches (to suggest the cherry-pick target) and what's already picked there.
    const date = (b) => Math.max(local.get(b)?.date || 0, remote.get(b)?.date || 0);
    const tickets = new Set(groups.flatMap((g) => g.commits.map((c) => c.ticket)).filter(Boolean));
    const branches = {};
    for (const b of [...new Set([...local.keys(), ...remote.keys()])].sort((a, z) => date(z) - date(a))) {
      const m = b.match(TASK_RE);
      if (!m) continue;
      for (const id of m[2].split('-')) {
        const t = `VLEARN-${id}`;
        if (!tickets.has(t)) continue;
        branches[t] ||= {};
        branches[t][m[4]] ||= b;
      }
    }
    for (const [t, b] of Object.entries(branches)) {
      if (!b.develop) continue;
      const tip = local.has(b.develop) ? `refs/heads/${b.develop}` : `origin/${b.develop}`;
      const onBranch = new Set(await lines(['log', '--no-merges', '-n', '300', '--format=%s', tip, '^origin/develop', '--']));
      for (const g of groups) for (const c of g.commits) if (c.ticket === t && onBranch.has(c.subject)) c.onDevBranch = true;
    }
    out.branches = branches;
    // Jira decides which tickets belong to this epic; commits of other epics' tickets must not be picked from here.
    out.ticketEpics = {};
    out.ticketTitles = {};
    await pool([...tickets], 4, async (t) => {
      out.ticketEpics[t] = await resolveEpic(t).catch(() => null);
      out.ticketTitles[t] = ticketSummary(t) || '';
    });
    out.groups = groups.reverse(); // newest first
    out.total = chain.length;
    return out;
  }

  const strip = ({ parents, ...c }) => c;

  async function flow(key, epicKey) {
    const epic = epicKey || (await resolveEpic(key).catch(() => key));
    const entries = await Promise.all(Object.keys(REPOS).map(async (r) => [r, await repoFlow(r, key, epic).catch((e) => ({ repo: r, error: e.message }))]));
    return { key, epic, epicFromJira: !epicKey, repos: Object.fromEntries(entries) };
  }

  async function overview() {
    const entries = await Promise.all(
      Object.entries(REPOS).map(async ([repo, cwd]) => {
        try {
          const [main, wts, web] = await Promise.all([wtState(cwd), worktrees(cwd), webUrl(cwd)]);
          const others = await Promise.all(
            wts
              .filter((w) => path.resolve(w.path) !== path.resolve(cwd) && !w.prunable && fs.existsSync(w.path))
              .map(async (w) => {
                const s = await wtState(w.path).catch(() => null);
                return { ...w, op: s?.op || null, dirty: s ? s.files.filter((f) => f.xy !== '??').length : null };
              }),
          );
          const stashes = (await git(cwd, ['stash', 'list', '--format=%gd%x00%s%x00%cI'])).stdout
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              const [ref, subject, at] = l.split('\0');
              return { ref, subject, at };
            });
          return [repo, { repo, dir: cwd, web, main, stashes, worktrees: others, fetchedAt: fetchedAt(cwd) }];
        } catch (e) {
          return [repo, { repo, dir: cwd, error: e.message }];
        }
      }),
    );
    return { root: LMS_ROOT, repos: Object.fromEntries(entries) };
  }

  // Local branches with what's needed to decide whether they can go.
  async function branches(repo) {
    const cwd = REPOS[repo];
    const [{ local }, wts, merged, backupList] = await Promise.all([
      refs(cwd),
      worktrees(cwd),
      out(cwd, ['branch', '--format=%(refname:short)', '--merged', 'origin/uat']),
      out(cwd, ['for-each-ref', '--format=%(refname)', BACKUP_NS]),
    ]);
    const mergedSet = new Set(merged.split('\n').filter(Boolean));
    const backups = backupList.split('\n').filter(Boolean);
    const list = [...local].map(([name, b]) => {
      const kind = name.startsWith('backup/') ? 'backup' : name.startsWith('epic/') ? 'epic' : TASK_RE.test(name) ? 'task' : 'other';
      return {
        name,
        kind,
        date: b.date,
        upstream: b.upstream || null,
        gone: b.gone,
        mergedToUat: mergedSet.has(name) && !['uat', 'develop', 'main'].includes(name),
        worktree: wts.find((w) => w.branch === name)?.path || null,
        tickets: ticketIds(name).map((id) => `VLEARN-${id}`),
        suffix: (name.match(TASK_RE) || [])[4] || null,
      };
    });
    list.sort((a, b) => b.date - a.date);
    const now = Date.now();
    const oldBackups = backups.filter((r) => now - stampTime(r) > 14 * 86_400_000).length;
    return { repo, branches: list, backups: { total: backups.length, olderThan14d: oldBackups } };
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

  // -------------------------------------------------------------------------
  // Merge requests (GitLab API through glab's stored login; needs the VPN)

  const mrCache = new Map(); // repo → { at, promise }

  function glabApi(host, endpoint) {
    return new Promise((resolve, reject) => {
      execFile(GLAB_BIN, ['api', '--hostname', host, '--paginate', endpoint], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const text = String(stderr || err.message);
          const why = err.code === 'ENOENT' ? 'glab not found' : err.killed || /timeout|dial tcp/i.test(text) ? 'GitLab not reachable (VPN?)' : text.trim().split('\n').pop();
          return reject(httpError(502, why));
        }
        // --paginate prints one JSON array per page.
        const pages = String(stdout).trim().replace(/\]\s*\[/g, ',');
        resolve(JSON.parse(pages || '[]'));
      });
    });
  }

  async function projectMrs(repo) {
    const web = await webUrl(REPOS[repo]);
    if (!web) throw httpError(400, 'origin is not a GitLab repository');
    const u = new URL(web);
    const since = new Date(Date.now() - MR_DAYS * 86_400_000).toISOString();
    const list = await glabApi(u.host, `projects/${encodeURIComponent(u.pathname.slice(1))}/merge_requests?state=all&per_page=100&updated_after=${since}`);
    const byBranch = {};
    for (const m of list) {
      (byBranch[m.source_branch] ||= []).push({
        iid: m.iid,
        state: m.state, // opened | merged | closed | locked
        draft: !!(m.draft || m.work_in_progress),
        title: m.title,
        target: m.target_branch,
        url: m.web_url,
        author: m.author?.name || '',
        updated: m.updated_at,
        merged: m.merged_at || null,
        conflicts: !!m.has_conflicts,
        comments: m.user_notes_count || 0,
        // false = some threads that block merging are still unresolved
        resolved: m.blocking_discussions_resolved !== false,
        status: m.detailed_merge_status || m.merge_status || null,
      });
    }
    for (const mrs of Object.values(byBranch)) mrs.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
    return { repo, byBranch, at: Date.now() };
  }

  // Cached 60s (30s after a failure) so the drawer and the Git view share one call per repo.
  function mrs(repo, fresh) {
    const hit = mrCache.get(repo);
    if (!fresh && hit && Date.now() - hit.at < (hit.failed ? 30_000 : 60_000)) return hit.promise;
    const entry = { at: Date.now(), failed: false };
    entry.promise = projectMrs(repo).catch((e) => {
      entry.failed = true;
      return { repo, byBranch: null, error: e.message, at: Date.now() };
    });
    mrCache.set(repo, entry);
    return entry.promise;
  }

  // -------------------------------------------------------------------------
  // Jobs

  const jobs = new Map();
  let queue = Promise.resolve();

  function startJob(title, repo, fn) {
    const job = { id: crypto.randomUUID(), title, repo, status: 'running', log: [], result: null, error: null, startedAt: Date.now(), endedAt: null };
    jobs.set(job.id, job);
    for (const id of [...jobs.keys()].slice(0, Math.max(0, jobs.size - 40))) jobs.delete(id);
    const ctx = {
      log: (text) => void job.log.push(text),
      // Runs git and records the command + its output in the job log; throws on failure unless allowFail.
      async run(cwd, args, opts = {}) {
        const full = opts.noHooks ? ['-c', 'core.hooksPath=/dev/null', ...args] : args;
        const where = path.resolve(cwd) === path.resolve(REPOS[repo]) ? '' : `   (${tilde(cwd)})`;
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

  const jobDto = (j) => ({ ...j });

  // Detach the scratch worktree after a job so it doesn't hold the branch (git allows a branch in one worktree only).
  // Left alone while a conflict is pending there.
  async function releaseScratch(ctx) {
    const dir = ctx.scratchDir;
    if (!dir || (await operation(dir).catch(() => 'unknown'))) return;
    await git(dir, ['-c', 'core.hooksPath=/dev/null', 'switch', '--detach', '-q']);
  }

  // -------------------------------------------------------------------------
  // Steps

  async function ensureClean(dir, what) {
    const s = await wtState(dir);
    if (s.op) throw httpError(409, `${tilde(dir)} is in the middle of a ${s.op} — Continue or Abort it first.`);
    const changed = s.files.filter((f) => f.xy !== '??');
    if (changed.length) throw httpError(409, `${tilde(dir)} has ${changed.length} uncommitted file(s)${what ? ` (${what})` : ''} — commit or stash first.`);
    return s;
  }

  // The worktree to run a branch step in: wherever the branch is checked out, else the scratch worktree.
  async function dirFor(ctx, repo, branch, { createFrom } = {}) {
    const cwd = REPOS[repo];
    const wts = await worktrees(cwd);
    const hit = wts.find((w) => w.branch === branch);
    if (hit) {
      await ensureClean(hit.path, branch);
      return hit.path;
    }
    const dir = path.join(SCRATCH_ROOT, `dash-${repo}`);
    if (!wts.some((w) => path.resolve(w.path) === dir)) {
      if (fs.existsSync(dir)) throw httpError(409, `${tilde(dir)} exists but is not a worktree of ${repo}.`);
      fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
      ctx.log(`Creating scratch worktree ${tilde(dir)} so your own checkout is left alone.`);
      await ctx.run(cwd, ['worktree', 'add', '--detach', dir, 'origin/uat'], { noHooks: true, timeout: 600_000 });
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

  const fetchOrigin = (ctx, repo) => ctx.run(REPOS[repo], ['fetch', 'origin', '--prune'], { timeout: 300_000, failMsg: 'git fetch failed (VPN / SSH key?)' });

  const remoteHas = async (repo, branch) => !!(await git(REPOS[repo], ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`])).stdout.trim();
  const localHas = async (repo, branch) => !!(await git(REPOS[repo], ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).stdout.trim();

  // After a failed rebase / cherry-pick: leave the conflict for the user, or rethrow.
  async function conflictOr(e, dir) {
    const op = await operation(dir);
    if (!op) throw e;
    const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    return { conflict: true, op, dir, files };
  }

  async function push(ctx, repo, branch, { force = false, lease } = {}) {
    const args = ['push', '-u'];
    if (force) args.push(lease ? `--force-with-lease=${branch}:${lease}` : '--force-with-lease');
    args.push('origin', branch);
    await ctx.run(REPOS[repo], args, {
      timeout: 300_000,
      failMsg: force ? 'Push failed — origin has new commits; fetch and try again.' : 'Push rejected — the local branch diverged from origin (rebase first?).',
    });
  }

  const ACTIONS = {
    async fetch(ctx, { repo }) {
      await fetchOrigin(ctx, repo);
    },

    async 'ensure-epic'(ctx, { repo, epic }) {
      const name = `epic/${issueKey(epic)}`;
      await fetchOrigin(ctx, repo);
      if (await remoteHas(repo, name)) return ctx.log(`${name} already exists on origin — reusing it.`);
      await ctx.run(REPOS[repo], ['push', 'origin', `refs/remotes/origin/uat:refs/heads/${name}`], { timeout: 300_000 });
      ctx.log(`Created ${name} from origin/uat.`);
    },

    async 'create-task'(ctx, { repo, epic, branch }) {
      branch = taskBranch(branch, 'uat');
      const epicName = `epic/${issueKey(epic)}`;
      await fetchOrigin(ctx, repo);
      if ((await localHas(repo, branch)) || (await remoteHas(repo, branch))) throw httpError(409, `${branch} already exists.`);
      if (!(await remoteHas(repo, epicName))) {
        await ctx.run(REPOS[repo], ['push', 'origin', `refs/remotes/origin/uat:refs/heads/${epicName}`], { timeout: 300_000 });
        ctx.log(`${epicName} did not exist → created from origin/uat.`);
      }
      const cwd = REPOS[repo];
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
      branch = taskBranch(branch, 'uat');
      const list = (Array.isArray(repos) ? repos : []).filter((r) => Object.hasOwn(REPOS, r));
      if (!list.length) throw httpError(400, 'Pick at least one repo.');
      const epicKey = issueKey(epic || (await resolveEpic(issueKey(ticket)).catch(() => ticket)));
      const epicName = `epic/${epicKey}`;
      ctx.log(`Epic: ${epicName}`);
      const done = [];
      for (const repo of list) {
        const cwd = REPOS[repo];
        ctx.log(`\n── ${repo} ──`);
        await ctx.run(cwd, ['fetch', 'origin', '--prune'], { timeout: 300_000, failMsg: 'git fetch failed (VPN / SSH key?)' });
        const exists = (await localHas(repo, branch)) || (await remoteHas(repo, branch));
        if (!exists && !(await remoteHas(repo, epicName))) {
          await ctx.run(cwd, ['push', 'origin', `refs/remotes/origin/uat:refs/heads/${epicName}`], { timeout: 300_000 });
          ctx.log(`${epicName} did not exist → created from origin/uat.`);
        }
        const wt = (await worktrees(cwd)).find((w) => w.branch === branch);
        if (wt && path.resolve(wt.path) !== path.resolve(cwd)) throw httpError(409, `${branch} is checked out at ${tilde(wt.path)}.`);
        const s = await wtState(cwd);
        if (s.op) throw httpError(409, `${tilde(cwd)} is in the middle of a ${s.op} — finish it first.`);
        if (s.branch === branch) {
          ctx.log(`Already on ${branch}.`);
          done.push(repo);
          continue;
        }
        if (s.files.some((f) => f.xy !== '??')) {
          if (!stash) throw httpError(409, `${tilde(cwd)} has uncommitted changes on ${s.branch} — enable "stash" or commit first.`);
          await ctx.run(cwd, ['stash', 'push', '--include-untracked', '-m', `dashboard: ${s.branch || 'detached'} before ${branch}`]);
          ctx.log(`↳ changes on ${s.branch} stashed (pop them from the Workspace tab).`);
        }
        await ctx.run(cwd, exists ? ['switch', branch] : ['switch', '--no-track', '-c', branch, `origin/${epicName}`], { timeout: 600_000 });
        done.push(repo);
      }
      ctx.log(`\nReady to code on ${branch} (${done.join(', ')}). Commit as "${branch.match(/VLEARN-\d+/)[0]}: <what changed, in English>".`);
      return { branch, repos: done, epic: epicKey };
    },

    async 'stash-pop'(ctx, { repo, ref }) {
      if (typeof ref !== 'string' || !/^stash@\{\d+\}$/.test(ref)) throw httpError(400, 'Invalid stash.');
      const cwd = REPOS[repo];
      try {
        await ctx.run(cwd, ['stash', 'pop', ref]);
      } catch (e) {
        const files = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
        if (!files.length) throw e;
        ctx.log('Pop hit a conflict — the stash is kept; fix the files, then commit or `git checkout -- <file>`.');
        throw new Error(`Conflict while popping: ${files.join(', ')}`);
      }
    },

    async checkout(ctx, { repo, branch }) {
      branch = anyBranch(branch);
      const cwd = REPOS[repo];
      await ensureClean(cwd, 'checkout');
      const wt = (await worktrees(cwd)).find((w) => w.branch === branch);
      if (wt) throw httpError(409, `${branch} is checked out at ${tilde(wt.path)}.`);
      await ctx.run(cwd, ['switch', branch], { timeout: 600_000 });
    },

    async commit(ctx, { repo, message, files }) {
      const cwd = REPOS[repo];
      message = typeof message === 'string' ? message.trim() : '';
      if (!/^VLEARN-\d+: \S/.test(message)) throw httpError(400, 'The commit message must look like "VLEARN-123: <what changed, in English>".');
      const s = await wtState(cwd);
      if (s.op) throw httpError(409, `A ${s.op} is in progress — finish it before committing.`);
      const branchTicket = (s.branch || '').match(/VLEARN-\d+/)?.[0];
      if (branchTicket && !message.startsWith(branchTicket + ':')) throw httpError(400, `Branch ${s.branch} needs messages starting with "${branchTicket}: ".`);
      const known = new Set(s.files.map((f) => f.path));
      const pick = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && known.has(f)) : [];
      if (!pick.length) throw httpError(400, 'No file selected.');
      const skipStaged = s.files.filter((f) => !pick.includes(f.path) && f.xy[0] !== '.' && f.xy !== '??').map((f) => f.path);
      if (skipStaged.length) await ctx.run(cwd, ['restore', '--staged', '--', ...skipStaged]);
      await ctx.run(cwd, ['add', '-A', '--', ...pick]);
      ctx.log('Committing (hooks: lint-staged, typecheck, gitleaks… may take a few minutes)');
      await ctx.run(cwd, ['commit', '-m', message], { timeout: 30 * 60_000, env: hookEnv(), failMsg: 'Commit failed — see the hook output above.' });
    },

    async push(ctx, { repo, branch, force }) {
      branch = anyBranch(branch);
      if (['uat', 'develop', 'main'].includes(branch) || branch.startsWith('release/')) throw httpError(400, `Never push straight to ${branch}.`);
      await push(ctx, repo, branch, { force: !!force });
    },

    // Rebase the task onto the tip of its epic and force-push it (rule step 3).
    async 'sync-task'(ctx, { repo, epic, branch }) {
      branch = taskBranch(branch, 'uat');
      const epicName = `epic/${issueKey(epic)}`;
      await fetchOrigin(ctx, repo);
      if (!(await remoteHas(repo, epicName))) throw httpError(409, `${epicName} is not on origin.`);
      const dir = await dirFor(ctx, repo, branch);
      if (await remoteHas(repo, branch)) {
        const c = await counts(dir, branch, `origin/${branch}`);
        if (c?.onlyB && !c.onlyA) await ctx.run(dir, ['merge', '--ff-only', `origin/${branch}`]);
        else if (c?.onlyB) ctx.log(`⚠ Local and origin/${branch} diverged — keeping the local version.`);
      }
      await backup(ctx, dir, branch);
      try {
        await ctx.run(dir, ['rebase', `origin/${epicName}`], { noHooks: true, timeout: 600_000 });
      } catch (e) {
        return conflictOr(e, dir);
      }
      await push(ctx, repo, branch, { force: await remoteHas(repo, branch) });
      return { dir };
    },

    // Epic fell behind uat: rebase it keeping each task's merge commit, then force-push (rule step 5).
    async 'rebase-epic'(ctx, { repo, epic }) {
      const name = `epic/${issueKey(epic)}`;
      await fetchOrigin(ctx, repo);
      if (!(await remoteHas(repo, name))) throw httpError(409, `${name} is not on origin.`);
      const lease = (await git(REPOS[repo], ['rev-parse', `origin/${name}`])).stdout.trim();
      const dir = await dirFor(ctx, repo, name);
      const c = await counts(dir, name, `origin/${name}`);
      if (c?.onlyA) throw httpError(409, `Local ${name} has ${c.onlyA} commit(s) not on origin — check them before rebasing a shared epic.`);
      if (c?.onlyB) await ctx.run(dir, ['merge', '--ff-only', `origin/${name}`]);
      await backup(ctx, dir, name);
      try {
        await ctx.run(dir, ['rebase', '--rebase-merges', 'origin/uat'], { noHooks: true, timeout: 600_000 });
      } catch (e) {
        return conflictOr(e, dir);
      }
      await push(ctx, repo, name, { force: true, lease });
      ctx.log('⚠ Tell the team: open task branches need a rebase onto the epic.');
      return { dir };
    },

    // Cherry-pick the task's regular commits onto the -develop branch (rule "Develop track").
    async 'pick-develop'(ctx, { repo, branch, shas }) {
      branch = taskBranch(branch, 'develop');
      if (!Array.isArray(shas) || !shas.length || shas.length > 100 || !shas.every((s) => SHA_RE.test(s))) throw httpError(400, 'Invalid commit list.');
      await fetchOrigin(ctx, repo);
      // The rule picks regular commits only; a merge commit would stop cherry-pick with a fatal error.
      // A -develop branch carries its own tickets only (never another task's or another epic's commits).
      const own = ticketIds(branch);
      const regular = [];
      const foreign = [];
      for (const sha of shas) {
        const [parentLine, subject] = (await git(REPOS[repo], ['log', '-1', '--format=%P%x00%s', sha])).stdout.trim().split('\0');
        const id = subject?.match(/^VLEARN-(\d+):/)?.[1];
        if (parentLine.split(' ').length > 1) ctx.log(`Skipping merge commit ${sha.slice(0, 9)}.`);
        else if (id && own.length && !own.includes(id)) foreign.push(`${sha.slice(0, 9)} ${subject}`);
        else regular.push(sha);
      }
      if (foreign.length) throw httpError(400, `These commits belong to other tickets than ${branch}:\n${foreign.join('\n')}`);
      if (!regular.length) throw httpError(400, 'No regular commits to cherry-pick.');
      const exists = (await localHas(repo, branch)) || (await remoteHas(repo, branch));
      const dir = exists ? await dirFor(ctx, repo, branch) : await dirFor(ctx, repo, branch, { createFrom: 'origin/develop' });
      if (exists && (await remoteHas(repo, branch))) {
        const c = await counts(dir, branch, `origin/${branch}`);
        if (c?.onlyB && !c.onlyA) await ctx.run(dir, ['merge', '--ff-only', `origin/${branch}`]);
      }
      await backup(ctx, dir, branch);
      try {
        await ctx.run(dir, ['cherry-pick', ...regular], { noHooks: true, timeout: 600_000 });
      } catch (e) {
        const result = await conflictOr(e, dir).catch(async (err) => {
          // Not a conflict (e.g. bad commit): don't leave a half-done sequence behind.
          await git(dir, ['cherry-pick', '--quit']);
          throw err;
        });
        return result;
      }
      await push(ctx, repo, branch);
      return { dir };
    },

    async continue(ctx, { repo, dir }) {
      const wt = await knownDir(repo, dir);
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
      ctx.log(`${op} finished. Push to update origin.`);
      return { dir };
    },

    async skip(ctx, { repo, dir }) {
      const wt = await knownDir(repo, dir);
      dir = wt.path;
      if (wt.scratch) ctx.scratchDir = dir;
      const op = await operation(dir);
      if (op !== 'rebase' && op !== 'cherry-pick') throw httpError(409, 'No rebase or cherry-pick in progress here.');
      try {
        await ctx.run(dir, [op, '--skip'], { noHooks: true, timeout: 600_000 });
      } catch (e) {
        return conflictOr(e, dir);
      }
      return { dir };
    },

    async abort(ctx, { repo, dir }) {
      const wt = await knownDir(repo, dir);
      dir = wt.path;
      if (wt.scratch) ctx.scratchDir = dir;
      const op = await operation(dir);
      if (!op) throw httpError(409, 'Nothing in progress here.');
      await ctx.run(dir, [op, '--abort'], { noHooks: true });
    },

    // Put a branch back to its latest dashboard backup (the current tip is backed up first).
    async undo(ctx, { repo, branch }) {
      branch = anyBranch(branch);
      const cwd = REPOS[repo];
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
      const cwd = REPOS[repo];
      const wts = await worktrees(cwd);
      for (const raw of names) {
        const branch = anyBranch(raw);
        if (['uat', 'develop', 'main'].includes(branch)) {
          ctx.log(`Skipping ${branch} (main branch).`);
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
      const cwd = REPOS[repo];
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
    'rebase-epic': 'Rebase epic onto uat',
    'pick-develop': 'Cherry-pick to develop',
    continue: 'Continue',
    skip: 'Skip commit',
    abort: 'Abort',
    undo: 'Undo',
    'delete-branches': 'Delete branches',
    'prune-backups': 'Prune backups',
  };

  // -------------------------------------------------------------------------
  // Validation helpers

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

  function taskBranch(b, suffix) {
    anyBranch(b);
    if (!BRANCH_RE.test(b) || !b.endsWith(`-${suffix}`)) {
      throw httpError(400, `Branch names must look like feature|bugfix/VLEARN-<id>-<description>-${suffix} (lowercase, ASCII).`);
    }
    return b;
  }

  async function knownDir(repo, dir) {
    const wts = await worktrees(REPOS[repo]);
    const hit = wts.find((w) => path.resolve(w.path) === path.resolve(String(dir || REPOS[repo])));
    if (!hit) throw httpError(400, 'That worktree does not belong to this repo.');
    return hit;
  }

  function openEditor(dir) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(editorBin, [dir], { env, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }

  // -------------------------------------------------------------------------
  // Routes (all under /api/git/)

  return async function handle(req, url) {
    const p = url.pathname.slice('/api/git'.length);
    const repoParam = (r) => {
      if (!Object.hasOwn(REPOS, r)) throw httpError(400, 'repo must be backend or frontend');
      return r;
    };

    if (req.method === 'GET' && p === '/overview') return overview();
    if (req.method === 'GET' && p === '/branches') return branches(repoParam(url.searchParams.get('repo')));
    if (req.method === 'GET' && p === '/flow') {
      const k = url.searchParams.get('key') || '';
      const epic = url.searchParams.get('epic') || '';
      if (!KEY_RE.test(k) || (epic && !KEY_RE.test(epic))) throw httpError(400, 'Invalid issue key');
      return flow(k, epic || null);
    }
    if (req.method === 'GET' && p === '/epic') {
      const k = url.searchParams.get('key') || '';
      if (!KEY_RE.test(k)) throw httpError(400, 'Invalid epic key');
      return epicView(k);
    }
    if (req.method === 'GET' && p === '/mrs') return mrs(repoParam(url.searchParams.get('repo')), url.searchParams.has('fresh'));
    if (req.method === 'GET' && p === '/jobs') return { jobs: [...jobs.values()].reverse().map(({ log, ...j }) => j) };
    const jm = p.match(/^\/jobs\/([0-9a-f-]{36})$/);
    if (req.method === 'GET' && jm) {
      const job = jobs.get(jm[1]);
      if (!job) throw httpError(404, 'Job not found');
      return jobDto(job);
    }
    if (req.method === 'POST' && p === '/open') {
      const body = (await readJson(req)) || {};
      openEditor((await knownDir(repoParam(body.repo), body.dir)).path);
      return { ok: true };
    }
    if (req.method === 'POST' && p === '/action') {
      const body = (await readJson(req)) || {};
      const run = ACTIONS[body.action];
      if (!run || !Object.hasOwn(ACTIONS, body.action)) throw httpError(400, 'Invalid action');
      const repo = body.action === 'start-task' && !body.repo ? 'backend' : repoParam(body.repo);
      const where = body.action === 'start-task' && Array.isArray(body.repos) ? body.repos.join(' + ') : repo;
      const job = startJob(`${TITLES[body.action]} · ${where}`, repo, (ctx) => run(ctx, { ...body, repo }));
      return { id: job.id };
    }
    throw httpError(404, 'Not found');
  };
}

// ---------------------------------------------------------------------------

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
}

// refs/dash-backup/<branch>/20260929T101500[-undo] → epoch ms
function stampTime(ref) {
  const m = ref.match(/\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:-undo)?$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

function tilde(p) {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

module.exports = { createGitApi };
