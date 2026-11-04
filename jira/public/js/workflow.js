'use strict';

// Where an in-progress Jira status stands in the test flow, from Settings → Workflow (lib/config.js workflow.*).
// A browser script (task list, Overview) that the server also requires for its defaults.
// Each line of a list is a status name (any case) or a /regex/ (case-insensitive). Names win over patterns; among
// patterns the lists are tried tested, testing, then test queue.

const WORKFLOW_DEFAULTS = {
  // Done coding, waiting for a tester (the test pile; the status testers filter by).
  testQueue: ['Ready for SIT', 'Ready for Test', 'Ready for QA', '/review|\\bqa\\b/'],
  // A tester has it now.
  testing: ['Ready for UAT', 'In Testing', '/\\btesting\\b|\\bin test\\b|verif|\\buat\\b/'],
  // Tested, waiting for a deploy (no one is testing it). Ready for Production is in Jira's Done category: QA done.
  tested: ['Test SIT Done'],
  // Status order in the status pills and progress bar (unlisted statuses go after the listed ones of their category).
  statusOrder: [
    'Backlog', 'Open', 'To Do', 'Selected for Development', 'In Development', 'In Progress', 'Code Review', 'In Review',
    'Ready for SIT', 'Ready for Test', 'In Testing', 'Test SIT Done', 'Ready for UAT', 'UAT', 'Ready for Production',
    'Done', 'Resolved', 'Closed',
  ],
};
const PHASES = ['tested', 'testing', 'testQueue'];

// '' when a line is fine, else why not (Settings validation, server side).
function workflowLineError(line) {
  const m = /^\/(.+)\/$/.exec(String(line).trim());
  if (!m) return '';
  try { new RegExp(m[1], 'i'); return ''; } catch (e) { return `bad pattern ${line}: ${e.message}`; }
}

let wfNames = new Map(); // lower-case name → phase
let wfPatterns = []; // [phase, RegExp]
let wfOrder = [];
function setWorkflow(w) {
  const cfg = { ...WORKFLOW_DEFAULTS, ...(w || {}) };
  wfNames = new Map(); wfPatterns = [];
  for (const phase of PHASES) {
    for (const raw of cfg[phase] || []) {
      const line = String(raw).trim(), m = /^\/(.+)\/$/.exec(line);
      if (!m) { if (line && !wfNames.has(line.toLowerCase())) wfNames.set(line.toLowerCase(), phase); continue; }
      try { wfPatterns.push([phase, new RegExp(m[1], 'i')]); } catch { /* checked when saved */ }
    }
  }
  wfOrder = (cfg.statusOrder || []).map((s) => String(s).trim().toLowerCase());
}
setWorkflow();

// 'testQueue' | 'testing' | 'tested' | '' (still with the developer). For in-progress statuses; the caller checks the category.
const phaseOf = (name) => {
  const n = String(name || '').trim();
  return wfNames.get(n.toLowerCase()) || wfPatterns.find(([, re]) => re.test(n))?.[0] || '';
};
// Where a task stands, for every number the dashboard shows:
//   'todo'  not started (Jira's To Do category)
//   'dev'   being coded (In Progress, Selftest, any in-progress status outside the test flow)
//   'qa'    dev done, QA not done: in one of the Workflow lists, whatever its Jira category (Test SIT Done may be a
//           To Do-category status on the board, yet the code is done)
//   'done'  QA done: Jira's Done category (Ready for Production, Done, Cancelled)
// Dev done = 'qa' or 'done'.
function stageOf(status) {
  if (!status) return 'todo';
  if (status.category === 'done') return 'done';
  if (phaseOf(status.name)) return 'qa';
  return status.category === 'new' ? 'todo' : 'dev';
}
const STAGE_ORDER = { todo: 0, dev: 1, qa: 2, done: 3 };
const isDevDone = (status) => STAGE_ORDER[stageOf(status)] >= STAGE_ORDER.qa;

const statusRank = (name) => {
  const i = wfOrder.indexOf(String(name || '').trim().toLowerCase());
  return i < 0 ? 1000 : i;
};

if (typeof module !== 'undefined') module.exports = { WORKFLOW_DEFAULTS, workflowLineError, setWorkflow, phaseOf, stageOf, isDevDone, STAGE_ORDER, statusRank };
