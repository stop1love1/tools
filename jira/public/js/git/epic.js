'use strict';

// Epic issue: the same layout as a task — what to do next, where the epic stands per repo (uat, develop), then the
// epic's commits per ticket (one row per ticket, one column per repo) and cherry-picking them to develop.

function getEpic(key) {
  if (!gitState.epics.has(key)) {
    const p = api(`/api/git/epic?key=${encodeURIComponent(key)}`);
    p.catch(() => gitState.epics.delete(key));
    gitState.epics.set(key, p);
  }
  return gitState.epics.get(key);
}

function epicBlock(issue) {
  const box = h('section', { class: 'block git-flow', id: 'git-flow' }, h('h3', null, icon('branch'), 'Git · epic'), h('div', { class: 'muted small' }, 'Reading the epic branch…'));
  getEpic(issue.key).then(
    (d) => fillEpic(box, issue, d),
    (e) => box.replaceChildren(box.firstChild, h('div', { class: 'error-box' }, e.message)),
  );
  return box;
}

function fillEpic(box, issue, d) {
  const repos = gitRepos().filter((r) => d.repos[r]);
  const redraw = () => box.isConnected && fillEpic(box, issue, d);
  // Ticket titles: the epic's children from Jira (most tickets on the branch aren't in my own list).
  if (!gitState.epicTitles.has(issue.key)) {
    gitState.epicTitles.set(issue.key, {});
    getDetail(issue.key)
      .then((det) => {
        gitState.epicTitles.set(issue.key, Object.fromEntries((det.children || []).map((c) => [c.key, c.summary])));
        redraw();
      })
      .catch(() => {});
  }
  gitState.titles = gitState.epicTitles.get(issue.key);

  const name = repos.map((r) => d.repos[r].name).find(Boolean);
  const head = h(
    'h3',
    null,
    icon('branch'),
    'Git · epic',
    name && h('button', { class: 'gcode gbranch', title: `${name}\nClick to copy`, onClick: () => copyText(name, 'Branch name copied') }, name),
    h('span', { class: 'spacer' }),
    h('button', { class: 'icon-btn sm', title: 'Reload', onClick: refreshGit }, icon('refresh')),
  );

  const broken = repos.filter((r) => d.repos[r].error).map((r) => h('div', { class: 'error-box' }, h('b', null, repoLabel(r)), ' — ', d.repos[r].error));
  const live = repos.filter((r) => !d.repos[r].error);
  const exists = live.filter((r) => d.repos[r].exists);
  const M = (r) => gitState.mrData[r];

  // The epic's tickets across repos: one entry per ticket, with each repo's commits.
  const byKey = new Map();
  for (const r of exists) {
    for (const t of epicTickets(d.repos[r], issue.key)) {
      if (!byKey.has(t.key)) byKey.set(t.key, { key: t.key, title: t.title, latest: 0, repos: {} });
      const x = byKey.get(t.key);
      x.repos[r] = t;
      x.title ||= t.title;
      x.latest = Math.max(x.latest, t.latest);
    }
  }
  const needsPick = (t) => Object.values(t.repos).some((x) => x.missing.length > 0);
  const tickets = [...byKey.values()].sort((a, b) => needsPick(b) - needsPick(a) || b.latest - a.latest);

  const uat = Object.fromEntries(exists.map((r) => [r, epicUat(issue, d.repos[r], M(r))]));
  const items = [];
  for (const r of live.filter((x) => !d.repos[x].exists)) {
    const e = d.repos[r];
    items.push({
      state: 'wait',
      repo: repoLabel(r),
      title: `${e.name} is not on origin`,
      why: `Created from ${UAT()} when the first task of this epic starts.`,
      secondary: [act(`Create from ${UAT()}`, () => gitAction({ action: 'ensure-epic', repo: r, epic: issue.key }, `Create ${e.name} from origin/${UAT()} and push it?`))],
    });
  }
  for (const r of exists) if (uat[r].item) items.push(uat[r].item);
  const picks = tickets.flatMap((t) =>
    exists
      .filter((r) => t.repos[r]?.missing.length > 0)
      .map((r) => {
        const x = t.repos[r];
        return {
          state: 'todo',
          repo: repoLabel(r),
          title: `${t.key}: ${x.missing.length} commit(s) not on ${DEV()}`,
          why: x.target ? `Into ${x.target}, then pushed.` : `No -${DEV()} branch known yet — you'll be asked for one.`,
          primary: act(`Cherry-pick ${x.missing.length} → ${DEV()}`, () => pickTicket(r, x, x.missing.map((c) => c.sha), redraw)),
          secondary: [
            act('Choose commits', () => {
              gitState.epicOpen.add(t.key);
              LS.set('epicFilter', false);
              redraw();
            }),
          ],
        };
      }),
  );
  items.push(...picks.slice(0, 4));
  if (picks.length > 4) items.push({ state: 'todo', title: `+${picks.length - 4} more to cherry-pick — see the tickets below` });
  const rank = { warn: 0, todo: 1, wait: 2 };
  items.sort((a, b) => rank[a.state] - rank[b.state]);
  const allDone = exists.length > 0 && !items.length && exists.every((r) => !d.repos[r].pending);

  box.replaceChildren(
    ...[
      head,
      ...broken,
      live.length > 0 && nextBlock(items, { allDone, mrOff: exists.some((r) => M(r)?.error) }),
      exists.length > 0 && epicTable(exists.map((r) => d.repos[r]), uat, tickets),
      exists.length > 0 && ticketTable(tickets, exists, redraw),
      exists.length > 0 && epicFooter(issue, exists.map((r) => d.repos[r]), tickets, uat),
      mrUnavailable(exists, null),
    ].filter(Boolean),
  );
  for (const r of exists) if (!gitState.mrData[r] || !gitState.mrs.has(r)) getMrs(r).then(redraw);
}

