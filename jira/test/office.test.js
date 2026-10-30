'use strict';

// The 3D office's rules (public/js/office/rules.js, a browser script) and the server's team grouping (lib/team.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { mkTemp, rmTemp } = require('./_helpers');

const ctx = vm.createContext({ Date, Math });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'office', 'rules.js'), 'utf8'), ctx);
const R = (expr) => vm.runInContext(expr, ctx);
const toTask = R('toTask');
const stateOf = R('stateOf');
const zoneOf = R('zoneOf');
const diffTasks = R('diffTasks');

const NOW = new Date(2026, 9, 14, 12, 0, 0);
const api = (patch = {}) => ({ key: 'X-1', summary: 's', type: 'Task', status: { name: 'In Progress', category: 'indeterminate' }, priority: 'Medium', due: null, updated: NOW.toISOString(), storyPoints: 3, ...patch });
const person = (tasks, role = 'dev') => ({ id: 'a', name: 'A B', role, tasks: tasks.map((t) => toTask(api(t), NOW)) });

test('toTask: status category and name → office status', () => {
  assert.equal(toTask(api({ status: { name: 'To Do', category: 'new' } }), NOW).st, 'todo');
  assert.equal(toTask(api(), NOW).st, 'prog');
  assert.equal(toTask(api({ status: { name: 'Code Review', category: 'indeterminate' } }), NOW).st, 'review');
  assert.equal(toTask(api({ status: { name: 'Ready for QA', category: 'indeterminate' } }), NOW).st, 'review');
  assert.equal(toTask(api({ status: { name: 'Ready for Test', category: 'indeterminate' } }), NOW).st, 'review');
  assert.equal(toTask(api({ status: { name: 'In Testing', category: 'indeterminate' } }), NOW).st, 'review');
  assert.equal(toTask(api({ status: { name: 'Ready for Production', category: 'indeterminate' } }), NOW).st, 'review');
  assert.equal(toTask(api({ status: { name: 'Selftest', category: 'indeterminate' } }), NOW).st, 'prog');
  assert.equal(toTask(api({ status: { name: 'Closed', category: 'done' } }), NOW).st, 'done');
});

test('toTask: priority, type, due and idle days', () => {
  assert.equal(toTask(api({ priority: 'Highest' }), NOW).pr, 'highest');
  assert.equal(toTask(api({ priority: 'Blocker' }), NOW).pr, 'highest');
  assert.equal(toTask(api({ priority: 'High' }), NOW).pr, 'high');
  assert.equal(toTask(api({ priority: null }), NOW).pr, 'medium');
  assert.equal(toTask(api({ type: 'Bug' }), NOW).type, 'bug');
  assert.equal(toTask(api({ due: '2026-10-12' }), NOW).due, -2);
  assert.equal(toTask(api({ due: '2026-10-14' }), NOW).due, 0);
  assert.equal(toTask(api({ updated: new Date(2026, 9, 9, 11).toISOString() }), NOW).idle, 5);
});

test('stateOf: Highest open work wins, then review, then in progress', () => {
  assert.equal(stateOf(person([{ priority: 'Highest', status: { name: 'To Do', category: 'new' } }, {}])), 'urgent');
  // A done Highest task no longer counts.
  assert.equal(stateOf(person([{ priority: 'Highest', status: { name: 'Done', category: 'done' } }, {}])), 'desk');
  assert.equal(stateOf(person([{ status: { name: 'In Review', category: 'indeterminate' } }, {}])), 'review');
  assert.equal(stateOf(person([{ status: { name: 'To Do', category: 'new' } }])), 'todo');
  assert.equal(stateOf(person([{ status: { name: 'Done', category: 'done' } }])), 'done');
  assert.equal(stateOf(person([])), 'done');
  // Overdue alone does not send anyone to the war room.
  assert.equal(stateOf(person([{ due: '2026-10-01' }])), 'desk');
});

