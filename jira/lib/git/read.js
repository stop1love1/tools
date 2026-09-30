'use strict';

// Read-only views of the git flow: where a ticket stands per repo, what an epic branch carries,
// the workspace overview and the local branches.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { settings } = require('./settings');
const { BACKUP_NS, git, out, counts, refs, worktrees, operation, wtState, webUrl, fetchedAt, backupsOf, stampTime } = require('./exec');
const { resolveEpic, ticketSummary } = require('../issues');
const { mapPool } = require('../util');

const ticketIds = (s, branch) => {
  const m = branch.match(s.taskRe);
  return m ? m[2].split('-') : [];
};

// Commits whose subject starts with one of the tickets ("<KEY>-123: …"), oldest first.
async function ticketCommits(s, cwd, revs, ids) {
  if (!revs.length || !ids.length) return [];
  const r = await git(cwd, [
    'log', '--no-merges', '--reverse', '-E', s.since, '--format=%H%x00%s%x00%cI',
    ...ids.flatMap((id) => ['--grep', s.grep(id)]), ...revs, '--',
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
// Where a ticket stands in the flow, per repo

async function repoFlow(s, repo, key, epicKey) {
  const cwd = s.repos[repo];
  const { uat: UAT, develop: DEV } = s;
  const num = key.split('-')[1];
  const [{ local, remote }, wts, web, main] = await Promise.all([refs(cwd), worktrees(cwd), webUrl(cwd), wtState(cwd)]);
  const exists = (b) => ({ local: local.has(b), remote: remote.has(b), worktree: wts.find((w) => w.branch === b)?.path || null });
  const tipOf = (b) => (local.has(b) ? `refs/heads/${b}` : remote.has(b) ? `origin/${b}` : null);
  const date = (b) => Math.max(local.get(b)?.date || 0, remote.get(b)?.date || 0);
  const all = [...new Set([...local.keys(), ...remote.keys()])];
  const forTicket = (suffix) =>
    all
      .filter((b) => {
        const m = b.match(s.taskRe);
        return m && m[4] === suffix && m[2].split('-').includes(num);
      })
      .sort((a, b) => (b === main.branch) - (a === main.branch) || date(b) - date(a));

  // Branches that name the ticket but don't follow the task pattern (e.g. no -uat suffix): worth knowing about.
  const mentions = new RegExp(`${s.key}-(?:\\d+-)*${num}(?:\\D|$)`);
  const otherBranches = all.filter((b) => mentions.test(b) && !s.taskRe.test(b) && !b.startsWith('epic/') && !b.startsWith('backup/')).slice(0, 5);
  const flow = { repo, web, dir: cwd, current: main.branch, otherBranches, dirty: main.files.filter((f) => f.xy !== '??').length, op: main.op, fetchedAt: fetchedAt(cwd) };
  const live = wts.filter((w) => !w.prunable && fs.existsSync(w.path));
  flow.conflicts = (await Promise.all(live.map(async (w) => ({ dir: w.path, branch: w.branch, op: await operation(w.path).catch(() => null) })))).filter((w) => w.op);

  // 1. Epic
  const epicName = `epic/${epicKey}`;
  const epicRef = remote.has(epicName) ? `origin/${epicName}` : local.has(epicName) ? `refs/heads/${epicName}` : null;
  flow.epic = { name: epicName, ...exists(epicName) };
  if (epicRef) {
    const [vsUat, merged] = await Promise.all([
      counts(cwd, epicRef, `origin/${UAT}`),
      git(cwd, ['log', `origin/${UAT}`, '--first-parent', '--merges', s.since, '-n1', '-F', '--format=%h%x00%s', '--grep', `'${epicName}'`]),
    ]);
    flow.epic.pending = vsUat?.onlyA ?? null; // commits the epic → uat MR still has to bring
    flow.epic.behindUat = vsUat?.onlyB ?? null;
    const [sha, subject] = merged.stdout.trim().split('\0');
    flow.epic.mergedToUat = sha ? { sha, subject } : null;
    if (local.has(epicName) && remote.has(epicName)) flow.epic.sync = await counts(cwd, `refs/heads/${epicName}`, `origin/${epicName}`);
  }

  // 2–4. Task branch off the epic
  const uats = forTicket(UAT);
  const uatName = uats[0] || null;
  flow.uat = uatName ? { name: uatName, ...exists(uatName), others: uats.slice(1) } : null;
  const ids = uatName ? ticketIds(s, uatName) : [num];
  if (flow.uat) {
    const tip = tipOf(uatName);
    if (local.has(uatName) && remote.has(uatName)) flow.uat.sync = await counts(cwd, `refs/heads/${uatName}`, `origin/${uatName}`);
    if (epicRef) {
      const c = await counts(cwd, tip, epicRef);
      flow.uat.aheadEpic = c?.onlyA ?? null;
      flow.uat.behindEpic = c?.onlyB ?? null;
      const m = await git(cwd, ['log', epicRef, '--first-parent', '--merges', s.since, '-n1', '-F', '--format=%h%x00%s%x00%cI', '--grep', `'${uatName}'`]);
      const [sha, subject, at] = m.stdout.trim().split('\0');
      flow.uat.mergedToEpic = sha ? { sha, subject, at } : null;
    }
    flow.uat.backups = await backupsOf(cwd, uatName);
  }
  flow.epic.backups = await backupsOf(cwd, epicName);

  // 5–6. Develop branch: which of the task's commits are already picked
  const devName = uatName ? s.toDevelop(uatName) : forTicket(DEV)[0] || null;
  const devTip = devName && tipOf(devName);
  flow.develop = devName ? { name: devName, ...exists(devName), backups: await backupsOf(cwd, devName) } : null;
  if (flow.develop && local.has(devName) && remote.has(devName)) flow.develop.sync = await counts(cwd, `refs/heads/${devName}`, `origin/${devName}`);

  const source = [uatName && tipOf(uatName), epicRef].filter(Boolean);
  const taskCommits = (await ticketCommits(s, cwd, source.slice(0, 1), ids)).slice(-100);
  const [onBranch, onDevelop, onEpic, onUat] = await Promise.all([
    devTip ? ticketCommits(s, cwd, [devTip], ids) : [],
    ticketCommits(s, cwd, [`origin/${DEV}`], ids),
    epicRef && source[0] !== epicRef ? ticketCommits(s, cwd, [epicRef], ids) : [],
    ticketCommits(s, cwd, [`origin/${UAT}`], ids),
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
  const epicBranches = [...remote.keys()].filter((b) => s.epicRe.test(b));
  const grep = ids.flatMap((id) => ['--grep', s.grep(id)]);
  flow.epicsWithTicket = (
    await Promise.all(
      epicBranches.map(async (b) => {
        const r = await git(cwd, ['log', '--no-merges', '-E', s.since, '-n1', '--format=%H', ...grep, `origin/${b}`, '--']);
        return r.stdout.trim() ? b.slice(5) : null;
      }),
    )
  ).filter(Boolean);
  // The task's changes reached the epic without the task → epic merge commit: it can't be reverted in one step.
  if (flow.uat && !flow.uat.mergedToEpic && taskCommits.length) {
    flow.uat.onEpicWithoutMerge = taskCommits.filter((c) => has(inEpic, c)).length;
  }

  // Commits on a branch that aren't this ticket's: branched off the wrong base (develop ↔ uat), or a wrong message.
  const ticketRe = new RegExp(`^${s.key}-(${ids.join('|')}):`);
  if (flow.uat) flow.uat.foreign = await foreignCommits(s, cwd, tipOf(uatName), [epicRef, `origin/${UAT}`].filter(Boolean), ticketRe);
  if (flow.develop && devTip) flow.develop.foreign = await foreignCommits(s, cwd, devTip, [`origin/${DEV}`], ticketRe);
  return flow;
}

// Non-merge commits on `tip` missing from `bases` whose subject isn't the ticket's. Subjects already on a base
// (e.g. after the epic was rebased and got new SHAs) don't count.
async function foreignCommits(s, cwd, tip, bases, ticketRe) {
  const r = await git(cwd, ['log', '--no-merges', '--format=%h%x00%s', '-n', '200', tip, ...bases.map((b) => '^' + b), '--']);
  const candidates = r.stdout.split('\n').filter(Boolean).map((l) => l.split('\0')).filter(([, subj]) => !ticketRe.test(subj));
  if (!candidates.length) return [];
  const known = new Set((await git(cwd, ['log', '--no-merges', s.since, '--format=%s', ...bases, '--'])).stdout.split('\n'));
  return candidates.filter(([, subj]) => !known.has(subj)).slice(0, 20).map(([sha, subject]) => ({ sha, subject }));
}

async function flow(key, epicKey) {
  const s = settings();
  const epic = epicKey || (await resolveEpic(key).catch(() => key));
  const entries = await Promise.all(Object.keys(s.repos).map(async (r) => [r, await repoFlow(s, r, key, epic).catch((e) => ({ repo: r, error: e.message }))]));
  return { key, epic, epicFromJira: !epicKey, repos: Object.fromEntries(entries) };
}

// -------------------------------------------------------------------------
// What an epic branch carries — its own first-parent chain back to uat, each task merge expanded.

async function epicView(key) {
  const s = settings();
  const entries = await Promise.all(Object.keys(s.repos).map(async (r) => [r, await repoEpic(s, r, key).catch((e) => ({ repo: r, error: e.message }))]));
  return { key, repos: Object.fromEntries(entries) };
}

async function repoEpic(s, repo, key) {
  const cwd = s.repos[repo];
  const name = `epic/${key}`;
  const [{ local, remote }, web] = await Promise.all([refs(cwd), webUrl(cwd)]);
  const res = { repo, web, name, exists: remote.has(name), fetchedAt: fetchedAt(cwd) };
  if (!res.exists) return res;
  const ref = `origin/${name}`;
  const lines = async (args) => (await git(cwd, args)).stdout.split('\n').filter(Boolean);
  const [vsUat, uatFirst, inUat, devSubjects] = await Promise.all([
    counts(cwd, ref, `origin/${s.uat}`),
    lines(['rev-list', '--first-parent', s.since, `origin/${s.uat}`]).then((l) => new Set(l)),
    lines(['rev-list', s.since, `origin/${s.uat}`]).then((l) => new Set(l)),
    lines(['log', '--no-merges', s.since, '--format=%s', `origin/${s.develop}`]).then((l) => new Set(l)),
  ]);
  res.pending = vsUat?.onlyA ?? null;
  res.behindUat = vsUat?.onlyB ?? null;
  // Last time GitLab merged this epic into uat ("Merge branch 'epic/X' into 'uat'").
  const [mSha, mDate, mSubject] = (await git(cwd, ['log', `origin/${s.uat}`, '--first-parent', '--merges', s.since, '-n1', '-F', '--format=%h%x00%cI%x00%s', '--grep', `'${name}'`])).stdout.trim().split('\0');
  res.mergedToUat = mSha ? { sha: mSha, date: mDate, subject: mSubject } : null;

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
      ticket: subject.match(s.subjectRe)?.[1] || null,
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
    const m = b.match(s.taskRe);
    if (!m) continue;
    const track = m[4] === s.uat ? 'uat' : 'develop';
    for (const id of m[2].split('-')) {
      const t = s.ticket(id);
      if (!tickets.has(t)) continue;
      branches[t] ||= {};
      branches[t][track] ||= b;
    }
  }
  for (const [t, b] of Object.entries(branches)) {
    if (!b.develop) continue;
    const tip = local.has(b.develop) ? `refs/heads/${b.develop}` : `origin/${b.develop}`;
    const onBranch = new Set(await lines(['log', '--no-merges', '-n', '300', '--format=%s', tip, `^origin/${s.develop}`, '--']));
    for (const g of groups) for (const c of g.commits) if (c.ticket === t && onBranch.has(c.subject)) c.onDevBranch = true;
  }
  res.branches = branches;
  // Jira decides which tickets belong to this epic; commits of other epics' tickets must not be picked from here.
  res.ticketEpics = {};
  res.ticketTitles = {};
  await mapPool([...tickets], 4, async (t) => {
    res.ticketEpics[t] = await resolveEpic(t).catch(() => null);
    res.ticketTitles[t] = ticketSummary(t) || '';
  });
  res.groups = groups.reverse(); // newest first
  res.total = chain.length;
  return res;
}

const strip = ({ parents, ...c }) => c;

// -------------------------------------------------------------------------
// Workspace

async function overview() {
  const s = settings();
  const entries = await Promise.all(
    Object.entries(s.repos).map(async ([repo, cwd]) => {
      try {
        const [main, wts, web] = await Promise.all([wtState(cwd), worktrees(cwd), webUrl(cwd)]);
        const others = await Promise.all(
          wts
            .filter((w) => path.resolve(w.path) !== path.resolve(cwd) && !w.prunable && fs.existsSync(w.path))
            .map(async (w) => {
              const st = await wtState(w.path).catch(() => null);
              return { ...w, op: st?.op || null, dirty: st ? st.files.filter((f) => f.xy !== '??').length : null };
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
  return { root: s.root, repos: Object.fromEntries(entries) };
}

// Local branches with what's needed to decide whether they can go.
async function branches(repo) {
  const s = settings();
  const cwd = s.repos[repo];
  const [{ local }, wts, merged, backupList] = await Promise.all([
    refs(cwd),
    worktrees(cwd),
    out(cwd, ['branch', '--format=%(refname:short)', '--merged', `origin/${s.uat}`]),
    out(cwd, ['for-each-ref', '--format=%(refname)', BACKUP_NS]),
  ]);
  const mergedSet = new Set(merged.split('\n').filter(Boolean));
  const backups = backupList.split('\n').filter(Boolean);
  const list = [...local].map(([name, b]) => {
    const kind = name.startsWith('backup/') ? 'backup' : name.startsWith('epic/') ? 'epic' : s.taskRe.test(name) ? 'task' : 'other';
    return {
      name,
      kind,
      date: b.date,
      upstream: b.upstream || null,
      gone: b.gone,
      mergedToUat: mergedSet.has(name) && !s.isProtected(name),
      worktree: wts.find((w) => w.branch === name)?.path || null,
      tickets: ticketIds(s, name).map(s.ticket),
      suffix: (name.match(s.taskRe) || [])[4] || null,
    };
  });
  list.sort((a, b) => b.date - a.date);
  const days = config.get().git.backupPruneDays;
  const old = backups.filter((r) => Date.now() - stampTime(r) > days * 86_400_000).length;
  return { repo, branches: list, backups: { total: backups.length, old, days } };
}

module.exports = { flow, epicView, overview, branches, ticketIds };
