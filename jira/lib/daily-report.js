'use strict';

// Daily report for the team's Teams chat, in the format the team agreed on:
//
//   Ngày 09/11/2026
//   - Đã bàn giao: 0
//   - Đã làm nhưng chưa bàn giao:
//
//   VLEARN-5800: <title> (Ready for SIT - 10/11) cc @<tester>
//
// Handed over = my tasks whose status I changed today and that a tester now has (Settings → Workflow "Being tested" /
// "Tested") or that are done. Worked on but not handed over = my tasks still being coded, plus those in review /
// waiting for a tester (Ready for SIT…) that were touched today, with the expected hand-over date: the due date,
// else the next working day. Only the ticket types QC tests (Settings → Daily report, default Story and Bug), never
// subtasks.

const config = require('./config');
const { searchAll } = require('./mcp');
const { stageOf, phaseOf } = require('../public/js/workflow.js');

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

const isHandedOver = (status) => stageOf(status) === 'done' || ['testing', 'tested'].includes(phaseOf(status?.name));
const isPending = (status) => status?.category !== 'done' && !isHandedOver(status) && (stageOf(status) === 'dev' || phaseOf(status?.name) === 'testQueue');

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
  const [changedToday, inProgress] = await Promise.all([
    // Only my own moves: a PO closing a whole release (or a tester's move) is not something I handed over today.
    searchAll(forUser('assignee = currentUser() AND status CHANGED BY currentUser() AFTER startOfDay() ORDER BY key ASC'), fields, 100),
    searchAll(forUser('assignee = currentUser() AND statusCategory = "In Progress" ORDER BY key ASC'), fields, 100),
  ]);
  // QC tests stories and bugs (Settings → Daily report "Ticket types"), not their subtasks: a subtask stays out of the
  // report and its story stands for it.
  const types = new Set((config.get().daily.issueTypes || []).map((t) => t.trim().toLowerCase()));
  const isSubtask = (i) => !!i.fields?.issuetype?.subtask;
  const reported = (i) => !isSubtask(i) && types.has(String(i.fields?.issuetype?.name || '').toLowerCase());
  const handedOver = changedToday
    .filter((i) => reported(i) && isHandedOver(statusOf(i.fields?.status)))
    .map((i) => ({ key: i.key, summary: i.fields?.summary || '', status: i.fields.status.name, testers: testersOf(i.fields, testerField) }));
  const handed = new Set(handedOver.map((t) => t.key));
  // Still coding: always listed. In review / waiting for SIT: only when touched today, so a ticket parked in
  // Ready for SIT for weeks does not show up in every report.
  // A story whose subtask I worked on today counts as touched today too.
  const updatedToday = (i) => i.fields?.updated && dayKey(new Date(i.fields.updated)) === dayKey(now);
  const parentsTouched = new Set([...changedToday, ...inProgress].filter((i) => isSubtask(i) && updatedToday(i) && i.fields.parent?.key).map((i) => i.fields.parent.key));
  const touchedToday = (i) => updatedToday(i) || parentsTouched.has(i.key);
  const pending = inProgress
    .filter((i) => reported(i) && !handed.has(i.key) && isPending(statusOf(i.fields?.status)))
    .filter((i) => stageOf(statusOf(i.fields.status)) === 'dev' || touchedToday(i))
    .map((i) => ({ key: i.key, summary: i.fields?.summary || '', status: i.fields.status.name, expected: expectedDate(i.fields?.duedate, now), testers: testersOf(i.fields, testerField) }));
  return {
    date: dayKey(now),
    // The dialog turns every ticket key into a link to <site>/browse/<key> when it copies the report.
    site: config.get().jira.siteUrl.replace(/\/+$/, ''),
    text: formatReport({ now, handedOver, pending }),
    // The dialog's checklist: the heading and one editable line per ticket.
    heading: heading(now),
    handedOver: handedOver.map((t) => ({ ...t, line: handedLine(t) })),
    pending: pending.map((t) => ({ ...t, line: pendingLine(t), expected: dayKey(t.expected) })),
  };
}

module.exports = { buildDailyReport, formatReport, composeReport, expectedDate, nextWorkingDay, testersOf };