// Has the epic reached uat, and what is left to do about it? → { cell, item } (item: a "Next" entry, if any).
function epicUat(issue, e, M) {
  const label = repoLabel(e.repo);
  const m = mrsOf(M, e.name, UAT()).find((x) => x.state === 'opened');
  const c = conflictOf(m, e.conflictUat);
  const open = m && linkAct(`Open MR !${m.iid}`, m.url);
  const waiting = `${e.pending} commit(s) ${e.mergedToUat ? 'new since the last merge' : 'waiting'}${e.behindUat > 0 ? ` · ${e.behindUat} behind` : ''}`;
  if (!e.pending) {
    const done = e.mergedToUat;
    return { cell: { state: 'done', text: done ? `Merged into ${UAT()}` : `In ${UAT()}`, sub: done ? `${fmtDate(done.date)} · ${done.sha}` : '' } };
  }
  if (c) {
    return {
      cell: { state: 'warn', text: m ? `MR !${m.iid} conflicts` : `Conflicts with ${UAT()}`, sub: waiting },
      item: { state: 'warn', repo: label, title: `The epic conflicts with ${UAT()}${conflictFiles(c)}`, why: 'The epic is shared: tell the team before rebasing it (force-push). Open task branches will need a rebase afterwards.', primary: rebaseEpicAct(e.repo, issue.key), secondary: [open].filter(Boolean) },
    };
  }
  if (m) {
    return {
      cell: { state: 'wait', text: `MR !${m.iid} · ${mrSub(m)}`, sub: waiting },
      item: { state: 'wait', repo: label, title: `Epic MR !${m.iid} → ${UAT()}: ${mrSub(m)}`, why: m.draft ? `Take it out of draft when the epic is ready for ${UAT()}.` : '', secondary: [open] },
    };
  }
  if (M?.byBranch) {
    return {
      cell: { state: 'todo', text: 'No epic MR', sub: waiting },
      item: {
        state: 'todo',
        repo: label,
        title: `No MR epic → ${UAT()} yet`,
        why: 'Only ONE MR per epic per repo; tasks merged into the epic later show up in it.',
        primary: linkAct(`Create MR → ${UAT()}`, mrUrl(e.web, e.name, UAT(), `${issue.key}: ${issue.summary}`, mrDescription(issue.key, e.name))),
      },
    };
  }
  // MR status unknown (GitLab unreachable / loading): the table and the "unavailable" line say so — nothing for Next.
  return { cell: { state: 'wait', text: `Not in ${UAT()}`, sub: waiting } };
}

