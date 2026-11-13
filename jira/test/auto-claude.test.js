'use strict';

// lib/auto-claude.js: the server-side loop that opens my not-started tasks in Claude Code one at a time, takes newly
// assigned ones, and moves on when the task in hand is dev done (or skipped).

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkTemp, rmTemp, purge } = require('./_helpers');

let tmp;
let ac;
let jira; // key → issue; what the fake Jira search returns
let opened; // prompts sent to Claude Code

const issue = (key, { status = 'To Do', category = 'new', type = 'Story', sprint = 'active', summary = `BE: ${key}` } = {}) => ({
  key,
  summary,
  type: { name: type },
  status: { name: status, category },
  sprint: sprint && { id: 1, name: 'Sprint 1', state: sprint },
  sprints: sprint ? [{ id: 1, name: 'Sprint 1', state: sprint }] : [],
});

// The JQLs the module sends: the To Do list, or `key = X AND assignee = currentUser()` for the task in hand.
async function fakeList(jql) {
  const one = jql.match(/^key = (\S+)/);
  if (one) return jira[one[1]] ? [jira[one[1]]] : [];
  return Object.values(jira).filter((i) => i.status.category === 'new');
}

test.beforeEach(() => {
  tmp = mkTemp();
  purge();
  ac = require('../lib/auto-claude');
  jira = { 'VLEARN-1': issue('VLEARN-1'), 'VLEARN-2': issue('VLEARN-2') };
  opened = [];
  ac._setDeps({ listIssues: fakeList, open: async (prompt) => opened.push(prompt) });
});
test.afterEach(() => rmTemp(tmp));

const keysIn = (prompts) => prompts.map((p) => p.match(/VLEARN-\d+/)[0]);

test('off: nothing is opened', async () => {
  await ac.tick();
  assert.deepEqual(opened, []);
});

test('on: opens the first task, and only one until it moves on', async () => {
  const v = await ac.update({ on: true });
  assert.equal(v.current, 'VLEARN-1');
  assert.deepEqual(keysIn(opened), ['VLEARN-1']);
  await ac.tick();
  assert.deepEqual(keysIn(opened), ['VLEARN-1'], 'still in To Do: no second task');
  jira['VLEARN-1'] = issue('VLEARN-1', { status: 'In Development', category: 'indeterminate' });
  await ac.tick();
  assert.deepEqual(keysIn(opened), ['VLEARN-1'], 'started is not dev done (default advance: qa)');
  jira['VLEARN-1'] = issue('VLEARN-1', { status: 'Done', category: 'done' });
  await ac.tick();
  assert.deepEqual(keysIn(opened), ['VLEARN-1', 'VLEARN-2']);
});

test('a newly assigned task joins the queue, ticked, and is logged', async () => {
  await ac.update({ on: true });
  jira['VLEARN-3'] = issue('VLEARN-3');
  await ac.tick(); // reads Jira fresh (the view's list is cached 30 s)
  const after = await ac.view();
  const t3 = after.candidates.find((i) => i.key === 'VLEARN-3');
  assert.ok(t3, 'listed');
  assert.equal(t3.ticked, true, 'new task is ticked');
  assert.ok(after.log.some((l) => /New task: VLEARN-3/.test(l.text)));
});

test('unticked tasks are passed over; skip takes the next ticked one', async () => {
  jira['VLEARN-3'] = issue('VLEARN-3');
  await ac.update({ tick: { key: 'VLEARN-2', on: false } });
  await ac.update({ on: true });
  assert.deepEqual(keysIn(opened), ['VLEARN-1']);
  const v = await ac.update({ skip: true });
  assert.equal(v.current, 'VLEARN-3', 'VLEARN-2 is unticked');
  assert.deepEqual(keysIn(opened), ['VLEARN-1', 'VLEARN-3']);
});

test('settings filter the candidates: types and the active sprint', async () => {
  jira['VLEARN-4'] = issue('VLEARN-4', { type: 'Bug' });
  jira['VLEARN-5'] = issue('VLEARN-5', { sprint: 'closed' });
  let v = await ac.update({ cfg: { types: ['Story'] } });
  assert.deepEqual(v.candidates.map((i) => i.key), ['VLEARN-1', 'VLEARN-2']);
  v = await ac.update({ cfg: { types: ['Story', 'Bug'] } });
  assert.deepEqual(v.candidates.map((i) => i.key).sort(), ['VLEARN-1', 'VLEARN-2', 'VLEARN-4'], 'VLEARN-5 is not in the active sprint');
});

test('guessRepos reads the summary tags; no tag → frontend', () => {
  assert.deepEqual(ac.guessRepos('BE: API'), ['backend']);
  assert.deepEqual(ac.guessRepos('[FE][BE] Both'), ['frontend', 'backend']);
  assert.deepEqual(ac.guessRepos('Something else'), ['frontend']);
});
