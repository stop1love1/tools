'use strict';

// Issue drawer: one repo's place in the flow as data (stageModel), drawn by flow.js, and the rule checks.
//
// A repo is 4 stages, each a cell: { state, text, sub, title?, why?, quiet?, detail }.
//   state: done | todo (the user's move) | warn (needs a fix) | wait (on someone else) | na (not yet)
//   title / why: the sentence shown in "Next" when the cell is the user's move or waits on someone
//   detail: the cell's panel — { title, where, steps: [{ state, text, chips }], commits?, note?, primary?, secondary, more }
// Every action is defined once, in a cell's detail; "Next" reuses the cell's primary action.

const stages = () => [
  { id: 'code', label: 'Code', hint: 'commit · push' },
  { id: 'epic', label: '→ Epic', hint: 'task MR' },
  { id: 'uat', label: `→ ${UAT()}`, hint: 'epic MR', fork: true },
  { id: 'dev', label: `→ ${DEV()}`, hint: 'pick · MR' },
];

// What an open MR is waiting for, in a few words.
const mrSub = (m) =>
  m.draft ? 'draft' : m.state === 'opened' && !m.resolved ? 'unresolved threads' : (m.state === 'opened' && MERGE_STATUS[m.status]) || (m.comments ? 'in review' : 'waiting for review');

