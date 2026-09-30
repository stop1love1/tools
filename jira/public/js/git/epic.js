'use strict';

// Epic issue: the commits its branch carries (grouped by task MR) and cherry-picking them to develop.

// ---------------------------------------------------------------------------
// Epic issue: the commits its branch carries (grouped by task MR) and cherry-picking them to develop

function getEpic(key) {
  if (!gitState.epics.has(key)) {
    const p = api(`/api/git/epic?key=${encodeURIComponent(key)}`);
    p.catch(() => gitState.epics.delete(key));
    gitState.epics.set(key, p);
  }
  return gitState.epics.get(key);
}

function epicBlock(issue) {
  const box = h('section', { class: 'block git-flow', id: 'git-flow' }, h('h3', null, icon('branch'), 'Git · epic branch'), h('div', { class: 'muted small' }, 'Reading the epic branch…'));
  getEpic(issue.key).then(
    (d) => fillEpic(box, issue, d),
    (e) => box.replaceChildren(box.firstChild, h('div', { class: 'error-box' }, e.message)),
  );
  return box;
}

function fillEpic(box, issue, d) {
  const repos = gitRepos().filter((r) => d.repos[r]);
  // Ticket titles: the epic's children from Jira (most tickets on the branch aren't in my own list).
  if (!gitState.epicTitles.has(issue.key)) {
    gitState.epicTitles.set(issue.key, {});
    getDetail(issue.key)
      .then((det) => {
        gitState.epicTitles.set(issue.key, Object.fromEntries((det.children || []).map((c) => [c.key, c.summary])));
        if (box.isConnected) fillEpic(box, issue, d);
      })
      .catch(() => {});
  }
  gitState.titles = gitState.epicTitles.get(issue.key);
  const head = h(
    'h3',
    null,
    icon('branch'),
    'Git · epic branch',
    h('span', { class: 'spacer' }),
    h('button', { class: 'icon-btn sm', title: 'Reload', onClick: refreshGit }, icon('refresh')),
  );
  box.replaceChildren(head, ...repos.map((r) => epicCard(issue, d.repos[r], gitState.mrData[r])));
  for (const r of repos) if (d.repos[r].exists && (!gitState.mrData[r] || !gitState.mrs.has(r))) getMrs(r).then(() => box.isConnected && fillEpic(box, issue, d));
}

function epicCard(issue, e, M) {
  const repo = e.repo;
  const label = repoLabel(repo);
  if (e.error) return h('div', { class: 'gsum' }, h('div', { class: 'gsum-top' }, h('b', null, label)), h('div', { class: 'error-box' }, e.error));
  if (!e.exists) {
    return h(
      'div',
      { class: 'gsum' },
      h('div', { class: 'gsum-top' }, h('b', null, label), code(e.name)),
      h('div', { class: 'gsum-headline' }, 'Not on origin'),
      h('div', { class: 'gsum-detail' }, `Created from ${UAT()} when the first task of this epic starts.`),
      h('div', { class: 'gstep-act' }, actBtn(`Create epic from ${UAT()}`, () => gitAction({ action: 'ensure-epic', repo, epic: issue.key }, `Create ${e.name} from origin/${UAT()} and push it?`))),
    );
  }

  const tickets = epicTickets(e, issue.key);
  const commits = tickets.flatMap((t) => t.commits);
  const onDev = commits.filter((c) => c.inDevelop || c.onDevBranch).length;
  const todo = tickets.filter((t) => t.missing.length);
  const noMr = tickets.filter((t) => t.direct).length;
  const filterKey = `epicFilter:${repo}`;
  const showAll = LS.get(filterKey, false) || !todo.length;
  const epicMr = mrsOf(M, e.name, UAT()).find((m) => m.state === 'opened') || mrsOf(M, e.name, UAT())[0];

  const card = h('div', { class: `gsum ${todo.length || e.behindUat > 0 ? 't-accent' : 't-ok'}` });
  const redraw = () => card.replaceWith(epicCard(issue, e, M));
  // append() prints null/false as text: drop the empty slots.
  card.append(
    ...[
      h('div', { class: 'gsum-top' }, h('b', null, label), h('button', { class: 'gcode gbranch', title: `${e.name}\nClick to copy`, onClick: () => copyText(e.name, 'Branch name copied') }, e.name)),

      // uat side: the one epic → uat MR
      h(
        'div',
        { class: 'eline' },
        h('b', null, 'UAT'),
        h(
          'span',
          null,
          uatState(e),
          e.behindUat > 0 && gitChip(`${e.behindUat} behind ${UAT()}`, 'warn', `${UAT()} has commits the epic does not — rebase if the MR conflicts`),
          conflictChip(conflictOf(epicMr, e.conflictUat), UAT()),
          epicMr && mrChip(sansConflict(epicMr)),
          epicMr && mrFacts(sansConflict(epicMr)),
        ),
        h(
          'span',
          { class: 'gstep-act' },
          epicMr?.state === 'opened'
            ? linkBtn(epicMr.url, `Open MR !${epicMr.iid}`, false)
            : e.pending > 0 && (M?.byBranch ? linkBtn(mrUrl(e.web, e.name, UAT(), `${issue.key}: ${issue.summary}`, mrDescription(issue.key, e.name)), `Create MR → ${UAT()}`, false) : iconLink(mrListUrl(e.web, e.name), 'mr', 'MRs of the epic on GitLab')),
          e.behindUat > 0 &&
            actBtn(`Rebase the epic onto ${UAT()}`, () =>
              gitAction({ action: 'rebase-epic', repo, epic: issue.key }, `Rebase ${e.name} onto origin/${UAT()} (keeping each task's merge commit) and FORCE-PUSH it?\n\nThe epic is shared: tell the team first. Open task branches will need a rebase afterwards.`),
              { danger: true, iconOnly: true, iconName: 'rebase', title: `Rebase ${e.name} onto ${UAT()} (${e.behindUat} behind) — force-push` },
            ),
        ),
      ),

      // develop side: progress, then one row per ticket
      commits.length
        ? h(
            'div',
            { class: 'eline' },
            h('b', null, 'Develop'),
            h(
              'span',
              null,
              `${onDev}/${commits.length} commits on ${DEV()}`,
              todo.length ? gitChip(`${todo.length} ticket(s) to pick`, 'warn') : gitChip('all picked', 'ok'),
              h('span', { class: 'eprog' }, h('i', { style: `width:${Math.round((onDev / commits.length) * 100)}%` })),
            ),
          )
        : h('div', { class: 'muted small' }, 'No commits of its own yet.'),
      noMr > 0 && h('div', { class: 'gsum-detail' }, `${noMr} ticket(s) were committed straight to the epic without a task MR (no merge commit to revert).`),
      mrUnavailable(repo, M, null),
      tickets.length > 0 &&
        h(
          'div',
          { class: 'etools' },
          h(
            'div',
            { class: 'gtabs' },
            h('button', { 'aria-selected': String(!showAll), disabled: !todo.length, onClick: () => (LS.set(filterKey, false), redraw()) }, `Needs pick (${todo.length})`),
            h('button', { 'aria-selected': String(showAll), onClick: () => (LS.set(filterKey, true), redraw()) }, `All tickets (${tickets.length})`),
          ),
        ),
      tickets.length > 0 && h('ul', { class: 'etickets' }, (showAll ? tickets : todo).map((t) => ticketRow(repo, t, redraw))),
    ].filter(Boolean),
  );
  return card;
}

