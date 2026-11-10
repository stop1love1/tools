'use strict';

// Daily report reminder, run by the server so it works the same with the desktop app and with a browser:
//
// - At the reminder time (daily report dialog → Settings tab) (on the chosen days), once a day, also when the server starts late (up to
//   LATE_MS after the time). The day it last fired is kept on disk, so a restart does not fire it again.
// - The desktop app (electron-main.js) polls POST /api/daily-report/poll: while it does, it shows the reminder
//   itself (a native notification that opens the app window).
// - Otherwise (npm start + a browser): an OS notification via notify-send; clicking it opens the report in the
//   browser (tasks page, #daily-report), whether or not a dashboard tab is open.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('./config');
const { dailyDue, dayKey } = require('./daily-schedule');
const { safeJson } = require('./util');

const TICK_MS = 30_000;
const SHELL_TTL_MS = 60_000; // the desktop app polls every 15 s; after a minute without a poll it is gone
const STATE_FILE = process.env.DASHBOARD_DAILY_STATE_FILE || path.join(__dirname.includes('/snapshot/') ? process.cwd() : path.join(__dirname, '..'), '.daily-report-state.json');
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

let shellSeenAt = 0;
let pending = null; // a reminder waiting for the desktop app's next poll
let deps = { spawn, now: () => new Date(), buildReport: null, port: null };

function lastDay() {
  return (fs.existsSync(STATE_FILE) && safeJson(fs.readFileSync(STATE_FILE, 'utf8'))?.last) || '';
}

function saveDay(day) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ last: day }));
  } catch (e) {
    console.error(`[daily] could not save ${STATE_FILE}: ${e.message}`);
  }
}

const shellAttached = () => Date.now() - shellSeenAt < SHELL_TTL_MS;
const reportUrl = () => `http://localhost:${deps.port || config.get().server.port}/tasks.html#daily-report`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function summary() {
  try {
    const r = await Promise.race([deps.buildReport(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000))]);
    return `${r.handedOver.length} handed over · ${r.pending.length} in progress — click to open the report and copy it for Teams.`;
  } catch {
    return 'Click to open the report, filled in from Jira, and copy it for Teams.';
  }
}

// OS notification (Linux, libnotify). Resolves with how it was shown, for the test button and the log.
async function osNotify(title) {
  if (process.platform !== 'linux') return 'unsupported';
  const body = await summary();
  return new Promise((resolve) => {
    let child;
    try {
      child = deps.spawn('notify-send', ['-a', 'Jira Dashboard', '-u', 'critical', '-i', ICON, '-A', 'default=Open report', title, esc(body)], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve('no-notify-send');
    }
    let out = '';
    child.on('error', () => resolve('no-notify-send'));
    child.stdout?.on('data', (d) => (out += d));
    // notify-send -A waits for a click or dismissal; answer the caller right away.
    child.on('spawn', () => resolve('os'));
    child.on('close', () => {
      if (out.trim() === 'default') deps.spawn('xdg-open', [reportUrl()], { stdio: 'ignore', detached: true }).on('error', () => {}).unref?.();
    });
  });
}

async function deliver(cfg, { test = false } = {}) {
  const title = test ? 'Daily report (test)' : `Daily report — ${cfg.time}`;
  if (shellAttached()) {
    pending = { title };
    return 'app';
  }
  return osNotify(title);
}

async function tick() {
  const cfg = config.get().daily;
  const now = deps.now();
  if (!dailyDue(cfg, now, lastDay())) return null;
  saveDay(dayKey(now));
  const how = await deliver(cfg);
  console.log(`[daily] reminder for ${dayKey(now)} ${cfg.time}: ${how}`);
  return how;
}

// The desktop app's poll: marks it as attached and hands it a waiting reminder, once.
function poll() {
  shellSeenAt = Date.now();
  const p = pending;
  pending = null;
  return { due: !!p, title: p?.title || null };
}

let timer = null;
function start(opts = {}) {
  deps = { ...deps, ...opts };
  clearInterval(timer);
  timer = setInterval(() => tick().catch((e) => console.error('[daily]', e.message)), TICK_MS);
  timer.unref();
  setTimeout(() => tick().catch(() => {}), 5_000).unref(); // after startup: a reminder missed while it was off
}

const test = () => deliver(config.get().daily, { test: true });

// For tests: replace spawn / clock / report builder, reset the in-memory state.
function _setDeps(d) {
  deps = { ...deps, ...d };
  shellSeenAt = 0;
  pending = null;
}

module.exports = { start, tick, poll, test, STATE_FILE, _setDeps };
