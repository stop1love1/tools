'use strict';

// Issue drawer: where a ticket stands in the flow, per repo (summary card).

// ---------------------------------------------------------------------------
// Issue drawer: where this ticket stands in the flow, per repo

function gitFlowBlock(issue, detail) {
  if (/epic/i.test(issue.type?.name || '')) return epicBlock(issue);
  if (detail) gitState.jiraMrs.set(issue.key, detail.links.filter((l) => l.kind === 'mr'));
  const box = h(
    'section',
    { class: 'block git-flow', id: 'git-flow' },
    h('h3', null, icon('branch'), 'Git flow'),
    h('div', { class: 'muted small' }, 'Reading git status…'),
  );
  getFlow(issue.key).then(
    (f) => fillFlow(box, issue, f),
    (e) => box.replaceChildren(box.firstChild, h('div', { class: 'error-box' }, e.message)),
  );
  return box;
}

function fillFlow(box, issue, f) {
  const repos = gitRepos().filter((r) => f.repos[r]);
  const used = repos.filter((r) => f.repos[r].uat || f.repos[r].develop || f.repos[r].commits?.length);

  const editEpic = async () => {
    const v = await promptPop(`Epic branch for ${issue.key}`, {
      value: epicOverride(issue.key) || f.epic,
      prefix: 'epic/',
      hint: 'Leave empty to use the parent Epic on Jira (or the ticket itself).',
      okLabel: 'Use epic',
      validate: (x) => (!x.trim() || ISSUE_KEY_RE.test(x.trim().toUpperCase()) ? '' : `Expected a key like ${KEY()}-4718`),
    });
    if (v == null) return;
    const all = LS.get('gitEpic', {});
    const next = v.trim().toUpperCase();
    if (next && next !== f.epic) all[issue.key] = next;
    else delete all[issue.key];
    LS.set('gitEpic', all);
    refreshGit();
  };

  const head = h(
    'h3',
    null,
    icon('branch'),
    'Git',
    h('span', { class: 'spacer' }),
    h('button', { class: 'gchip link', title: 'The epic branch this ticket goes into — click to change', onClick: editEpic }, `epic/${f.epic}`, epicOverride(issue.key) ? ' (manual)' : ''),
    h('button', { class: 'icon-btn sm', title: 'Reload git status', onClick: refreshGit }, icon('refresh')),
  );

  // Jira's parent Epic may not be the epic branch the work actually went into.
  const elsewhere = [...new Set(repos.flatMap((x) => f.repos[x].epicsWithTicket || []))].filter((e) => e !== f.epic);
  const onCurrent = repos.some((x) => (f.repos[x].epicsWithTicket || []).includes(f.epic));
  const hint =
    elsewhere.length > 0 &&
    !onCurrent &&
    h(
      'div',
      { class: 'gconflict ghint' },
      h('div', null, `${issue.key} commits are on `, elsewhere.map((e) => code(`epic/${e}`)), ` but not on epic/${f.epic}.`),
      h(
        'div',
        { class: 'gstep-act' },
        elsewhere.map((e) =>
          actBtn(`Use epic/${e}`, () => {
            LS.set('gitEpic', { ...LS.get('gitEpic', {}), [issue.key]: e });
            refreshGit();
          }),
        ),
      ),
    );

  const body = used.length
    ? used.map((repo) => repoCard2(issue, f, f.repos[repo], gitState.mrData[repo], repos.filter((x) => !used.includes(x))))
    : [startPanel(issue, f)];
  box.replaceChildren(...[head, hint, ...body].filter(Boolean));
  // MR states arrive later (GitLab API); redraw once they're in.
  for (const repo of used) {
    if (!gitState.mrData[repo] || !gitState.mrs.has(repo)) getMrs(repo).then(() => box.isConnected && fillFlow(box, issue, f));
  }
}

// Nothing in git yet: one button that does the whole setup the rule asks for.
function startPanel(issue, f) {
  const epicReady = gitRepos().some((r) => f.repos[r]?.epic?.remote);
  const other = gitRepos().flatMap((r) => (f.repos[r]?.otherBranches || []).map((b) => [r, b]));
  return h(
    'div',
    { class: 'gsum gsum-start' },
    h('div', { class: 'gsum-headline' }, 'Not started in git yet'),
    other.length > 0 &&
      h('div', { class: 'gstep-note' }, gitChip('check first', 'warn'), `Branches naming ${issue.key} outside the flow: `, other.map(([r, b]) => [code(b), h('span', { class: 'muted small' }, ` (${repoLabel(r)}) `)])),
    h(
      'ol',
      { class: 'gsum-plan' },
      h('li', null, epicReady ? ['Use ', code(`epic/${f.epic}`)] : ['Create ', code(`epic/${f.epic}`), ` from ${UAT()}`]),
      h('li', null, 'Create ', code(`feature/${issue.key}-<short-description>-${UAT()}`), ' from the epic'),
      h('li', null, 'Stash your unfinished work and check the new branch out'),
    ),
    h('div', { class: 'gstep-act' }, actBtn('Start…', () => startTaskPop(issue), { primary: true, iconName: 'branch' }), actBtn('Start with Claude', () => startWithClaude(issue), { iconName: 'ai' })),
  );
}