test('zoneOf: people at work sit in their role\'s room', () => {
  assert.equal(zoneOf(person([{}], 'dev')), 'dev');
  assert.equal(zoneOf(person([{}], 'qa')), 'qa');
  // Not started or waiting for review: still at their desk.
  assert.equal(zoneOf(person([{ status: { name: 'To Do', category: 'new' } }], 'qa')), 'qa');
  assert.equal(zoneOf(person([{ status: { name: 'In Review', category: 'indeterminate' } }], 'dev')), 'dev');
  assert.equal(zoneOf(person([{ priority: 'Highest' }], 'qa')), 'urgent');
  assert.equal(zoneOf(person([])), 'done');
  // BA in the QA room; PO and PM at the meeting table, even with nothing open.
  assert.equal(zoneOf(person([{}], 'ba')), 'qa');
  assert.equal(zoneOf(person([{}], 'po')), 'review');
  assert.equal(zoneOf(person([], 'pm')), 'review');
  assert.equal(zoneOf(person([{ priority: 'Highest' }], 'pm')), 'urgent');
});

test('scheduleAt: office hours, standup, lunch, and the sprint\'s first and last day', () => {
  const scheduleAt = R('scheduleAt'), S = { hours: '08:30-17:30', lunch: '12:00-13:00', standup: '09:15', retro: '16:00' };
  const at = (h, m, d = 14) => new Date(2026, 9, d, h, m); // 14 Oct 2026 is a Wednesday
  const kind = (h, m, sprint, d) => scheduleAt(at(h, m, d), S, sprint).kind;
  assert.equal(kind(8, 0), 'off');
  assert.equal(kind(9, 0), 'work');
  assert.equal(scheduleAt(at(9, 0), S).next.name, 'Daily standup');
  assert.equal(kind(9, 20), 'standup');
  assert.equal(kind(9, 30), 'work');
  assert.equal(kind(12, 30), 'lunch');
  assert.equal(kind(17, 30), 'off');
  assert.equal(kind(10, 0, null, 17), 'off'); // Saturday
  const sprint = { startDate: at(0, 0).toISOString(), endDate: at(0, 0, 16).toISOString() };
  assert.equal(kind(9, 50, sprint), 'planning');
  assert.equal(kind(16, 30, sprint, 16), 'retro');
  assert.equal(kind(9, 20, { startDate: 'x' }), 'standup');
  assert.equal(scheduleAt(at(9, 0), { hours: 'bad' }).kind, 'work'); // a bad setting falls back to the defaults
});

test('byOrder: the Team panel order first, then by name', () => {
  const byOrder = R('byOrder');
  const people = [{ id: 'c', name: 'Cee' }, { id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }];
  assert.deepEqual([...people].sort(byOrder(['b'])).map((p) => p.id), ['b', 'a', 'c']);
});

test('short: drops the team suffix of a Jira display name', () => {
  const short = R('short');
  assert.equal(short({ name: 'Nguyễn Thái Tiệp - TIEP' }), 'Thái Tiệp');
  assert.equal(short({ name: 'Cù Huy Toàn (VSF-QTVHG)' }), 'Huy Toàn');
  assert.equal(short({ name: 'Nguyễn Văn Huy - (huyn)' }), 'Văn Huy');
  assert.equal(short({ name: 'Vũ Thị Vui' }), 'Thị Vui');
  assert.equal(short({ name: 'X', me: true }), 'You');
});

test('diffTasks: new tasks and status moves', () => {
  const before = [toTask(api({ key: 'X-1' }), NOW), toTask(api({ key: 'X-2', status: { name: 'To Do', category: 'new' } }), NOW)];
  const after = [toTask(api({ key: 'X-1', status: { name: 'Done', category: 'done' } }), NOW), toTask(api({ key: 'X-2', status: { name: 'To Do', category: 'new' } }), NOW), toTask(api({ key: 'X-3' }), NOW)];
  const d = [...diffTasks(before, after)].map((c) => `${c.kind}:${c.task.k}:${c.was || ''}`); // an array of this realm
  assert.deepEqual(d, ['move:X-1:prog', 'new:X-3:']);
});

// ---- lib/team.js ----
let tmp;
test.before(() => {
  tmp = mkTemp();
});
test.after(() => rmTemp(tmp));

