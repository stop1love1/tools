'use strict';

// Daily report for the team's Teams chat, in the format the team agreed on:
//
//   Ngày 09/11/2026
//   - Đã bàn giao: 0
//   - Đã làm nhưng chưa bàn giao:
//
//   VLEARN-5800: <title> (Ready for SIT - 10/11) cc @<tester>
//
// Handed over = my tasks whose status I changed today to Ready for SIT / Ready for UAT or later (any Settings →
// Workflow list except code review), or to done. Worked on but not handed over = my tasks still being coded, plus
// those in code review that were touched today, with the expected hand-over date: the due date,
// else the next working day. Only the ticket types QC tests (Settings → Daily report, default Story and Bug), never
// subtasks.

const config = require('./config');
const { searchAll } = require('./mcp');
const { stageOf } = require('../public/js/workflow.js');

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fullDate = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const shortDate = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;

function nextWorkingDay(d) {
  const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  while (n.getDay() === 0 || n.getDay() === 6) n.setDate(n.getDate() + 1);
  return n;
}

// Jira due dates are plain "YYYY-MM-DD": read them as local days, not UTC midnight.
function expectedDate(due, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due || '');
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (dayKey(d) >= dayKey(now)) return d;
  }
  return nextWorkingDay(now);
}

// Code review is still with the developers, though it sits in the Workflow test-queue list ("In Review").
const isReview = (status) => /review/i.test(status?.name || '');
// Handed over: Ready for SIT / Ready for UAT and everything after it (testing, tested, done); not code review.
const isHandedOver = (status) => stageOf(status) === 'done' || (stageOf(status) === 'qa' && !isReview(status));
const isPending = (status) => status?.category !== 'done' && !isHandedOver(status) && (stageOf(status) === 'dev' || isReview(status));

// One ticket's line, without the list bullet: "VLEARN-123: <title> (<status>[ - <expected>]) cc @<tester>".
// "cc @Tester" is the QC assigned in the ticket's Tester field (Settings → Daily report).
const cc = (t) => (t.testers?.length ? ` cc ${t.testers.map((n) => `@${n}`).join(' ')}` : '');
const title = (t) => (t.summary?.trim() ? `${t.key}: ${t.summary.trim()}` : t.key);
const handedLine = (t) => `${title(t)} (${t.status})${cc(t)}`;
const pendingLine = (t) => `${title(t)} (${t.status} - ${shortDate(t.expected)})${cc(t)}`;
const heading = (now) => `Ngày ${fullDate(now)}`;

// The report text from the lines kept (the dialog's checklist builds the same text in daily-report.js
// composeDailyReport). Each ticket is a "• " list item, copied to Teams as a bulleted list.
function composeReport(head, handed, pending) {
  const lines = [head];
  if (handed.length) lines.push('- Đã bàn giao:', '', ...handed.map((l) => `• ${l}`), '');
  else lines.push('- Đã bàn giao: 0');
  if (pending.length) lines.push('- Đã làm nhưng chưa bàn giao:', '', ...pending.map((l) => `• ${l}`));
  else lines.push('- Đã làm nhưng chưa bàn giao: 0');
  return lines.join('\n');
}

// The report text from plain task lists (exported for tests).
const formatReport = ({ now, handedOver, pending }) => composeReport(heading(now), handedOver.map(handedLine), pending.map(pendingLine));

// Tester field (a user picker, single or multi) → display names, without Jira's " - username" suffix.
function testersOf(fields, field) {
  const v = field ? fields?.[field] : null;
  return (Array.isArray(v) ? v : v ? [v] : [])
    .map((u) => String(u?.displayName || '').replace(/\s+-\s+[^-]+$/, '').trim())
    .filter(Boolean);
}

const statusOf = (s) => (s ? { name: s.name, category: s.statusCategory?.key || 'indeterminate' } : null);

