'use strict';

// OverviewData (public/js/overview-data.js) is a browser script with no module system. Load it into a vm context
// together with the scripts it builds on (format.js, progress.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');

function load() {
  const state = { issues: [], type: 'all', q: '', sprint: null };
  const ctx = vm.createContext({ h: () => ({}), recentlyTransitioned: new Map(), HOLD_MS: 6000, HOLD_PENDING_MS: 30000, NO_SPRINT: -1, state, Intl, Date, URL });
  for (const f of ['format.js', 'progress.js', 'overview-data.js']) vm.runInContext(read(f), ctx);
  return vm.runInContext('OverviewData', ctx);
}

const O = load();
const NOW = new Date(2026, 9, 14, 12, 0, 0);
const day = (offset) => {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const at = (offset) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset, 9).toISOString();

const CATS = { new: 'To Do', indeterminate: 'In Progress', done: 'Done' };
let n = 0;
const issue = (patch = {}) => {
  const category = patch.category || 'new';
  const { category: _c, ...rest } = patch;
  return {
    key: `X-${++n}`,
    summary: 'x',
    type: { name: 'Task' },
    status: { name: CATS[category], category },
    priority: 'Medium',
    labels: [],
    due: null,
    updated: at(0),
    resolved: null,
    sprint: null,
    storyPoints: null,
    ...rest,
  };
};
const sprint = { id: 7, name: 'Sprint 7', state: 'active', startDate: at(-4), endDate: at(5) };

test('scope drops Epics, keeps cancelled tasks (Jira counts them as done) and only the chosen sprint', () => {
  const list = [
    issue({ sprint }),
    issue({ type: { name: 'Epic' }, sprint }),
    issue({ category: 'done', status: { name: 'Cancelled', category: 'done' }, sprint }),
    issue({ sprint: { ...sprint, id: 8 } }),
  ];
  assert.equal(O.scope(list, null).length, 3);
  assert.equal(O.scope(list, 7).length, 2);
});

test('scope with NO_SPRINT keeps only the tasks that were never in a sprint', () => {
  const none = issue();
  const list = [none, issue({ sprint }), issue({ sprintIds: [6] })];
  assert.deepEqual(Array.from(O.scope(list, -1), (i) => i.key), [none.key]);
});

test('kpis count overdue, due soon, story points and what finished this week', () => {
  const list = [
    issue({ due: day(-2), storyPoints: 3 }),
    issue({ due: day(0) }),
    issue({ due: day(3) }),
    issue({ due: day(10) }),
    issue({ category: 'done', storyPoints: 5, resolved: at(-1), due: day(-9) }),
    issue({ category: 'done', storyPoints: 2, resolved: at(-20) }),
  ];
  const k = O.kpis(list, NOW);
  assert.equal(k.total, 6);
  assert.equal(k.open, 4);
  assert.equal(k.done, 2);
  assert.deepEqual({ ...k.sp }, { done: 7, total: 10 });
  assert.equal(k.overdue, 1);
  assert.equal(k.dueSoon, 2);
  assert.equal(k.doneWeek, 1);
});

test('a done task with an old due date is never overdue', () => {
  assert.equal(O.kpis([issue({ category: 'done', due: day(-5), resolved: at(-5) })], NOW).overdue, 0);
});

test('byEpic groups tasks under their Epic and counts the done ones', () => {
  const epic = { key: 'E-1', summary: 'Epic one' };
  const rows = O.byEpic([issue({ epic, storyPoints: 2 }), issue({ epic, category: 'done', storyPoints: 3 }), issue()]);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { key: 'E-1', name: 'Epic one', total: 2, done: 1, spTotal: 5, spDone: 3 });
});

test('burndown starts at the full total and ends at the planned scope; actual stops at today', () => {
  const list = [issue({ sprint, storyPoints: 5 }), issue({ sprint, storyPoints: 5, category: 'done', resolved: at(-1) })];
  const b = O.burndown(list, sprint, NOW);
  assert.equal(b.unit, 'SP');
  assert.equal(b.total, 10);
  assert.equal(b.points[0].ideal, 10);
  assert.equal(b.points[b.length].ideal, 0);
  assert.equal(b.points[b.today].actual, 5);
  assert.equal(b.points[b.today + 1].actual, null);
});

test('burndown counts work done before the sprint started in its total, burned from day 0', () => {
  const list = [issue({ sprint, storyPoints: 5 }), issue({ sprint, storyPoints: 3, category: 'done', resolved: at(-10) })];
  const b = O.burndown(list, sprint, NOW);
  assert.equal(b.total, 8);
  assert.equal(b.points[0].ideal, 5);
  assert.equal(b.points[0].actual, 5);
});

