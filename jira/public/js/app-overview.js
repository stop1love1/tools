'use strict';

// index.html: progress overview. Same issues as the other pages (state.js): sprint progress, a few numbers, and what needs attention.
// window.PAGE = 'overview' is set inline in index.html before this script loads.

window.PAGE_SHORTCUTS = [['r', 'Refresh data'], ['/', 'Jump to a task']];

const PERIOD_NAMES = { day: 'day', week: 'week', month: 'month', year: 'year' };
const PERIOD_KEY = 'jd:ovPeriod';
const METRIC_KEY = 'jd:ovMetric';
// Trends come from /api/history (a longer window than the task list), one fetch per period and user.
const trendState = { period: 'week', metric: 'delivered', key: null, data: null, loading: false, error: null };
try {
  const saved = localStorage.getItem(PERIOD_KEY);
  if (PERIOD_NAMES[saved]) trendState.period = saved;
  trendState.metric = localStorage.getItem(METRIC_KEY) || 'delivered';
} catch {}

function openIssueChip(key) {
  showPageLoader();
  location.href = pageHref('/tasks.html', `#${encodeURIComponent(key)}`);
}

const sprintState = { key: null, data: null, error: null };
const sprintKey = () => (state.sprint && state.sprint !== NO_SPRINT ? `${state.sprint}|${state.user || ''}` : null);

async function loadSprint({ fresh = false } = {}) {
  const key = sprintKey();
  if (!key) return;
  const params = new URLSearchParams();
  if (state.user) params.set('user', state.user);
  if (fresh) params.set('fresh', '1');
  try {
    const data = await api(`/api/sprint/${state.sprint}${params.size ? '?' + params : ''}`);
    if (key !== sprintKey()) return; // the sprint or user changed meanwhile
    Object.assign(sprintState, { key, data, error: null });
    state.extraSprints = data.sprint ? [data.sprint] : [];
  } catch (e) {
    if (key !== sprintKey()) return;
    Object.assign(sprintState, { key, data: null, error: e.message });
  }
  render();
}

function load(opts) {
  loadHistory({ fresh: !!opts && !opts.silent });
  const fresh = !!opts?.fresh;
  loadSprint({ fresh });
  return loadIssues(opts).then(render).then(() => allSprintTasks({ fresh }));
}

// "All sprints" counts every task of the sprints in the list, as the Tasks page does. A chosen sprint has /api/sprint
// already (loadSprint); the call is still made so the sprint filter's counts settle (the server shares the request).
const allSprintTasks = (opts) => loadSprintTasks(opts).then(render);

async function loadHistory({ fresh = false } = {}) {
  const key = `${trendState.period}|${state.user || ''}`;
  if (!fresh && trendState.key === key && trendState.data) return render();
  trendState.loading = true;
  render();
  const params = new URLSearchParams({ days: String(OverviewData.PERIODS[trendState.period].days) });
  if (state.user) params.set('user', state.user);
  if (fresh) params.set('fresh', '1');
  try {
    const data = await api(`/api/history?${params}`);
    if (key !== `${trendState.period}|${state.user || ''}`) return; // the period or user changed meanwhile
    Object.assign(trendState, { key, data, error: null });
  } catch (e) {
    trendState.error = e.message;
  } finally {
    trendState.loading = false;
    render();
  }
}

function setMetric(id) {
  trendState.metric = id;
  try {
    localStorage.setItem(METRIC_KEY, id);
  } catch {}
  render();
}

function setPeriod(p) {
  trendState.period = p;
  try {
    localStorage.setItem(PERIOD_KEY, p);
  } catch {}
  loadHistory();
}

