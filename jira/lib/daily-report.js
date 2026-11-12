'use strict';

// Daily report for the team's Teams chat. The layout is one template text the user edits in the dialog's Settings
// tab (config daily.template, public/js/daily-template.js parses and fills it); with the default one:
//
//   📢 BÁO CÁO CÔNG VIỆC HÀNG NGÀY - 09/11/2026
//   ✅ DANH SÁCH TICKET ĐÃ BÀN GIAO
//   • [VLEARN-5800] <title> ➡️ @<tester>
//
//   ⏳ DANH SÁCH CHƯA BÀN GIAO (ĐANG TRIỂN KHAI)
//   • [VLEARN-5797] <title>
//     Trạng thái: In Progress
//     Dự kiến bàn giao: 17:00 - 10/11
//
// Handed over = my tasks whose status I changed today to Ready for SIT / Ready for UAT or later (any Settings →
// Workflow list except code review), or to done. Not handed over = my tasks still being coded, plus
// those in code review that were touched today, with the expected hand-over date: the due date,
// else the next working day. Only the ticket types QC tests (daily.issueTypes, default Story and Bug), never
// subtasks.

const config = require('./config');
const { searchAll } = require('./mcp');
const { stageOf } = require('../public/js/workflow.js');
const tpl = require('../public/js/daily-template.js');

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

// Code review is still with the developers (stage 'dev'), unless a hand-edited Workflow list puts it in the test flow.
const isReview = (status) => /review/i.test(status?.name || '');
// Handed over: Ready for SIT / Ready for UAT and everything after it (testing, tested, done); not code review.
const isHandedOver = (status) => stageOf(status) === 'done' || (stageOf(status) === 'qa' && !isReview(status));
const isPending = (status) => status?.category !== 'done' && !isHandedOver(status) && (stageOf(status) === 'dev' || isReview(status));

// The saved template, parsed. Settings validates it on save, so a parse error here means a hand-edited
// config.json: the default template stands in.
function layout() {
  try {
    return tpl.parseDailyTemplate(config.get().daily.template);
  } catch {
    return tpl.parseDailyTemplate(tpl.DAILY_TEMPLATE_DEFAULT);
  }
}

// A ticket's placeholder values ({testers}: "@Name" for each QC in the Tester field, daily.testerField).
const valuesOf = (t, now) => ({
  date: fullDate(now),
  key: t.key,
  title: t.summary,
  status: t.status,
  testers: (t.testers || []).map((n) => `@${n}`).join(' '),
  expectedTime: t.expected ? config.get().daily.expectedTime : '',
  expectedDate: t.expected ? shortDate(t.expected) : '',
});

// One ticket's text in a section ('handed' / 'pending'), without the list bullet.
const ticketText = (t, section, now, lay = layout()) => tpl.dailyTicketText(lay, section, valuesOf(t, now));

// The report text from plain task lists (exported for tests; the dialog composes the same text from what is ticked).
function formatReport({ now, handedOver, pending }) {
  const lay = layout();
  const fixed = tpl.dailyFixedParts(lay, { date: fullDate(now) });
  const items = { handed: handedOver.map((t) => ticketText(t, 'handed', now, lay)), pending: pending.map((t) => ticketText(t, 'pending', now, lay)) };
  return tpl.composeDailyText({ texts: fixed.texts, sections: fixed.sections.map((s) => ({ ...s, items: items[s.id] })) });
}

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
  const { testerField } = config.get().daily;
  const fields = ['summary', 'status', 'duedate', 'updated', 'issuetype', 'parent', ...(testerField ? [testerField] : [])];
  const [changedToday, inProgress, recent] = await Promise.all([
    // Only my own moves: a PO closing a whole release (or a tester's move) is not something I handed over today.
    searchAll(forUser('assignee = currentUser() AND status CHANGED BY currentUser() AFTER startOfDay() ORDER BY key ASC'), fields, 100),
    searchAll(forUser('assignee = currentUser() AND statusCategory = "In Progress" ORDER BY key ASC'), fields, 100),
    // "+ Add line" suggestions: my open tickets and those closed in the last two weeks, most recently updated first.
    searchAll(forUser('assignee = currentUser() AND (statusCategory != Done OR status CHANGED AFTER -14d) ORDER BY updated DESC'), fields, 100),
  ]);
  // QC tests stories and bugs (the dialog's Settings tab, "Ticket types"), not their subtasks: a subtask stays out of the
  // report and its story stands for it.
  const types = new Set((config.get().daily.issueTypes || []).map((t) => t.trim().toLowerCase()));
  const isSubtask = (i) => !!i.fields?.issuetype?.subtask;
  const reported = (i) => !isSubtask(i) && types.has(String(i.fields?.issuetype?.name || '').toLowerCase());
  const ticket = (i) => ({ key: i.key, summary: i.fields?.summary || '', status: i.fields?.status?.name || '', expected: expectedDate(i.fields?.duedate, now), testers: testersOf(i.fields, testerField) });
  // A ticket for the dialog: its line in each section (`lines`), so a row dragged to the other section, or picked
  // from the suggestions into either, takes that section's format.
  const lay = layout();
  const forDialog = (t, section) => {
    const lines = { handed: ticketText(t, 'handed', now, lay), pending: ticketText(t, 'pending', now, lay) };
    return { ...t, line: lines[section], lines, expected: dayKey(t.expected) };
  };
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
    .filter((i) => !isReview(statusOf(i.fields.status)) || touchedToday(i))
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
    // The dialog's checklist: the template's own text around the sections ({date} filled in), each section's
    // {else} text, and one editable text per ticket.
    layout: tpl.dailyFixedParts(lay, { date: fullDate(now) }),
    handedOver: handedOver.map((t) => forDialog(t, 'handed')),
    pending: pending.map((t) => forDialog(t, 'pending')),
    // Stories / bugs to pick from when adding a line (the dialog leaves out those already listed).
    candidates: candidates.map((t) => forDialog(t, 'pending')),
  };
}

module.exports = { buildDailyReport, formatReport, expectedDate, nextWorkingDay, testersOf };
