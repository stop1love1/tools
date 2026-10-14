'use strict';

// index.html: progress overview. Same issues as the other pages (state.js), summarised as KPIs, charts and lists.
// window.PAGE = 'overview' is set inline in index.html before this script loads.

window.PAGE_SHORTCUTS = [['r', 'Refresh data']];

function openIssueChip(key) {
  showPageLoader();
  location.href = pageHref('/tasks.html', `#${encodeURIComponent(key)}`);
}

function load(opts) {
  return loadIssues(opts).then(render);
}

function buildOverview() {
  const O = OverviewData;
  const now = new Date();
  const list = O.scope(state.issues, state.sprint);
  const everything = O.scope(state.issues, null);
  const sprint = O.pickSprint(state.issues, state.sprint);
  const sprintTasks = sprint ? O.scope(state.issues, sprint.id) : list;
  const k = O.kpis(list, now);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const open = list.filter(O.isOpen);
  const lists = O.lists(list, now);
  const timeline = O.dueTimeline(list, now);
  const weekLabel = (r) => r.date.slice(5).replace('-', '/');

  return h(
    'div',
    { class: 'overview' },
    h(
      'div',
      { class: 'ov-kpis' },
      kpiCard('Open tasks', k.open, { sub: `${k.total} in scope` }),
      kpiCard('Done', `${pct(k.done, k.total)}%`, { sub: `${k.done}/${k.total} tasks` }),
      kpiCard('Story points', `${k.sp.done}/${k.sp.total}`, { sub: `${pct(k.sp.done, k.sp.total)}% done`, title: 'Story points of done tasks / all tasks in scope' }),
      kpiCard('Overdue', k.overdue, { tone: k.overdue ? 'danger' : '', sub: 'open, past due date' }),
      kpiCard('Due in 3 days', k.dueSoon, { tone: k.dueSoon ? 'warn' : '', sub: 'including today' }),
      kpiCard('Done this week', k.doneWeek, { sub: 'last 7 days' }),
    ),
    h(
      'div',
      { class: 'ov-grid-cards' },
      chartCard('Status', 'Tasks by status category', donutChart(O.byCategory(list), 'tasks')),
      chartCard('Statuses', 'Every workflow status', hBarChart(O.byStatus(list))),
      chartCard('Priority', 'All tasks in scope', hBarChart(O.byPriority(list))),
      chartCard('Type', 'Split by status category', stackedBars(O.byType(list))),
      chartCard('Epics', 'Done / total tasks under each Epic', progressBars(O.byEpic(list), { href: (r) => pageHref('/tasks.html', `#${encodeURIComponent(r.key)}`) }), 'wide'),
      chartCard('Sprints', 'Done and planned per sprint (story points, or tasks when none are estimated)', sprintColumns(O.bySprint(state.issues)), 'wide'),
      chartCard('Due dates', `Open tasks due in the next 14 days${timeline.overdue ? `, plus ${timeline.overdue} overdue` : ''}`, columnChart([{ name: 'Overdue', n: timeline.overdue, date: 'overdue' }, ...timeline.slots], { danger: (r) => r.date === 'overdue', label: (r) => (r.date === 'overdue' ? 'Late' : weekLabel(r)) }), 'wide'),
      chartCard('Age of open tasks', 'Days since the last update', columnChart(O.ageBuckets(list, now), { color: 'var(--warn)' })),
      chartCard(`Burndown${sprint ? ` — ${sprint.name}` : ''}`, 'Remaining work against the ideal line', lineChart(O.burndown(sprintTasks, sprint, now)), 'wide'),
      chartCard('Done per week', 'Last 8 weeks, tasks resolved (all sprints)', columnChart(O.weeklyDone(everything, now).map((r) => ({ ...r, name: weekLabel(r) })), { color: 'var(--done-dot)' })),
    ),
    h(
      'div',
      { class: 'ov-grid-cards' },
      taskList('Overdue and due soon', 'Due within 3 days, soonest first', lists.attention),
      taskList('In progress', 'Most recently updated first', lists.doing),
      taskList('Not touched for over 7 days', 'Oldest update first', lists.stale, { extra: (i) => h('span', { class: 'muted small' }, `${O.idleDays(i, now)}d`) }),
      taskList('Missing sprint or story points', 'Open tasks that cannot be planned yet', lists.unplanned, { extra: (i) => h('span', { class: 'muted small' }, [!i.sprint && 'no sprint', !i.storyPoints && 'no SP'].filter(Boolean).join(', ')) }),
    ),
    !open.length && !k.done && h('div', { class: 'empty-state' }, 'No tasks match the current filters.'),
  );
}

function render() {
  renderMeta();
  renderSprints();
  syncUrl();
  const main = $('#main');
  if (state.error) {
    main.replaceChildren(
      h(
        'div',
        { class: 'error-box' },
        h('div', null, h('strong', null, 'Failed to load data. '), state.error),
        state.errorLogin && h('a', { class: 'btn primary', href: '/oauth/login' }, 'Sign in to Atlassian'),
      ),
    );
    return;
  }
  if (state.loading && state.loadedFor !== issuesQuery()) {
    main.replaceChildren(h('div', { class: 'empty-state loading-state' }, h('span', { class: 'spin' }, icon('refresh')), 'Loading overview…'));
    return;
  }
  if (!state.fetchedAt) return;
  main.replaceChildren(buildOverview());
}

window.onUserFilterChange = () => load();
window.onJqlChange = () => load();
window.onSprintFilterChange = () => render();
window.onShortcutR = (opts) => load(opts);

async function initPage() {
  const cached = !!state.fetchedAt;
  if (cached) render();
  const firstLoad = load({ silent: cached });
  loadUsers();
  return cached ? undefined : firstLoad;
}
window.initPage = initPage;
