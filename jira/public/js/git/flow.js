'use strict';

// Issue drawer: the "Git" block of a ticket — what to do next, where each repo stands (a stage × repo table) and the
// details of one cell at a time. The data comes from stageModel (steps.js); epics are drawn by epic.js.

function gitFlowBlock(issue, detail) {
  if (/epic/i.test(issue.type?.name || '')) return epicBlock(issue);
  if (detail) gitState.jiraMrs.set(issue.key, detail.links.filter((l) => l.kind === 'mr'));
  const box = h(
    'section',
    { class: 'block git-flow', id: 'git-flow' },
    h('h3', null, icon('branch'), 'Git'),
    h('div', { class: 'muted small' }, 'Reading git status…'),
  );
  // A story's work is usually on its subtasks' branches: they are listed under the story's own state.
  const children = detail ? Promise.resolve(detail.children || []) : getDetail(issue.key).then((d) => d.children || [], () => []);
  Promise.all([getFlow(issue.key), children]).then(
    ([f, kids]) => fillFlow(box, issue, f, kids),
    (e) => box.replaceChildren(box.firstChild, h('div', { class: 'error-box' }, e.message)),
  );
  return box;
}

function fillFlow(box, issue, f, kids = []) {
  const repos = gitRepos().filter((r) => f.repos[r]);
  const used = repos.filter((r) => f.repos[r].uat || f.repos[r].develop || f.repos[r].commits?.length);
  const redraw = () => box.isConnected && fillFlow(box, issue, f, kids);
  const subtasks = kids.length > 0 && subtaskBlock(kids, redraw);

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
    h('button', { class: 'gchip link', title: 'The epic branch this ticket goes into — click to change', onClick: editEpic }, `into epic/${f.epic}`, epicOverride(issue.key) ? ' (manual)' : ''),
    h('button', { class: 'icon-btn sm', title: 'Reload git status', onClick: refreshGit }, icon('refresh')),
  );

  // Jira's parent Epic may not be the epic branch the work actually went into.
  const elsewhere = [...new Set(repos.flatMap((x) => f.repos[x].epicsWithTicket || []))].filter((e) => e !== f.epic);
  const onCurrent = repos.some((x) => (f.repos[x].epicsWithTicket || []).includes(f.epic));
  const useEpic = (e) => {
    LS.set('gitEpic', { ...LS.get('gitEpic', {}), [issue.key]: e });
    refreshGit();
  };
  const hint = elsewhere.length > 0 &&
    !onCurrent && {
      state: 'warn',
      title: `${issue.key} commits are on ${elsewhere.map((e) => `epic/${e}`).join(', ')} — not on epic/${f.epic}`,
      why: 'Jira’s parent Epic is not the epic branch the work went into.',
      primary: act(`Use epic/${elsewhere[0]}`, () => useEpic(elsewhere[0])),
      secondary: elsewhere.slice(1).map((e) => act(`Use epic/${e}`, () => useEpic(e))),
    };

  const broken = used.filter((r) => f.repos[r].error).map((r) => h('div', { class: 'error-box' }, h('b', null, repoLabel(r)), ' — ', f.repos[r].error));
  const ok = used.filter((r) => !f.repos[r].error);
  if (!ok.length) {
    // Nothing on the ticket itself: a story shows its subtasks (where the work is) and keeps starting its own branch at hand.
    const own = subtasks
      ? [
          subtasks,
          h('div', { class: 'gfooter' }, `${issue.key} itself has no branch — the work is on its subtasks.`, h('button', { class: 'link-btn', onClick: () => startTaskPop(issue) }, `Start a branch for ${issue.key}…`)),
        ]
      : startPanel(issue, f);
    box.replaceChildren(...[head, hint && nextBlock([hint]), ...broken, ...(broken.length ? [] : own)].filter(Boolean));
    return;
  }

  const models = ok.map((repo) => stageModel(issue, f, f.repos[repo], gitState.mrData[repo]));
  const items = nextItems(models);
  if (hint) items.unshift(hint);
  const allDone = models.every((m) => Object.values(m.cells).every((c) => c.state === 'done'));

  const firstMine = items.find((i) => i.state !== 'wait' && i.cell)?.cell || null;
  const sel = gitState.sel.has(issue.key) ? gitState.sel.get(issue.key) : firstMine;
  const choose = (id) => {
    gitState.sel.set(issue.key, id === sel ? null : id);
    redraw();
  };
  const panel = panelFor(issue, models, sel);

  box.replaceChildren(
    ...[
      head,
      ...broken,
      nextBlock(items, { allDone, choose, mrOff: ok.some((r) => gitState.mrData[r]?.error) }),
      stageTable(models, sel, choose),
      stateLegend(),
      panel && stagePanel(panel, () => choose(sel)),
      flowFooter(issue, models, repos.filter((x) => !used.includes(x)), choose),
      mrUnavailable(ok, issue.key),
      subtasks,
    ].filter(Boolean),
  );
  // MR states arrive later (GitLab API); redraw once they're in.
  for (const repo of ok) {
    if (!gitState.mrData[repo] || !gitState.mrs.has(repo)) getMrs(repo).then(redraw);
  }
}