const raw = (key, assignee, sprints, extra = {}) => ({
  key,
  fields: {
    summary: key,
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    assignee: assignee && { accountId: assignee, displayName: assignee.toUpperCase() },
    customfield_10020: sprints,
    customfield_10016: 2,
    ...extra,
  },
});
const S1 = { id: 1, name: 'S1', state: 'active', startDate: '2026-10-01' };
const S2 = { id: 2, name: 'S2', state: 'active', startDate: '2026-10-01' };

test('groupTeam: one entry per assignee, in the busiest active sprint, me first', () => {
  const { groupTeam } = require('../lib/team');
  const out = groupTeam(
    [raw('A-1', 'ann', [S1]), raw('A-2', 'bob', [S1]), raw('A-3', 'bob', [S1]), raw('B-1', 'cid', [S2]), raw('A-4', null, [S1]), raw('A-5', 'ann', [S1], { issuetype: { name: 'Epic' } })],
    { me: 'zed', meName: 'Zed', qa: ['BOB'] },
  );
  assert.equal(out.sprint.id, 1);
  assert.deepEqual(out.members.map((m) => [m.accountId, m.me, m.role, m.tasks.length]), [['zed', true, 'dev', 0], ['ann', false, 'dev', 1], ['bob', false, 'qa', 2]]);
  assert.deepEqual(out.members[1].tasks[0], { key: 'A-1', summary: 'A-1', type: 'Task', status: { name: 'In Progress', category: 'indeterminate' }, priority: 'Medium', due: null, updated: null, storyPoints: 2 });
});

test('groupTeam: an asked-for sprint wins over the busiest one', () => {
  const { groupTeam } = require('../lib/team');
  const out = groupTeam([raw('A-1', 'ann', [S1]), raw('A-2', 'bob', [S1]), raw('B-1', 'cid', [S2])], { me: 'cid', sprintId: 2 });
  assert.equal(out.sprint.id, 2);
  assert.deepEqual(out.members.map((m) => m.accountId), ['cid']);
});

test('withProfiles: the Team panel sets gender, and its role wins over the QA list; order and schedule come along', () => {
  const { withProfiles } = require('../lib/team');
  const out = withProfiles({ sprint: null, members: [{ accountId: 'ann', role: 'dev' }, { accountId: 'bob', role: 'qa' }] }, { people: { ann: { role: 'qa', gender: 'female' } }, order: ['bob', 'ann'], standup: '09:15' });
  assert.deepEqual(out.members, [
    { accountId: 'ann', role: 'qa', gender: 'female' },
    { accountId: 'bob', role: 'qa', gender: null },
  ]);
  assert.deepEqual(out.order, ['bob', 'ann']);
  assert.equal(out.schedule.standup, '09:15');
});

test('savePerson: keeps known values only, clears a person with nothing set, leaves other settings alone', () => {
  const config = require('../lib/config');
  fs.writeFileSync(process.env.DASHBOARD_CONFIG_FILE, JSON.stringify({ office: { qaPeople: ['Bob'] } }));
  config.load();
  assert.deepEqual(config.savePerson('ann', { gender: 'female', role: 'ba', level: 'lead', x: 1 }), { ann: { gender: 'female', role: 'ba' } });
  assert.deepEqual(config.savePerson('ann', { gender: 'female', role: 'po' }), { ann: { gender: 'female', role: 'po' } });
  assert.throws(() => config.savePerson('ann', { role: 'boss' }), /Unknown role/);
  assert.deepEqual(config.savePerson('ann', { gender: '' }), {});
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.DASHBOARD_CONFIG_FILE, 'utf8')), { office: { qaPeople: ['Bob'] } });
  assert.throws(() => config.savePerson('bad id', {}), /accountId/);
});

test('saveOrder: keeps valid, unique account ids in the given order', () => {
  const config = require('../lib/config');
  assert.deepEqual(config.saveOrder(['bob', 'ann', 'bob', 'bad id', 7]), ['bob', 'ann']);
  assert.deepEqual(config.get().office.order, ['bob', 'ann']);
  assert.deepEqual(config.saveOrder([]), []);
  assert.throws(() => config.saveOrder('bob'), /order/);
});
