'use strict';

// Settings → Workflow: public/js/workflow.js (phaseOf, statusRank) and its fields in lib/config.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { mkTemp, rmTemp } = require('./_helpers');
const { phaseOf, stageOf, isDevDone, statusRank, setWorkflow } = require('../public/js/workflow.js');

let tmp;
test.before(() => {
  tmp = mkTemp(); // a config.json of its own
});
test.after(() => rmTemp(tmp));

test('defaults: the VLEARN test flow, and common names of other teams', () => {
  setWorkflow();
  assert.equal(phaseOf('Ready for SIT'), 'testQueue'); // on dev: the tester's filter
  assert.equal(phaseOf('Test SIT Done'), 'tested'); // the dev deploys it to uat
  assert.equal(phaseOf('Ready for UAT'), 'testing'); // on uat: the tester checks it
  assert.equal(phaseOf('Ready for Production'), ''); // Jira Done category: QA done, not in the lists
  for (const name of ['Ready for Test', 'Ready for QA']) assert.equal(phaseOf(name), 'testQueue', name);
  for (const name of ['Code Review', 'In Review']) assert.equal(phaseOf(name), '', name); // code review: still dev
  assert.equal(phaseOf('In Testing'), 'testing');
  for (const name of ['In Progress', 'Selftest', '']) assert.equal(phaseOf(name), '', name); // still with the developer
  assert.ok(statusRank('In Progress') < statusRank('Ready for SIT'));
  assert.ok(statusRank('ready for sit') < statusRank('Ready for UAT'));
  assert.equal(statusRank('Something else'), 1000);
});

test('stageOf: todo, dev, qa (dev done), done (QA done)', () => {
  setWorkflow();
  const s = (name, category) => stageOf({ name, category });
  assert.equal(s('To Do', 'new'), 'todo');
  assert.equal(s('In Progress', 'indeterminate'), 'dev');
  assert.equal(s('Ready for SIT', 'indeterminate'), 'qa');
  assert.equal(s('Test SIT Done', 'new'), 'qa'); // the board may file it under To Do
  assert.equal(s('Ready for UAT', 'indeterminate'), 'qa');
  assert.equal(s('Ready for Production', 'done'), 'done');
  assert.equal(s('Cancelled', 'done'), 'done');
  assert.equal(isDevDone({ name: 'In Progress', category: 'indeterminate' }), false);
  assert.equal(isDevDone({ name: 'Ready for SIT', category: 'indeterminate' }), true);
});

test('names win over /patterns/, any case; bad patterns are skipped', () => {
  try {
    setWorkflow({ testQueue: ['Chờ test', '/^pending/'], testing: ['/test/'], tested: ['Tested on DEV'] });
    assert.equal(phaseOf('chờ TEST'), 'testQueue');
    assert.equal(phaseOf('Pending QA'), 'testQueue');
    assert.equal(phaseOf('In Test'), 'testing');
    assert.equal(phaseOf('Tested on dev'), 'tested'); // a name, though /test/ matches it
    assert.equal(phaseOf('Ready for SIT'), ''); // no longer listed
    setWorkflow({ testQueue: ['/[bad/'] }); // refused when saved
    assert.equal(phaseOf('[bad'), '');
  } finally {
    setWorkflow();
  }
});

test('Settings: saved, sent to the pages, bad patterns refused', () => {
  const config = require('../lib/config');
  fs.writeFileSync(process.env.DASHBOARD_CONFIG_FILE, '{}');
  config.load();
  assert.ok(config.client().workflow.testQueue.includes('Ready for SIT')); // the defaults
  assert.throws(() => config.save({ 'workflow.testing': ['/[bad/'] }), /bad pattern/);
  config.save({ 'workflow.testQueue': ['Chờ test'], 'workflow.tested': [] });
  assert.deepEqual(config.client().workflow.testQueue, ['Chờ test']);
  assert.deepEqual(config.client().workflow.tested, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.DASHBOARD_CONFIG_FILE, 'utf8')), { workflow: { testQueue: ['Chờ test'], tested: [] } });
  fs.writeFileSync(process.env.DASHBOARD_CONFIG_FILE, '{}');
  config.load();
  setWorkflow();
});