function buildTrends(list, now) {
  const O = OverviewData;
  const name = PERIOD_NAMES[trendState.period];
  const head = h(
    'div',
    { class: 'ov-section-head' },
    h('h2', null, 'Trends'),
    h(
      'div',
      { class: 'seg', role: 'tablist', 'aria-label': 'Group by' },
      Object.keys(PERIOD_NAMES).map((p) => h('button', { role: 'tab', 'aria-selected': String(p === trendState.period), onClick: () => setPeriod(p) }, `By ${p}`)),
    ),
    h('span', { class: 'muted small' }, `Last ${O.PERIODS[trendState.period].slots} ${name}s · all sprints, ignores the JQL filter`),
  );
  if (trendState.error) return [head, h('div', { class: 'error-box' }, h('strong', null, 'Could not load the history. '), trendState.error)];
  if (!trendState.data) return [head, h('div', { class: 'empty-state loading-state' }, h('span', { class: 'spin' }, icon('refresh')), 'Loading history…')];

  const slots = O.trend(trendState.data.issues, trendState.period, now);
  const c1 = 'var(--chart-1)';
  const c2 = 'var(--chart-2)';
  const c3 = 'var(--chart-3)';
  const pct = (v) => `${v}%`;
  const days = (v) => `${v}d`;
  const hasDue = slots.some((r) => r.withDue);
  // Story points when the team estimates, task counts otherwise. Bugs carry no points, so they get their own chart.
  const useSP = slots.some((r) => r.spDone > 0);
  const sp = (v) => `${v} SP`;
  // Three lines in one unit (a count of issues); the story points ride along in the tooltip.
  const workLines = [
    { key: 'tasksDone', label: 'Tasks done', color: c1 },
    { key: 'bugsDone', label: 'Bugs fixed', color: c2 },
    { key: 'bugsNew', label: 'Bugs reported', color: c3 },
    useSP && { key: 'spDone', label: 'story points delivered', hidden: true, fmt: sp },
  ].filter(Boolean);
  const metrics = [
    useSP
      ? { id: 'delivered', label: `Delivered per ${name}`, key: 'spDone', better: 'up', fmt: sp, chartFmt: String, series: workLines }
      : { id: 'delivered', label: `Tasks done per ${name}`, key: 'tasksDone', better: 'up', series: workLines },
    { id: 'bugs', label: `Bugs reported per ${name}`, key: 'bugsNew', better: 'down', series: [{ key: 'bugsNew', label: 'Reported', color: c3 }, { key: 'bugsDone', label: 'Fixed', color: c2 }] },
    { id: 'backlog', label: 'Open work', key: 'backlog', current: true, better: 'down', series: [{ key: 'backlog', label: 'Open', color: c1 }] },
    { id: 'lead', label: 'Lead time (median)', key: 'leadMedian', better: 'down', fmt: days, series: [{ key: 'leadMedian', label: 'Median', color: c1 }, { key: 'leadP85', label: '85% done within', color: c2 }] },
    hasDue && { id: 'onTime', label: 'Done on time', key: 'onTime', better: 'up', fmt: pct, max: 100, series: [{ key: 'onTime', label: 'On time', color: c1 }] },
  ].filter(Boolean);
  const active = metrics.find((m) => m.id === trendState.metric) || metrics[0];
  const hints = {
    delivered: `issues per ${name}: tasks done, bugs fixed and bugs reported${useSP ? ' · story points in the tooltip' : ''}`,
    bugs: `new bugs reported vs bugs fixed, per ${name} — reported above fixed means bugs pile up`,
    backlog: `open tasks at the end of each ${name}`,
    lead: 'days from created to done',
    onTime: 'share of tasks with a due date that were done by it',
  };
  return [
    head,
    h(
      'div',
      { class: `ov-trends${trendState.loading ? ' is-loading' : ''}` },
      h(
        'div',
        { class: 'ov-metrics', role: 'tablist', 'aria-label': 'Metric to chart' },
        metrics.map((m) => metricTile(m, O.metricSummary(slots, m.key, { current: m.current }), slots, { selected: m === active, onSelect: () => setMetric(m.id) })),
      ),
      card(active.label, `${hints[active.id]} · hover for values`, trendChart(slots, [{ title: '', fmt: active.chartFmt || active.fmt, max: active.max, series: active.series }], { lane: 200 }), { cls: 'ov-trend-card' }),
      insightsCard(O.insights(slots, list, now, name)),
      h('div', { class: 'ov-trends-foot' }, trendTable(slots), trendState.data.truncated && h('p', { class: 'muted small' }, 'Only the latest 2000 tasks were loaded: the oldest periods may be incomplete.')),
    ),
  ];
}