// Rows → uat and → develop, one column per repo (same look as a task's stage table, read-only).
function epicTable(epics, uat, tickets) {
  const cols = `--cols:${epics.length}`;
  const row = (cls, ...kids) => h('div', { class: `gm-row${cls ? ' ' + cls : ''}`, style: cols }, kids);
  const label = (text, hint) => h('div', { class: 'gm-label' }, h('b', null, text), hint && h('span', null, hint));
  const cell = (c, extra) => h('div', { class: 'gm-cell', 'data-state': c.state }, stateDot(c.state), h('span', { class: 'gm-text' }, h('b', null, c.text), c.sub && h('span', null, c.sub), extra));
  const dev = (e) => {
    const commits = tickets.flatMap((t) => t.repos[e.repo]?.commits || []);
    if (!commits.length) return cell({ state: 'na', text: '—', sub: 'no commits of its own yet' });
    const on = commits.filter((c) => c.inDevelop || c.onDevBranch).length;
    return cell({ state: on === commits.length ? 'done' : 'todo', text: `${on} / ${commits.length} commits`, sub: '' }, h('span', { class: 'eprog' }, h('i', { style: `width:${Math.round((on / commits.length) * 100)}%` })));
  };
  return h(
    'div',
    { class: 'gmatrix' },
    row('gm-head', h('div', { class: 'gm-label' }, 'Epic'), epics.map((e) => h('div', { class: 'gm-repo' }, repoLabel(e.repo)))),
    row('', label(`→ ${UAT()}`, 'one MR per epic'), epics.map((e) => cell(uat[e.repo].cell))),
    row('', label(`→ ${DEV()}`, 'per ticket'), epics.map(dev)),
  );
}

function ticketTable(tickets, repos, redraw) {
  const todo = tickets.filter((t) => Object.values(t.repos).some((x) => x.missing.length > 0)).length;
  const showAll = LS.get('epicFilter', false) || !todo;
  const list = showAll ? tickets : tickets.filter((t) => Object.values(t.repos).some((x) => x.missing.length > 0));
  const cols = `--cols:${repos.length}`;
  return h(
    'div',
    { class: 'etable' },
    h(
      'div',
      { class: 'etable-head' },
      h('span', { class: 'gpanel-label' }, 'Tickets on the epic'),
      h('span', { class: 'spacer' }),
      todo > 0
        ? h(
            'div',
            { class: 'gtabs' },
            h('button', { 'aria-selected': String(!showAll), onClick: () => (LS.set('epicFilter', false), redraw()) }, `Needs pick (${todo})`),
            h('button', { 'aria-selected': String(showAll), onClick: () => (LS.set('epicFilter', true), redraw()) }, `All (${tickets.length})`),
          )
        : h('span', { class: 'muted small' }, tickets.length ? `${tickets.length} ticket(s) · all on ${DEV()}` : 'No tickets with commits yet'),
    ),
    list.length > 0 &&
      h(
        'div',
        { class: 'etickets' },
        h('div', { class: 'et-row et-head', style: cols }, h('div', null, 'Ticket'), repos.map((r) => h('div', null, repoLabel(r)))),
        list.map((t) => ticketRow(t, repos, redraw)),
      ),
  );
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
  const tickets = [...map.values()].filter(belongs);
  for (const t of tickets) {
    t.repo = e.repo;
    t.commits.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    t.missing = t.commits.filter((c) => !c.inDevelop && !c.onDevBranch);
    t.title = e.ticketTitles?.[t.key] || '';
    const b = e.branches?.[t.key] || {};
    const uatBranch = t.uatBranch || b.uat;
    t.target = gitState.devTargets.get(`${e.repo}:${t.key}`) || b.develop || (uatBranch ? toDevName(uatBranch) : '');
    t.latest = Math.max(...t.commits.map((c) => Date.parse(c.date)));
  }
  return tickets;
}

