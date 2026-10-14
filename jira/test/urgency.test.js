'use strict';

// urgency() (public/js/format.js) and countedBySprint() (public/js/progress.js) are browser scripts with no module
// system. Load them into a vm context with the few globals they read stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');

function load(state = { issues: [], type: 'all', q: '', sprint: null }) {
  const ctx = vm.createContext({ h: () => ({}), recentlyTransitioned: new Map(), HOLD_MS: 6000, HOLD_PENDING_MS: 30000, state, Intl, Date, URL });
  vm.runInContext(read('format.js'), ctx);
  vm.runInContext(read('progress.js'), ctx);
  return {
    urgency: (i) => {
      const u = vm.runInContext('urgency', ctx)(i);
      return { score: u.score, level: u.level, labels: Array.from(u.reasons, (r) => r.label) };
    },
    isUrgent: vm.runInContext('isUrgent', ctx),
    counted: () => Array.from(vm.runInContext('countedBySprint', ctx)(), (i) => i.key),
  };
}

const issue = (patch = {}) => ({
  key: 'X-1',
  summary: 'x',
  type: { name: 'Task' },
  status: { name: 'To Do', category: 'new' },
  priority: 'Medium',
  labels: [],
  due: null,
  updated: new Date().toISOString(),
  sprint: null,
  ...patch,
});

test('High priority is urgent and says why', () => {
  const { urgency, isUrgent } = load();
  const i = issue({ priority: 'High' });
  assert.equal(urgency(i).score, 35);
  assert.ok(isUrgent(i));
  assert.deepEqual(urgency(i).labels, ['Priority High']);
});

test('Medium priority is not urgent', () => {
  const { urgency, isUrgent } = load();
  assert.equal(isUrgent(issue()), false);
  assert.deepEqual(urgency(issue()).labels, []);
});

test('an urgent label counts only as a whole label', () => {
  const { urgency } = load();
  for (const l of ['hotfix', 'URGENT', ' asap ', 'gap', 'gấp', 'blocker']) {
    assert.deepEqual(urgency(issue({ labels: [l] })).labels, ['Urgent label'], l);
  }
  for (const l of ['data-gap', 'non-urgent', 'asap-review', 'mapping', 'blockers']) {
    assert.deepEqual(urgency(issue({ labels: [l] })).labels, [], l);
  }
});

test('a Done task is never urgent', () => {
  const { urgency } = load();
  assert.equal(urgency(issue({ status: { name: 'Done', category: 'done' }, priority: 'Highest', labels: ['urgent'] })).score, -1);
});

test('status pills and progress do not count Epics, in any sprint mode', () => {
  const all = { issues: [issue({ key: 'E-1', type: { name: 'Epic' } }), issue({ key: 'T-1', sprint: { id: 7 } }), issue({ key: 'T-2', sprint: { id: 7 } })], type: 'all', q: '', sprint: null };
  assert.deepEqual(load(all).counted(), ['T-1', 'T-2'], 'All sprints');
  assert.deepEqual(load({ ...all, sprint: 7 }).counted(), ['T-1', 'T-2'], 'one sprint');
});
