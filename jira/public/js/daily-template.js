'use strict';

// Daily report template: one text the user writes in the daily report dialog's Settings tab (config daily.template).
// A browser script (the dialog, its live preview) that the server also requires (lib/daily-report.js, lib/config.js).
//
//   📢 BÁO CÁO CÔNG VIỆC HÀNG NGÀY - {date}
//   ✅ DANH SÁCH TICKET ĐÃ BÀN GIAO
//   {#handed}
//   [{key}] {title} ➡️ {testers}
//   {else}
//   Không có
//   {/handed}
//
// Text outside a block is copied as written ({date} filled in). {#handed} … {/handed} and {#pending} … {/pending}
// are repeated once per ticket, each ticket a "• " list item with its further lines indented under it; the part
// after {else} is shown instead when the section has no ticket. Each block once, on lines of their own.

const DAILY_TEMPLATE_DEFAULT = [
  '📢 BÁO CÁO CÔNG VIỆC HÀNG NGÀY - {date}',
  '✅ DANH SÁCH TICKET ĐÃ BÀN GIAO',
  '{#handed}',
  '[{key}] {title} ➡️ {testers}',
  '{else}',
  'Không có',
  '{/handed}',
  '',
  '⏳ DANH SÁCH CHƯA BÀN GIAO (ĐANG TRIỂN KHAI)',
  '{#pending}',
  '[{key}] {title}',
  'Trạng thái: {status}',
  'Dự kiến bàn giao: {expectedTime} - {expectedDate}',
  '{else}',
  'Không có',
  '{/pending}',
].join('\n');

// The sections a template can hold, and the placeholders it knows (for the editor's chips and help).
const DAILY_SECTIONS = { handed: 'Đã bàn giao', pending: 'Chưa bàn giao' };
const DAILY_VARS = {
  date: 'today, dd/mm/yyyy',
  key: 'ticket key',
  title: 'ticket title',
  status: 'Jira status',
  testers: '@Name of each QC in the Tester field',
  expectedTime: 'expected hand-over time (setting below)',
  expectedDate: 'due date dd/mm, else the next working day',
};

// Template text → { texts: [lines before, between, after], sections: [{ id, lines, empty }] }, sections in the
// order written. Throws an Error with a message for the user when the blocks are not right.
function parseDailyTemplate(tpl) {
  const texts = [[]];
  const sections = [];
  let open = null; // the block being read
  String(tpl ?? '').replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
    const tag = /^\s*\{\s*(#|\/)?\s*(\w+)\s*\}\s*$/.exec(line);
    const at = `line ${i + 1}`;
    if (tag && tag[1] === '#') {
      if (open) throw new Error(`${at}: {#${tag[2]}} inside {#${open.id}}: close it with {/${open.id}} first`);
      if (!(tag[2] in DAILY_SECTIONS)) throw new Error(`${at}: unknown block {#${tag[2]}}; use {#handed} or {#pending}`);
      if (sections.some((s) => s.id === tag[2])) throw new Error(`${at}: {#${tag[2]}} appears twice`);
      open = { id: tag[2], lines: [], empty: null };
    } else if (tag && tag[1] === '/') {
      if (!open || open.id !== tag[2]) throw new Error(`${at}: {/${tag[2]}} without its {#${tag[2]}}`);
      sections.push(open);
      texts.push([]);
      open = null;
    } else if (tag && tag[2] === 'else' && open) {
      if (open.empty) throw new Error(`${at}: {else} twice in {#${open.id}}`);
      open.empty = [];
    } else if (open) {
      (open.empty || open.lines).push(line);
    } else {
      texts.at(-1).push(line);
    }
  });
  if (open) throw new Error(`{#${open.id}} is not closed: add {/${open.id}}`);
  for (const id of Object.keys(DAILY_SECTIONS)) if (!sections.some((s) => s.id === id)) throw new Error(`the template needs a {#${id}} … {/${id}} block`);
  for (const s of sections) {
    if (!s.lines.some((l) => l.trim())) throw new Error(`{#${s.id}} has no line for its tickets`);
    s.empty = (s.empty || []).filter((l, k, all) => l.trim() || all.slice(k).some((x) => x.trim())); // no trailing blanks
  }
  return { texts, sections };
}

// '' when the template is fine, else what is wrong (Settings validation).
function dailyTemplateError(tpl) {
  try {
    parseDailyTemplate(tpl);
    return '';
  } catch (e) {
    return e.message;
  }
}

// Fills {name} placeholders; an unknown one is kept as typed. An empty value at the end of a line takes the
// separator before it along ("[KEY] title ➡️ " → "[KEY] title"); elsewhere it leaves one space.
const DAILY_EMPTY = '\u0000';
function fillDailyLine(line, values) {
  return line
    .replace(/\{(\w+)\}/g, (m, name) => (name in values ? String(values[name] ?? '').trim() || DAILY_EMPTY : m))
    .replace(new RegExp(`[^\\p{L}\\p{N}\\])}]*${DAILY_EMPTY}\\s*$`, 'u'), '')
    .replace(new RegExp(`\\s*${DAILY_EMPTY}\\s*`, 'g'), ' ')
    .trimEnd();
}

// One ticket's text in a section: its block lines filled in; a line left empty is dropped.
function dailyTicketText(layout, sectionId, values) {
  const sec = layout.sections.find((s) => s.id === sectionId);
  return sec.lines.map((l) => fillDailyLine(l, values)).filter((l) => l.trim()).join('\n');
}

// The report text. parts: { texts: [string|null…] (one more than sections), sections: [{ items, empty }] } where
// an item is one ticket's text. Blank lines at the very end are dropped.
function composeDailyText({ texts, sections }) {
  const lines = [];
  // null = no line at all; '' = one blank line.
  const add = (text) => text != null && lines.push(...text.split('\n'));
  texts.forEach((text, i) => {
    if (i) {
      const { items, empty } = sections[i - 1];
      if (items.length) lines.push(...items.map((t) => `• ${t.replace(/\n/g, '\n  ')}`));
      else add(empty);
    }
    add(text);
  });
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.join('\n');
}

// The template's fixed parts for one day: { texts, sections: [{ id, empty }] } as strings (null where the template
// has no line at all), {date} filled in.
function dailyFixedParts(layout, values) {
  const fill = (lines) => (lines.length ? lines.map((l) => fillDailyLine(l, values)).join('\n') : null);
  return { texts: layout.texts.map(fill), sections: layout.sections.map((s) => ({ id: s.id, empty: fill(s.empty) })) };
}

if (typeof module !== 'undefined') {
  module.exports = { DAILY_TEMPLATE_DEFAULT, DAILY_SECTIONS, DAILY_VARS, parseDailyTemplate, dailyTemplateError, fillDailyLine, dailyTicketText, composeDailyText, dailyFixedParts };
}