const devTargetValidate = (x) => (devBranchRe().test(x.trim()) ? '' : `Expected feature/${KEY()}-123-description-${DEV()}`);

async function pickTicket(repo, t, shas, redraw) {
  if (!shas.length) return toast('No commit selected', 'error');
  if (!t.target) {
    const v = await promptPop(`Cherry-pick ${t.key} to ${DEV()}`, {
      value: `feature/${t.key}-`,
      hint: `No task branch known for this ticket. Name the -${DEV()} branch to create (from ${DEV()}).`,
      okLabel: 'Use branch',
      validate: devTargetValidate,
    });
    if (v == null) return;
    t.target = v.trim();
    gitState.devTargets.set(`${repo}:${t.key}`, t.target);
    redraw?.();
  }
  const list = t.missing.filter((c) => shas.includes(c.sha));
  gitAction({ action: 'pick-develop', repo, branch: t.target, shas }, `Cherry-pick ${list.length} commit(s) of ${t.key} onto ${t.target} and push it:\n\n${list.map((c) => `${c.short} ${stripTicket(c.subject)}`).join('\n')}`);
}

async function changeTarget(t, redraw) {
  const v = await promptPop(`${DEV()} branch for ${t.key} (${repoLabel(t.repo)})`, { value: t.target || `feature/${t.key}-`, okLabel: 'Use branch', validate: devTargetValidate });
  if (v == null) return;
  gitState.devTargets.set(`${t.repo}:${t.key}`, v.trim());
  redraw();
}

