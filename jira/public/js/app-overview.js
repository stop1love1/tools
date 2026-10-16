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

function load(opts) {
  loadHistory({ fresh: !!opts && !opts.silent });
  return loadIssues(opts).then(render);
}

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
  // "All sprints" means all of them: no sprint strip for the active one, no burndown.
  const sprint = state.sprint ? O.pickSprint(state.issues, state.sprint) : null;
  const list = O.planned(O.scope(state.issues, state.sprint), sprint);
  const sprintTasks = sprint ? O.planned(O.scope(state.issues, sprint.id), sprint) : list;
  const k = O.kpis(list, now);
  const lists = O.lists(list, now);
  const burn = O.burndown(sprintTasks, sprint, now);
  const pace = O.pace(burn);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  if (!list.length) return h('div', { class: 'empty-state' }, 'No tasks match the current filters.');

  return h(
    'div',
    { class: 'overview' },
    sprintCard(sprint, O.progress(sprintTasks, sprint, now), pace, sprintTasks.length),
    h(
      'div',
      { class: 'ov-stats' },
      statCard('Done', `${pct(k.done, k.total)}%`, { sub: `${k.done} / ${k.total} tasks` }),
      statCard('Overdue', k.overdue, { tone: k.overdue ? 'danger' : '', sub: 'open, past due date' }),
      statCard('Due in 3 days', k.dueSoon, { tone: k.dueSoon ? 'warn' : '', sub: 'today included' }),
      statCard('Not planned', lists.unplanned.length, { sub: 'no sprint or no story points' }),
    ),
    buildTrends(list, now),
    h(
      'div',
      { class: 'ov-main' },
      attentionCard([
        { title: 'Overdue', tone: 'danger', issues: lists.overdue, when: dueBadge },
        { title: 'Due soon', tone: 'warn', issues: lists.dueSoon, when: dueBadge },
        { title: 'Untouched for over 7 days', issues: lists.stale, when: (i) => h('span', { class: 'muted small' }, `${O.idleDays(i, now)}d idle`) },
      ]),
      h('div', { class: 'ov-side' }, sprint && burndownCard(burn, pace), epicsCard(O.byEpic(list), { href: (r) => pageHref('/tasks.html', `#${encodeURIComponent(r.key)}`) })),
    ),
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