function stageModel(issue, f, r, M) {
  const key = issue.key;
  const repo = r.repo;
  const label = repoLabel(repo);
  const { epic, uat } = r;
  const dev = r.develop;
  const commits = r.commits || [];
  const title = commits[0]?.subject || `${key}: ${issue.summary}`;
  const devName = dev?.name || (uat ? toDevName(uat.name) : `feature/${key}-${slugify(issue.summary)}-${DEV()}`);
  const desc = mrDescription(key, epic.name, devName);

  const mrs = (src, tgt) => (src ? mrsOf(M, src, tgt) : []);
  const openMr = (src, tgt) => mrs(src, tgt).find((m) => m.state === 'opened');
  const mergedMr = (src, tgt) => mrs(src, tgt).find((m) => m.state === 'merged');
  const newMr = (src, tgt, text) => linkAct(text, mrUrl(r.web, src, tgt, title, desc));
  const openAct = (m) => m && linkAct(`Open MR !${m.iid}`, m.url);
  const listAct = (b) => linkAct('MRs of this branch on GitLab', mrListUrl(r.web, b));
  const mrSteps = (src, tgt, name) =>
    mrs(src, tgt)
      .slice(0, 3)
      .map((m) => ({
        state: m.state === 'merged' ? 'done' : m.state === 'opened' ? (m.conflicts ? 'warn' : 'wait') : 'na',
        text: `MR → ${name}`,
        chips: [mrChip(m), ...mrFacts(sansConflict({ ...m, comments: 0 }))],
      }));
  const where = (b) => [
    b.local ? gitChip('local') : null,
    b.remote ? gitChip('on origin', 'ok') : gitChip('not pushed', 'warn'),
    b.name === r.current ? gitChip('checked out', 'accent') : b.worktree ? gitChip('worktree', '', b.worktree) : null,
  ];
  const panel = (stage, where) => ({ title: `${label} · ${stage}`, where, steps: [], secondary: [], more: [] });
  // GitLab not reachable (or still loading): whether the MR exists is unknown — link to the branch's MRs, and offer
  // creating one only as a second choice.
  const unknownMr = (d, branch, create, target) => {
    const list = listAct(branch);
    d.secondary = [list, create];
    d.more = d.more.filter((a) => a?.label !== list.label);
    d.note = 'MR status unavailable: check GitLab before creating a new MR.';
    return { state: 'wait', text: 'MR unknown', sub: 'GitLab unreachable', quiet: true, title: `MR → ${target}: status unknown`, secondary: [list], detail: d };
  };

  const sync = uat?.sync || {};
  const dirtyHere = !!uat && r.current === uat.name && r.dirty > 0;
  const codeDone = !!uat && commits.length > 0 && !!uat.remote && !(sync.onlyA > 0) && !(sync.onlyB > 0);
  const inEpic = !!uat && (!!uat.mergedToEpic || !!mergedMr(uat.name, epic.name) || uat.onEpicWithoutMerge > 0);
  const inUat = commits.length > 0 && commits.every((c) => c.inUat);
  const inDev = (commits.length > 0 && commits.every((c) => c.inDevelop)) || !!mergedMr(dev?.name, DEV());
  const missing = commits.filter((c) => !c.picked);
  const taskMr = uat && openMr(uat.name, epic.name);
  const epicConflict = uat && commits.length > 0 && conflictOf(taskMr, uat.conflictEpic);

  function codeCell() {
    const d = panel('code', uat?.name || '');
    if (!uat) {
      d.primary = act('Start…', () => startTaskPop(issue, { repos: [repo] }), { icon: 'branch' });
      d.steps.push({ state: commits.length ? 'warn' : 'todo', text: commits.length ? `${commits.length} ${key} commit(s) went straight to another branch` : `No -${UAT()} branch for ${key} yet` });
      d.note = `The branch is created off ${epic.name}${epic.remote ? '' : ` (made from ${UAT()} first)`}, then checked out.`;
      return commits.length
        ? { state: 'warn', text: `${commits.length} commits`, sub: 'no task branch', title: `${commits.length} ${key} commit(s), but no task branch`, why: 'They went straight to another branch — not the flow (task branch → MR → epic).', detail: d }
        : { state: 'todo', text: 'No branch', sub: 'start it', title: 'No task branch yet', why: d.note, detail: d };
    }

    const commit = uat.name === r.current && act('Commit…', () => openCommitDialog(repo), { icon: 'commit' });
    const checkout = uat.name !== r.current && !uat.worktree && act('Checkout', () => checkoutBranch(repo, uat.name, r.dirty), { icon: 'branch', title: `Switch ${r.dir} to this branch` });
    d.steps.push({ state: 'done', text: 'Task branch', chips: where(uat) });
    if (dirtyHere) d.steps.push({ state: 'todo', text: `${r.dirty} uncommitted file(s)` });
    d.steps.push(commits.length ? { state: 'done', text: `${commits.length} ${key} commit(s)` } : { state: 'todo', text: 'No commits yet' });
    if (!uat.remote) d.steps.push({ state: 'todo', text: 'Not on origin yet' });
    else if (sync.onlyA > 0) d.steps.push({ state: 'todo', text: `${sync.onlyA} commit(s) not pushed` });
    if (sync.onlyB > 0) d.steps.push({ state: 'warn', text: `${sync.onlyB} commit(s) only on origin — local and origin diverged` });
    if (commits.length) d.commits = { label: `${key} commits (oldest first)`, items: commits.map((c) => ({ short: c.short, subject: c.subject })) };
    d.more.push(undoAct(repo, uat));

    let cell;
    if (dirtyHere) {
      d.primary = commit;
      cell = { state: 'todo', text: `${r.dirty} uncommitted`, sub: 'checked out', title: `${r.dirty} uncommitted file(s)`, why: `Commit as "${key}: <what changed, in English>".` };
    } else if (!commits.length) {
      d.primary = checkout || null;
      cell = { state: 'todo', text: 'No commits yet', sub: uat.name === r.current ? 'checked out' : 'not checked out', title: 'Branch ready — no commits yet', why: uat.name === r.current ? 'Checked out: start coding.' : 'Check it out to start coding.' };
    } else if (uat.remote && sync.onlyB > 0) {
      d.primary = forcePushAct(repo, uat.name);
      cell = { state: 'warn', text: 'Diverged', sub: `${sync.onlyB} only on origin`, title: `${uat.name} differs from origin`, why: 'After a rebase / undo: force-push (with lease) to replace origin’s version.' };
    } else if (!uat.remote || sync.onlyA > 0) {
      d.primary = pushAct(repo, uat);
      cell = { state: 'todo', text: uat.remote ? `${sync.onlyA} to push` : 'Not pushed', sub: `${commits.length} commit(s)`, title: uat.remote ? `${sync.onlyA} commit(s) not pushed` : 'Branch not pushed yet', why: 'Push, then open the MR into the epic.' };
      // Rebasing onto the epic pushes too, and pushing as is would only open a conflicting MR.
      if (epicConflict) cell.quiet = true;
    } else {
      cell = { state: 'done', text: `${commits.length} commit(s)`, sub: 'pushed' };
    }
    d.secondary = [commit, checkout].filter((a) => a && a !== d.primary);
    return { ...cell, detail: d };
  }

  function epicCell() {
    const d = panel('into the epic', uat ? `${uat.name} → ${epic.name}` : epic.name);
    if (!uat) return { state: 'na', text: '—', sub: 'after a branch', detail: { ...d, note: 'Start a task branch first.' } };
    const m = taskMr;
    const c = epicConflict;
    d.steps.push(...mrSteps(uat.name, epic.name, 'epic'));
    if (c) d.steps.push({ state: 'warn', text: 'Conflicts with the epic', chips: [conflictChip(c, 'epic')] });
    if (!inEpic && uat.behindEpic > 0) d.steps.push({ state: 'todo', text: `${uat.behindEpic} new commit(s) on the epic since the branch` });
    if (!inEpic) d.steps.push({ state: 'na', text: 'The reviewer merges with “Create merge commit” (one merge commit per task) — never merge locally into the epic' });
    if (!inEpic) d.more.push(pickEpicAct(repo, f.epic, uat.name, commits));
    if (!M?.byBranch) d.more.push(listAct(uat.name));

    if (c) {
      d.primary = rebaseTaskAct(repo, f.epic, uat);
      d.secondary = [openAct(m)].filter(Boolean);
      return {
        state: 'warn',
        text: 'Conflict',
        sub: [m && `MR !${m.iid}`, c.files.length && `${c.files.length} file(s)`].filter(Boolean).join(' · ') || 'with the epic',
        title: m ? `MR !${m.iid} conflicts with the epic` : inEpic ? 'New commits conflict with the epic' : 'Conflicts with the epic',
        why: `Merging into ${epic.name} would conflict${conflictFiles(c)}. Rebase, resolve in Cursor, Continue — it pushes (a backup is kept).`,
        detail: d,
      };
    }
    if (inEpic) {
      const merged = uat.mergedToEpic || null;
      const noMerge = !merged && !mergedMr(uat.name, epic.name);
      d.steps.unshift(
        merged
          ? { state: 'done', text: 'Merged into the epic', chips: [gitChip(merged.sha, 'ok', merged.subject), rel(merged.at)] }
          : { state: 'done', text: noMerge ? `All ${commits.length} commit(s) are on ${epic.name}` : 'Merged into the epic' },
      );
      if (noMerge) d.note = 'Reached the epic without a task MR, so there is no merge commit to revert it with.';
      if (m) d.secondary = [openAct(m)];
      return { state: 'done', text: noMerge ? 'On the epic' : 'Merged', sub: m ? `MR !${m.iid} still open` : noMerge ? 'no task MR' : merged ? rel(merged.at) : '', detail: d };
    }
    if (!codeDone) return { state: 'na', text: 'After push', sub: '', detail: { ...d, note: 'Push the branch first.' } };
    if (uat.behindEpic > 0) {
      d.primary = rebaseTaskAct(repo, f.epic, uat);
      d.secondary = [openAct(m)].filter(Boolean);
      return { state: 'todo', text: 'Epic moved on', sub: `${uat.behindEpic} new on the epic`, title: 'Epic moved on — rebase before the MR', why: `${uat.behindEpic} new commit(s) on ${epic.name}. Rebasing keeps the MR clean (a backup is kept).`, detail: d };
    }
    if (m && !m.resolved) {
      d.primary = openAct(m);
      return { state: 'warn', text: `MR !${m.iid}`, sub: 'unresolved threads', title: `MR !${m.iid} has unresolved review threads`, why: `${uat.name} → ${epic.name}`, detail: d };
    }
    if (m) {
      d.secondary = [openAct(m)];
      return { state: 'wait', text: `MR !${m.iid}`, sub: mrSub(m), title: `MR !${m.iid} → epic: ${mrSub(m)}`, secondary: [openAct(m)], detail: d };
    }
    if (!M?.byBranch) return unknownMr(d, uat.name, newMr(uat.name, epic.name, 'Create MR → epic'), 'epic');
    d.primary = newMr(uat.name, epic.name, 'Create MR → epic');
    return { state: 'todo', text: 'No MR yet', sub: 'create it', title: 'Ready for the MR into the epic', why: 'Merge it with “Create merge commit” (one merge commit per task).', detail: d };
  }

  function uatCell() {
    const m = openMr(epic.name, UAT());
    const d = panel(`into ${UAT()}`, `${epic.name} → ${UAT()} (one MR per epic)`);
    d.steps.push(...mrSteps(epic.name, UAT(), UAT()));
    if (epic.mergedToUat) d.steps.push({ state: 'done', text: `Epic merged into ${UAT()}`, chips: [gitChip(epic.mergedToUat.sha, 'ok', epic.mergedToUat.subject)] });
    if (epic.pending > 0) d.steps.push({ state: 'wait', text: `${epic.pending} commit(s) of the epic not in ${UAT()} yet` });
    if (epic.behindUat > 0) d.steps.push({ state: 'na', text: `The epic is ${epic.behindUat} commit(s) behind ${UAT()}`, chips: [gitChip('fine unless its MR conflicts')] });
    d.more.push(epic.behindUat > 0 && rebaseEpicAct(repo, f.epic), undoAct(repo, epic));

    if (!inEpic) return { state: 'na', text: 'After the epic', sub: 'via the epic MR', detail: { ...d, note: `Tasks go up to ${UAT()} with their epic’s MR.` } };
    if (inUat) return { state: 'done', text: `In ${UAT()}`, sub: epic.mergedToUat ? fmtDate(epic.mergedToUat.date) : '', detail: d };
    const c = conflictOf(m, epic.conflictUat);
    if (c) {
      d.primary = rebaseEpicAct(repo, f.epic);
      d.more = d.more.filter((a) => a && a.label !== d.primary.label);
      d.secondary = [openAct(m)].filter(Boolean);
      d.steps.push({ state: 'warn', text: `The epic conflicts with ${UAT()}`, chips: [conflictChip(c, UAT())] });
      return { state: 'warn', text: 'Epic conflicts', sub: `with ${UAT()}`, title: `epic/${f.epic} conflicts with ${UAT()}`, why: 'The epic is shared: tell the team before rebasing it (force-push).', detail: d };
    }
    if (m) {
      d.secondary = [openAct(m)];
      return { state: 'wait', text: `Epic MR !${m.iid}`, sub: mrSub(m), title: `Epic MR !${m.iid} → ${UAT()}: ${mrSub(m)}`, secondary: [openAct(m)], detail: d };
    }
    if (epic.pending > 0 && M?.byBranch) {
      d.primary = newMr(epic.name, UAT(), `Create epic MR → ${UAT()}`);
      d.note = 'Only ONE MR per epic per repo; tasks merged into the epic later show up in it.';
      return { state: 'todo', text: 'No epic MR', sub: `${epic.pending} commits waiting`, title: `No MR epic → ${UAT()} yet`, why: d.note, detail: d };
    }
    if (epic.pending > 0) {
      const list = linkAct('MRs of the epic on GitLab', mrListUrl(r.web, epic.name));
      d.secondary = [list];
      return { state: 'wait', text: 'Epic MR', sub: 'MR status unknown', quiet: true, title: `Epic → ${UAT()}: MR status unknown`, secondary: [list], detail: d };
    }
    return { state: 'wait', text: `Waiting for ${UAT()}`, sub: '', detail: d };
  }

  function devCell() {
    const d = panel(`into ${DEV()}`, `${devName} → ${DEV()}`);
    if (!commits.length) return { state: 'na', text: '—', sub: `no ${key} commits`, detail: { ...d, note: `No commits starting with ${key}: yet.` } };

    d.steps.push({ state: missing.length ? 'todo' : 'done', text: `${commits.length - missing.length} / ${commits.length} commit(s) cherry-picked` });
    if (dev) d.steps.push({ state: dev.remote && !(dev.sync?.onlyA > 0) ? 'done' : 'todo', text: 'Develop branch', chips: where(dev) });
    d.steps.push(...mrSteps(dev?.name, DEV(), DEV()));
    d.more.push(undoAct(repo, dev));

    let pick = null;
    if (missing.length) {
      const boxes = missing.map((c) => h('input', { type: 'checkbox', checked: true, value: c.sha, 'aria-label': c.subject }));
      const target = h('input', { class: 'gin mono', value: devName, spellcheck: 'false', 'aria-label': `${DEV()} branch` });
      d.commits = { label: `Not on ${DEV()} yet (oldest first, merge commits excluded)`, items: missing.map((c, i) => ({ short: c.short, subject: c.subject, box: boxes[i] })), target, targetHint: dev ? '' : `created from ${DEV()}` };
      pick = act(`Cherry-pick ${missing.length} → ${DEV()}`, () => {
        const shas = boxes.filter((b) => b.checked).map((b) => b.value);
        if (!shas.length) return toast('No commit selected', 'error');
        const branch = target.value.trim();
        const list = missing.filter((c) => shas.includes(c.sha));
        gitAction({ action: 'pick-develop', repo, branch, shas }, `Cherry-pick onto ${branch}${dev ? '' : ` (created from ${DEV()})`} and push it:\n\n${list.map((c) => `${c.short} ${c.subject}`).join('\n')}`);
      });
    }

    if (inDev) return { state: 'done', text: `In ${DEV()}`, sub: '', detail: d };
    if (!inEpic) {
      if (pick) d.more.unshift({ ...pick, label: `Cherry-pick ${missing.length} → ${DEV()} now (before the epic)` });
      return { state: 'na', text: 'After the epic', sub: `${commits.length - missing.length}/${commits.length} picked`, detail: d };
    }
    if (pick) {
      d.primary = pick;
      return {
        state: 'todo',
        text: `${commits.length - missing.length} / ${commits.length} picked`,
        sub: 'cherry-pick',
        title: `${missing.length} commit(s) to cherry-pick → ${DEV()}`,
        why: `Onto ${devName}${dev ? '' : ` (created from ${DEV()})`}, then pushed.`,
        detail: d,
      };
    }
    if (dev && (!dev.remote || dev.sync?.onlyA > 0 || dev.sync?.onlyB > 0)) {
      d.primary = pushAct(repo, dev);
      return { state: 'todo', text: 'Picked', sub: 'not pushed', title: `${DEV()} branch not pushed`, why: `Push ${dev.name}, then open the MR into ${DEV()}.`, detail: d };
    }
    const m = dev && openMr(dev.name, DEV());
    const c = dev && conflictOf(m, dev.conflictDevelop);
    if (c) {
      d.primary = syncDevAct(repo, dev.name);
      d.secondary = [openAct(m)].filter(Boolean);
      d.steps.push({ state: 'warn', text: `Conflicts with ${DEV()}`, chips: [conflictChip(c, DEV())] });
      return { state: 'warn', text: 'Conflict', sub: `with ${DEV()}`, title: `${dev.name} conflicts with ${DEV()}`, why: `Rebase onto ${DEV()}, resolve in Cursor, Continue — it pushes (a backup is kept).`, detail: d };
    }
    if (m) {
      d.secondary = [openAct(m)];
      return { state: 'wait', text: `MR !${m.iid}`, sub: mrSub(m), title: `MR !${m.iid} → ${DEV()}: ${mrSub(m)}`, secondary: [openAct(m)], detail: d };
    }
    if (dev && !M?.byBranch) return unknownMr(d, dev.name, newMr(dev.name, DEV(), `Create MR → ${DEV()}`), DEV());
    if (dev) {
      d.primary = newMr(dev.name, DEV(), `Create MR → ${DEV()}`);
      d.note = `Title and description identical to the ${UAT()} MR.`;
      return { state: 'todo', text: 'No MR yet', sub: 'create it', title: `Picked — needs an MR into ${DEV()}`, why: d.note, detail: d };
    }
    return { state: 'wait', text: 'Picked', sub: `waiting for ${DEV()}`, detail: d };
  }

  const cells = { code: codeCell(), epic: epicCell(), uat: uatCell(), dev: devCell() };
  for (const c of Object.values(cells)) {
    c.detail.secondary = (c.detail.secondary || []).filter(Boolean);
    c.detail.more = (c.detail.more || []).filter(Boolean);
  }

  const branch = uat?.name || dev?.name || null;
  const pinned = branchPins(key)[repo];
  const branchChips = [
    branch && branch === r.current && { text: 'checked out', kind: 'accent' },
    pinned && branch === pinned && { text: 'pinned', kind: 'accent' },
    uat?.legacy && { text: `no -${UAT()} suffix`, title: 'Older branch name without the -uat suffix' },
  ].filter(Boolean);

  return { repo, label, r, branch, branchChips, cells };
}

