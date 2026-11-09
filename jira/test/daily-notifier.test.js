'use strict';

// lib/daily-notifier.js: the server-side daily report reminder — once a day at the set time, handed to the desktop
// app while it polls, else an OS notification (notify-send) whose click opens the report in the browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { mkTemp, rmTemp } = require('./_helpers');

let tmp;
test.before(() => {
  tmp = mkTemp();
});
test.after(() => rmTemp(tmp));

// A fake child process: emits 'spawn' right away, then prints `out` and closes when finish() is called.
function fakeSpawn({ fail = false } = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.unref = () => {};
    const call = { cmd, args, child, finish: (out = '') => (out && child.stdout.emit('data', out), child.emit('close', 0)) };
    calls.push(call);
    setImmediate(() => (fail ? child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })) : child.emit('spawn')));
    return child;
  };
  fn.calls = calls;
  return fn;
}

function load({ now, daily = {}, spawn = fakeSpawn(), report } = {}) {
  const libDir = path.resolve(__dirname, '..', 'lib') + path.sep;
  for (const k of Object.keys(require.cache)) if (k.startsWith(libDir)) delete require.cache[k];
  const config = require('../lib/config');
  if (Object.keys(daily).length) config.save(Object.fromEntries(Object.entries(daily).map(([k, v]) => [`daily.${k}`, v])));
  const notifier = require('../lib/daily-notifier');
  let clock = now;
  notifier._setDeps({
    spawn,
    now: () => clock,
    port: 4747,
    buildReport: report || (async () => ({ handedOver: [1], pending: [1, 2] })),
  });
  return { notifier, spawn, config, setNow: (d) => (clock = d) };
}

const MON_1700 = new Date(2026, 10, 9, 17, 0, 10);
const resetState = () => fs.rmSync(process.env.DASHBOARD_DAILY_STATE_FILE, { force: true });

test('fires once at the time with notify-send, and not again the same day', async () => {
  resetState();
  const { notifier, spawn, setNow } = load({ now: new Date(2026, 10, 9, 16, 59) });
  assert.equal(await notifier.tick(), null); // before 17:00
  setNow(MON_1700);
  assert.equal(await notifier.tick(), 'os');
  assert.equal(spawn.calls.length, 1);
  const { cmd, args } = spawn.calls[0];
  assert.equal(cmd, 'notify-send');
  assert.deepEqual(args.slice(0, 2), ['-a', 'Jira Dashboard']);
  assert.ok(args.includes('-A') && args.includes('default=Open report'));
  assert.ok(args.includes('Daily report — 17:00'));
  assert.match(args.at(-1), /1 handed over · 2 in progress/);
  assert.equal(await notifier.tick(), null); // same day
  assert.equal(spawn.calls.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(process.env.DASHBOARD_DAILY_STATE_FILE, 'utf8')).last, '2026-11-09');
});

test('a server restart the same day does not fire it again', async () => {
  // State file from the previous test says 2026-11-09.
  const { notifier, spawn } = load({ now: new Date(2026, 10, 9, 17, 30) });
  assert.equal(await notifier.tick(), null);
  assert.equal(spawn.calls.length, 0);
});

test('clicking the notification opens the report in the browser; dismissing it does nothing', async () => {
  resetState();
  const { notifier, spawn } = load({ now: MON_1700 });
  await notifier.tick();
  spawn.calls[0].finish('default\n');
  assert.equal(spawn.calls.length, 2);
  assert.equal(spawn.calls[1].cmd, 'xdg-open');
  assert.deepEqual(spawn.calls[1].args, ['http://localhost:4747/tasks.html#daily-report']);

  const second = load({ now: MON_1700 });
  await second.notifier.test();
  second.spawn.calls[0].finish(''); // closed without clicking
  assert.equal(second.spawn.calls.length, 1);
});

test('while the desktop app polls, it gets the reminder (once) instead of notify-send', async () => {
  resetState();
  const { notifier, spawn } = load({ now: MON_1700 });
  assert.deepEqual(notifier.poll(), { due: false, title: null }); // the app announces itself
  assert.equal(await notifier.tick(), 'app');
  assert.equal(spawn.calls.length, 0);
  assert.deepEqual(notifier.poll(), { due: true, title: 'Daily report — 17:00' });
  assert.deepEqual(notifier.poll(), { due: false, title: null });
});

test('off switch and days of the week', async () => {
  resetState();
  let l = load({ now: MON_1700, daily: { enabled: false } });
  assert.equal(await l.notifier.tick(), null);
  l = load({ now: MON_1700, daily: { enabled: true, days: [2, 4] } }); // Monday is not chosen
  assert.equal(await l.notifier.tick(), null);
  l.setNow(new Date(2026, 10, 10, 17, 1)); // Tuesday
  assert.equal(await l.notifier.tick(), 'os');
  l.config.save({ 'daily.days': [1, 2, 3, 4, 5] });
});

test('custom time', async () => {
  resetState();
  const l = load({ now: new Date(2026, 10, 9, 16, 31), daily: { time: '16:30' } });
  assert.equal(await l.notifier.tick(), 'os');
  assert.ok(l.spawn.calls[0].args.includes('Daily report — 16:30'));
  l.config.save({ 'daily.time': '17:00' });
});

test('no notify-send installed: reported, nothing thrown', async () => {
  resetState();
  const { notifier } = load({ now: MON_1700, spawn: fakeSpawn({ fail: true }) });
  assert.equal(await notifier.test(), 'no-notify-send');
});

test('Jira failing still notifies, with a generic text; Jira text is escaped for notify-send markup', async () => {
  resetState();
  let l = load({ now: MON_1700, report: async () => { throw new Error('401'); } });
  assert.equal(await l.notifier.tick(), 'os');
  assert.match(l.spawn.calls[0].args.at(-1), /Click to open the report/);
  l = load({ now: MON_1700 });
  await l.notifier.test();
  assert.doesNotMatch(l.spawn.calls[0].args.at(-1), /</);
});

test('the test button does not use up today\'s reminder', async () => {
  resetState();
  const { notifier } = load({ now: MON_1700 });
  assert.equal(await notifier.test(), 'os');
  assert.equal(await notifier.tick(), 'os');
});