// forUser: rewrites currentUser() in the JQL for the person the header's user filter shows (server.js forUserMapper).
async function buildDailyReport(now = new Date(), forUser = (jql) => jql) {
  const testerField = config.get().daily.testerField;
  const fields = ['summary', 'status', 'duedate', 'updated', 'issuetype', 'parent', ...(testerField ? [testerField] : [])];
  const [changedToday, inProgress, recent] = await Promise.all([
    // Only my own moves: a PO closing a whole release (or a tester's move) is not something I handed over today.
    searchAll(forUser('assignee = currentUser() AND status CHANGED BY currentUser() AFTER startOfDay() ORDER BY key ASC'), fields, 100),
    searchAll(forUser('assignee = currentUser() AND statusCategory = "In Progress" ORDER BY key ASC'), fields, 100),
    // "+ Add line" suggestions: my open tickets and those closed in the last two weeks, most recently updated first.
    searchAll(forUser('assignee = currentUser() AND (statusCategory != Done OR status CHANGED AFTER -14d) ORDER BY updated DESC'), fields, 100),
  ]);
  // QC tests stories and bugs (Settings → Daily report "Ticket types"), not their subtasks: a subtask stays out of the
  // report and its story stands for it.
  const types = new Set((config.get().daily.issueTypes || []).map((t) => t.trim().toLowerCase()));
  const isSubtask = (i) => !!i.fields?.issuetype?.subtask;
  const reported = (i) => !isSubtask(i) && types.has(String(i.fields?.issuetype?.name || '').toLowerCase());
  const ticket = (i) => ({ key: i.key, summary: i.fields?.summary || '', status: i.fields?.status?.name || '', expected: expectedDate(i.fields?.duedate, now), testers: testersOf(i.fields, testerField) });
  // A ticket for the dialog: its line in each section (`lines`), so a row dragged to the other section, or picked
  // from the suggestions into either, takes that section's format.
  const forDialog = (t, section) => ({ ...t, line: section === 'handed' ? handedLine(t) : pendingLine(t), lines: { handed: handedLine(t), pending: pendingLine(t) }, expected: dayKey(t.expected) });
  const handedOver = changedToday.filter((i) => reported(i) && isHandedOver(statusOf(i.fields?.status))).map(ticket);
  const handed = new Set(handedOver.map((t) => t.key));
  // Still coding: always listed. In code review: only when touched today, so a ticket parked in review for weeks
  // does not show up in every report.
  // A story whose subtask I worked on today counts as touched today too.
  const updatedToday = (i) => i.fields?.updated && dayKey(new Date(i.fields.updated)) === dayKey(now);
  const parentsTouched = new Set([...changedToday, ...inProgress].filter((i) => isSubtask(i) && updatedToday(i) && i.fields.parent?.key).map((i) => i.fields.parent.key));
  const touchedToday = (i) => updatedToday(i) || parentsTouched.has(i.key);
  const pending = inProgress
    .filter((i) => reported(i) && !handed.has(i.key) && isPending(statusOf(i.fields?.status)))
    .filter((i) => stageOf(statusOf(i.fields.status)) === 'dev' || touchedToday(i))
    .map(ticket);
  const seen = new Set();
  const candidates = [...changedToday, ...inProgress, ...recent]
    .filter((i) => reported(i) && !seen.has(i.key) && seen.add(i.key))
    .map(ticket);
  return {
    date: dayKey(now),
    // The dialog turns every ticket key into a link to <site>/browse/<key> when it copies the report.
    site: config.get().jira.siteUrl.replace(/\/+$/, ''),
    text: formatReport({ now, handedOver, pending }),
    // The dialog's checklist: the heading and one editable line per ticket.
    heading: heading(now),
    handedOver: handedOver.map((t) => forDialog(t, 'handed')),
    pending: pending.map((t) => forDialog(t, 'pending')),
    // Stories / bugs to pick from when adding a line (the dialog leaves out those already listed).
    candidates: candidates.map((t) => forDialog(t, 'pending')),
  };
}

module.exports = { buildDailyReport, formatReport, composeReport, expectedDate, nextWorkingDay, testersOf };
