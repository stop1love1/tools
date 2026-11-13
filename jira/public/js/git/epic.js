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
  gitState.epicTableOpen.delete(issue.key); // a freshly opened drawer starts with the ticket table folded
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
  const children = new Set(Object.keys(gitState.titles || {}));

  // The epic's tickets across repos: one entry per ticket, with each repo's commits.
  const byKey = new Map();
  for (const r of exists) {
    for (const t of epicTickets(d.repos[r], issue.key, children)) {
      if (!byKey.has(t.key)) byKey.set(t.key, { key: t.key, keys: [], title: t.title, latest: 0, repos: {} });
      const x = byKey.get(t.key);
      x.repos[r] = t;
      x.keys = [...new Set([...x.keys, ...t.keys])].sort(byTicket);
      x.title ||= t.title;
      x.latest = Math.max(x.latest, t.latest);
    }
  }
  const needsPick = (t) => Object.values(t.repos).some(hasWork);
  const tickets = [...byKey.values()].sort((a, b) => needsPick(b) - needsPick(a) || b.latest - a.latest);

  const uat = Object.fromEntries(exists.map((r) => [r, epicUat(issue, d.repos[r], M(r))]));
  const items = [];
  // A repo without the epic branch is simply not started — nothing to do or wait for, so it stays out of "Next"
  // (the footer offers creating it).
  for (const r of exists) if (uat[r].item) items.push(uat[r].item);
  const show = (t) => () => {
    gitState.epicTableOpen.add(issue.key);
    gitState.epicOpen.add(t.key);
    LS.set('epicFilter', false);
    redraw();
  };
  const picks = tickets.flatMap((t) =>
    exists
      .filter((r) => t.repos[r] && hasWork(t.repos[r]))
      .map((r) => {
        const x = t.repos[r];
        const name = t.keys.length > 1 ? `${t.keys[0]} (+${t.keys.length - 1})` : t.key;
        if (x.needsRebuild) {
          return {
            state: 'warn',
            repo: repoLabel(r),
            title: `${name}: ${x.target} is based on an old ${DEV()}`,
            why: `${DEV()} was rewritten after the branch was cut: its MR would bring back ${x.stale} old merge(s). Rebuild it from ${DEV()} (only its own commits are kept, backup kept)${x.missing.length ? `, then pick the ${x.missing.length} missing commit(s)` : ''}.`,
            primary: rebuildDevAct(r, x.target, x.stale),
            secondary: [act('Show commits', show(t))],
          };
        }
        const n = tickedOf(pickScope(x), x.missing).length;
        return {
          state: 'todo',
          repo: repoLabel(r),
          title: `${name}: ${x.missing.length} commit(s) not on ${DEV()}`,
          why: x.target ? `Into ${x.target}, then pushed.` : `No -${DEV()} branch known yet — you'll be asked for one.`,
          primary: act(n === x.missing.length ? `Cherry-pick ${n} → ${DEV()}` : `Cherry-pick ${n} of ${x.missing.length} → ${DEV()}`, () => pickTicket(r, x, redraw)),
          secondary: [act('Choose commits', show(t))],
        };
      }),
  );
  // Rebuilds first (warn), then picks; the rest is in the ticket table.
  picks.sort((a, b) => (a.state === 'warn' ? 0 : 1) - (b.state === 'warn' ? 0 : 1));
  items.push(...picks.slice(0, 4));
  if (picks.length > 4) items.push({ state: 'todo', title: `+${picks.length - 4} more — see the tickets below` });
  const rank = { warn: 0, todo: 1, wait: 2 };
  items.sort((a, b) => rank[a.state] - rank[b.state]);
  const allDone = exists.length > 0 && !items.length && exists.every((r) => !d.repos[r].pending);

  box.replaceChildren(
    ...[
      head,
      ...broken,
      live.length > 0 && nextBlock(items, { allDone, mrOff: exists.some((r) => M(r)?.error) }),
      exists.length > 0 && epicTable(exists.map((r) => d.repos[r]), uat, tickets),
      exists.length > 0 && ticketTable(tickets, exists, redraw, issue.key),
      live.length > 0 && epicFooter(issue, exists.map((r) => d.repos[r]), tickets, uat, live.filter((r) => !d.repos[r].exists).map((r) => d.repos[r])),
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
    const files = c.files.length ? `${c.files.length} file(s): ${c.files.join(', ')}` : '';
    // No MR yet: only a heads-up in the table — there is nothing to resolve on until the epic is ready for uat.
    if (!m) return { cell: { state: 'warn', text: `Would conflict with ${UAT()}`, sub: `no MR yet · ${waiting}`, title: files } };
    // Team rule (git-workflow.mdc step 4): never rebase / force-push the epic — tell the lead, resolve on the MR.
    return {
      cell: { state: 'warn', text: `MR !${m.iid} conflicts`, sub: waiting, title: files },
      item: { state: 'warn', repo: label, title: `Epic MR !${m.iid} conflicts with ${UAT()}${conflictFiles(c)}`, why: EPIC_CONFLICT_WHY(), secondary: [open] },
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
  const cell = (c, extra) => h('div', { class: 'gm-cell', 'data-state': c.state, title: c.title || null }, stateDot(c.state), h('span', { class: 'gm-text' }, h('b', null, c.text), c.sub && h('span', null, c.sub), extra));
  const dev = (e) => {
    const commits = tickets.flatMap((t) => (t.repos[e.repo]?.commits || []).filter((c) => !c.skip));
    if (!commits.length) return cell({ state: 'na', text: '—', sub: 'no commits of its own yet' });
    const on = commits.filter((c) => c.inDevelop || c.onDevBranch).length;
    const stale = tickets.filter((t) => t.repos[e.repo]?.needsRebuild).length;
    if (stale) return cell({ state: 'warn', text: `${on} / ${commits.length} commits`, sub: `${stale} -${DEV()} branch(es) on an old ${DEV()} — rebuild` }, h('span', { class: 'eprog' }, h('i', { style: `width:${Math.round((on / commits.length) * 100)}%` })));
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

// Folded when the drawer opens (the "Next" block already lists what needs doing); "Choose commits" / "Show commits"
// open it. Open / closed lives in gitState, so the redraws MR / title loading cause don't fold it again.
function ticketTable(tickets, repos, redraw, epicKey) {
  const todo = tickets.filter((t) => Object.values(t.repos).some(hasWork)).length;
  const showAll = LS.get('epicFilter', false) || !todo;
  const list = showAll ? tickets : tickets.filter((t) => Object.values(t.repos).some(hasWork));
  const cols = `--cols:${repos.length}`;
  const open = gitState.epicTableOpen.has(epicKey);
  const toggle = () => {
    open ? gitState.epicTableOpen.delete(epicKey) : gitState.epicTableOpen.add(epicKey);
    redraw();
  };
  return h(
    'div',
    { class: `etable${open ? ' open' : ''}` },
    h(
      'div',
      { class: 'etable-head' },
      h(
        'button',
        { class: 'etable-toggle', 'aria-expanded': String(open), onClick: toggle },
        icon('chevRight'),
        h('span', { class: 'gpanel-label' }, 'Tickets on the epic'),
        h('span', { class: 'muted small' }, todo > 0 ? `${todo} to do · ${tickets.length}` : String(tickets.length)),
      ),
      h('span', { class: 'spacer' }),
      !open ? null : todo > 0
        ? h(
            'div',
            { class: 'gtabs' },
            h('button', { 'aria-selected': String(!showAll), onClick: () => (LS.set('epicFilter', false), redraw()) }, `To do (${todo})`),
            h('button', { 'aria-selected': String(showAll), onClick: () => (LS.set('epicFilter', true), redraw()) }, `All (${tickets.length})`),
          )
        : h('span', { class: 'muted small' }, tickets.length ? `${tickets.length} ticket(s) · all on ${DEV()}` : 'No tickets with commits yet'),
    ),
    open &&
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
function epicTickets(e, epicKey, children = new Set()) {
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
  const ours = (key) => key.startsWith(`${KEY()}-`) && (!e.ticketEpics?.[key] || e.ticketEpics[key] === epicKey);
  const own = [...map.values()].filter((t) => ours(t.key));
  // Only tickets of the epic join a row: those with commits here, or the epic's children on Jira. A key in a commit's
  // "(…)" is usually a sub-task of the ticket — it is not a second ticket done together.
  const rowKeys = new Set([...own.map((t) => t.key), ...children]);
  const tickets = groupWorkedTogether(e, own, (k) => ours(k) && rowKeys.has(k));
  for (const t of tickets) {
    t.repo = e.repo;
    t.commits.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    // A commit reverted later on the epic and its revert (c.skip, from the server) are never picked.
    t.skipped = t.commits.filter((c) => c.skip && !c.inDevelop && !c.onDevBranch);
    t.missing = t.commits.filter((c) => !c.inDevelop && !c.onDevBranch && !c.skip);
    t.title = e.ticketTitles?.[t.key] || '';
    const b = e.branches?.[t.key] || {};
    const uatBranch = t.uatBranch || b.uat;
    t.target = gitState.devTargets.get(`${e.repo}:${t.key}`) || b.develop || (uatBranch ? toDevName(uatBranch) : '');
    t.stale = (t.target && e.devStale?.[t.target]) || 0;
    // Its -develop branch sits on an old develop and still has to go in: rebuild it, even when nothing is left to pick.
    t.needsRebuild = t.stale > 0 && t.commits.some((c) => !c.inDevelop && !c.skip);
    t.latest = Math.max(...t.commits.map((c) => Date.parse(c.date)));
  }
  return tickets;
}

const pickScope = (t) => `${t.repo}:${t.key}:edev`;
const hasWork = (x) => x.missing.length > 0 || x.needsRebuild;

const byTicket = (a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]);

// Tickets done together are one row: commits are filed under the ticket of their "KEY-123:" prefix only, so work on
// VLEARN-4547 committed as "VLEARN-4546: … (VLEARN-4547)" on feature/VLEARN-4546-4547-… would otherwise leave 4547
// out. Linked: tickets named in a commit's trailing "(KEY-…)" and the tickets of a combined branch name. One row
// keeps each commit once (no double count, no second Pick button for the same commits).
function groupWorkedTogether(e, tickets, ours) {
  const keyRe = new RegExp(`${KEY()}-\\d+`, 'g');
  const parent = new Map();
  const find = (k) => {
    if (!parent.has(k)) parent.set(k, k);
    return parent.get(k) === k ? k : (parent.set(k, find(parent.get(k))), parent.get(k));
  };
  const link = (keys) => keys.filter(ours).reduce((a, k) => (a && parent.set(find(k), find(a)), a || k), null);
  const branchKeys = (name) => {
    const m = name?.match(new RegExp(`${KEY()}-(\\d+(?:-\\d+)*)`));
    return m ? m[1].split('-').map((n) => `${KEY()}-${n}`) : [];
  };
  for (const t of tickets) {
    find(t.key);
    for (const c of t.commits) link([t.key, ...(c.subject.match(/\(([^)]*)\)\s*$/)?.[1].match(keyRe) || [])]);
    const b = e.branches?.[t.key] || {};
    for (const name of [t.uatBranch, b.uat, b.develop]) link([t.key, ...branchKeys(name)]);
  }
  const groups = new Map();
  for (const t of tickets) {
    const root = find(t.key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }
  return [...groups.entries()].map(([root, list]) => {
    // The row is named after the ticket carrying most commits (its branch, title and target are used).
    list.sort((a, b) => b.commits.length - a.commits.length || byTicket(a.key, b.key));
    const t = list[0];
    for (const o of list.slice(1)) {
      t.commits.push(...o.commits);
      t.direct ||= o.direct;
      t.merged ||= o.merged;
      t.uatBranch ||= o.uatBranch;
    }
    t.keys = [...parent.keys()].filter((k) => find(k) === root).sort(byTicket);
    return t;
  });
}

const devTargetValidate =(x) => (devBranchRe().test(x.trim()) ? '' : `Expected feature/${KEY()}-123-description-${DEV()}`);

// Cherry-picks the ticked commits of a ticket (every pick button of the epic view goes through here, so they all
// pick the same thing: what is ticked in the ticket's row).
async function pickTicket(repo, t, redraw) {
  const list = tickedOf(pickScope(t), t.missing);
  if (!list.length) return toast('No commit selected', 'error');
  if (t.stale) return toast(`${t.target} is based on an old ${DEV()} — rebuild it first`, 'error');
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
  const left = t.skipped?.length ? `\n\nLeft out (reverted later on the epic, or the revert itself): ${t.skipped.map((c) => c.short).join(', ')}` : '';
  gitAction(
    { action: 'pick-develop', repo, branch: t.target, shas: list.map((c) => c.sha) },
    `Cherry-pick -x ${list.length} commit(s) of ${t.key} onto ${t.target} and push it:\n\n${list.map((c) => `${c.short} ${stripTicket(c.subject)}`).join('\n')}${left}`,
  );
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
  const titleOf = (k) => state.issues.find((i) => i.key === k)?.summary || gitState.titles?.[k] || '';
  const summary = titleOf(t.key) || t.title || '';
  const complete = !Object.values(t.repos).some(hasWork);
  const mark = (c) =>
    c.inDevelop ? h('span', { class: 'emark ok', title: `In ${DEV()}` }, '✓') : c.onDevBranch ? h('span', { class: 'emark picked', title: `Picked onto the -${DEV()} branch, not merged yet` }, '●') : h('span', { class: 'emark todo', title: `Not on ${DEV()} yet` }, '○');

  // The row only says where each repo stands; the one pick button is in the opened row, next to the checkboxes
  // (and in "Next", which picks the same ticked commits).
  const cell = (r) => {
    const x = t.repos[r];
    if (!x) return h('div', { class: 'et-cell muted' }, '—');
    const live = x.commits.length - x.skipped.length;
    if (x.needsRebuild) return h('button', { class: 'et-cell et-open warn-text', title: `${x.target} is based on an old ${DEV()} — open to rebuild it`, onClick: toggle }, stateDot('warn'), 'old base');
    if (x.missing.length) return h('button', { class: 'et-cell et-open', title: `Open to choose and cherry-pick → ${x.target || `a -${DEV()} branch`}`, onClick: toggle }, stateDot('todo'), `${x.missing.length} to pick`);
    return h('div', { class: 'et-cell ok-text', title: x.skipped.length ? `${x.skipped.length} reverted commit(s) left out` : null }, stateDot('done'), `${live} / ${live}`);
  };

  const repoBody = (r) => {
    const x = t.repos[r];
    if (!x) return null;
    const scope = pickScope(x);
    const boxes = x.missing.map((c) => tickBox(scope, c, redraw));
    const n = tickedOf(scope, x.missing).length;
    const done = x.commits.filter((c) => !x.missing.includes(c) && !x.skipped.includes(c));
    const line = (c, lead, note) =>
      h(
        'li',
        { class: 'ecommit' },
        h(lead ? 'label' : 'span', { class: lead ? '' : 'elabel' }, lead, mark(c), h('span', { class: 'mono muted' }, c.short), h('span', { class: `gsubj${lead ? '' : ' muted'}`, title: c.subject }, stripTicket(c.subject))),
        note ? h('span', { class: 'muted small' }, note) : h('span', { class: 'muted small', title: `${c.author} · ${fmtDate(c.date)}` }, rel(c.date)),
      );
    const pickBtn = x.needsRebuild
      ? actEl(rebuildDevAct(r, x.target, x.stale), 'primary')
      : actEl(act(n === x.missing.length ? `Cherry-pick ${n} → ${DEV()}` : `Cherry-pick ${n} of ${x.missing.length} → ${DEV()}`, () => pickTicket(r, x, redraw)), 'primary');
    return h(
      'div',
      { class: 'et-repo' },
      h(
        'div',
        { class: 'etarget' },
        h('b', null, repoLabel(r)),
        hasWork(x) && ['→ ', x.target ? code(x.target) : h('span', { class: 'muted' }, `no -${DEV()} branch yet`), h('button', { class: 'link-btn', onClick: () => changeTarget(x, redraw) }, x.target ? 'change' : 'choose')],
        !x.missing.length && h('span', { class: 'ok-text small' }, `all ${x.commits.length - x.skipped.length} picked`),
      ),
      x.needsRebuild && h('div', { class: 'gstep-note warn-text' }, `${x.target} carries ${x.stale} merge commit(s) that ${DEV()} no longer has — ${DEV()} was rewritten after it was cut. Rebuild it from ${DEV()} (own commits kept, backup kept)${x.missing.length ? ', then pick' : ''}.`),
      x.missing.length > 0 && h('ul', { class: 'ecommits' }, x.missing.map((c, i) => line(c, boxes[i]))),
      hasWork(x) && h('div', { class: 'gacts' }, pickBtn),
      x.skipped.length > 0 &&
        h(
          'details',
          { class: 'edone' },
          h('summary', null, `${x.skipped.length} left out — reverted later on the epic (work redone), or the revert itself`),
          h('ul', { class: 'ecommits' }, x.skipped.map((c) => line(c, null, skipText(c)))),
        ),
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
        h(
          'span',
          { class: 'et-keys', title: t.keys.length > 1 ? `Done together: ${t.keys.map((k) => `${k} ${titleOf(k)}`.trim()).join('\n')}` : null },
          t.keys.map((k, i) => [i > 0 && ' + ', h('a', { class: 'key', href: '#' + k, onClick: (ev) => (ev.preventDefault(), openIssueChip(k)) }, i > 0 ? k.replace(`${KEY()}-`, '') : k)]),
        ),
        h('button', { class: 'et-sum gsubj', title: summary, onClick: toggle }, summary),
      ),
      repos.map(cell),
    ),
    open && h('div', { class: 'eticket-body' }, repos.map(repoBody)),
  );
}

function epicFooter(issue, epics, tickets, uat, missing = []) {
  const fetched = Math.min(...epics.map((e) => e.fetchedAt || Infinity));
  const many = epics.length > 1;
  return h(
    'div',
    { class: 'gfooter' },
    // A repo without the epic branch: not started there (the first task's start creates it).
    missing.map((e) =>
      h(
        'span',
        null,
        `${repoLabel(e.repo)}: no ${e.name} yet · `,
        h('button', { class: 'link-btn', onClick: () => gitAction({ action: 'ensure-epic', repo: e.repo, epic: issue.key }, `Create ${e.name} from origin/${UAT()} and push it?\n\nUsually not needed: starting the first task in ${repoLabel(e.repo)} creates it.`) }, `create from ${UAT()}`),
      ),
    ),
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
    // Team rule: the epic is never rebased / force-pushed. Being behind uat is normal (uat keeps moving), so the
    // escape hatch only shows while the epic → uat MR conflicts — for when the lead decides on a rebase anyway.
    epics.filter((e) => uat[e.repo]?.item?.state === 'warn').map((e) => actEl({ ...rebaseEpicAct(e.repo, issue.key), ...(many && { label: `${repoLabel(e.repo)}: ${rebaseEpicAct(e.repo, issue.key).label}` }) }, 'more')),
  );
}