function ticketRow(t, repos, redraw) {
  const open = gitState.epicOpen.has(t.key);
  const toggle = () => {
    open ? gitState.epicOpen.delete(t.key) : gitState.epicOpen.add(t.key);
    redraw();
  };
  const summary = state.issues.find((i) => i.key === t.key)?.summary || t.title || gitState.titles?.[t.key] || '';
  const direct = Object.values(t.repos).some((x) => x.direct);
  const complete = !Object.values(t.repos).some((x) => x.missing.length);
  const mark = (c) =>
    c.inDevelop ? h('span', { class: 'emark ok', title: `In ${DEV()}` }, '✓') : c.onDevBranch ? h('span', { class: 'emark picked', title: `Picked onto the -${DEV()} branch, not merged yet` }, '●') : h('span', { class: 'emark todo', title: `Not on ${DEV()} yet` }, '○');

  const cell = (r) => {
    const x = t.repos[r];
    if (!x) return h('div', { class: 'et-cell muted' }, '—');
    if (x.missing.length) return h('div', { class: 'et-cell' }, actEl(act(`Pick ${x.missing.length}`, () => pickTicket(r, x, x.missing.map((c) => c.sha), redraw), { title: x.target ? `→ ${x.target}` : `Choose the -${DEV()} branch` }), 'primary'));
    return h('div', { class: 'et-cell ok-text' }, stateDot('done'), `${x.commits.length} / ${x.commits.length}`);
  };

  const repoBody = (r) => {
    const x = t.repos[r];
    if (!x) return null;
    const boxes = x.missing.map((c) => h('input', { type: 'checkbox', checked: true, value: c.sha, 'aria-label': c.subject }));
    const done = x.commits.filter((c) => !x.missing.includes(c));
    const line = (c, lead) =>
      h('li', { class: 'ecommit' }, h(lead ? 'label' : 'span', { class: lead ? '' : 'elabel' }, lead, mark(c), h('span', { class: 'mono muted' }, c.short), h('span', { class: `gsubj${lead ? '' : ' muted'}`, title: c.subject }, stripTicket(c.subject))), h('span', { class: 'muted small', title: `${c.author} · ${fmtDate(c.date)}` }, rel(c.date)));
    return h(
      'div',
      { class: 'et-repo' },
      h(
        'div',
        { class: 'etarget' },
        h('b', null, repoLabel(r)),
        x.missing.length > 0 && ['→ ', x.target ? code(x.target) : h('span', { class: 'muted' }, `no -${DEV()} branch yet`), h('button', { class: 'link-btn', onClick: () => changeTarget(x, redraw) }, x.target ? 'change' : 'choose')],
        !x.missing.length && h('span', { class: 'ok-text small' }, `all ${x.commits.length} on ${DEV()}`),
      ),
      x.missing.length > 0 && h('ul', { class: 'ecommits' }, x.missing.map((c, i) => line(c, boxes[i]))),
      x.missing.length > 0 && h('div', { class: 'gacts' }, actEl(act(`Cherry-pick → ${DEV()}`, () => pickTicket(r, x, boxes.filter((b) => b.checked).map((b) => b.value), redraw)), 'primary')),
      done.length > 0 && h('details', { class: 'edone' }, h('summary', null, `${done.length} already on ${DEV()}`), h('ul', { class: 'ecommits' }, done.map((c) => line(c)))),
    );
  };

  return h(
    'div',
    { class: `eticket${open ? ' open' : ''}${complete ? ' complete' : ''}` },
    h(
      'div',
      { class: 'et-row', style: `--cols:${repos.length}` },
      h(
        'div',
        { class: 'et-ticket' },
        h('button', { class: 'et-fold', 'aria-expanded': String(open), 'aria-label': `${open ? 'Hide' : 'Show'} the commits of ${t.key}`, onClick: toggle }, icon('chevRight')),
        h('a', { class: 'key', href: '#' + t.key, onClick: (ev) => (ev.preventDefault(), openDetail(t.key)) }, t.key),
        h('button', { class: 'et-sum gsubj', title: summary, onClick: toggle }, summary),
        direct && h('span', { class: 'gnomr', title: 'Committed straight to the epic, without a task MR', 'aria-label': 'no task MR' }, icon('unlink')),
      ),
      repos.map(cell),
    ),
    open && h('div', { class: 'eticket-body' }, repos.map(repoBody)),
  );
}

function epicFooter(issue, epics, tickets, uat) {
  const noMr = tickets.filter((t) => Object.values(t.repos).some((x) => x.direct)).length;
  const fetched = Math.min(...epics.map((e) => e.fetchedAt || Infinity));
  const many = epics.length > 1;
  return h(
    'div',
    { class: 'gfooter' },
    noMr > 0 && h('span', null, `${noMr} ticket(s) reached the epic without a task MR (no merge commit to revert)`),
    Number.isFinite(fetched) && h('span', null, `Fetched ${rel(new Date(fetched).toISOString())}`),
    h(
      'button',
      {
        class: 'link-btn',
        onClick: async () => {
          for (const e of epics) await gitAction({ action: 'fetch', repo: e.repo });
        },
      },
      'Fetch now',
    ),
    // A conflict already puts the rebase in "Next"; otherwise it is only worth it when the MR conflicts.
    epics
      .filter((e) => e.behindUat > 0 && uat[e.repo].cell.state !== 'warn')
      .map((e) => actEl({ ...rebaseEpicAct(e.repo, issue.key), label: `Rebase ${many ? `the ${repoLabel(e.repo)} ` : 'the '}epic onto ${UAT()}… (only if its MR conflicts)` }, 'more')),
  );
}
