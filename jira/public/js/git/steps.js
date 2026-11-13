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

function stageModel(issue, f, r, M, redraw) {
  const key = issue.key;
  const repo = r.repo;
  const label = repoLabel(repo);
  const { epic, uat } = r;
  const dev = r.develop;
  const commits = r.commits || [];
  const title = commits[0]?.subject || `${key}: ${issue.summary}`;
  const devName = dev?.name || (uat ? toDevName(uat.name) : `feature/${key}-${slugify(issue.summary)}-${DEV()}`);
  const desc = mrDescription(key, epic.name);

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
        chips: [mrChip(m), pipeChip(pipeOf(repo, m.iid), `MR !${m.iid}`), ...mrFacts(sansConflict({ ...m, comments: 0 }))],
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

  // The formula. C = the ticket's commits in this repo, minus a commit reverted later and its revert. Each stage is
  // read from where C is — never from which branches or MRs exist (those only say how to reach the next stage):
  //   Code  : C written and pushed — on a task branch, or (against the rule, but done) straight on the epic
  //   Epic  : every c of C on the epic                  ← cherry-pick -x from the task branch
  //   uat   : every c of C in uat                       ← the one epic → uat MR          (needs Epic)
  //   dev   : every c of C in develop                   ← cherry-pick -x onto -develop → MR (needs Epic)
  // A stage is "done" only from C; a merged MR counts only when C can't be matched (squash) and develop wasn't rewritten.
  const sync = uat?.sync || {};
  const direct = !uat && !!r.onEpicDirectly; // no task branch: the commits were made on the epic itself
  const dirtyHere = !!uat && r.current === uat.name && r.dirty > 0;
  const codeDone = (!!uat && commits.length > 0 && !!uat.remote && !(sync.onlyA > 0) && !(sync.onlyB > 0)) || direct;
  const epicC = commits.filter((c) => !c.skipEpic);
  const inEpic = epicC.length > 0 && epicC.every((c) => c.inEpic);
  const inUat = commits.length > 0 && commits.every((c) => c.inUat);
  // A commit reverted later on the branch and its revert cancel out: never offered for a pick.
  const devCommits = commits.filter((c) => !c.skipDev);
  const devSkipped = commits.filter((c) => c.skipDev);
  // A merged MR into develop doesn't count once develop was rewritten after it (the merge is gone with the old develop).
  const inDev = (devCommits.length > 0 && devCommits.every((c) => c.inDevelop)) || (!!mergedMr(dev?.name, DEV()) && !(dev?.staleBase > 0));
  const missing = devCommits.filter((c) => !c.picked);
  const skippedStep = (list, field) =>
    list.length > 0 && {
      state: 'na',
      text: `${list.length} commit(s) left out — reverted later on the branch (work redone), or the revert itself`,
      chips: list.map((c) => gitChip(`${c.short} · ${skipText(c[field])}`, '', c.subject)),
    };
  const taskMr = uat && openMr(uat.name, epic.name);
  // The task reaches the epic by cherry-pick, so a "merge" conflict of the whole branch with the epic only matters
  // while some commit still has to go there (once all are on the epic, the branch's own copies always differ).
  const epicConflict = uat && commits.some((c) => !c.inEpic && !c.skipEpic) && conflictOf(taskMr, uat.conflictEpic);

  function codeCell() {
    const d = panel('code', uat?.name || epic.name);
    if (direct) {
      // The work is done and on the epic: nothing to start. The rule breach is a flow warning, not a next step.
      d.steps.push({ state: 'done', text: `${commits.length} ${key} commit(s) on ${epic.name}` });
      d.steps.push({ state: 'warn', text: `Committed straight onto the epic, without a -${UAT()} task branch (the rule: task branch → cherry-pick -x onto the epic)` });
      d.commits = { label: `${key} commits (oldest first)`, items: commits.map((c) => ({ short: c.short, subject: c.subject })) };
      d.more.push(act('Start a task branch for the next change…', () => startTaskPop(issue, { repos: [repo] }), { icon: 'branch' }));
      return { state: 'done', text: `${commits.length} commit(s)`, sub: 'on the epic · no task branch', detail: d };
    }
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

  // Epic panel: the task reaches the epic by cherry-pick (pick-epic action), not by an MR task → epic.
  // Shows: whether the task's commits are on the epic (git cherry check), conflicts, and the pick button.
  function epicCell() {
    const d = panel('into the epic', uat ? `${uat.name} → ${epic.name}` : epic.name);
    if (direct) {
      d.steps.push({ state: 'done', text: `All ${epicC.length} commit(s) are on the epic` });
      return { state: 'done', text: 'On the epic', sub: 'committed directly', detail: d };
    }
    if (!uat) return { state: 'na', text: '—', sub: 'after a branch', detail: { ...d, note: 'Start a task branch first.' } };
    const m = taskMr; // legacy MR task → epic, if one exists
    const c = epicConflict;
    const notInEpic = commits.filter((c) => !c.inEpic && !c.skipEpic);
    const allIn = commits.length > 0 && notInEpic.length === 0;
    
    if (allIn) d.steps.push({ state: 'done', text: `All ${commits.length} commit(s) are on the epic` });
    else if (notInEpic.length) d.steps.push({ state: 'wait', text: `${notInEpic.length} commit(s) not on the epic yet` });
    if (c) d.steps.push({ state: 'warn', text: 'Conflicts with the epic', chips: [conflictChip(c, 'epic')] });
    if (!allIn && uat.behindEpic > 0) d.steps.push({ state: 'todo', text: `${uat.behindEpic} new commit(s) on the epic since the branch` });
    if (!M?.byBranch) d.more.push(listAct(uat.name));
    d.more.push(undoAct(repo, uat));

    if (c) {
      d.primary = rebaseTaskAct(repo, f.epic, uat);
      d.secondary = [openAct(m)].filter(Boolean);
      return {
        state: 'warn',
        text: 'Conflict',
        sub: `${c.files.length} file(s)`,
        title: `${uat.name} conflicts with the epic`,
        why: `Merging into ${epic.name} would conflict${conflictFiles(c)}. Rebase, resolve in Cursor, Continue — it pushes (a backup is kept).`,
        detail: d,
      };
    }
    if (allIn) {
      if (m) d.secondary = [openAct(m), m.open && closeAct(repo, m, 'Close the legacy task → epic MR')].filter(Boolean);
      return { state: 'done', text: 'On the epic', sub: m?.open ? `MR !${m.iid} still open` : '', detail: d };
    }
    if (!codeDone) return { state: 'na', text: 'After push', sub: '', detail: { ...d, note: 'Push the branch first.' } };
    if (uat.behindEpic > 0) {
      d.primary = rebaseTaskAct(repo, f.epic, uat);
      if (m) d.secondary = [openAct(m)];
      return { state: 'todo', text: 'Epic moved on', sub: `${uat.behindEpic} new on the epic`, title: 'Epic moved on — rebase before the pick', why: `${uat.behindEpic} new commit(s) on ${epic.name}. Rebase keeps the pick clean (a backup is kept).`, detail: d };
    }
    // The pick button is added by withEpicPick, which also checks for conflicts.
    if (m?.open) d.secondary = [openAct(m)];
    return { state: 'todo', text: 'Ready to pick', sub: `${notInEpic.length} to cherry-pick`, title: 'Ready to cherry-pick onto the epic', why: `${notInEpic.length} commit(s) to pick onto ${epic.name}.`, detail: d };
  }

  function uatCell() {
    const m = openMr(epic.name, UAT());
    const d = panel(`into ${UAT()}`, `${epic.name} → ${UAT()} (one MR per epic)`);
    d.steps.push(...mrSteps(epic.name, UAT(), UAT()));
    if (epic.mergedToUat) d.steps.push({ state: 'done', text: `Epic merged into ${UAT()}`, chips: [gitChip(epic.mergedToUat.sha, 'ok', epic.mergedToUat.subject)] });
    if (epic.pending > 0) d.steps.push({ state: 'wait', text: `${epic.pending} commit(s) of the epic not in ${UAT()} yet` });
    if (epic.behindUat > 0) d.steps.push({ state: 'na', text: `The epic is ${epic.behindUat} commit(s) behind ${UAT()}`, chips: [gitChip('fine unless its MR conflicts')] });
    // Behind uat is normal (uat keeps moving) and the rule says never rebase the epic: the escape hatch is only offered
    // when the epic → uat MR actually conflicts and the lead may decide on a rebase.
    const epicMrConflict = m && conflictOf(m, epic.conflictUat);
    d.more.push(epicMrConflict && rebaseEpicAct(repo, f.epic), undoAct(repo, epic));

    if (!inEpic) return { state: 'na', text: 'After the epic', sub: 'via the epic MR', detail: { ...d, note: `Tasks go up to ${UAT()} with their epic’s MR.` } };
    if (inUat) return { state: 'done', text: `In ${UAT()}`, sub: epic.mergedToUat ? fmtDate(epic.mergedToUat.date) : '', detail: d };
    const c = conflictOf(m, epic.conflictUat);
    if (c) {
      // Team rule: no rebase / force-push of the epic — the lead decides; it is resolved on the epic → uat MR.
      d.secondary = [openAct(m)].filter(Boolean);
      d.note = EPIC_CONFLICT_WHY();
      d.steps.push({ state: 'warn', text: `The epic conflicts with ${UAT()}`, chips: [conflictChip(c, UAT())] });
      // Before the epic MR exists this is only a heads-up: there is nothing to resolve on yet.
      if (!m) return { state: 'warn', text: 'Would conflict', sub: `with ${UAT()} · no MR yet`, detail: d };
      return { state: 'warn', text: 'Epic MR conflicts', sub: `!${m.iid} · ${UAT()}`, title: `Epic MR !${m.iid} conflicts with ${UAT()}${conflictFiles(c)}`, why: EPIC_CONFLICT_WHY(), secondary: d.secondary, detail: d };
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

    const total = devCommits.length;
    d.steps.push({ state: missing.length ? 'todo' : 'done', text: `${total - missing.length} / ${total} commit(s) cherry-picked` });
    if (dev) d.steps.push({ state: dev.remote && !(dev.sync?.onlyA > 0) ? 'done' : 'todo', text: 'Develop branch', chips: where(dev) });
    const skipped = skippedStep(devSkipped, 'skipDev');
    if (skipped) d.steps.push(skipped);
    d.steps.push(...mrSteps(dev?.name, DEV(), DEV()));
    d.more.push(undoAct(repo, dev));

    // develop was rewritten after the -develop branch was cut: rebuild it before anything else (a pick or an MR
    // from it would bring back the old develop's merges).
    if (dev?.staleBase > 0 && !inDev) {
      d.primary = rebuildDevAct(repo, dev.name, dev.staleBase);
      d.steps.push({ state: 'warn', text: `Cut from an old ${DEV()}: ${dev.staleBase} merge commit(s) that ${DEV()} no longer has`, chips: [gitChip(`${DEV()} was rewritten`, 'warn')] });
      return {
        state: 'warn',
        text: 'Old base',
        sub: `${DEV()} was rewritten`,
        title: `${dev.name} is based on an old ${DEV()}`,
        why: `${DEV()} was reset / force-pushed after the branch was cut: its MR would bring back ${dev.staleBase} old merge(s). Rebuild it from ${DEV()} (only its own commits are kept; a backup is kept).`,
        detail: d,
      };
    }

    // Just cherry-picked onto the epic from the epic panel: those commits come pre-ticked (once; then the user's ticks).
    const scope = `${repo}:${key}:dev`;
    const preset = gitState.devPreset.get(`${key}:${repo}`);
    if (preset) {
      gitState.devPreset.delete(`${key}:${repo}`);
      if (missing.some((c) => preset.includes(c.sha))) gitState.unticked.set(scope, new Set(missing.filter((c) => !preset.includes(c.sha)).map((c) => c.sha)));
    }
    let pick = null;
    if (missing.length) {
      const ticked = tickedOf(scope, missing);
      const boxes = missing.map((c) => tickBox(scope, c, redraw));
      const target = h('input', { class: 'gin mono', value: gitState.devTargets.get(`${repo}:${key}`) || devName, spellcheck: 'false', 'aria-label': `${DEV()} branch`, onChange: (e) => gitState.devTargets.set(`${repo}:${key}`, e.target.value.trim()) });
      d.commits = { label: `Not on ${DEV()} yet (oldest first, merge commits excluded)`, items: missing.map((c, i) => ({ short: c.short, subject: c.subject, box: boxes[i] })), target, targetHint: dev ? '' : `created from ${DEV()}` };
      pick = act(`Cherry-pick ${ticked.length === missing.length ? missing.length : `${ticked.length} of ${missing.length}`} → ${DEV()}`, () => {
        const list = tickedOf(scope, missing);
        if (!list.length) return toast('No commit selected', 'error');
        const branch = target.value.trim();
        // The rule picks the epic's SHAs (then -x points at the epic); a commit not on the epic yet goes from the task branch.
        const shas = list.map((c) => c.epicSha || c.sha);
        gitAction(
          { action: 'pick-develop', repo, branch, shas },
          `Cherry-pick -x onto ${branch}${dev ? '' : ` (created from ${DEV()})`} and push it:\n\n${list.map((c) => `${(c.epicSha || c.sha).slice(0, 9)} ${c.subject}${c.epicSha ? '' : '  (from the task branch — not on the epic yet)'}`).join('\n')}`,
        );
      });
    }

    if (!missing.length) {
      d.steps[0].text += ` — nothing left to cherry-pick${inDev ? '' : ` (they wait in ${dev?.name || `the -${DEV()} branch`})`}`;
      d.commits = { label: inDev ? `In ${DEV()}` : `On the -${DEV()} branch`, items: devCommits.map((c) => ({ short: c.short, subject: c.subject })) };
    }
    if (inDev) return { state: 'done', text: `In ${DEV()}`, sub: '', detail: d };
    if (!inEpic) {
      if (pick) d.more.unshift({ ...pick, label: `${pick.label} now (before the epic)` });
      return { state: 'na', text: 'After the epic', sub: `${total - missing.length}/${total} picked`, detail: d };
    }
    if (pick) {
      d.primary = pick;
      return {
        state: 'todo',
        text: `${total - missing.length} / ${total} picked`,
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

  // No merge rights on the epic MR: cherry-pick the chosen commits of the task straight onto the epic (fast-forward
  // push — the epic is shared). Once done, the develop panel opens with those same commits ticked.
  function withEpicPick(cell) {
    const todo = uat ? commits.filter((c) => !c.inEpic && !c.skipEpic) : [];
    const d = cell.detail;
    const skipped = uat && skippedStep(commits.filter((c) => c.skipEpic), 'skipEpic');
    if (skipped) d.steps.push(skipped);
    if (!todo.length) {
      // Say why there is nothing to tick, rather than leave the pick missing without a word.
      if (uat && commits.length) {
        d.commits = { label: `All ${commits.length} on the epic — nothing to cherry-pick`, items: commits.map((c) => ({ short: c.short, subject: c.subject })) };
      }
      return cell;
    }
    const scope = `${repo}:${key}:epic`;
    const n = tickedOf(scope, todo).length;
    const boxes = todo.map((c) => tickBox(scope, c, redraw));
    d.commits = { label: `Not on the epic yet (oldest first)`, items: todo.map((c, i) => ({ short: c.short, subject: c.subject, box: boxes[i] })) };
    const pick = act(
      `Cherry-pick ${n === todo.length ? n : `${n} of ${todo.length}`} → epic`,
      async () => {
        const list = tickedOf(scope, todo);
        if (!list.length) return toast('No commit selected', 'error');
        const shas = list.map((c) => c.sha);
        const job = await gitAction(
          { action: 'pick-epic', repo, epic: f.epic, branch: uat.name, shas },
          `Cherry-pick -x ${shas.length} commit(s) of ${uat.name} onto epic/${f.epic} and push (fast-forward only):\n\n${list.map((c) => `${c.short} ${c.subject}`).join('\n')}\n\nThe log ends with git cherry: no "+" line = fully on the epic.`,
        );
        if (job?.status === 'ok') {
          gitState.sel.set(key, `${repo}:dev`);
          gitState.devPreset.set(`${key}:${repo}`, shas);
        }
      },
      { icon: 'commit', title: `Cherry-pick the ticked commits of ${uat.name} onto epic/${f.epic}` },
    );
    // While the task conflicts with the epic the pick would conflict too: keep it out of the way.
    if (epicConflict) d.more.unshift(pick);
    else d.primary = pick;
    return cell;
  }

  const cells = { code: codeCell(), epic: withEpicPick(epicCell()), uat: uatCell(), dev: devCell() };
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

  // Every branch of the ticket in this repo, with the MR whose pipeline is that branch's CI (the team's CI runs on MR
  // events only): the task branch has none (it goes to the epic by cherry-pick), -develop → develop, the epic → uat.
  const latestMr = (src, tgt) => openMr(src, tgt) || mrs(src, tgt)[0] || null;
  const branches = [
    uat && { name: uat.name, role: 'task', mr: null },
    dev && { name: dev.name, role: DEV(), mr: latestMr(dev.name, DEV()) },
    { name: epic.name, role: 'epic', mr: latestMr(epic.name, UAT()) },
  ].filter(Boolean);

  return { repo, label, r, branch, branchChips, branches, cells };
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
  if (r.onEpicDirectly) checks.push([`${key} was committed straight onto `, code(epic.name), ` — no -${UAT()} task branch. Next time: task branch → cherry-pick -x onto the epic.`]);
  if (r.develop?.staleBase > 0) checks.push([code(r.develop.name), ` was cut from a ${DEV()} that has since been rewritten (${r.develop.staleBase} old merges on it).`]);
  foreign(uat, 'should be the epic');
  foreign(r.develop, `should be ${DEV()}`);
  if (uat && mrsOf(M, uat.name, UAT()).length) checks.push(['MR from the task branch straight into ', code(UAT()), ' — it must go into the epic.']);
  if (mrsOf(M, epic.name, UAT()).filter((m) => m.state === 'opened').length > 1) checks.push(['More than one open MR ', code(`${epic.name} → ${UAT()}`), ' — keep exactly one.']);
  if (uat && mrsOf(M, uat.name).some((m) => m.target.startsWith('epic/') && m.target !== epic.name)) checks.push(['The task MR targets a different epic than ', code(epic.name), '.']);
  if (r.otherBranches?.length) checks.push([`Other branches name ${key} outside the flow: `, r.otherBranches.map(code)]);
  return checks;
}