function buildOverview() {
  const O = OverviewData;
  const now = new Date();
  const fetched = sprintKey() && sprintState.key === sprintKey() ? sprintState.data : null;
  // "All sprints" means all of them: no sprint strip for the active one, no burndown. "No sprint" is read the same way,
  // over the tasks in none.
  const noSprint = state.sprint === NO_SPRINT ? NO_SPRINT : null;
  const sprint = state.sprint && !noSprint ? fetched?.sprint || O.pickSprint(state.issues, state.sprint) : null;
  const source = fetched?.issues || state.issues;
  const all = sprint ? O.members(source, sprint.id) : countable(source).filter((i) => isSprintTask(i, noSprint));
  const list = sprint ? O.sprintView(source, sprint) : O.scope(source, noSprint);
  const closed = sprint?.state === 'closed';
  const k = O.kpis(list, now);
  const lists = O.lists(list, now);
  const bugs = O.bugStats(all, list, sprint);
  const burn = O.burndown(list, sprint, now);
  const pace = O.pace(burn);
  const prog = O.progress(list, sprint, now);
  const status = O.paceStatus(sprint, pace, prog);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  // Where the numbers come from while the full sprint is loading, or when it could not be loaded.
  const note = state.sprintTasksLoading && !sprintKey()
    ? h('p', { class: 'ov-source muted small' }, [h('span', { class: 'spin' }, icon('refresh')), "Loading every task of the sprints…"])
    : sprintKey() &&
    !fetched &&
    h('p', { class: 'ov-source muted small' }, sprintState.error && sprintState.key === sprintKey() ? `Could not load the whole sprint (${sprintState.error}): numbers below are from the task list only.` : [h('span', { class: 'spin' }, icon('refresh')), 'Loading every task of this sprint…']);

  // Partial numbers would read as final: show them once every task is in (or the sprint failed to load).
  const failed = sprintState.error && sprintState.key === sprintKey();
  if (sprintKey() ? !fetched && !failed : state.sprintTasksLoading) return h('div', { class: 'overview' }, note);

  if (!list.length) return h('div', { class: 'overview' }, note, h('div', { class: 'empty-state' }, 'No tasks match the current filters.'));

  const idle = (i) => h('span', { class: 'muted small' }, `${O.idleDays(i, now)}d idle`);
  const doneLater = (i) => h('span', { class: 'muted small' }, i.status.category === 'done' || i.resolved ? `done ${fmtDay(O.isoDay(O.doneAt(i)))}` : 'still open');
  // A closed sprint has nothing left to chase: what matters there is what it did not finish.
  const groups = closed
    ? [{ title: 'Carried over (not done when the sprint closed)', tone: 'warn', issues: lists.carriedOver, when: doneLater }]
    : [
        { title: 'Overdue', tone: 'danger', issues: lists.overdue, when: dueBadge },
        { title: 'Due soon', tone: 'warn', issues: lists.dueSoon, when: dueBadge },
        { title: 'Untouched for over 7 days', issues: lists.stale, when: idle },
      ];
  const attention = groups.some((g) => g.issues.length) && attentionCard(groups);
  const epics = epicsCard(O.byEpic(list), { href: (r) => pageHref('/tasks.html', `#${encodeURIComponent(r.key)}`) });
  const bugSub = [`${bugs.fixed} fixed`, bugs.cancelled && `${bugs.cancelled} cancelled`, bugs.reported != null && `${bugs.reported} new this sprint`].filter(Boolean).join(' · ');

  return h(
    'div',
    { class: 'overview' },
    note,
    sprintCard(sprint, prog, status, list.length),
    h(
      'div',
      { class: 'ov-stats' },
      statCard('Done', `${pct(k.done, k.total)}%`, { sub: `${k.done} / ${k.total} tasks${k.sp.total ? ` · ${k.sp.done} / ${k.sp.total} SP` : ''}` }),
      statCard(closed ? 'Bugs left open' : 'Open bugs', bugs.open, { tone: bugs.open ? 'warn' : '', sub: bugs.total || bugs.cancelled ? bugSub : 'no bugs' }),
      closed
        ? statCard('Carried over', lists.carriedOver.length, { tone: lists.carriedOver.length ? 'warn' : '', sub: 'not done when it closed' })
        : statCard('Overdue', k.overdue, { tone: k.overdue ? 'danger' : '', sub: k.dueSoon ? `+ ${k.dueSoon} due in 3 days` : 'open, past due date' }),
      statCard('Not estimated', lists.unplanned.length, { tone: lists.unplanned.length ? 'warn' : '', sub: 'open, no SP or sprint (bugs aside)' }),
    ),
    // Sprint first, then the history across sprints: nothing about this sprint sits below the trends.
    h(
      'div',
      { class: `ov-main${attention || sprint ? '' : ' single'}` },
      h('div', { class: 'ov-side' }, attention || epics),
      (attention || sprint) && h('div', { class: 'ov-side' }, sprint && burndownCard(burn, pace, status), attention && epics),
    ),
    // The tips read today's open work: a closed sprint's snapshot is not that.
    buildTrends(closed ? O.scope(state.issues, null) : list, now),
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

// Header search: jump to the task list filtered by the text (a key opens straight on it there).
function jumpToTasks(text) {
  const u = new URL(pageHref('/tasks.html'), location.origin);
  if (text) u.searchParams.set('q', text);
  showPageLoader();
  location.href = u.pathname + u.search;
}
$('#search')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') jumpToTasks(e.target.value.trim());
});
window.onShortcutExtra = (e, typing) => {
  if (!typing && e.key === '/') {
    e.preventDefault();
    $('#search').focus();
  }
};

window.onUserFilterChange = () => load();
window.onJqlChange = () => load();
window.onSprintFilterChange = () => {
  render();
  loadSprint();
  allSprintTasks();
};
// No opts: the refresh button or "r", which also skips the server's sprint cache.
window.onShortcutR = (opts) => load(opts || { fresh: true });

async function initPage() {
  const cached = !!state.fetchedAt;
  if (cached) render();
  const firstLoad = load({ silent: cached });
  loadUsers();
  return cached ? undefined : firstLoad;
}
window.initPage = initPage;