// Plain-language state of one repo: a headline, 4 milestones and the next action(s).
function repoStatus(issue, f, r, M) {
  const key = issue.key;
  const repo = r.repo;
  const epic = r.epic;
  const uat = r.uat;
  const dev = r.develop;
  const commits = r.commits || [];
  const title = commits[0]?.subject || `${key}: ${issue.summary}`;
  const devName = dev?.name || (uat ? toDevName(uat.name) : `feature/${key}-${slugify(issue.summary)}-${DEV()}`);
  const desc = mrDescription(key, epic.name, devName);
  const mrs = (src, tgt) => (src ? mrsOf(M, src, tgt) : []);
  const openMr = (src, tgt) => mrs(src, tgt).find((m) => m.state === 'opened');
  const mergedMr = (src, tgt) => mrs(src, tgt).find((m) => m.state === 'merged');
  const newMr = (src, tgt, label, primary = true) => linkBtn(mrUrl(r.web, src, tgt, title, desc), label, primary);
  const openBtn = (m, primary = true) => linkBtn(m.url, `Open MR !${m.iid}`, primary);
  const push = (b, primary = true) =>
    b.sync?.onlyB > 0
      ? forcePushBtn(repo, b.name)
      : actBtn('Push', () => gitAction({ action: 'push', repo, branch: b.name }), { primary, iconName: 'upload' });

  // The task branch is the user's own and a backup is kept (Undo), so no confirm.
  const rebaseBtn = () =>
    actBtn('Rebase & push', () => gitAction({ action: 'sync-task', repo, epic: f.epic, branch: uat.name }), {
      primary: true,
      title: `Rebase ${uat.name} onto origin/${epic.name} and force-push it (with lease) — a backup is kept (Undo)`,
    });

  const pushed = !!uat?.remote && !(uat.sync?.onlyA > 0);
  const inEpic = !!uat?.mergedToEpic || !!mergedMr(uat?.name, epic.name) || uat?.onEpicWithoutMerge > 0;
  const inUat = commits.length > 0 && commits.every((c) => c.inUat);
  const inDev = (commits.length > 0 && commits.every((c) => c.inDevelop)) || !!mergedMr(dev?.name, DEV());
  const missing = commits.filter((c) => !c.picked);
  const milestones = [
    { label: 'Code', done: pushed && commits.length > 0 },
    { label: 'Epic', done: inEpic },
    { label: 'UAT', done: inUat },
    { label: 'Develop', done: inDev },
  ];

  const out = { milestones, tone: 'accent', lines: [], actions: [] };
  const dirtyHere = uat && r.current === uat.name && r.dirty > 0;

  if (!uat) {
    out.headline = commits.length ? `${commits.length} ${key} commit(s), but no ${key} -${UAT()} branch` : 'No task branch';
    out.detail = commits.length ? 'Commits went straight to another branch (not the flow: task branch → MR → epic).' : '';
    out.tone = 'warn';
    out.actions.push(actBtn('Start…', () => startTaskPop(issue, { repos: [repo] }), { primary: true, iconName: 'branch' }));
    return out;
  }
  if (dirtyHere) {
    out.headline = `Coding — ${r.dirty} uncommitted file(s)`;
    out.detail = `Commit as "${key}: <what changed, in English>".`;
    out.actions.push(actBtn('Commit…', () => openCommitDialog(repo), { primary: true }));
  } else if (!commits.length) {
    out.headline = 'Branch ready — no commits yet';
    out.detail = uat.name === r.current ? 'Checked out: start coding.' : 'Check it out to start coding.';
    if (uat.name !== r.current && !uat.worktree) out.actions.push(actBtn('Checkout', () => checkoutBranch(repo, uat.name, r.dirty), { primary: true }));
  } else if (conflictOf(openMr(uat.name, epic.name), uat.conflictEpic)) {
    // Before "push": the rebase pushes too, and pushing as is would only open a conflicting MR. Also when the task is
    // already in the epic: its newer commits need another MR.
    const m = openMr(uat.name, epic.name);
    const c = conflictOf(m, uat.conflictEpic);
    out.headline = m ? `MR !${m.iid} conflicts with the epic` : inEpic ? 'New commits conflict with the epic — rebase before the MR' : 'Conflicts with the epic — rebase before the MR';
    out.detail = `Merging into ${epic.name} would conflict${conflictFiles(c)}. Rebase onto the epic, resolve them in Cursor, Continue — it pushes (a backup is kept).`;
    out.tone = 'warn';
    out.conflict = conflictChip(c, 'epic');
    out.mr = sansConflict(m);
    out.actions.push(rebaseBtn());
    if (m) out.actions.push(openBtn(m, false));
  } else if (!uat.remote || uat.sync?.onlyA > 0) {
    out.headline = !uat.remote ? 'Not pushed yet' : `${uat.sync.onlyA} commit(s) not pushed`;
    out.detail = 'Push, then open the MR into the epic.';
    out.tone = 'warn';
    out.actions.push(push(uat));
  } else if (!inEpic && uat.behindEpic > 0) {
    out.headline = 'Epic moved on — rebase before the MR';
    out.detail = `${uat.behindEpic} new commit(s) on ${epic.name}. Rebasing keeps the MR clean (a backup is kept).`;
    out.tone = 'warn';
    out.actions.push(rebaseBtn());
    const m = openMr(uat.name, epic.name);
    if (m) out.actions.push(openBtn(m, false));
    out.mr = m;
  } else if (!inEpic) {
    const m = openMr(uat.name, epic.name);
    out.mr = m;
    out.headline = !m ? 'Ready for the MR into the epic' : !m.resolved ? `MR !${m.iid} has unresolved review threads` : m.comments ? `MR !${m.iid} in review` : `MR !${m.iid} waiting for review`;
    out.detail = m ? `${uat.name} → ${epic.name}` : `Merge it with “Create merge commit” (one merge commit per task).`;
    if (m && !m.resolved) out.tone = 'warn';
    out.actions.push(m ? openBtn(m) : newMr(uat.name, epic.name, 'Create MR → epic'));
    if (!M?.byBranch && !m) out.actions.push(iconLink(mrListUrl(r.web, uat.name), 'mr', 'MRs of this branch on GitLab'));
    // No merge rights on the epic MR: cherry-pick the task's own commits straight onto the epic instead.
    out.actions.push(pickEpicBtn(repo, f.epic, uat.name, commits, false));
  } else {
    // In the epic: two independent tracks left, uat (via the epic MR) and develop (cherry-pick + MR).
    // A task MR can still be open when its commits reached the epic another way — it still needs attention.
    const taskMr = openMr(uat.name, epic.name);
    if (taskMr) out.lines.push({ label: 'Epic', mr: taskMr, text: `task MR !${taskMr.iid} still open`, actions: [openBtn(taskMr, false)] });
    const noMerge = uat.onEpicWithoutMerge && !uat.mergedToEpic;
    out.headline = inUat && inDev ? `Done — in ${UAT()} and ${DEV()}` : noMerge ? 'On the epic' : 'Merged into the epic';
    out.note = noMerge ? 'Reached the epic without a task MR, so there is no merge commit to revert it with.' : null;
    out.tone = 'ok';

    if (inUat) out.lines.push({ label: 'UAT', ok: true, text: `In ${UAT()}` });
    else {
      const m = openMr(epic.name, UAT());
      const c = conflictOf(m, epic.conflictUat);
      out.lines.push({
        label: 'UAT',
        mr: sansConflict(m),
        conflict: conflictChip(c, UAT()),
        text: m ? `Epic MR !${m.iid}${m.draft ? ' (draft)' : ''}` : epic.pending > 0 ? `Waiting for the epic MR → ${UAT()}` : `Waiting for the epic to reach ${UAT()}`,
        actions: [
          c && rebaseEpicBtn(repo, f.epic, { iconOnly: false }),
          ...(m ? [openBtn(m, false)] : epic.pending > 0 ? [M?.byBranch ? newMr(epic.name, UAT(), `Create epic MR → ${UAT()}`, false) : iconLink(mrListUrl(r.web, epic.name), 'mr', 'MRs of the epic on GitLab')] : []),
        ],
      });
    }

    if (inDev) out.lines.push({ label: 'Develop', ok: true, text: `In ${DEV()}` });
    else if (missing.length) {
      out.lines.push({
        label: 'Develop',
        text: `${missing.length} of ${commits.length} commit(s) to cherry-pick`,
        actions: [
          actBtn(`Cherry-pick ${missing.length} → ${DEV()}`, () =>
            gitAction(
              { action: 'pick-develop', repo, branch: devName, shas: missing.map((c) => c.sha) },
              `Cherry-pick onto ${devName}${dev ? '' : ` (created from ${DEV()})`} and push it:\n\n${missing.map((c) => `${c.short} ${c.subject}`).join('\n')}`,
            ),
          ),
        ],
      });
    } else if (dev && (!dev.remote || dev.sync?.onlyA > 0)) {
      out.lines.push({ label: 'Develop', text: 'Picked · not pushed', actions: [push(dev, false)] });
    } else {
      const m = dev && openMr(dev.name, DEV());
      const c = dev && conflictOf(m, dev.conflictDevelop);
      out.lines.push({
        label: 'Develop',
        mr: sansConflict(m),
        conflict: conflictChip(c, DEV()),
        text: m ? `MR !${m.iid}${c ? '' : ' in review'}` : `Picked · needs an MR into ${DEV()}`,
        actions: [c && syncDevBtn(repo, dev.name), m ? openBtn(m, false) : dev ? newMr(dev.name, DEV(), `Create MR → ${DEV()}`, false) : null],
      });
    }
    if (out.lines.some((l) => l.conflict)) out.tone = 'warn';
  }
  return out;
}

