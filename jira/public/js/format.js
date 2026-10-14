'use strict';

// Formatting (status tones, types, dates) and urgency scoring.

// ---------------------------------------------------------------------------
// Formatting

const CAT_ORDER = { new: 0, indeterminate: 1, done: 2 };
const NAME_ORDER = [
  'backlog', 'open', 'to do', 'todo', 'selected for development', 'in development', 'in progress',
  'code review', 'in review', 'review', 'testing', 'in test', 'qa', 'ready for uat', 'uat', 'done', 'resolved', 'closed',
];
const rank = (name) => {
  const i = NAME_ORDER.indexOf(name.toLowerCase());
  return i < 0 ? 50 : i;
};

function tone(status) {
  if (!status) return 'new';
  if (status.category === 'done') {
    // Distinguish real Done vs Cancelled/Rejected
    if (/cancel|hủy|huỷ|reject|won.?t|invalid|duplicate/i.test(status.name)) return 'void';
    return 'done';
  }
  if (status.category === 'new') return 'new';
  return /review|test|qa|uat|verif/i.test(status.name) ? 'review' : 'prog';
}

function statusList(issues) {
  const m = new Map();
  for (const i of issues) if (!m.has(i.status.name)) m.set(i.status.name, i.status);
  return [...m.values()].sort(
    (a, b) => (CAT_ORDER[a.category] ?? 1) - (CAT_ORDER[b.category] ?? 1) || rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
  );
}

function typeClass(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('epic')) return ['t-epic', ''];
  if (n.includes('sub')) return ['t-sub', ''];
  if (n.includes('story')) return ['t-story', ''];
  if (n.includes('bug')) return ['t-bug', ''];
  if (n.includes('task')) return ['t-task', ''];
  return ['', (name || '?').charAt(0).toUpperCase()];
}

const typeBadge = (name) => {
  const [cls, text] = typeClass(name);
  return h('span', { class: `type ${cls}`, title: name });
};

const PRIO = { highest: '⇈', high: '↑', medium: '=', low: '↓', lowest: '⇊' };
const prio = (p) => {
  if (!p) return null;
  const k = p.toLowerCase();
  return h('span', { class: `prio p-${k}`, title: `Priority: ${p}` }, PRIO[k] || '•');
};

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function rel(iso) {
  if (!iso) return '';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const units = [
    [60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600], [604800, 'day', 86400],
    [2629800, 'week', 604800], [31557600, 'month', 2629800], [Infinity, 'year', 31557600],
  ];
  for (const [limit, unit, div] of units) {
    if (Math.abs(diff) < limit) return rtf.format(Math.round(diff / div), unit);
  }
  return '';
}
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDay = (day) => (day ? new Date(day + 'T00:00:00').toLocaleDateString('en-US', { day: '2-digit', month: '2-digit' }) : '—');
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}
const docTitle = (d) => d.title || shortUrl(d.url);
const siteOf = (issue) => issue.url.replace(/\/browse\/.*$/, '');

// ---------------------------------------------------------------------------
// Urgency: what should be finished first

function dayDiff(day) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(day + 'T00:00:00') - today) / 86400000);
}

const URGENT_LABELS = new Set(['hotfix', 'urgent', 'gấp', 'gap', 'asap', 'blocker']);

function urgency(i) {
  const reasons = [];
  let score = 0;
  if (i.status.category === 'done') return { score: -1, reasons, level: null };
  if (i.due) {
    const d = dayDiff(i.due);
    if (d < 0) (score += 100), reasons.push({ level: 'danger', label: `${-d}d overdue` });
    else if (d === 0) (score += 80), reasons.push({ level: 'danger', label: 'Due today' });
    else if (d <= 3) (score += 50), reasons.push({ level: 'warn', label: `${d}d left` });
    else if (d <= 7) (score += 15), reasons.push({ level: 'info', label: `Due ${fmtDay(i.due)}` });
  }
  const p = (i.priority || '').toLowerCase();
  if (/highest|blocker|critical|urgent/.test(p)) (score += 60), reasons.push({ level: 'danger', label: `Priority ${i.priority}` });
  else if (/high|major/.test(p)) (score += 35), reasons.push({ level: 'info', label: `Priority ${i.priority}` }); // 35 = the urgent threshold: say why it is listed
  // Whole labels only: "data-gap" or "non-urgent" must not count as urgent.
  if (i.labels.some((l) => URGENT_LABELS.has(l.trim().toLowerCase()))) (score += 40), reasons.push({ level: 'warn', label: 'Urgent label' });
  const t = tone(i.status);
  score += t === 'prog' ? 8 : t === 'review' ? 4 : 0;
  const idle = Math.floor((Date.now() - Date.parse(i.updated)) / 86400000);
  if (t === 'prog' && idle >= 7) (score += 5), reasons.push({ level: 'info', label: `${idle}d since update` });
  const level = reasons.some((r) => r.level === 'danger') ? 'danger' : reasons.some((r) => r.level === 'warn') ? 'warn' : null;
  return { score, reasons, level };
}

// A status change is "held" for HOLD_MS (see state.js): the row stays where it was, in the same filter and
// group, so the user can see where it went. The sort / urgent checks use its previous status meanwhile.
function heldMove(key) {
  const m = recentlyTransitioned.get(key);
  // Held while the request is in flight (up to HOLD_PENDING_MS), then for HOLD_MS after Jira confirmed.
  return m && Date.now() - m.at < (m.settled ? HOLD_MS : HOLD_PENDING_MS) ? m : null;
}

function sortUrgency(i) {
  const m = heldMove(i.key);
  return urgency(m ? { ...i, status: m.from } : i);
}

const URGENT_SCORE = 35;
// For placing a row (urgent filter, urgent block): a held row keeps its previous status, so it does not vanish at once.
const isUrgent = (i) => sortUrgency(i).score >= URGENT_SCORE;
// For counting (the Urgent pill): the real status, so the number moves the moment a task does.
const isUrgentNow = (i) => urgency(i).score >= URGENT_SCORE;

const byUrgency = (a, b) => sortUrgency(b).score - sortUrgency(a).score || Date.parse(b.updated) - Date.parse(a.updated);

const reasonChips = (i) => urgency(i).reasons.map((r) => h('span', { class: `reason r-${r.level}` }, r.label));

function dueBadge(i) {
  if (!i.due || i.status.category === 'done') return null;
  const d = dayDiff(i.due);
  const lvl = d <= 0 ? 'danger' : d <= 3 ? 'warn' : 'info';
  return h('span', { class: `reason r-${lvl}`, title: `Due: ${fmtDay(i.due)}` }, d < 0 ? `${-d}d overdue` : d === 0 ? 'Today' : `Due ${fmtDay(i.due)}`);
}