// Has the epic reached uat? Answered from git: the merge commit on uat, and what the epic still has that uat lacks.
function uatState(e) {
  const m = e.mergedToUat;
  const when = m && h('span', { class: 'muted', title: `${m.sha} ${m.subject}` }, `${fmtDate(m.date)} · ${m.sha}`);
  if (!e.pending) return m ? [h('b', { class: 'ok-text' }, `✓ Merged into ${UAT()}`), when] : h('b', { class: 'ok-text' }, `✓ In ${UAT()}`);
  if (m) return [h('b', null, `Merged into ${UAT()}`), when, gitChip(`${e.pending} new commit(s) since`, 'warn', `Committed after the last epic → ${UAT()} merge; they go up with the next MR`)];
  return [h('b', null, `Not merged into ${UAT()}`), gitChip(`${e.pending} commit(s) waiting`, '')];
}

// The epic's commits per ticket: which are on develop, which still need picking, and where they should go.
// Only tickets of this epic (per Jira) are listed; commits of other epics' tickets — e.g. from an epic this one
// was stacked on — and commits without a ticket are left out entirely.
function epicTickets(e, epicKey) {
  const map = new Map();
  for (const g of e.groups) {
    for (const c of g.commits) {
      const key = c.ticket || '(no ticket)';
      if (!map.has(key)) map.set(key, { key, commits: [], direct: false, merged: false, uatBranch: null });
      const t = map.get(key);
      t.commits.push(c);
      if (g.kind === 'merge') {
        t.merged = true;
        if (g.branch?.endsWith(`-${UAT()}`)) t.uatBranch ||= g.branch;
      } else t.direct = true;
    }
  }
  const belongs = (t) => t.key.startsWith(`${KEY()}-`) && (!e.ticketEpics?.[t.key] || e.ticketEpics[t.key] === epicKey);
  const all = [...map.values()];
  const tickets = all.filter(belongs);
  for (const t of tickets) {
    t.commits.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    t.missing = t.commits.filter((c) => !c.inDevelop && !c.onDevBranch);
    t.title = e.ticketTitles?.[t.key] || '';
    const b = e.branches?.[t.key] || {};
    const uatBranch = t.uatBranch || b.uat;
    t.target = b.develop || (uatBranch ? toDevName(uatBranch) : '');
    t.latest = Math.max(...t.commits.map((c) => Date.parse(c.date)));
  }
  tickets.sort((a, b) => (b.missing.length > 0) - (a.missing.length > 0) || b.latest - a.latest);
  return tickets;
}