// The user's moves first (fixes, then todos), then what waits on someone else; stage order, then repo order.
function nextItems(models) {
  const rank = { warn: 0, todo: 1, wait: 2 };
  const out = [];
  for (const m of models) {
    for (const c of m.r.conflicts || []) {
      out.push({ state: 'warn', rank: -1, repo: m.label, title: `${c.op} stopped on a conflict`, why: `In ${c.dir}. Resolve the files in Cursor, then Continue.`, els: conflictActions(m.repo, c.dir, c.op) });
    }
    for (const s of stages()) {
      const c = m.cells[s.id];
      if (!(c.state in rank) || c.quiet || !c.title) continue;
      out.push({
        state: c.state,
        rank: rank[c.state],
        repo: m.label,
        title: c.title,
        why: c.why,
        primary: c.detail.primary,
        secondary: c.secondary || c.detail.secondary,
        cell: `${m.repo}:${s.id}`,
      });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

const stateDot = (state) => h('span', { class: 'gdot', 'data-state': state, 'aria-hidden': 'true' }, state === 'done' ? icon('check') : state === 'warn' ? '!' : '');

function nextBlock(items, { allDone = false, choose, mrOff = false } = {}) {
  const mine = items.filter((i) => i.state !== 'wait');
  const waiting = items.filter((i) => i.state === 'wait');
  const head = mine.length
    ? `Next · ${mine.length} for you${waiting.length ? ` · ${waiting.length} waiting` : ''}`
    : waiting.length
      ? `Nothing for you · waiting on ${waiting.length}`
      : allDone
        ? `Done — in ${UAT()} and ${DEV()}`
        : mrOff
          ? 'Nothing for you right now · MR status unavailable'
          : 'Nothing to do right now';
  const item = (i) =>
    h(
      'div',
      { class: 'gnext-item', 'data-state': i.state },
      stateDot(i.state),
      h(
        'div',
        { class: 'gnext-body' },
        h('div', { class: 'gnext-title' }, i.repo && h('span', { class: 'grepo' }, i.repo), h('span', null, i.title)),
        i.why && h('div', { class: 'gnext-why' }, i.why),
        (i.primary || i.secondary?.length > 0 || i.els || (i.cell && choose)) &&
          h(
            'div',
            { class: 'gacts' },
            actEl(i.primary, 'primary'),
            (i.secondary || []).map((a) => actEl(a)),
            i.els,
            i.cell && choose && h('button', { class: 'link-btn small', onClick: () => choose(i.cell) }, 'Details'),
          ),
      ),
    );
  return h('div', { class: `gnext${mine.length ? ' mine' : allDone ? ' done' : ''}` }, h('div', { class: 'gnext-head' }, head), [...mine, ...waiting].map(item));
}

// Rows are stages, columns are repos. A ticket's branch usually has the same name in every repo: one cell then.
function stageTable(models, sel, choose) {
  const cols = `--cols:${models.length}`;
  const row = (cls, ...kids) => h('div', { class: `gm-row${cls ? ' ' + cls : ''}`, style: cols }, kids);
  const label = (text, hint) => h('div', { class: 'gm-label' }, h('b', null, text), hint && h('span', null, hint));

  const names = models.map((m) => m.branch);
  const same = models.length > 1 && names.every((n) => n && n === names[0]);
  const chips = (list, prefix) => list.map((c) => gitChip(prefix ? `${c.text} · ${prefix}` : c.text, c.kind || '', c.title));
  const branchCell = (name, chipEls, span) =>
    h(
      'div',
      { class: `gm-cell gm-branch${span ? ' span' : ''}` },
      name ? h('button', { class: 'gcode gbranch', title: `${name}\nClick to copy`, onClick: () => copyText(name, 'Branch name copied') }, name) : h('span', { class: 'muted' }, '—'),
      chipEls.length > 0 && h('span', { class: 'gchips' }, chipEls),
    );
  // One branch cell for every repo: a chip all repos share is shown once, the others say which repo they are about.
  const shared = (c) => models.every((m) => m.branchChips.some((x) => x.text === c.text));
  const sharedChips = same ? [...chips(models[0].branchChips.filter(shared)), ...models.flatMap((m) => chips(m.branchChips.filter((c) => !shared(c)), m.label))] : [];
  const branchRow = same
    ? row('', label('Branch', 'click to copy'), branchCell(names[0], sharedChips, true))
    : row('', label('Branch', 'click to copy'), models.map((m) => branchCell(m.branch, chips(m.branchChips))));

  const cell = (m, id) => {
    const c = m.cells[id];
    const pid = `${m.repo}:${id}`;
    const on = sel === pid;
    return h(
      'button',
      { class: `gm-cell${on ? ' on' : ''}`, 'data-state': c.state, 'aria-pressed': String(on), disabled: !choose, title: `${m.label} · ${id}: details`, onClick: choose && (() => choose(pid)) },
      stateDot(c.state),
      h('span', { class: 'gm-text' }, h('b', null, c.text), c.sub && h('span', null, c.sub)),
    );
  };

  return h(
    'div',
    { class: 'gmatrix' },
    row('gm-head', h('div', { class: 'gm-label' }, 'Stage'), models.map((m) => h('div', { class: 'gm-repo' }, m.label))),
    branchRow,
    stages().map((s) => [
      s.fork && h('div', { class: 'gm-fork' }, icon('branch'), 'After the epic: two separate tracks, in any order'),
      row('', label(s.label, s.hint), models.map((m) => cell(m, s.id))),
    ]),
  );
}

const stateLegend = () =>
  h(
    'div',
    { class: 'glegend' },
    [
      ['done', 'done'],
      ['todo', 'your move'],
      ['warn', 'needs a fix'],
      ['wait', 'waiting on others'],
      ['na', 'not yet'],
    ].map(([s, t]) => h('span', null, stateDot(s), t)),
  );

// The open panel: a cell (`backend:epic`), or a repo's branch list / flow warnings (`backend:branches`, `backend:checks`).
function panelFor(issue, models, sel) {
  if (!sel) return null;
  const [repo, what] = sel.split(':');
  const m = models.find((x) => x.repo === repo);
  if (!m) return null;
  if (m.cells[what]) return m.cells[what].detail;
  if (what === 'branches') {
    return { title: `${m.label} · branches for ${issue.key}`, where: '', body: branchList(issue, m.r), note: 'The branch in use drives the table. “Use” pins another one for this ticket.', secondary: [], more: [] };
  }
  if (what === 'checks') {
    const checks = flowChecks(issue.key, m.r, gitState.mrData[repo]);
    return { title: `${m.label} · flow warnings`, where: '', body: h('ul', { class: 'gpanel-list' }, checks.map((c) => h('li', null, c))), secondary: [], more: [] };
  }
  return null;
}

function stagePanel(d, close) {
  const more = (d.more || []).filter(Boolean);
  const c = d.commits;
  return h(
    'div',
    { class: 'gpanel' },
    h(
      'div',
      { class: 'gpanel-head' },
      h('div', { class: 'gpanel-title' }, h('b', null, d.title), d.where && h('span', { class: 'gpanel-where', title: d.where }, d.where)),
      h('button', { class: 'icon-btn sm', title: 'Close', 'aria-label': 'Close details', onClick: close }, icon('x')),
    ),
    d.steps?.length > 0 &&
      h(
        'ol',
        { class: 'gpanel-steps' },
        d.steps.map((s) => h('li', { 'data-state': s.state }, stateDot(s.state), h('span', { class: 'gpanel-step' }, h('span', null, s.text), s.chips))),
      ),
    c &&
      h(
        'div',
        { class: 'gpanel-commits' },
        h('div', { class: 'gpanel-label' }, c.label),
        h('ul', null, c.items.map((x) => h('li', null, h(x.box ? 'label' : 'span', { class: 'gcommit' }, x.box, h('span', { class: 'mono muted' }, x.short), h('span', { class: 'gsubj', title: x.subject }, x.subject))))),
        c.target && h('label', { class: 'gpanel-target' }, h('span', { class: 'muted small' }, 'Into'), c.target, c.targetHint && h('span', { class: 'muted small' }, c.targetHint)),
      ),
    d.body,
    d.note && h('div', { class: 'gpanel-note' }, d.note),
    (d.primary || d.secondary?.length > 0) && h('div', { class: 'gacts' }, actEl(d.primary, 'primary'), (d.secondary || []).map((a) => actEl(a))),
    more.length > 0 && h('div', { class: 'gpanel-more' }, h('span', { class: 'muted' }, 'Other options'), more.map((a) => actEl(a, 'more'))),
  );
}

function flowFooter(issue, models, unused, choose) {
  const many = models.length > 1;
  const items = [];
  for (const m of models) {
    const n = branchCount(m.r);
    if (n) items.push(h('button', { class: 'link-btn', onClick: () => choose(`${m.repo}:branches`) }, `${many ? `${m.label}: ` : ''}${n} branch${n > 1 ? 'es' : ''}`));
  }
  for (const m of models) {
    const n = flowChecks(issue.key, m.r, gitState.mrData[m.repo]).length;
    if (n) items.push(h('button', { class: 'link-btn warn-text', onClick: () => choose(`${m.repo}:checks`) }, `⚠ ${many ? `${m.label}: ` : ''}${n} flow warning${n > 1 ? 's' : ''}`));
  }
  const fetched = Math.min(...models.map((m) => m.r.fetchedAt || Infinity));
  if (Number.isFinite(fetched)) items.push(h('span', null, `Fetched ${rel(new Date(fetched).toISOString())}`));
  items.push(
    h(
      'button',
      {
        class: 'link-btn',
        onClick: async () => {
          for (const m of models) await gitAction({ action: 'fetch', repo: m.repo });
        },
      },
      'Fetch now',
    ),
  );
  if (models.some((m) => !gitState.mrData[m.repo])) items.push(h('span', null, 'loading MR status…'));
  const branch = models.find((m) => m.r.uat)?.r.uat.name;
  if (branch) {
    for (const x of unused) items.push(h('button', { class: 'link-btn', onClick: () => startTaskPop(issue, { repos: [x], preset: branch }) }, `+ Start in ${repoLabel(x)}`));
  }
  return h('div', { class: 'gfooter' }, items);
}

// Nothing in git yet: one button that does the whole setup the rule asks for, and the stages ahead (all "not yet").
function startPanel(issue, f) {
  const epicReady = gitRepos().some((r) => f.repos[r]?.epic?.remote);
  const other = gitRepos().flatMap((r) => (f.repos[r]?.otherBranches || []).map((b) => [r, b]));
  const ghost = gitRepos()
    .filter((r) => f.repos[r])
    .map((repo) => ({
      repo,
      label: repoLabel(repo),
      branch: null,
      branchChips: [],
      cells: Object.fromEntries(stages().map((s) => [s.id, { state: 'na', text: '—', sub: '' }])),
    }));
  return [
    h(
      'div',
      { class: 'gnext mine' },
      h('div', { class: 'gnext-head' }, 'Next'),
      h(
        'div',
        { class: 'gnext-item', 'data-state': 'todo' },
        stateDot('todo'),
        h(
          'div',
          { class: 'gnext-body' },
          h('div', { class: 'gnext-title' }, h('span', null, 'Not started in git yet')),
          other.length > 0 &&
            h('div', { class: 'gnext-why' }, gitChip('check first', 'warn'), ` Branches naming ${issue.key} outside the flow: `, other.map(([r, b]) => [code(b), h('span', { class: 'muted small' }, ` (${repoLabel(r)}) `)])),
          h(
            'ol',
            { class: 'gplan' },
            h('li', null, epicReady ? ['Use ', code(`epic/${f.epic}`), ' (already on origin)'] : ['Create ', code(`epic/${f.epic}`), ` from ${UAT()}`]),
            h('li', null, 'Create ', code(`feature/${issue.key}-<short-description>-${UAT()}`), ' from the epic'),
            h('li', null, 'Stash your unfinished work and check the new branch out'),
          ),
          h('div', { class: 'gacts' }, actEl(act('Start…', () => startTaskPop(issue), { icon: 'branch' }), 'primary'), actEl(act('Start with Claude', () => startWithClaude(issue), { icon: 'ai' }))),
        ),
      ),
    ),
    ghost.length > 0 && stageTable(ghost, null, null),
  ];
}

// How many task branches a repo has for the ticket, when it is worth listing them (several, or an old-style name).
function branchCount(r) {
  const list = [...(r.branches?.uat || []), ...(r.branches?.develop || [])];
  return list.length >= 2 || list.some((b) => b.legacy) ? list.length : 0;
}

// All the ticket's task branches in a repo (a ticket can have several), with what each still carries.
// The primary one drives the table; "Use" pins another one for this ticket.
function branchList(issue, r) {
  const list = [...(r.branches?.uat || []), ...(r.branches?.develop || [])];
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
        b.track === 'uat' && !primary.includes(b.name) && actBtn('Use', () => pinBranch(issue.key, r.repo, b.name), { title: 'Make this the branch the table works on, for this ticket' }),
        b.name === pinned && actBtn('Auto', () => pinBranch(issue.key, r.repo, null), { title: 'Go back to picking the branch automatically' }),
        b.name !== r.current && !b.worktree && actBtn('Checkout', () => checkoutBranch(r.repo, b.name, r.dirty), { iconName: 'branch', iconOnly: true }),
      ),
    );
  return h('ul', { class: 'gpanel-branches' }, list.map(row));
}

// GitLab unreachable (VPN off…): say so once for the repos concerned, offer a retry, and fall back to the MR links
// recorded on Jira.
function mrUnavailable(repos, key) {
  const off = repos.filter((r) => gitState.mrData[r]?.error);
  if (!off.length) return null;
  const error = gitState.mrData[off[0]].error;
  const jira = (key && gitState.jiraMrs.get(key)) || [];
  const retry = () => {
    for (const repo of off) {
      gitState.mrs.delete(repo);
      gitState.mrStale.add(repo);
      delete gitState.mrData[repo];
    }
    refreshGit();
  };
  return h(
    'div',
    { class: 'gmr-off' },
    h(
      'div',
      { class: 'gstep-note' },
      h('span', { class: 'warn-text' }, `MR status unavailable${repos.length > 1 ? ` (${off.map(repoLabel).join(', ')})` : ''}`),
      h('span', { class: 'muted', title: error }, `(${error})`),
      h('button', { class: 'link-btn', onClick: retry }, 'Retry'),
    ),
    jira.length > 0 &&
      h('ul', { class: 'link-list compact' }, jira.map((l) => h('li', null, icon('mr'), h('a', { href: l.url, target: '_blank', rel: 'noopener', title: l.url }, l.title.replace(/^Merge request - /, '')), h('span', { class: 'tag muted small' }, 'from Jira')))),
  );
}

// A story's subtasks, where its work usually is: their next actions, then one row per subtask with a column per repo
// (the four stages as dots, plus what is up next). A row's key opens the subtask.
function subtaskBlock(kids, redraw) {
  const label = h('div', { class: 'gpanel-label' }, `Subtasks · ${kids.length}`);
  const unread = kids.filter((k) => !gitState.flowOf.has(k.key));
  if (unread.length) {
    // getFlow records each result in flowOf first, so the redraw finds them all read (no loop).
    Promise.allSettled(unread.map((k) => getFlow(k.key))).then(redraw);
    return h('div', { class: 'gsub' }, label, h('div', { class: 'muted small' }, 'Reading the subtasks’ git status…'));
  }

  const rows = kids.map((k) => {
    const f = gitState.flowOf.get(k.key);
    const kid = { key: k.key, summary: k.summary, type: { name: k.type }, status: k.status };
    const repos = f?.repos ? gitRepos().filter((r) => f.repos[r] && !f.repos[r].error && (f.repos[r].uat || f.repos[r].develop || f.repos[r].commits?.length)) : [];
    return { k, kid, f, models: repos.map((r) => stageModel(kid, f, f.repos[r], gitState.mrData[r])) };
  });
  const cols = gitRepos().filter((r) => rows.some((x) => x.models.some((m) => m.repo === r)));
  for (const r of cols) if (!gitState.mrs.has(r)) getMrs(r).then(redraw);

  const items = rows
    .flatMap(({ k, models }) => nextItems(models).map((i) => ({ ...i, repo: `${k.key} · ${i.repo}`, cell: k.key })))
    .sort((a, b) => a.rank - b.rank);

  // What a repo column says about a subtask: a fix first, then the user's move, then what waits on others.
  const focus = (m) => {
    const all = stages();
    const s = ['warn', 'todo', 'wait'].map((st) => all.find((x) => m.cells[x.id].state === st)).find(Boolean) || all.find((x) => m.cells[x.id].state !== 'done');
    return s ? { state: m.cells[s.id].state, text: `${s.label}: ${m.cells[s.id].text}` } : { state: 'done', text: 'Done' };
  };
  const cell = (m) => {
    if (!m) return h('div', { class: 'gs-cell muted' }, '—');
    const x = focus(m);
    return h(
      'div',
      { class: 'gs-cell' },
      h('span', { class: 'gs-dots' }, stages().map((s) => h('span', { title: `${s.label}: ${m.cells[s.id].text}` }, stateDot(m.cells[s.id].state)))),
      h('span', { class: `gs-focus s-${x.state}` }, x.text),
    );
  };
  const row = ({ k, kid, f, models }) => {
    const done = k.status?.category === 'done';
    const branch = models.map((m) => m.branch).find(Boolean);
    return h(
      'div',
      { class: `gs-row${done ? ' gs-done' : ''}`, style: `--cols:${cols.length}` },
      h(
        'div',
        { class: 'gs-ticket' },
        h('div', { class: 'gs-title' }, h('a', { class: 'key', href: '#' + k.key, onClick: (ev) => (ev.preventDefault(), openDetail(k.key)) }, k.key), h('span', { class: 'gsubj', title: k.summary }, k.summary)),
        f?.error
          ? h('span', { class: 'warn-text small' }, f.error)
          : branch
            ? h('button', { class: 'gcode gbranch', title: `${branch}\nClick to copy`, onClick: () => copyText(branch, 'Branch name copied') }, branch)
            : h('span', { class: 'muted small' }, 'No branch yet ', !done && h('button', { class: 'link-btn', onClick: () => startTaskPop(kid) }, 'Start…')),
      ),
      cols.map((r) => cell(models.find((m) => m.repo === r))),
    );
  };

  return h(
    'div',
    { class: 'gsub' },
    label,
    items.length > 0 && nextBlock(items, { choose: (key) => openDetail(key) }),
    h(
      'div',
      { class: 'gs-table' },
      cols.length > 0 && h('div', { class: 'gs-row gs-head', style: `--cols:${cols.length}` }, h('div', null, 'Subtask'), cols.map((r) => h('div', null, repoLabel(r)))),
      rows.map(row),
    ),
  );
}