function repoCard2(issue, f, r, M, missingRepos) {
  const repo = r.repo;
  const label = repoLabel(repo);
  if (r.error) return h('div', { class: 'gsum' }, h('div', { class: 'gsum-top' }, h('b', null, label)), h('div', { class: 'error-box' }, r.error));
  const st = repoStatus(issue, f, r, M);
  const branch = r.uat?.name || r.develop?.name;
  const checks = flowChecks(issue.key, r, M);
  const openAll = LS.get('gitAllSteps', false);

  return h(
    'div',
    { class: `gsum t-${st.tone}` },
    h(
      'div',
      { class: 'gsum-top' },
      h('b', null, label),
      branch && h('button', { class: 'gcode gbranch', title: `${branch}\nClick to copy`, onClick: () => copyText(branch, 'Branch name copied') }, branch),
      branch && branch === r.current && gitChip('checked out', 'accent'),
    ),
    (r.conflicts || []).map((c) =>
      h('div', { class: 'gconflict' }, h('div', null, h('b', null, `${c.op} stopped on a conflict`), ' in ', code(c.dir)), h('div', { class: 'gstep-act' }, conflictActions(repo, c.dir, c.op))),
    ),
    h('div', { class: 'gsum-headline' }, st.headline),
    st.detail && h('div', { class: 'gsum-detail' }, st.detail),
    st.note && h('div', { class: 'gsum-detail' }, st.note),
    (st.conflict || (st.mr && mrFacts(st.mr).length > 0)) && h('div', { class: 'gstep-note' }, st.conflict, st.mr && mrFacts(st.mr)),
    h(
      'ol',
      { class: 'gtrack' },
      st.milestones.map((m) => h('li', { class: m.done ? (m.warn ? 'warn' : 'done') : '' }, h('span', { class: 'gtrack-dot' }, m.done ? icon('check') : ''), m.label)),
    ),
    st.lines.length > 0 &&
      h(
        'ul',
        { class: 'gsum-lines' },
        st.lines.map((l) => h('li', { class: l.ok ? 'ok' : '' }, h('b', null, l.label), h('span', { class: 'gline-text' }, l.ok ? '✓ ' + l.text : l.text, l.conflict, mrFacts(l.mr)), l.actions?.filter(Boolean).length > 0 && h('span', { class: 'gstep-act' }, l.actions))),
      ),
    st.actions.length > 0 && h('div', { class: 'gstep-act' }, st.actions),
    branchList(issue, r),
    checks.length > 0 &&
      h('details', { class: 'gsum-checks' }, h('summary', null, `⚠ ${checks.length} flow warning${checks.length > 1 ? 's' : ''}`), h('ul', null, checks.map((c) => h('li', null, c)))),
    h(
      'details',
      { class: 'gsum-all', open: openAll, onToggle: (e) => LS.set('gitAllSteps', e.target.open) },
      h('summary', null, 'All steps'),
      flowSteps(issue, f, r, M),
    ),
    mrUnavailable(repo, M, issue.key),
    missingRepos.length > 0 &&
      r.uat &&
      h(
        'div',
        { class: 'gsum-more' },
        missingRepos.map((x) =>
          h('button', { class: 'link-btn', onClick: () => startTaskPop(issue, { repos: [x], preset: r.uat.name }) }, `+ Start in ${repoLabel(x)} (same branch name)`),
        ),
      ),
  );
}

