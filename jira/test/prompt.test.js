'use strict';

// Tests for validate() in lib/prompt.js and the `writes` description of task_brief in lib/mcp-server.js.
// brief() is not covered: it needs Jira and git.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTemp, rmTemp, purge } = require('./_helpers');

test.before(() => {
  purge();
  // No config file: defaults apply, so mcp.allowWrites is false.
  process.env.DASHBOARD_CONFIG_FILE = '/nonexistent-for-tests.json';
});
test.after(() => rmTemp(null));

test('validate: writes defaults to false in implement mode', () => {
  const prompt = require('../lib/prompt');
  const o = prompt.validate({ key: 'VLEARN-123' });
  assert.equal(o.writes, false);
});

test('validate: opts.writes=true is gated by config.mcp.allowWrites', () => {
  const prompt = require('../lib/prompt');
  const o = prompt.validate({ key: 'VLEARN-123', writes: true });
  assert.equal(o.writes, false);
});

test('validate: opts.writes="true" string is accepted but still gated', () => {
  const prompt = require('../lib/prompt');
  const o = prompt.validate({ key: 'VLEARN-123', writes: 'true' });
  assert.equal(o.writes, false);
});

test('validate: plan mode forces writes=false regardless of opts', () => {
  const prompt = require('../lib/prompt');
  const o = prompt.validate({ key: 'VLEARN-123', mode: 'plan', writes: true });
  assert.equal(o.mode, 'plan');
  assert.equal(o.writes, false);
});

test('validate: invalid key throws 400', () => {
  const prompt = require('../lib/prompt');
  assert.throws(() => prompt.validate({ key: 'not a key' }), /Invalid issue key/);
});

test('task_brief inputSchema description no longer claims writes default true', () => {
  // Only the `writes` block: other fields (moveStatus, checklist `checked`) legitimately say "default true".
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../lib/mcp-server.js'), 'utf8');
  const writesBlock = src.match(/writes:\s*\{[\s\S]*?\},\s*\}/);
  assert.ok(writesBlock, 'task_brief writes schema block should be present');
  assert.ok(
    !/default\s*true/i.test(writesBlock[0]),
    'task_brief writes description must not say default true',
  );
  assert.match(writesBlock[0], /false\s*\(default\)/);
});
