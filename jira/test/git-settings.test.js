'use strict';

// lib/git/settings.js: the branch-name patterns built from config (project key, uat / develop names, branch types).

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkTemp, rmTemp, purge } = require('./_helpers');

let tmp;
let settings;

test.before(() => {
  tmp = mkTemp();
  purge();
  ({ settings } = require('../lib/git/settings'));
});
test.after(() => rmTemp(tmp));

test('taskMatch parses a single-ticket branch on each track', () => {
  const s = settings();
  assert.deepEqual(s.taskMatch('feature/VLEARN-123-add-export-uat'), { ids: ['123'], track: 'uat', legacy: false });
  assert.deepEqual(s.taskMatch('bugfix/VLEARN-9-fix-crash-develop'), { ids: ['9'], track: 'develop', legacy: false });
});

test('taskMatch parses a branch that merges several tickets', () => {
  const m = settings().taskMatch('feature/VLEARN-4546-4547-4548-bulk-edit-uat');
  assert.deepEqual(m.ids, ['4546', '4547', '4548']);
  assert.equal(m.track, 'uat');
});

test('taskMatch treats a branch without a suffix as legacy on the uat track', () => {
  assert.deepEqual(settings().taskMatch('feature/VLEARN-4546-4547-bulk-edit'), { ids: ['4546', '4547'], track: 'uat', legacy: true });
});

test('taskMatch rejects other keys, unknown types and non-task branches', () => {
  const s = settings();
  for (const b of ['feature/OTHER-123-foo-uat', 'wip/VLEARN-123-foo-uat', 'uat', 'develop', 'main', 'epic/VLEARN-100', 'release/1.2']) {
    assert.equal(s.taskMatch(b), null, b);
  }
});

test('epicRe and branchRe accept the team naming', () => {
  const s = settings();
  assert.ok(s.epicRe.test('epic/VLEARN-100'));
  assert.ok(!s.epicRe.test('epic/vlearn-100'));
  assert.ok(!s.epicRe.test('feature/VLEARN-100'));
  assert.ok(s.branchRe.test('epic/VLEARN-100'));
  assert.ok(s.branchRe.test('feature/VLEARN-123-add-export'));
  assert.ok(!s.branchRe.test('feature/add-export'));
});

test('toDevelop maps a uat task branch to its develop twin', () => {
  const s = settings();
  assert.equal(s.toDevelop('feature/VLEARN-123-add-export-uat'), 'feature/VLEARN-123-add-export-develop');
  // Legacy name without a suffix gets one.
  assert.equal(s.toDevelop('feature/VLEARN-123-add-export'), 'feature/VLEARN-123-add-export-develop');
});

test('isProtected covers uat, develop, main and release/*', () => {
  const s = settings();
  for (const b of ['uat', 'develop', 'main', 'release/1.0', 'release/x']) assert.equal(s.isProtected(b), true, b);
  for (const b of ['feature/VLEARN-1-a-uat', 'epic/VLEARN-1', 'releases']) assert.equal(s.isProtected(b), false, b);
});

test('subjectRe, grep and ticket helpers use the project key', () => {
  const s = settings();
  const m = 'VLEARN-123: add export'.match(s.subjectRe);
  assert.equal(m[1], 'VLEARN-123');
  assert.equal(m[2], '123');
  assert.equal('Merge VLEARN-123: x'.match(s.subjectRe), null);
  assert.equal(s.grep('123'), '^VLEARN-123:');
  assert.equal(s.ticket('123'), 'VLEARN-123');
});
