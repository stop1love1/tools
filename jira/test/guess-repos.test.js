'use strict';

// guessRepos lives in a browser script (public/js/git/start.js, no module system). Load it into a vm
// context with the one global it needs stubbed, instead of changing the script to export itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'git', 'start.js'), 'utf8');

function load(repos) {
  const ctx = vm.createContext({ gitRepos: () => repos });
  vm.runInContext(SRC, ctx);
  // Array.from: the result is an array of the vm realm; deepStrictEqual compares prototypes, so copy it into this realm.
  return (summary) => Array.from(vm.runInContext('guessRepos', ctx)({ summary }));
}

const guess = load(['frontend', 'backend']);

test('single tag in each supported format picks that repo', () => {
  for (const s of ['[FE] Add button', 'FE: Add button', 'FE, Add button', 'FE- Add button', 'FE - Add button', 'FE Add button', '[fe] Add button']) {
    assert.deepEqual(guess(s), ['frontend'], s);
  }
  for (const s of ['[BE] Add endpoint', 'BE: Add endpoint', 'BE Add endpoint', '[backend] Add endpoint', 'BACKEND: Add endpoint']) {
    assert.deepEqual(guess(s), ['backend'], s);
  }
});

test('long names are aliases', () => {
  assert.deepEqual(guess('[Frontend] Foo'), ['frontend']);
  assert.deepEqual(guess('Backend: Foo'), ['backend']);
});

test('several tags select several repos, once each', () => {
  assert.deepEqual(guess('[FE][BE] Full stack'), ['frontend', 'backend']);
  assert.deepEqual(guess('[BE][FE] Full stack'), ['backend', 'frontend']);
  assert.deepEqual(guess('FE/BE: Full stack'), ['frontend', 'backend']);
  assert.deepEqual(guess('[fe/be] Full stack'), ['frontend', 'backend']);
  assert.deepEqual(guess('[FE][FE] Dup'), ['frontend']);
});

test('no recognised tag defaults to the frontend repo', () => {
  assert.deepEqual(guess('Add export button'), ['frontend']);
  assert.deepEqual(guess(''), ['frontend']);
  assert.deepEqual(guess(undefined), ['frontend']);
});

test('ordinary words that look like tags are not tags', () => {
  // "Be able to…" starts with "Be" but is a sentence, not a BE tag.
  assert.deepEqual(guess('Be able to export'), ['frontend']);
  assert.deepEqual(guess('Fe able to export'), ['frontend']);
});

test('an unknown word in the tag group stops detection', () => {
  assert.deepEqual(guess('[FE][QA] Foo'), ['frontend']);
  assert.deepEqual(guess('[QA] Foo'), ['frontend']);
  assert.deepEqual(guess('[FE/QA] Foo'), ['frontend']);
});

test('tags only count at the start of the title', () => {
  assert.deepEqual(guess('Fix BE: crash'), ['frontend']);
});

test('falls back to the first repo when there is no frontend repo, and to nothing when there are no repos', () => {
  assert.deepEqual(load(['backend', 'tools'])('Add thing'), ['backend']);
  assert.deepEqual(load([])('Add thing'), []);
});

test('a tag whose repo is not configured is ignored', () => {
  assert.deepEqual(load(['frontend'])('[BE] Add endpoint'), ['frontend']);
});
