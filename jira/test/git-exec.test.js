'use strict';

// lib/git/exec.js against real throwaway repos in the temp dir (no mocks: this is the code that drives rebases and pushes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mkTemp, rmTemp, purge } = require('./_helpers');

let tmp;
let exec;
let repo;

const sh = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (file, text) => fs.writeFileSync(path.join(repo, file), text);
const commit = (msg) => (sh(repo, 'add', '-A'), sh(repo, 'commit', '-q', '-m', msg));

test.before(() => {
  tmp = mkTemp();
  purge();
  exec = require('../lib/git/exec');
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  write('a.txt', 'one\ntwo\nthree\n');
  commit('init');
});
test.after(() => rmTemp(tmp));

test('stampTime reads the timestamp of a backup ref, with or without -undo', () => {
  const at = Date.UTC(2026, 8, 29, 10, 15, 0);
  assert.equal(exec.stampTime('refs/dash-backup/feature/VLEARN-1-x-uat/20260929T101500'), at);
  assert.equal(exec.stampTime('refs/dash-backup/feature/VLEARN-1-x-uat/20260929T101500-undo'), at);
  assert.equal(exec.stampTime('refs/dash-backup/feature/VLEARN-1-x-uat/latest'), 0);
});

test('stamp produces a value stampTime can read back', () => {
  const before = Date.now();
  const t = exec.stampTime(`refs/dash-backup/b/${exec.stamp()}`);
  assert.ok(Math.abs(t - before) < 5000, `stamp round-trips (${t} vs ${before})`);
});

test('webUrl turns ssh, scp-style and https remotes into a web URL', async () => {
  const cases = {
    'git@gitlab.example.com:group/sub/lms.git': 'https://gitlab.example.com/group/sub/lms',
    'ssh://git@gitlab.example.com:2222/group/lms.git': 'https://gitlab.example.com/group/lms',
    'https://user@gitlab.example.com/group/lms.git': 'https://gitlab.example.com/group/lms',
    'https://gitlab.example.com/group/lms': 'https://gitlab.example.com/group/lms',
  };
  for (const [remote, web] of Object.entries(cases)) {
    sh(repo, 'remote', 'add', 'origin', remote);
    assert.equal(await exec.webUrl(repo), web, remote);
    sh(repo, 'remote', 'remove', 'origin');
  }
});

test('refs lists local branches and tracks remote-less state', async () => {
  sh(repo, 'branch', 'feature/VLEARN-1-a-uat');
  const { local, remote } = await exec.refs(repo);
  assert.ok(local.has('main'));
  assert.ok(local.has('feature/VLEARN-1-a-uat'));
  assert.equal(remote.size, 0);
  assert.equal(local.get('main').gone, false);
});

test('wtState reports branch, clean/dirty files and no operation', async () => {
  let st = await exec.wtState(repo);
  assert.equal(st.branch, 'main');
  assert.deepEqual(st.files, []);
  assert.equal(st.op, null);
  write('b.txt', 'new\n');
  write('a.txt', 'one\ntwo\nthree\nfour\n');
  st = await exec.wtState(repo);
  assert.deepEqual(st.files.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
  assert.equal(st.files.find((f) => f.path === 'b.txt').xy, '??');
  sh(repo, 'checkout', '-q', '--', 'a.txt');
  fs.rmSync(path.join(repo, 'b.txt'));
});

test('backupsOf returns backup refs newest first', async () => {
  const sha = sh(repo, 'rev-parse', 'HEAD');
  sh(repo, 'update-ref', `${exec.BACKUP_NS}topic/20260101T000000`, sha);
  sh(repo, 'update-ref', `${exec.BACKUP_NS}topic/20260202T000000`, sha);
  const list = await exec.backupsOf(repo, 'topic');
  assert.equal(list.length, 2);
  assert.ok(list[0].at > list[1].at);
  assert.deepEqual(await exec.backupsOf(repo, 'nothing'), []);
});

test('mergeConflicts: null when clean, files when conflicting, undefined for a bad ref', async (t) => {
  const [maj, min] = sh(process.cwd(), '--version').match(/(\d+)\.(\d+)/).slice(1).map(Number);
  if (maj < 2 || (maj === 2 && min < 38)) return t.skip('git < 2.38 has no merge-tree --write-tree');
  sh(repo, 'checkout', '-q', '-b', 'side-clean');
  write('c.txt', 'c\n');
  commit('clean change');
  sh(repo, 'checkout', '-q', 'main');
  sh(repo, 'checkout', '-q', '-b', 'side-a');
  write('a.txt', 'one\nAAA\nthree\n');
  commit('a change');
  sh(repo, 'checkout', '-q', 'main');
  sh(repo, 'checkout', '-q', '-b', 'side-b');
  write('a.txt', 'one\nBBB\nthree\n');
  commit('b change');
  sh(repo, 'checkout', '-q', 'main');
  assert.equal(await exec.mergeConflicts(repo, 'main', 'side-clean'), null);
  assert.deepEqual(await exec.mergeConflicts(repo, 'side-a', 'side-b'), { files: ['a.txt'] });
  assert.equal(await exec.mergeConflicts(repo, 'main', 'no-such-branch'), undefined);
});

test('operation detects a rebase stopped on a conflict', async (t) => {
  if (!(await exec.mergeConflicts(repo, 'main', 'side-clean').then((r) => r !== undefined))) return t.skip('merge-tree unavailable');
  sh(repo, 'checkout', '-q', 'side-b');
  assert.throws(() => sh(repo, 'rebase', 'side-a'));
  assert.equal(await exec.operation(repo), 'rebase');
  const st = await exec.wtState(repo);
  assert.equal(st.op, 'rebase');
  assert.ok(st.files.some((f) => f.conflict && f.path === 'a.txt'));
  sh(repo, 'rebase', '--abort');
  assert.equal(await exec.operation(repo), null);
});
