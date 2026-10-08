'use strict';

// Workspace → "Clean up local branches": per repo, every local branch with one clear status,
// filterable by sprint (through the tickets named in the branch). Server side: lib/git/read.js (branches),
// lib/git/actions.js (delete-branches, which re-checks the merged-into-uat rule).

// ready: merged / backup / gone, free to delete · held: could go but is checked out in a worktree · open: not in uat yet.
function branchStatus(b) {
  const safe = b.mergedToUat || b.kind === 'backup' || b.gone;
  if (!safe) return 'open';
  return b.worktree ? 'held' : 'ready';
}
const STATUS_ORDER = { ready: 0, held: 1, open: 2 };

function cleanupSection() {
  const issueByKey = new Map(state.issues.map((i) => [i.key, i]));
  const sprintOfTicket = (t) => gitState.branchSprints[t] ?? issueByKey.get(t)?.sprint ?? null;
  const inSprint = (b, id = state.sprint) => b.tickets.some((t) => sprintOfTicket(t)?.id === id);
  const candidates = (repo) => (gitState.branches[repo]?.branches || []).filter((b) => !isMainBranch(b.name));

  const sprints = new Map();
  for (const i of state.issues) if (i.sprint) sprints.set(i.sprint.id, i.sprint);
  for (const s of Object.values(gitState.branchSprints)) if (s) sprints.set(s.id, s);
  const perRepo = (id) => gitRepos().map((r) => [r, candidates(r).filter((b) => inSprint(b, id)).length]);
  const sprintList = [...sprints.values()].sort((a, b) => (b.state === 'active') - (a.state === 'active') || b.name.localeCompare(a.name));

  const sprintSelect =
    sprintList.length > 0 &&
    h(
      'select',
      {
        class: 'gsprint',
        'aria-label': 'Filter branches by sprint',
        title: `Show the local branches of one sprint (by ticket) and whether each is merged into ${UAT()}`,
        onChange: (e) => {
          state.sprint = e.target.value ? Number(e.target.value) : null;
          render();
        },
      },
      h('option', { value: '' }, 'All sprints'),
      sprintList.map((s) => {
        const counts = perRepo(s.id);
        const total = counts.reduce((n, [, c]) => n + c, 0);
        const text = total ? counts.map(([r, c]) => `${repoLabel(r)} ${c}`).join(' · ') : 'no branches';
        return h('option', { value: s.id, selected: state.sprint === s.id, disabled: !total && state.sprint !== s.id }, `${s.name} (${s.state}) — ${text}`);
      }),
    );

  const cards = gitRepos().map((repo) => cleanupCard(repo, candidates(repo), inSprint));
  const sprint = sprints.get(state.sprint);

  return h(
    'section',
    { class: 'gsection' },
    h(
      'h2',
      { class: 'section-title' },
      'Clean up local branches',
      sprint && h('span', { class: 'muted small' }, `· ${sprint.name}`),
      h('span', { class: 'spacer' }),
      sprintSelect,
      state.sprint
        ? h('button', { class: 'btn sm', onClick: () => ((state.sprint = null), render()) }, 'Clear sprint')
        : h(
            'label',
            { class: 'muted small gcheck-all', title: 'Also list branches that are not cleanup candidates' },
            h('input', { type: 'checkbox', checked: gitState.cleanupAll, onChange: (e) => ((gitState.cleanupAll = e.target.checked), render()) }),
            'Show all branches',
          ),
    ),
    h('div', { class: 'grepos' }, cards),
  );
}