test('burndown counts tasks when nothing is estimated, and is null without sprint dates', () => {
  const list = [issue({ sprint }), issue({ sprint })];
  assert.equal(O.burndown(list, sprint, NOW).unit, 'tasks');
  assert.equal(O.burndown(list, { id: 1 }, NOW), null);
});

test('lists put each open task in one group: overdue, due soon, then idle', () => {
  const late = issue({ due: day(-1), updated: at(-20), sprint, storyPoints: 1 });
  const soon = issue({ due: day(1), sprint, storyPoints: 1 });
  const stale = issue({ updated: at(-9), sprint, storyPoints: 1 });
  const unplanned = issue({ storyPoints: null });
  const l = O.lists([late, soon, stale, unplanned, issue({ due: day(5), sprint, storyPoints: 1 }), issue({ category: 'done', due: day(-3) })], NOW);
  assert.deepEqual(Array.from(l.overdue, (i) => i.key), [late.key]);
  assert.deepEqual(Array.from(l.dueSoon, (i) => i.key), [soon.key]);
  assert.deepEqual(Array.from(l.stale, (i) => i.key), [stale.key]);
  assert.deepEqual(Array.from(l.unplanned, (i) => i.key), [unplanned.key]);
});

test('progress splits the work by status category and counts the days left', () => {
  const list = [issue({ storyPoints: 3 }), issue({ category: 'indeterminate', storyPoints: 2 }), issue({ category: 'done', storyPoints: 5 })];
  const p = O.progress(list, sprint, NOW);
  assert.deepEqual({ ...p }, { unit: 'SP', done: 5, prog: 2, todo: 3, total: 10, daysLeft: 5, unestimated: 0 });
  assert.equal(O.progress([issue(), issue()], null, NOW).unit, 'tasks');
  assert.equal(O.progress([issue()], null, NOW).daysLeft, null);
});

test('progress counts the open tasks that weigh nothing in SP', () => {
  const list = [issue({ category: 'done', storyPoints: 5 }), issue({ category: 'indeterminate' }), issue({ category: 'done' })];
  const p = O.progress(list, sprint, NOW);
  assert.equal(p.done, p.total);
  assert.equal(p.unestimated, 1);
  assert.equal(O.progress([issue(), issue()], null, NOW).unestimated, 0);
});

test('sprintView finds work through every sprint it was in, and reads a closed sprint as it stood when it closed', () => {
  const closed = { id: 6, name: 'Sprint 6', state: 'closed', startDate: at(-20), endDate: at(-6), completeDate: at(-5) };
  const doneIn = issue({ sprintIds: [6], category: 'done', resolved: at(-10) });
  const doneAfter = issue({ sprintIds: [6, 7], sprint, category: 'done', resolved: at(-2) });
  // Done before the sprint began but still in it on Jira: counted, as the Jira sprint board does.
  const before = issue({ sprintIds: [6], category: 'done', resolved: at(-25) });
  const cancelled = issue({ sprintIds: [6], status: { name: 'Cancelled', category: 'done' }, resolved: at(-10) });
  const other = issue({ sprintIds: [7], sprint });
  const view = O.sprintView([doneIn, doneAfter, before, cancelled, other], closed);
  // Cancelled work stays too: the Jira sprint board counts it in its Done column.
  assert.deepEqual(Array.from(view, (i) => i.key), [doneIn.key, doneAfter.key, before.key, cancelled.key]);
  assert.equal(view[1].status.category, 'indeterminate');
  assert.equal(view[1].carriedOver, true);
  assert.deepEqual(Array.from(O.lists(view, NOW).carriedOver, (i) => i.key), [doneAfter.key]);
  // The active sprint keeps the work as it is now.
  assert.equal(O.sprintView([doneAfter], sprint)[0].status.category, 'done');
});

test('bugStats counts open, fixed, cancelled and newly reported bugs; bugs are never "not planned"', () => {
  const bug = (p) => issue({ type: { name: 'Bug' }, sprintIds: [7], sprint, created: at(-1), ...p });
  const all = [bug({}), bug({ category: 'done', resolved: at(-1) }), bug({ status: { name: 'Cancelled', category: 'done' } }), bug({ created: at(-30) }), issue({ sprintIds: [7], sprint })];
  const list = O.sprintView(all, sprint);
  assert.deepEqual({ ...O.bugStats(O.members(all, 7), list, sprint) }, { total: 3, open: 2, fixed: 1, cancelled: 1, reported: 2 });
  assert.equal(O.lists(list, NOW).unplanned.length, 1);
});