function ticketRow(repo, t, redraw) {
  const open = gitState.epicOpen.has(`${repo}:${t.key}`);
  const toggle = () => {
    open ? gitState.epicOpen.delete(`${repo}:${t.key}`) : gitState.epicOpen.add(`${repo}:${t.key}`);
    redraw();
  };
  const summary = state.issues.find((i) => i.key === t.key)?.summary || t.title || gitState.titles?.[t.key] || '';
  const picked = t.commits.length - t.missing.length;
  const boxes = t.missing.map((c) => h('input', { type: 'checkbox', checked: true, value: c.sha, 'aria-label': c.subject }));

  const pick = async () => {
    const shas = open ? boxes.filter((b) => b.checked).map((b) => b.value) : t.missing.map((c) => c.sha);
    if (!shas.length) return toast('No commit selected', 'error');
    let target = t.target;
    if (!target) {
      target = await promptPop(`Cherry-pick ${t.key} to ${DEV()}`, {
        value: `feature/${t.key}-`,
        hint: `No task branch known for this ticket. Name the -${DEV()} branch to create (from ${DEV()}).`,
        okLabel: 'Use branch',
        validate: (x) => (devBranchRe().test(x.trim()) ? '' : `Expected feature/${KEY()}-123-description-${DEV()}`),
      });
      if (target == null) return;
      target = t.target = target.trim();
    }
    const list = t.missing.filter((c) => shas.includes(c.sha));
    gitAction({ action: 'pick-develop', repo, branch: target, shas }, `Cherry-pick ${list.length} commit(s) of ${t.key} onto ${target} and push it:\n\n${list.map((c) => `${c.short} ${stripTicket(c.subject)}`).join('\n')}`);
  };
  const changeTarget = async () => {
    const v = await promptPop(`Develop branch for ${t.key}`, {
      value: t.target || `feature/${t.key}-`,
      okLabel: 'Use branch',
      validate: (x) => (devBranchRe().test(x.trim()) ? '' : `Expected feature/${KEY()}-123-description-${DEV()}`),
    });
    if (v != null) (t.target = v.trim()), redraw();
  };

  const mark = (c) => (c.inDevelop ? h('span', { class: 'emark ok', title: `In ${DEV()}` }, '✓') : c.onDevBranch ? h('span', { class: 'emark picked', title: `Picked onto the -${DEV()} branch, not merged yet` }, '●') : h('span', { class: 'emark todo', title: `Not on ${DEV()} yet` }, '○'));
  const done = t.commits.filter((c) => !t.missing.includes(c));

  return h(
    'li',
    { class: `eticket${open ? ' open' : ''}${t.missing.length ? '' : ' complete'}` },
    h(
      'div',
      {
        class: 'eticket-head',
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(open),
        onClick: (ev) => !ev.target.closest('a,button') && toggle(),
        onKeydown: (ev) => (ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget && (ev.preventDefault(), toggle()),
      },
      h('span', { class: 'fold-icon' }, icon('chevRight')),
      t.key.startsWith(KEY()) ? h('a', { class: 'key', href: '#' + t.key, onClick: (ev) => (ev.preventDefault(), openDetail(t.key)) }, t.key) : h('span', { class: 'muted' }, t.key),
      h('span', { class: 'gsubj muted', title: summary }, summary),
      t.direct && h('span', { class: 'gnomr', title: 'Committed straight to the epic, without a task MR', 'aria-label': 'no task MR' }, icon('unlink')),
      h('span', { class: `small ${t.missing.length ? '' : 'ok-text'}` }, `${picked}/${t.commits.length}`),
      t.missing.length > 0 ? actBtn(`Pick ${t.missing.length}`, pick, { primary: true, title: t.target ? `→ ${t.target}` : `Choose the -${DEV()} branch` }) : h('span', { class: 'emark ok' }, '✓'),
    ),
    open &&
      h(
        'div',
        { class: 'eticket-body' },
        t.missing.length > 0 &&
          h('div', { class: 'etarget' }, '→ ', t.target ? code(t.target) : h('span', { class: 'muted' }, `no -${DEV()} branch yet`), h('button', { class: 'link-btn', onClick: changeTarget }, t.target ? 'change' : 'choose')),
        t.missing.length > 0 &&
          h('ul', { class: 'ecommits' }, t.missing.map((c, i) => h('li', { class: 'ecommit' }, h('label', null, boxes[i], mark(c), h('span', { class: 'mono muted' }, c.short), h('span', { class: 'gsubj', title: c.subject }, stripTicket(c.subject))), h('span', { class: 'muted small', title: `${c.author} · ${fmtDate(c.date)}` }, rel(c.date))))),
        done.length > 0 &&
          h(
            'details',
            { class: 'edone', open: !t.missing.length },
            h('summary', null, `${done.length} already on ${DEV()}`),
            h('ul', { class: 'ecommits' }, done.map((c) => h('li', { class: 'ecommit' }, h('span', { class: 'elabel' }, mark(c), h('span', { class: 'mono muted' }, c.short), h('span', { class: 'gsubj muted', title: c.subject }, stripTicket(c.subject))), h('span', { class: 'muted small' }, rel(c.date))))),
          ),
      ),
  );
}