// All the ticket's task branches in a repo (a ticket can have several), with what each still carries.
// The primary one drives the card; "Use" pins another one for this ticket.
function branchList(issue, r) {
  const list = [...(r.branches?.uat || []), ...(r.branches?.develop || [])];
  if (list.length < 2 && !list.some((b) => b.legacy)) return null;
  const primary = [r.uat?.name, r.develop?.name];
  const pinned = branchPins(issue.key)[r.repo];
  const open = (b) => (b.open > 0 ? gitChip(`${b.open} not in ${b.track === 'uat' ? UAT() : DEV()}`, b.superseded ? '' : 'warn', `${b.open} ${issue.key} commit(s) on this branch are not in ${b.track === 'uat' ? `the epic / ${UAT()}` : DEV()} (copies counted as in)`) : null);
  const row = (b) =>
    h(
      'li',
      { class: primary.includes(b.name) ? 'on' : '' },
      h('button', { class: 'gcode gbranch', title: `${b.name}\nClick to copy`, onClick: () => copyText(b.name, 'Branch name copied') }, b.name),
      h(
        'span',
        { class: 'gchips' },
        primary.includes(b.name) && gitChip(b.name === pinned ? 'in use · pinned' : 'in use', 'accent'),
        b.name === r.current && gitChip('checked out', 'accent'),
        b.track === 'develop' && gitChip(DEV()),
        b.mergedToEpic ? gitChip('merged → epic', 'ok', b.mergedToEpic.subject) : b.mergedToUat ? gitChip(`merged → ${UAT()}`, 'ok', b.mergedToUat.subject) : b.open === 0 && gitChip('nothing left', 'ok', 'All its commits are in the target already'),
        open(b),
        b.superseded && gitChip('older', '', `A newer branch covers the same tickets: ${b.superseded}`),
        !b.remote && gitChip('not pushed', 'warn'),
      ),
      h('span', { class: 'muted small' }, b.date ? rel(new Date(b.date * 1000).toISOString()) : ''),
      h(
        'span',
        { class: 'gstep-act' },
        b.track === 'uat' && !primary.includes(b.name) && actBtn('Use', () => pinBranch(issue.key, r.repo, b.name), { title: 'Make this the branch the steps work on, for this ticket' }),
        b.name === pinned && actBtn('Auto', () => pinBranch(issue.key, r.repo, null), { title: 'Go back to picking the branch automatically' }),
        b.name !== r.current && !b.worktree && actBtn('Checkout', () => checkoutBranch(r.repo, b.name, r.dirty), { iconName: 'branch', iconOnly: true }),
      ),
    );
  const busy = list.filter((b) => b.open > 0 && !primary.includes(b.name) && !b.superseded).length;
  return h(
    'details',
    { class: 'gsum-branches', open: busy > 0 || !!pinned },
    h('summary', null, `${list.length} branch${list.length > 1 ? 'es' : ''} for ${issue.key}`, busy > 0 && [' · ', h('span', { class: 'warn-text' }, `${busy} other with unmerged work`)]),
    h('ul', null, list.map(row)),
  );
}

// GitLab unreachable (VPN off…): say so, offer a retry, and fall back to the MR links recorded on Jira.
function mrUnavailable(repo, M, key) {
  if (!M?.error) return null;
  const jira = (key && gitState.jiraMrs.get(key)) || [];
  const retry = () => {
    gitState.mrs.delete(repo);
    gitState.mrStale.add(repo);
    delete gitState.mrData[repo];
    refreshGit();
  };
  return h(
    'div',
    { class: 'gmr-off' },
    h('div', { class: 'gstep-note' }, h('span', { class: 'warn-text' }, 'MR status unavailable'), h('span', { class: 'muted', title: M.error }, `(${M.error})`), h('button', { class: 'link-btn', onClick: retry }, 'Retry')),
    jira.length > 0 &&
      h('ul', { class: 'link-list compact' }, jira.map((l) => h('li', null, icon('mr'), h('a', { href: l.url, target: '_blank', rel: 'noopener', title: l.url }, l.title.replace(/^Merge request - /, '')), h('span', { class: 'tag muted small' }, 'from Jira')))),
  );
}