test('paceStatus says ahead/behind, and never "done" while unestimated work is open', () => {
  const prog = (p) => ({ unit: 'SP', done: 5, total: 10, unestimated: 0, ...p });
  assert.deepEqual({ ...O.paceStatus(sprint, { left: 5, behind: 2 }, prog()) }, { tone: 'warn', text: 'Behind plan by 2 SP' });
  assert.deepEqual({ ...O.paceStatus(sprint, { left: 5, behind: -3.5 }, prog()) }, { tone: 'ok', text: 'Ahead of plan by 3.5 SP' });
  assert.deepEqual({ ...O.paceStatus(sprint, { left: 0, behind: -3 }, prog({ done: 10, unestimated: 2 })) }, { tone: 'warn', text: 'Estimated work done · 2 open tasks without SP' });
  assert.equal(O.paceStatus(sprint, { left: 0, behind: -3 }, prog({ done: 10 })).text, 'All planned work is done');
  assert.equal(O.paceStatus({ ...sprint, state: 'closed' }, { left: 4, behind: 4 }, prog({ done: 6 })).text, 'Closed with 4 SP not done');
  assert.equal(O.paceStatus({ ...sprint, state: 'closed' }, { left: 0 }, prog({ done: 10, unestimated: 12 })).text, 'Closed with 12 tasks without SP not done');
  assert.equal(O.paceStatus({ ...sprint, state: 'closed' }, { left: 0 }, prog({ done: 10 })).text, 'Closed, all done');
});

test('pace compares what is left today with the ideal line', () => {
  const list = [issue({ sprint, storyPoints: 9 }), issue({ sprint, storyPoints: 9 })];
  const p = O.pace(O.burndown(list, sprint, NOW));
  assert.equal(p.left, 18);
  assert.equal(p.ideal, 10);
  assert.equal(p.behind, 8);
  assert.equal(p.perDay, 3.6);
  assert.equal(O.pace(null), null);
});

test('trend counts new, done, open work and lead time per week', () => {
  const items = [
    issue({ created: at(-20), category: 'done', resolved: at(-1), due: day(0) }),
    issue({ created: at(-3), category: 'done', resolved: at(-2), type: { name: 'Bug' }, due: day(-5) }),
    issue({ created: at(-2) }),
    issue({ created: at(-30) }),
  ];
  const slots = O.trend(items, 'week', NOW);
  assert.equal(slots.length, 12);
  const last = slots[slots.length - 1]; // the week of NOW (Wed 14/10): Mon 12/10 → now
  assert.equal(last.partial, true);
  assert.equal(last.created, 1); // at(-3) is Sunday, the week before
  assert.equal(last.tasksDone + last.bugsDone, last.done);
  assert.equal(last.bugsDone, 1);
  assert.equal(last.bugsNew, 0);
  assert.equal(slots[slots.length - 2].bugsNew, 1);
  assert.equal(O.trend([issue({ created: at(-1), category: 'done', resolved: at(0), storyPoints: 3 }), issue({ created: at(-1), category: 'done', resolved: at(0), storyPoints: 5, type: { name: 'Bug' } })], 'week', NOW).at(-1).spDone, 3);
  assert.equal(last.done, 2);
  assert.equal(last.backlog, 2);
  assert.equal(last.leadMedian, 19);
  assert.equal(last.onTime, 50);
  assert.equal(last.bugShare, 50);
  assert.equal(O.trend(items, 'month', NOW).length, 12);
  assert.equal(O.trend(items, 'year', NOW).length, 5);
});

test('insights flag a growing backlog and stuck tasks, and praise what goes well', () => {
  const growing = Array.from({ length: 12 }, (_, k) => ({ label: String(k), partial: false, created: 5, done: 2, backlog: 10 + 3 * k, leadMedian: 3, leadP85: 5, onTime: 90, bugShare: 0, withDue: 2 }));
  const tips = O.insights(growing, [issue({ updated: at(-10) })], NOW, 'week');
  assert.equal(tips[0].level, 'bad');
  assert.match(tips[0].title, /Backlog/);
  assert.ok(tips.some((t) => /stuck/.test(t.title)));
  assert.ok(tips.some((t) => t.level === 'good' && /Due dates are kept/.test(t.title)));
});

test('metricSummary compares the latest finished period with the average before it', () => {
  const slots = [{ label: 'a', done: 2 }, { label: 'b', done: 4 }, { label: 'c', done: 9 }, { label: 'd', done: 1, partial: true }];
  assert.deepEqual({ ...O.metricSummary(slots, 'done') }, { value: 9, label: 'c', avg: 3, delta: 6 });
  assert.equal(O.metricSummary(slots, 'done', { current: true }).value, 1);
  assert.equal(O.metricSummary([{ label: 'a', x: null }], 'x'), null);
  const late = [{ label: 'a', done: 0 }, { label: 'b', done: 0 }, { label: 'c', done: 4 }, { label: 'd', done: 6 }];
  assert.equal(O.metricSummary(late, 'done').avg, 4); // the empty periods before any work are not averaged in
});