// Rule checks (lms/.cursor/rules/git-workflow.mdc).
function flowChecks(key, r, M) {
  const checks = [];
  const { uat, epic } = r;
  const foreign = (b, where) =>
    b?.foreign?.length > 0 &&
    checks.push([
      `${b.foreign.length} commit(s) on `,
      code(b.name),
      ` aren't ${key} — branched off the wrong base (${where}) or wrong commit message: `,
      b.foreign.slice(0, 3).map((c) => code(`${c.sha} ${c.subject}`)),
    ]);
  foreign(uat, 'should be the epic');
  foreign(r.develop, `should be ${DEV()}`);
  if (uat && mrsOf(M, uat.name, UAT()).length) checks.push(['MR from the task branch straight into ', code(UAT()), ' — it must go into the epic.']);
  if (mrsOf(M, epic.name, UAT()).filter((m) => m.state === 'opened').length > 1) checks.push(['More than one open MR ', code(`${epic.name} → ${UAT()}`), ' — keep exactly one.']);
  if (uat && mrsOf(M, uat.name).some((m) => m.target.startsWith('epic/') && m.target !== epic.name)) checks.push(['The task MR targets a different epic than ', code(epic.name), '.']);
  if (r.otherBranches?.length) checks.push([`Other branches name ${key} outside the flow: `, r.otherBranches.map(code)]);
  return checks;
}
