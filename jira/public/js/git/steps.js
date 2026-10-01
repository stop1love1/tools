'use strict';

// Issue drawer: rule checks and the full step-by-step list.

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

function flowSteps(issue, f, r, M) {
  const key = issue.key;
  const repo = r.repo;
  const epic = r.epic;
  const uat = r.uat;
  const commits = r.commits || [];
  const title = commits[0]?.subject || `${key}: ${issue.summary}`;
  const devName = r.develop?.name || (uat ? toDevName(uat.name) : null);
  const desc = mrDescription(key, epic.name, devName);
  const steps = [];
  const step = (status, name, body, actions) =>
    steps.push(
      h(
        'li',
        { class: `gstep s-${status}` },
        h('span', { class: 'gstep-dot' }, status === 'done' ? icon('check') : ''),
        h('div', { class: 'gstep-body' }, h('div', { class: 'gstep-name' }, name), body),
        actions && h('div', { class: 'gstep-act' }, actions),
      ),
    );
  const note = (...kids) => h('div', { class: 'gstep-note' }, ...kids);
  const undo = (b) =>
    b?.backups?.length > 0 &&
    actBtn('Undo', () => gitAction({ action: 'undo', repo, branch: b.name }, `Reset ${b.name} to its backup from ${fmtDate(b.backups[0].at)}?`), {
      iconName: 'undo',
      iconOnly: true,
      title: `Undo: back to ${b.backups[0].sha} (backed up ${rel(b.backups[0].at)})`,
    });
  // Push, or force-push with lease once local and origin diverged (after a rebase or an undo).
  const pushBtn = (b, primary) => {
    if (!b || (b.remote && !(b.sync?.onlyA > 0))) return null;
    if (b.sync?.onlyB > 0) return forcePushBtn(repo, b.name);
    return actBtn('Push', () => gitAction({ action: 'push', repo, branch: b.name }), { primary, iconName: 'upload' });
  };
  const where = (b) => [
    ...mrsOf(M, b.name).slice(0, 2).map(mrChip),
    b.local ? gitChip('local') : null,
    b.remote ? gitChip('origin', 'ok') : gitChip('not pushed', 'warn'),
    b.name === r.current ? gitChip('checked out', 'accent') : b.worktree ? gitChip('worktree', '', b.worktree) : null,
  ];

  // An open MR for source → target is the thing to go to; otherwise offer to create one.
  const mrButtons = (source, target, primary) => {
    const list = mrsOf(M, source, target);
    const open = list.find((m) => m.state === 'opened');
    if (open) return [linkBtn(open.url, `Open !${open.iid}`, primary)];
    return [linkBtn(mrUrl(r.web, source, target, title, desc), `New MR → ${target === epic.name ? 'epic' : target}`, primary), iconLink(mrListUrl(r.web, source), 'mr', 'MRs of this branch on GitLab')];
  };
  const mrNote = (source, target) => mrsOf(M, source, target).slice(0, 3).map(mrChip);

  // 1. Epic
  if (!epic.remote) {
    step('todo', ['Epic ', code(epic.name)], note('Not on origin yet. Created off ', code(UAT()), ', one per Jira Epic.'), [
      actBtn('Create epic', () => gitAction({ action: 'ensure-epic', repo, epic: f.epic }, `Create ${epic.name} from origin/${UAT()} and push it?`), { primary: true }),
    ]);
  } else {
    const behind = epic.behindUat > 0;
    step(
      behind || epic.conflictUat ? 'warn' : 'done',
      ['Epic ', code(epic.name)],
      note(
        gitChip(`${epic.pending} commit${epic.pending === 1 ? '' : 's'} not in ${UAT()}`, epic.pending ? '' : 'ok'),
        behind && gitChip(`${epic.behindUat} behind ${UAT()}`, 'warn', `Rebase the epic onto ${UAT()} (--rebase-merges) when it has conflicts with ${UAT()}`),
        conflictChip(epic.conflictUat, UAT()),
        epic.mergedToUat && gitChip(`merged to ${UAT()} ${epic.mergedToUat.sha}`, 'ok', epic.mergedToUat.subject),
      ),
      [behind && rebaseEpicBtn(repo, f.epic), undo(epic)],
    );
  }

  // 2. Task branch
  if (uat) {
    step(
      'done',
      ['Task branch ', code(uat.name)],
      note(where(uat), uat.others?.length > 0 && gitChip(`+${uat.others.length} other`, '', `${uat.others.join('\n')}\n\nAll of them: the branch list above`)),
      uat.name !== r.current &&
        !uat.worktree &&
        actBtn('Checkout', () => checkoutBranch(repo, uat.name, r.dirty), { title: `Switch ${r.dir} to this branch` }),
    );
  } else {
    step(
      'todo',
      'Start a branch',
      note('No ', code(`-${UAT()}`), ` branch for ${key} yet. Created off `, code(epic.name), epic.remote ? '' : ` (made from ${UAT()} first)`, ', then checked out.'),
      actBtn('Start…', () => startTaskPop(issue, { repos: [repo] }), { primary: true, iconName: 'branch' }),
    );
  }

  if (uat) {
    // 3. Commit, keep up with the epic, push
    const s = uat.sync;
    const toPush = !uat.remote || s?.onlyA > 0;
    // Once merged the epic moves on without it — unless newer commits on the branch conflict with it.
    const behindEpic = (uat.behindEpic > 0 && !uat.mergedToEpic) || !!uat.conflictEpic;
    const dirtyHere = uat.name === r.current && r.dirty > 0;
    step(
      uat.conflictEpic ? 'warn' : dirtyHere || toPush || behindEpic ? 'todo' : 'done',
      'Commit · rebase onto epic · push',
      note(
        dirtyHere && gitChip(`${r.dirty} uncommitted`, 'warn'),
        commits.length > 0 && gitChip(`${commits.length} ${key} commit${commits.length > 1 ? 's' : ''}`),
        !uat.remote ? gitChip('not pushed', 'warn') : s?.onlyA > 0 && gitChip(`${s.onlyA} to push`, 'warn'),
        s?.onlyB > 0 && gitChip(`${s.onlyB} only on origin`, 'warn', 'Local and origin diverged'),
        uat.behindEpic > 0 && behindEpic && gitChip(`${uat.behindEpic} behind epic`, 'warn'),
        conflictChip(uat.conflictEpic, 'epic'),
        !dirtyHere && !toPush && !behindEpic && gitChip('up to date with epic & origin', 'ok'),
      ),
      [
        dirtyHere && actBtn('Commit…', () => openCommitDialog(repo), { primary: true }),
        behindEpic
          ? actBtn(uat.remote ? 'Rebase & force-push' : 'Rebase & push', () => gitAction({ action: 'sync-task', repo, epic: f.epic, branch: uat.name }), {
              primary: !dirtyHere,
              title: `Rebase ${uat.name} onto origin/${epic.name} and ${uat.remote ? 'force-push (with lease)' : 'push'} — a backup is kept (Undo)`,
            })
          : toPush && pushBtn(uat, !dirtyHere),
        undo(uat),
      ],
    );

    // 4. MR task → epic
    if (uat.mergedToEpic) {
      step('done', 'MR task → epic', note(mrNote(uat.name, epic.name), gitChip(`merged ${uat.mergedToEpic.sha}`, 'ok', uat.mergedToEpic.subject), ' ', rel(uat.mergedToEpic.at)), iconLink(mrListUrl(r.web, uat.name), 'mr', 'MRs of this branch on GitLab'));
    } else {
      const skipped = uat.onEpicWithoutMerge > 0;
      step(
        skipped ? 'warn' : 'todo',
        'MR task → epic',
        note(
          mrNote(uat.name, epic.name),
          conflictChip(uat.conflictEpic, 'epic'),
          skipped
            ? [gitChip(`${uat.onEpicWithoutMerge} commit(s) already on the epic without a merge commit`, 'warn'), ' — this task cannot be reverted with one ', code('git revert -m 1'), '.']
            : uat.remote
              ? 'Merge with “Create merge commit” (1 merge commit per task). Never merge locally into the epic.'
              : 'Push the branch first.',
        ),
        uat.remote && [...mrButtons(uat.name, epic.name, !skipped && uat.aheadEpic > 0), pickEpicBtn(repo, f.epic, uat.name, commits)].filter(Boolean),
      );
    }
  }

  // 5. MR epic → uat (exactly one per epic per repo)
  if (epic.remote) {
    const done = epic.mergedToUat && !epic.pending;
    step(
      done ? 'done' : epic.pending ? 'todo' : 'na',
      `MR epic → ${UAT()}`,
      note(
        mrNote(epic.name, UAT()),
        conflictChip(epic.conflictUat, UAT()),
        done ? gitChip(`everything on the epic is in ${UAT()}`, 'ok') : 'Only ONE MR per epic per repo; tasks merged into the epic later show up in it.',
      ),
      !done &&
        (M?.byBranch
          ? mrButtons(epic.name, UAT(), epic.pending > 0)
          : [linkBtn(mrListUrl(r.web, epic.name), 'Existing MR', epic.pending > 0), linkBtn(mrUrl(r.web, epic.name, UAT(), title, desc), `New MR → ${UAT()}`)]),
    );
  }

  // 6. Cherry-pick to develop
  const missing = commits.filter((c) => !c.picked);
  const dev = r.develop;
  if (!commits.length) {
    step('na', `Cherry-pick to ${DEV()}`, note(`No commits starting with ${key}: yet.`));
  } else if (!missing.length) {
    step(
      'done',
      ['Develop branch ', dev ? code(dev.name) : ''],
      note(dev && where(dev), gitChip(`all ${commits.length} commit${commits.length > 1 ? 's' : ''} picked`, 'ok')),
      [pushBtn(dev, true), undo(dev)],
    );
  } else {
    const boxes = missing.map((c) => h('input', { type: 'checkbox', checked: true, value: c.sha }));
    const target = h('input', { class: 'gin mono', value: devName || `feature/${key}-${slugify(issue.summary)}-${DEV()}`, spellcheck: 'false', 'aria-label': 'Develop branch' });
    step(
      'todo',
      `Cherry-pick to ${DEV()}`,
      h(
        'div',
        null,
        note(`${missing.length} of ${commits.length} commits not on ${DEV()} yet (oldest first, merge commits excluded):`),
        h('ul', { class: 'gcommits' }, missing.map((c, i) => h('li', null, h('label', null, boxes[i], h('span', { class: 'mono muted' }, c.short), h('span', { class: 'gsubj', title: c.subject }, c.subject))))),
        dev ? note('Into ', where(dev)) : note('Creates the branch off ', code(`origin/${DEV()}`), ':'),
        target,
      ),
      [
        pushBtn(dev, false),
        actBtn(
          `Cherry-pick → ${DEV()}`,
          () => {
            const shas = boxes.filter((b) => b.checked).map((b) => b.value);
            if (!shas.length) return toast('No commit selected', 'error');
            gitAction({ action: 'pick-develop', repo, branch: target.value.trim(), shas }, `Cherry-pick ${shas.length} commit(s) onto ${target.value.trim()} and push it?`);
          },
          { primary: true },
        ),
        undo(dev),
      ],
    );
  }

  // 7. MR → develop (same title + description as the uat one)
  if (commits.length) {
    const inDevelop = commits.every((c) => c.inDevelop) || (dev && mrsOf(M, dev.name, DEV()).some((m) => m.state === 'merged'));
    const devConflict = !inDevelop && dev && conflictOf(mrsOf(M, dev.name, DEV()).find((m) => m.state === 'opened'), dev.conflictDevelop);
    step(
      inDevelop ? 'done' : devConflict ? 'warn' : dev?.remote ? 'todo' : 'na',
      `MR → ${DEV()}`,
      note(
        dev && mrNote(dev.name, DEV()),
        conflictChip(devConflict, DEV()),
        inDevelop ? gitChip(`all commits are in ${DEV()}`, 'ok') : dev?.remote ? `Title and description identical to the ${UAT()} MR.` : `Push the ${DEV()} branch first.`,
      ),
      !inDevelop && [devConflict && syncDevBtn(repo, dev.name), dev?.remote && mrButtons(dev.name, DEV(), !devConflict)],
    );
  }

  return h(
    'div',
    null,
    h('ol', { class: 'gsteps' }, steps),
    h(
      'div',
      { class: 'muted small gfoot' },
      r.fetchedAt ? `Remote state from fetch ${rel(new Date(r.fetchedAt).toISOString())} · ` : '',
      h('button', { class: 'link-btn', onClick: () => gitAction({ action: 'fetch', repo }) }, 'Fetch now'),
      ' · ',
      !M ? 'loading MR status…' : M.error ? h('span', { class: 'warn-text', title: M.error }, `MR status unavailable: ${M.error}`) : 'MR status from GitLab',
    ),
  );
}