function cleanupCard(repo, all, inSprint) {
  const data = gitState.branches[repo];
  if (!data) return h('div', { class: 'gcard' }, h('h3', null, repo), h('div', { class: 'muted' }, 'Loading…'));
  const mrData = gitState.mrData[repo];
  const mrOf = (b) => mrsOf(mrData, b.name);
  const hasReason = (b) => branchStatus(b) !== 'open' || ['merged', 'closed'].includes(mrOf(b)[0]?.state) || (b.kind === 'other' && !isMainBranch(b.name));
  const rows = all
    .filter((b) => (state.sprint ? inSprint(b) : gitState.cleanupAll || hasReason(b)))
    .sort((a, b) => STATUS_ORDER[branchStatus(a)] - STATUS_ORDER[branchStatus(b)] || b.date - a.date);
  const n = { ready: 0, held: 0, open: 0 };
  for (const b of rows) n[branchStatus(b)]++;

  const boxes = new Map();
  const count = h('span', null, `Delete merged (0)`);
  const delBtn = actBtn(count, () => {
    const names = [...boxes].filter(([, x]) => x.checked).map(([name]) => name);
    if (!names.length) return toast('Tick the branches to delete first', 'error');
    gitAction(
      { action: 'delete-branches', repo, branches: names },
      `Delete ${names.length} LOCAL branch(es) in ${repo}?\n\n${names.join('\n')}\n\nOrigin is not touched. Each tip is kept under refs/dash-backup/ (restore: git branch <name> refs/dash-backup/<name>/<time>).`,
    );
  }, { danger: true, iconName: 'trash', disabled: n.ready === 0 });
  const allBox = h('input', { type: 'checkbox', 'aria-label': 'Select all deletable branches', disabled: n.ready === 0, onChange: (e) => (boxes.forEach((x) => (x.checked = e.target.checked)), update()) });
  function update() {
    const picked = [...boxes.values()].filter((x) => x.checked).length;
    count.textContent = `Delete merged (${picked})`;
    allBox.checked = picked > 0 && picked === boxes.size;
    allBox.indeterminate = picked > 0 && picked < boxes.size;
  }

  const row = (b) => {
    const st = branchStatus(b);
    const box = h('input', { type: 'checkbox', disabled: st !== 'ready', 'aria-label': b.name, onChange: update });
    if (st === 'ready') boxes.set(b.name, box);
    const why = b.mergedToUat ? `in ${UAT()}` : b.gone ? 'gone on origin' : b.kind === 'backup' ? 'backup/*' : null;
    const chip =
      st === 'ready'
        ? gitChip(`Ready · ${why}`, 'ok', 'Safe to delete: nothing is lost, a backup ref is kept')
        : st === 'held'
          ? gitChip('Checked out', 'accent', `${why}, but checked out at ${b.worktree}`)
          : gitChip(`Not in ${UAT()}`, 'warn', `Not merged into origin/${UAT()}: can't be deleted from here`);
    const mr = mrOf(b)[0];
    return h(
      'li',
      { class: `gbrow ${st}` },
      h('label', { class: 'gbrow-name' }, box, h('span', { class: 'mono gbname', title: b.name }, b.name)),
      h('span', { class: 'gchips' }, chip, mr && mrChip(mr), b.tickets.length > 0 && b.tickets.map((t) => gitChip(t, '', 'Ticket named in the branch'))),
      h('span', { class: 'gbrow-end muted small' }, rel(new Date(b.date * 1000).toISOString())),
      st === 'held' && h('div', { class: 'gbrow-note small' }, h('span', { class: 'muted mono' }, b.worktree), actBtn('Open in Cursor', () => openInCursor(repo, b.worktree), { iconName: 'code' })),
    );
  };

  const fetched = gitState.overview?.repos[repo]?.fetchedAt;
  return h(
    'div',
    { class: 'gcard' },
    h('div', { class: 'gcard-head' }, h('h3', null, repo), h('span', { class: 'spacer' }), h('label', { class: 'gcheck-all small', title: n.ready ? '' : 'Nothing to select' }, allBox, 'Select all')),
    h(
      'div',
      { class: 'gsummary small' },
      h('b', null, `${rows.length}`),
      ' branch(es): ',
      gitChip(`${n.ready} ready`, n.ready ? 'ok' : ''),
      gitChip(`${n.held} checked out`, n.held ? 'accent' : ''),
      gitChip(`${n.open} not in ${UAT()}`, n.open ? 'warn' : ''),
    ),
    h(
      'div',
      { class: 'gfresh muted small' },
      `Merged is judged against origin/${UAT()}, ${fetched ? `fetched ${rel(new Date(fetched).toISOString())}` : 'never fetched'}.`,
      actBtn('Fetch', () => gitAction({ action: 'fetch', repo }), { iconName: 'download' }),
    ),
    h('ul', { class: 'gbranches' }, rows.length ? rows.map(row) : h('li', { class: 'muted' }, state.sprint ? 'No local branch for this sprint.' : 'Nothing to clean up.')),
    h(
      'div',
      { class: 'gstep-act' },
      rows.length > 0 && delBtn,
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, `${data.backups.total} dashboard backup(s)`),
      data.backups.old > 0 && actBtn(`Prune ${data.backups.old} > ${data.backups.days} days`, () => gitAction({ action: 'prune-backups', repo, days: data.backups.days }, `Delete ${data.backups.old} dashboard backup ref(s) older than ${data.backups.days} days in ${repo}?`)),
    ),
  );
}
