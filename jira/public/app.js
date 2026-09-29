'use strict';

// ---------------------------------------------------------------------------
// Tiny DOM helpers

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const ICONS = {
  chev: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 6 6 6-6 6"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  clip: '<path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.3-2.3l7.9-7.9"/>',
  mr: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4m0 0 2.5-2.5M11 6l2.5 2.5"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  ai: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  flame: '<path d="M12 22a7 7 0 0 0 7-7c0-4-3-6.5-4-9.5-1.5 2-2 3.5-2 5.5-1.5-1-2.5-2.5-2.5-4.5C7.5 9 5 11.5 5 15a7 7 0 0 0 7 7z"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  tree: '<path d="M6 3v12a3 3 0 0 0 3 3h6M6 9h9"/><circle cx="18" cy="9" r="2"/><circle cx="18" cy="18" r="2"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.7-4.4L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.4L20 16m0 4v-4h-4"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M16 7l3 3M14 9l2 2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  'circle-half': '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>',
};

function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstChild;
}

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem('jd:' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('jd:' + k, JSON.stringify(v));
    } catch {
      // Storage unavailable: preference just isn't remembered.
    }
  },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'X-Dashboard': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { login: !!data.login });
  return data;
}

// ---------------------------------------------------------------------------
// State

const PRESETS = [
  { label: 'Đang làm + mới xong', jql: '' },
  { label: 'Chưa xong', jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
  { label: 'Cập nhật 7 ngày', jql: 'assignee = currentUser() AND updated >= -7d ORDER BY updated DESC' },
  { label: 'Tất cả (90 ngày)', jql: 'assignee = currentUser() AND updated >= -90d ORDER BY updated DESC' },
  { label: 'Tôi tạo, chưa xong', jql: 'reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
];
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

// Read URL params on init
const initParams = new URLSearchParams(location.search);

const state = {
  issues: [],
  jql: LS.get('jql', ''),
  usedJql: '',
  defaultJql: '',
  view: initParams.get('view') || LS.get('view', 'list') === 'docs' ? 'docs' : 'list',
  me: null,
  user: initParams.get('user') || LS.get('user', ''),
  users: null,
  q: initParams.get('q') || '',
  type: initParams.get('type') || 'all',
  status: initParams.get('status') || null,
  sprint: initParams.has('sprint') ? (initParams.get('sprint') ? Number(initParams.get('sprint')) : null) : LS.get('sprint', null),
  urgentOnly: initParams.get('urgent') === '1',
  loading: false,
  error: null,
  errorLogin: false,
  fetchedAt: null,
  openKey: null,
  openIssue: null,
  menu: null,
  wide: LS.get('wide', false),
  closedGroups: new Set(LS.get('groupFold', [])),
  notif: { events: [], days: 7, loaded: false, error: null, seen: LS.get('notifSeen', 0), seenBefore: 0, open: false },
  recentlyViewed: LS.get('recentlyViewed', []),
  theme: LS.get('theme', 'auto'),
};
const cache = { transitions: new Map(), details: new Map() };
const recentlyTransitioned = new Map();

// Sync state to URL query params
function syncUrl() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.type !== 'all') params.set('type', state.type);
  if (state.status) params.set('status', state.status);
  if (state.urgentOnly) params.set('urgent', '1');
  if (state.user) params.set('user', state.user);
  if (state.sprint) params.set('sprint', String(state.sprint));
  if (state.view !== 'list') params.set('view', state.view);
  const query = params.toString();
  const url = location.pathname + (query ? '?' + query : '') + location.hash;
  history.replaceState(null, '', url);
}

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
    // Phân biệt Done thật vs Cancelled/Rejected
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
  return h('span', { class: `prio p-${k}`, title: `Ưu tiên: ${p}` }, PRIO[k] || '•');
};

const assigneeAvatar = (assignee) => {
  if (!assignee) return h('span', { class: 'assignee-empty', title: 'Chưa phân công' }, '—');
  const displayName = assignee.displayName || assignee;
  const initials = displayName
    .split(/\s+/)
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return h('span', { class: 'assignee-avatar', title: displayName }, initials);
};

const rtf = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' });
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
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDay = (day) => (day ? new Date(day + 'T00:00:00').toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }) : '—');
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

function urgency(i) {
  const reasons = [];
  let score = 0;
  if (i.status.category === 'done') return { score: -1, reasons, level: null };
  if (i.due) {
    const d = dayDiff(i.due);
    if (d < 0) (score += 100), reasons.push({ level: 'danger', label: `Quá hạn ${-d} ngày` });
    else if (d === 0) (score += 80), reasons.push({ level: 'danger', label: 'Hạn hôm nay' });
    else if (d <= 3) (score += 50), reasons.push({ level: 'warn', label: `Còn ${d} ngày` });
    else if (d <= 7) (score += 15), reasons.push({ level: 'info', label: `Hạn ${fmtDay(i.due)}` });
  }
  const p = (i.priority || '').toLowerCase();
  if (/highest|blocker|critical|urgent/.test(p)) (score += 60), reasons.push({ level: 'danger', label: `Ưu tiên ${i.priority}` });
  else if (/high|major/.test(p)) score += 35;
  if (i.labels.some((l) => /hotfix|urgent|gấp|gap|asap|blocker/i.test(l))) (score += 40), reasons.push({ level: 'warn', label: 'Nhãn gấp' });
  const t = tone(i.status);
  score += t === 'prog' ? 8 : t === 'review' ? 4 : 0;
  const idle = Math.floor((Date.now() - Date.parse(i.updated)) / 86400000);
  if (t === 'prog' && idle >= 7) (score += 5), reasons.push({ level: 'info', label: `${idle} ngày chưa cập nhật` });
  const level = reasons.some((r) => r.level === 'danger') ? 'danger' : reasons.some((r) => r.level === 'warn') ? 'warn' : null;
  return { score, reasons, level };
}

const isUrgent = (i) => urgency(i).score >= 35;

const byUrgency = (a, b) => {
  const now = Date.now();
  const aLocked = recentlyTransitioned.get(a.key);
  const bLocked = recentlyTransitioned.get(b.key);
  
  if (aLocked && bLocked && now - aLocked < 3000 && now - bLocked < 3000) {
    return aLocked - bLocked;
  }
  
  if (aLocked && now - aLocked < 3000) return -1;
  if (bLocked && now - bLocked < 3000) return 1;
  
  return urgency(b).score - urgency(a).score || Date.parse(b.updated) - Date.parse(a.updated);
};

const reasonChips = (i) => urgency(i).reasons.map((r) => h('span', { class: `reason r-${r.level}` }, r.label));

function dueBadge(i) {
  if (!i.due || i.status.category === 'done') return null;
  const d = dayDiff(i.due);
  const lvl = d <= 0 ? 'danger' : d <= 3 ? 'warn' : 'info';
  return h('span', { class: `reason r-${lvl}`, title: `Hạn: ${fmtDay(i.due)}` }, d < 0 ? `Quá hạn ${-d}n` : d === 0 ? 'Hôm nay' : `Hạn ${fmtDay(i.due)}`);
}

// ---------------------------------------------------------------------------
// Copy for AI

function htmlToText(html, site) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = new URL(a.getAttribute('href'), site + '/').href;
    if (a.textContent.trim() !== href) a.append(` (${href})`);
  }
  for (const li of doc.querySelectorAll('li')) li.prepend('- ');
  for (const el of doc.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,br,pre')) el.append('\n');
  return doc.body.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function issueMarkdown(i, d) {
  const site = siteOf(i);
  const docs = d?.issue?.docs?.length ? d.issue.docs : i.docs;
  const extraDocs = d?.confluence || [];
  const L = [
    `## ${i.key}: ${i.summary}`,
    `- Jira: ${i.url}`,
    `- Trạng thái: ${i.status.name} · Loại: ${i.type.name} · Ưu tiên: ${i.priority || '—'}${i.due ? ` · Hạn: ${i.due}` : ''}`,
  ];
  const reasons = urgency(i).reasons;
  if (reasons.length) L.push(`- Cần chú ý: ${reasons.map((r) => r.label).join(', ')}`);
  if (i.parent) L.push(`- Parent: ${i.parent.key} ${i.parent.summary} — ${site}/browse/${i.parent.key}`);
  const allDocs = [...docs, ...extraDocs.filter((x) => !docs.some((y) => (y.pageId || y.url) === (x.pageId || x.url)))];
  if (allDocs.length) {
    L.push('- Tài liệu Confluence:');
    for (const x of allDocs) L.push(`  - ${docTitle(x)}: ${x.url}`);
  }
  if (i.attachments.length) {
    L.push('- File đính kèm:');
    for (const a of i.attachments) L.push(`  - ${a.filename}: ${a.url}`);
  }
  if (d) {
    const mrs = d.links.filter((l) => l.kind === 'mr');
    if (mrs.length) {
      L.push('- Merge request:');
      for (const l of mrs) L.push(`  - ${l.title}: ${l.url}`);
    }
    if (d.children.length) {
      L.push('- Task con:');
      for (const c of d.children) L.push(`  - ${c.key} [${c.status?.name || ''}] ${c.summary} — ${site}/browse/${c.key}`);
    }
    const desc = htmlToText(d.descriptionHtml, site);
    if (desc) L.push('', '### Mô tả', desc);
    if (d.comments.length) {
      L.push('', '### Bình luận');
      for (const c of d.comments) L.push(`- ${c.author} (${fmtDate(c.created)}): ${htmlToText(c.html, site).replace(/\s*\n\s*/g, ' ')}`);
    }
  }
  return L.join('\n');
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(message);
}

const claudePrompt = (i, d) =>
  `Đọc task Jira dưới đây (dùng Atlassian MCP để xem chi tiết và các tài liệu Confluence liên quan):\n\n${issueMarkdown(i, d)}`.slice(0, 11_000);

// Opens a new Claude Code tab in Cursor with the task prefilled. An already-open session can't take a
// prompt from outside, so the same text also goes to the clipboard for pasting there.
async function sendToClaude(i, d) {
  const prompt = claudePrompt(i, d);
  try {
    await navigator.clipboard.writeText(prompt);
  } catch {
    // Clipboard unavailable: the new tab still gets the prompt.
  }
  try {
    await api('/api/claude-code', { method: 'POST', body: JSON.stringify({ prompt }) });
    toast(`Đã mở ${i.key} trong Claude Code (Cursor). Nội dung cũng đã được copy để dán vào phiên đang mở.`);
  } catch (e) {
    toast(`Không mở được Claude Code: ${e.message}. Nội dung đã được copy — dán thủ công.`, 'error');
  }
}

function claudeButton(i) {
  return h(
    'button',
    {
      class: 'icon-btn sm claude-btn',
      title: 'Mở trong Claude Code (Cursor) — tab mới với task điền sẵn, đồng thời copy nội dung',
      'aria-label': `Mở ${i.key} trong Claude Code`,
      onClick: (e) => {
        e.stopPropagation();
        sendToClaude(i);
      },
    },
    icon('ai'),
  );
}

// ---------------------------------------------------------------------------
// Data

async function load({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $('#refresh').classList.add('spin');
  $('#refresh').disabled = true;
  try {
    const params = new URLSearchParams();
    if (state.jql) params.set('jql', state.jql);
    if (state.user) params.set('user', state.user);
    const data = await api('/api/issues' + (params.size ? '?' + params : ''));
    state.issues = data.issues;
    state.defaultJql = data.defaultJql;
    state.usedJql = data.jql;
    state.error = null;
    state.fetchedAt = new Date();
    cache.transitions.clear();
    recentlyTransitioned.clear();
    if (!state.jql) $('#jql').value = data.defaultJql;
    if (state.openKey) state.openIssue = state.issues.find((i) => i.key === state.openKey) || state.openIssue;
  } catch (e) {
    if (silent && state.issues.length) toast(`Không tải lại được: ${e.message}`, 'error');
    else (state.error = e.message), (state.errorLogin = e.login);
  } finally {
    state.loading = false;
    $('#refresh').classList.remove('spin');
    $('#refresh').disabled = false;
    render();
  }
}

function getTransitions(key) {
  if (!cache.transitions.has(key)) {
    const p = api(`/api/issues/${key}/transitions`).then((d) => d.transitions);
    p.catch(() => cache.transitions.delete(key));
    cache.transitions.set(key, p);
  }
  return cache.transitions.get(key);
}

function getDetail(key) {
  if (!cache.details.has(key)) {
    const p = api(`/api/issues/${key}`);
    p.catch(() => cache.details.delete(key));
    cache.details.set(key, p);
  }
  return cache.details.get(key);
}

async function transition(issue, t) {
  const prev = issue.status;
  issue.status = { ...t.to };
  issue.pending = true;
  
  recentlyTransitioned.set(issue.key, Date.now());
  
  render();
  try {
    const d = await api(`/api/issues/${issue.key}/transitions`, { method: 'POST', body: JSON.stringify({ id: t.id }) });
    issue.status = d.status;
    toast(`${issue.key} → ${d.status.name}`);
  } catch (e) {
    issue.status = prev;
    recentlyTransitioned.delete(issue.key);
    toast(`${issue.key}: ${e.message}`, 'error', { href: issue.url, label: 'Mở trên Jira' });
  } finally {
    issue.pending = false;
    cache.transitions.delete(issue.key);
    cache.details.delete(issue.key);
    render();
    
    setTimeout(() => {
      recentlyTransitioned.delete(issue.key);
      render();
    }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Render

// Type + search only; status/urgency filters come on top in filtered().
function scoped() {
  const q = state.q.trim().toLowerCase();
  return state.issues.filter(
    (i) =>
      (state.type === 'all' || i.type.name === state.type) &&
      (!q ||
        i.key.toLowerCase().includes(q) ||
        i.summary.toLowerCase().includes(q) ||
        (i.parent && (i.parent.key.toLowerCase().includes(q) || i.parent.summary.toLowerCase().includes(q)))),
  );
}

function filtered() {
  return scoped().filter(
    (i) => 
      (!state.status || i.status.name === state.status) && 
      (!state.urgentOnly || isUrgent(i)) &&
      (!state.sprint || (i.sprint && i.sprint.id === Number(state.sprint)))
  );
}

// ---------------------------------------------------------------------------
// Progress

const isCancelled = (i) => i.status.category === 'done' && /cancel|hủy|huỷ|reject|won.?t|invalid|duplicate/i.test(i.status.name);

function renderProgress() {
  const el = $('#progress-strip');
  const base = scoped();
  if (state.error || !state.fetchedAt || !base.length) return el.replaceChildren();
  const cancelled = base.filter(isCancelled).length;
  const done = base.filter((i) => i.status.category === 'done').length - cancelled;
  const doing = base.filter((i) => i.status.category === 'indeterminate').length;
  const todo = base.length - done - doing - cancelled;
  const counted = base.length - cancelled;
  const pct = counted ? Math.round((done / counted) * 100) : 0;
  const parts = [
    ['done', 'Hoàn thành', done],
    ['prog', 'Đang làm', doing],
    ['new', 'Chưa làm', todo],
    ['void', 'Đã huỷ', cancelled],
  ].filter((p) => p[2] > 0);
  
  // Story Points calculation
  const totalSP = base.reduce((sum, i) => sum + (i.storyPoints || 0), 0);
  const doneSP = base.filter((i) => i.status.category === 'done' && !isCancelled(i)).reduce((sum, i) => sum + (i.storyPoints || 0), 0);
  const doingSP = base.filter((i) => i.status.category === 'indeterminate').reduce((sum, i) => sum + (i.storyPoints || 0), 0);
  const todoSP = totalSP - doneSP - doingSP;
  const spPct = totalSP ? Math.round((doneSP / totalSP) * 100) : 0;
  const spParts = [
    ['done', 'Đã xong', doneSP],
    ['prog', 'Đang làm', doingSP],
    ['new', 'Chưa làm', todoSP],
  ].filter((p) => p[2] > 0);
  
  const cards = [
    h(
      'div',
      { class: 'progress-card' },
      h(
        'div',
        { class: 'progress-top' },
        h('span', { class: 'progress-title' }, h('b', null, `${done}/${counted}`), ' hoàn thành', h('span', { class: 'pct' }, `${pct}%`)),
        h(
          'div',
          { class: 'track', role: 'img', 'aria-label': parts.map(([, label, n]) => `${label} ${n}`).join(', ') + ` trên tổng ${base.length}` },
          parts.map(([tone, label, n]) => h('span', { class: `seg seg-${tone}`, style: `width:${(n / base.length) * 100}%`, title: `${label}: ${n}` })),
        ),
      ),
      h(
        'span',
        { class: 'legend' },
        parts.map(([tone, label, n]) => h('span', { class: `legend-item seg-${tone}` }, h('span', { class: 'dot' }), label, ' ', h('b', null, n))),
      ),
    ),
  ];
  
  // Only show story points card if there are any story points
  if (totalSP > 0) {
    cards.push(
      h(
        'div',
        { class: 'progress-card' },
        h(
          'div',
          { class: 'progress-top' },
          h('span', { class: 'progress-title' }, h('b', null, `${doneSP}/${totalSP}`), ' story points', h('span', { class: 'pct' }, `${spPct}%`)),
          h(
            'div',
            { class: 'track', role: 'img', 'aria-label': spParts.map(([, label, n]) => `${label} ${n}`).join(', ') },
            spParts.map(([tone, label, n]) => h('span', { class: `seg seg-${tone}`, style: `width:${(n / totalSP) * 100}%`, title: `${label}: ${n}` })),
          ),
        ),
        h(
          'span',
          { class: 'legend' },
          spParts.map(([tone, label, n]) => h('span', { class: `legend-item seg-${tone}` }, h('span', { class: 'dot' }), label, ' ', h('b', null, n))),
        ),
      ),
    );
  }
  
  el.replaceChildren(...cards);
}

// ---------------------------------------------------------------------------
// Notifications (other people's changes/comments on my issues, last 7 days)

async function loadNotifications({ fresh = false } = {}) {
  try {
    const d = await api('/api/notifications' + (fresh ? '?fresh=1' : ''));
    state.notif.events = d.events;
    state.notif.days = d.days;
    state.notif.error = null;
  } catch (e) {
    state.notif.error = e.message;
  }
  state.notif.loaded = true;
  renderBell();
  if (state.notif.open) renderNotifPanel();
}

function renderBell() {
  const unread = state.notif.events.filter((e) => Date.parse(e.at) > state.notif.seen).length;
  const badge = $('#bell-badge');
  badge.hidden = !unread;
  badge.textContent = unread > 99 ? '99+' : String(unread);
  const bell = $('#bell');
  if (bell) bell.title = unread ? `${unread} thông báo mới` : 'Thông báo';
}

function toggleNotif(force) {
  const n = state.notif;
  n.open = force ?? !n.open;
  $('#notif').hidden = !n.open;
  $('#bell').setAttribute('aria-expanded', String(n.open));
  if (!n.open) return;
  // Opening marks everything read; keep the previous mark to highlight what was new.
  n.seenBefore = n.seen;
  n.seen = Date.now();
  LS.set('notifSeen', n.seen);
  renderBell();
  renderNotifPanel();
  if (!n.loaded) loadNotifications();
}

function toggleRecent(force) {
  const recent = $('#recent');
  const isOpen = force ?? recent.hidden;
  recent.hidden = !isOpen;
  $('#recent-btn').setAttribute('aria-expanded', String(isOpen));
  if (!isOpen) return;
  renderRecentPanel();
}

function renderRecentPanel() {
  const recent = $('#recent');
  const viewed = state.recentlyViewed
    .map(key => state.issues.find(i => i.key === key) || { key, summary: '(not in current filter)', url: null })
    .slice(0, 10);
  
  const item = (i) =>
    h(
      'button',
      {
        class: 'notif-item',
        onClick: () => {
          toggleRecent(false);
          openDetail(i.key);
        },
      },
      i.type && h('span', { class: 'avatar' }, typeBadge(i.type.name)),
      h(
        'span',
        { class: 'notif-body' },
        h('span', { class: 'notif-issue' }, h('span', { class: 'key' }, i.key), h('span', { class: 'notif-sum' }, i.summary)),
        i.status && h('span', { class: 'muted small' }, i.status.name),
      ),
    );
  
  recent.replaceChildren(
    h(
      'div',
      { class: 'notif-head' },
      h('b', null, 'Recently Viewed'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn sm', title: 'Clear', onClick: () => {
        state.recentlyViewed = [];
        LS.set('recentlyViewed', []);
        renderRecentPanel();
      }}, icon('x')),
      h('button', { class: 'icon-btn sm', title: 'Close', onClick: () => toggleRecent(false) }, icon('x')),
    ),
    h(
      'div',
      { class: 'notif-list' },
      viewed.length
        ? viewed.map(item)
        : h('div', { class: 'notif-empty' }, 'No recently viewed issues.'),
    ),
  );
}

function renderNotifPanel() {
  const n = state.notif;
  // "Nguyễn Phương Anh - ANHNP103" / "Cù Huy Toàn (VSF-…)" → drop the employee-code suffix first.
  const initials = (name) =>
    name
      .split(/\s+[-(]/)[0]
      .split(/\s+/)
      .filter(Boolean)
      .slice(-2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?';
  const verb = (e) => (e.kind === 'comment' ? (e.mention ? 'nhắc đến bạn trong bình luận' : 'bình luận') : e.text);
  const item = (e) =>
    h(
      'button',
      {
        class: `notif-item${Date.parse(e.at) > n.seenBefore ? ' unread' : ''}${e.mention ? ' mention' : ''}`,
        onClick: () => {
          toggleNotif(false);
          openDetail(e.issue.key);
        },
      },
      h('span', { class: `avatar k-${e.kind}` }, initials(e.author)),
      h(
        'span',
        { class: 'notif-body' },
        h('span', { class: 'notif-line' }, h('b', null, e.author || 'Ai đó'), ' ', verb(e)),
        e.kind === 'comment' && e.text && h('span', { class: 'notif-quote' }, e.text),
        h('span', { class: 'notif-issue' }, typeBadge(e.issue.type), h('span', { class: 'key' }, e.issue.key), h('span', { class: 'notif-sum' }, e.issue.summary)),
        h('span', { class: 'muted small', title: fmtDate(e.at) }, rel(e.at)),
      ),
    );
  $('#notif').replaceChildren(
    h(
      'div',
      { class: 'notif-head' },
      h('b', null, 'Thông báo'),
      h('span', { class: 'muted small' }, `${n.days} ngày qua · task bạn làm, tạo hoặc theo dõi`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn sm', title: 'Tải lại thông báo', onClick: () => loadNotifications({ fresh: true }) }, icon('refresh')),
      h('button', { class: 'icon-btn sm', title: 'Đóng', onClick: () => toggleNotif(false) }, icon('x')),
    ),
    h(
      'div',
      { class: 'notif-list' },
      !n.loaded
        ? h('div', { class: 'notif-empty' }, 'Đang tải…')
        : n.error
          ? h('div', { class: 'notif-empty err' }, n.error)
          : n.events.length
            ? n.events.map(item)
            : h('div', { class: 'notif-empty' }, 'Không có hoạt động mới từ người khác.'),
    ),
  );
}

function render() {
  closeMenu();
  renderMeta();
  for (const b of document.querySelectorAll('#views button')) b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  const list = filtered();
  renderTypes();
  renderSprints();
  renderProgress();
  renderFocus();
  renderStats();
  syncUrl();

  const main = $('#main');
  if (state.error) {
    main.replaceChildren(
      h(
        'div',
        { class: 'error-box' },
        h('div', null, h('strong', null, 'Không tải được dữ liệu. '), state.error),
        state.errorLogin && h('a', { class: 'btn primary', href: '/oauth/login' }, 'Đăng nhập Atlassian'),
      ),
    );
    return;
  }
  if (!state.fetchedAt) return;
  if (!state.issues.length) {
    main.replaceChildren(h('div', { class: 'empty-state' }, 'Không có task nào khớp JQL này.'));
    return;
  }
  main.replaceChildren(state.view === 'docs' ? renderDocs(list) : renderList(list));
  if (state.openKey) refreshDrawerStatus();
}

function renderMeta() {
  const parts = [];
  if (state.me) {
    parts.push(state.me.name);
    if (state.me.auth.source === 'own') parts.push('tự refresh token');
    else if (state.me.auth.expiresAt) {
      parts.push(`token Claude Code hết hạn ${new Date(state.me.auth.expiresAt).toLocaleString('vi-VN', { timeStyle: 'short', dateStyle: 'short' })}`);
    }
  }
  if (state.fetchedAt) parts.push(`cập nhật ${state.fetchedAt.toLocaleTimeString('vi-VN', { timeStyle: 'short' })}`);
  
  // Set tooltip on login button
  const login = $('#login');
  if (login && parts.length) {
    login.title = parts.join(' · ');
  }
}

function renderTypes() {
  const counts = new Map();
  for (const i of state.issues) counts.set(i.type.name, (counts.get(i.type.name) || 0) + 1);
  if (state.type !== 'all' && !counts.has(state.type)) state.type = 'all';
  const select = $('#type-filter');
  select.replaceChildren(
    h('option', { value: 'all' }, `Mọi loại (${state.issues.length})`),
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => h('option', { value: name }, `${name} (${n})`)),
  );
  select.value = state.type;
  select.hidden = counts.size < 2;
  syncUrl();
}

function renderSprints() {
  const sprints = new Map();
  for (const i of state.issues) {
    if (i.sprint) sprints.set(i.sprint.id, i.sprint);
  }
  const select = $('#sprint-filter');
  if (sprints.size === 0) {
    select.hidden = true;
    return;
  }
  const sorted = [...sprints.values()].sort((a, b) => {
    if (a.state === 'active' && b.state !== 'active') return -1;
    if (a.state !== 'active' && b.state === 'active') return 1;
    return b.name.localeCompare(a.name);
  });
  const counts = new Map();
  for (const i of state.issues) {
    if (i.sprint) counts.set(i.sprint.id, (counts.get(i.sprint.id) || 0) + 1);
  }
  select.replaceChildren(
    h('option', { value: '' }, 'Mọi sprint'),
    ...sorted.map((s) => 
      h('option', { value: s.id }, `${s.name}${s.state === 'active' ? ' 🟢' : ''} (${counts.get(s.id) || 0})`)
    ),
  );
  select.value = state.sprint || '';
  select.hidden = false;
  syncUrl();
}

function renderFocus() {
  const el = $('#focus');
  if (state.error || !state.fetchedAt || !state.issues.length) return el.replaceChildren();
  const urgent = state.issues.filter(isUrgent).sort(byUrgency);
  if (!urgent.length) return el.replaceChildren();
  const row = (i) => {
    const u = urgency(i);
    const isDone = i.status.category === 'done';
    return h(
      'div',
      { class: `focus-row lvl-${u.level || 'none'}${isDone ? ' done' : ''}`, onClick: (e) => !e.target.closest('a,button') && openDetail(i.key) },
      h('div', { class: 'focus-reasons' }, reasonChips(i)),
      h('div', { class: 'focus-main' }, typeBadge(i.type.name), keyLink(i), h('span', { class: 'focus-summary', title: i.summary }, i.summary)),
      h('div', { class: 'focus-actions' }, statusButton(i), claudeButton(i)),
    );
  };
  el.replaceChildren(
    h(
      'div',
      { class: 'focus-head' },
      h('h2', null, icon('flame'), 'Cần xử lý gấp'),
      h('span', { class: `count ${urgent.length ? 'hot' : ''}` }, urgent.length),
      h('span', { class: 'muted small' }, 'Quá hạn, sắp đến hạn (≤ 3 ngày), ưu tiên High trở lên hoặc có nhãn gấp'),
    ),
    urgent.length
      ? h(
          'div',
          { class: 'focus-list' },
          urgent.slice(0, 6).map(row),
          urgent.length > 6 &&
            h(
              'button',
              {
                class: 'link-btn',
                onClick: () => {
                  state.urgentOnly = true;
                  syncUrl();
                  render();
                },
              },
              `Xem tất cả ${urgent.length} task gấp →`,
            ),
        )
      : h('div', { class: 'focus-empty' }, 'Không có task quá hạn, sắp đến hạn hay ưu tiên cao.'),
  );
}

function renderStats() {
  const all = state.issues;
  if (!all.length) return $('#stats').replaceChildren();
  const pill = (label, value, toneName, pressed, onClick) =>
    h(
      'button',
      { class: `pill ${toneName ? 'tone-' + toneName : ''} ${toneName === 'hot' && value ? 'hot' : ''}`, 'aria-pressed': String(pressed), onClick },
      toneName && h('span', { class: 'dot' }),
      label,
      h('b', null, value),
    );
  $('#stats').replaceChildren(
    pill('Tất cả', all.length, null, !state.status && !state.urgentOnly, () => {
      state.status = null;
      state.urgentOnly = false;
      syncUrl();
      render();
    }),
    pill('Gấp', all.filter(isUrgent).length, 'hot', state.urgentOnly, () => {
      state.urgentOnly = !state.urgentOnly;
      syncUrl();
      render();
    }),
    ...statusList(all).map((s) =>
      pill(s.name, all.filter((i) => i.status.name === s.name).length, tone(s), state.status === s.name, () => {
        state.status = state.status === s.name ? null : s.name;
        state.urgentOnly = false;
        syncUrl();
        render();
      }),
    ),
  );
}

function keyLink(i) {
  return h(
    'a',
    {
      class: 'key',
      href: '#' + i.key,
      title: 'Mở chi tiết',
      onClick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let the browser open a new tab
        e.preventDefault();
        e.stopPropagation();
        openDetail(i.key);
      },
    },
    i.key,
  );
}

function statusButton(issue) {
  return h(
    'button',
    {
      class: `status tone-${tone(issue.status)}`,
      title: 'Đổi trạng thái',
      onClick: (e) => {
        e.stopPropagation();
        openStatusMenu(e.currentTarget, issue);
      },
    },
    issue.status.name,
    icon('chev'),
  );
}

const statusPill = (status) => status && h('span', { class: `status static tone-${tone(status)}` }, status.name);

function docBadges(issue) {
  return [
    issue.docs.length > 0 &&
      h('span', { class: 'badge doc', title: issue.docs.map(docTitle).join('\n') }, icon('doc'), issue.docs.length),
    issue.attachments.length > 0 &&
      h('span', { class: 'badge', title: issue.attachments.map((a) => a.filename).join('\n') }, icon('clip'), issue.attachments.length),
  ];
}

// --- list (grouped by parent; parents fold/unfold on click) ---

function renderList(list) {
  if (!list.length) return h('div', { class: 'empty-state' }, 'Không có task nào khớp bộ lọc.');
  const byKey = new Map(state.issues.map((i) => [i.key, i]));
  const groups = new Map();
  for (const i of list) {
    if (!i.parent) continue;
    if (!groups.has(i.parent.key)) groups.set(i.parent.key, { parent: byKey.get(i.parent.key) || i.parent, items: [] });
    groups.get(i.parent.key).items.push(i);
  }
  // A parent that is itself one of my issues is shown as its group's header.
  const loose = list.filter((i) => !i.parent && !groups.has(i.key)).sort(byUrgency);
  for (const g of groups.values()) g.items.sort(byUrgency);
  const top = (g) => Math.max(...g.items.map((i) => urgency(i).score));
  const latest = (g) => Math.max(...g.items.map((i) => Date.parse(i.updated)));
  const ordered = [...groups.values()].sort((a, b) => top(b) - top(a) || latest(b) - latest(a));

  const row = (i, child) => {
    const u = urgency(i);
    const isDone = i.status.category === 'done';
    return h(
      'div',
      {
        class: `row lvl-${u.level || 'none'}${child ? ' child' : ''}${i.pending ? ' pending' : ''}${isDone ? ' done' : ''}`,
        onClick: (e) => !e.target.closest('a,button') && openDetail(i.key),
      },
      h('div', { class: 'c-key' }, typeBadge(i.type.name), keyLink(i), i.storyPoints && h('span', { class: 'sp-badge', title: 'Story Points' }, i.storyPoints + ' SP')),
      h('div', { class: 'c-sum' }, h('span', { class: 'sum-text', title: i.summary }, i.summary), u.reasons.length ? reasonChips(i) : dueBadge(i)),
      h('div', { class: 'c-assignee' }, assigneeAvatar(i.assignee)),
      h('div', { class: 'c-status' }, statusButton(i)),
      h('div', { class: 'c-prio' }, prio(i.priority), ' ', i.priority || ''),
      h('div', { class: 'c-docs' }, docBadges(i)),
      h('div', { class: 'c-upd muted small', title: fmtDate(i.updated) }, rel(i.updated)),
      h('div', { class: 'c-act' }, claudeButton(i)),
    );
  };

  // Groups whose subtasks are all finished (Done or Cancelled) start collapsed; everything else starts expanded.
  const isClosed = (parent, items) => {
    // Check if all subtasks in this group are done (including cancelled)
    const allDone = items.every(i => i.status.category === 'done');
    const override = state.closedGroups.has(parent.key);
    // An override flips whatever the auto default would be.
    const result = override ? !allDone : allDone;
    if (allDone) {
      console.log(`[isClosed] ${parent.key}: allDone=${allDone}, override=${override}, result=${result}`, items.map(i => ({ key: i.key, cat: i.status.category })));
    }
    return result;
  };

  const groupRow = (parent, items, count, hot) => {
    const mine = parent.url ? parent : null; // full issue DTO when the parent is also assigned to me
    const closed = isClosed(parent, items);
    const toggle = () => {
      // Any click flips the current state; store/remove the override accordingly
      state.closedGroups.has(parent.key) ? state.closedGroups.delete(parent.key) : state.closedGroups.add(parent.key);
      LS.set('groupFold', [...state.closedGroups]);
      render();
    };
    
    // Count by type
    const typeCounts = new Map();
    for (const i of items) {
      const typeName = i.type.name.toLowerCase();
      let category = 'other';
      if (typeName.includes('task')) category = 'task';
      else if (typeName.includes('bug')) category = 'bug';
      else if (typeName.includes('story')) category = 'story';
      typeCounts.set(category, (typeCounts.get(category) || 0) + 1);
    }
    
    const parts = [];
    const taskCount = typeCounts.get('task') || 0;
    const bugCount = typeCounts.get('bug') || 0;
    const storyCount = typeCounts.get('story') || 0;
    const otherCount = typeCounts.get('other') || 0;
    
    if (taskCount > 0) parts.push(`${taskCount} task${taskCount > 1 ? 's' : ''}`);
    if (bugCount > 0) parts.push(`${bugCount} bug${bugCount > 1 ? 's' : ''}`);
    if (storyCount > 0) parts.push(`${storyCount} stor${storyCount > 1 ? 'ies' : 'y'}`);
    if (otherCount > 0) parts.push(`${otherCount} khác`);
    if (hot > 0) parts.push(`${hot} gấp`);
    
    const claudeGroupButton = h(
      'button',
      {
        class: 'icon-btn sm claude-btn',
        title: `Mở ${parent.key} + ${items.length} subtask trong Claude Code`,
        'aria-label': `Mở nhóm ${parent.key} trong Claude Code`,
        onClick: async (e) => {
          e.stopPropagation();
          // Build combined prompt with parent + all subtasks
          let combined = `# ${parent.key}: ${parent.summary}\n\n`;
          if (mine) {
            combined += issueMarkdown(mine, await getDetail(parent.key).catch(() => null));
          } else {
            combined += `- Jira: ${parent.url || siteOf(items[0]) + '/browse/' + parent.key}\n`;
            combined += `- Loại: ${parent.type?.name || parent.type}\n`;
          }
          combined += `\n---\n\n## Subtasks (${items.length}):\n\n`;
          for (const item of items) {
            combined += `### ${item.key}: ${item.summary}\n`;
            combined += `- Trạng thái: ${item.status.name}\n`;
            combined += `- Jira: ${item.url}\n`;
            const u = urgency(item);
            if (u.reasons.length) combined += `- Cần chú ý: ${u.reasons.map(r => r.label).join(', ')}\n`;
            combined += '\n';
          }
          combined = combined.slice(0, 11_000);
          try {
            await navigator.clipboard.writeText(combined);
          } catch {
            // Clipboard unavailable
          }
          try {
            await api('/api/claude-code', { method: 'POST', body: JSON.stringify({ prompt: combined }) });
            toast(`Đã mở ${parent.key} + ${items.length} subtask trong Claude Code`);
          } catch (err) {
            toast(`Không mở được Claude Code: ${err.message}. Nội dung đã copy.`, 'error');
          }
        },
      },
      icon('ai'),
    );
    
    return h(
      'div',
      {
        class: `group${closed ? ' closed' : ''}`,
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(!closed),
        title: closed ? 'Mở rộng' : 'Thu gọn',
        onClick: (e) => !e.target.closest('a,button') && toggle(),
        onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), toggle()),
      },
      // c-key: fold icon + type badge + key
      h('div', { class: 'c-key' }, 
        h('span', { class: 'fold-icon' }, icon('chevRight')),
        typeBadge(parent.type?.name || parent.type),
        mine ? keyLink(mine) : h('a', { class: 'key', href: '#' + parent.key, title: 'Mở chi tiết', onClick: (e) => (e.preventDefault(), openDetail(parent.key)) }, parent.key)
      ),
      // c-sum: group title
      h('div', { class: 'c-sum' }, h('span', { class: 'group-title' }, parent.summary)),
      // c-assignee: empty
      h('div', { class: 'c-assignee' }),
      // c-status: status button or parts text
      h('div', { class: 'c-status' }, mine ? statusButton(mine) : h('span', { class: 'muted small' }, parts.join(', '))),
      // c-prio: empty
      h('div', { class: 'c-prio' }),
      // c-docs: empty
      h('div', { class: 'c-docs' }),
      // c-upd: empty
      h('div', { class: 'c-upd' }),
      // c-act: claude button
      h('div', { class: 'c-act' }, claudeGroupButton),
    );
  };

  const out = h(
    'div',
    { class: 'list' },
    h('div', { class: 'list-head' }, ['Key', 'Tiêu đề', 'Người', 'Trạng thái', 'Ưu tiên', 'Tài liệu', 'Cập nhật', ''].map((t, idx) => h('div', { class: idx === 4 ? 'h-prio' : null }, t))),
  );
  for (const g of ordered) {
    out.append(groupRow(g.parent, g.items, g.items.length, g.items.filter(isUrgent).length));
    if (!isClosed(g.parent, g.items)) out.append(...g.items.map((i) => row(i, true)));
  }
  if (loose.length) {
    if (ordered.length) out.append(h('div', { class: 'group plain' }, h('span', { class: 'muted' }, 'Không thuộc nhóm')));
    out.append(...loose.map((i) => row(i, false)));
  }
  return out;
}

// --- docs ---

function renderDocs(list) {
  const pages = new Map();
  for (const i of list) {
    for (const d of i.docs) {
      const k = d.pageId || d.url;
      if (!pages.has(k)) pages.set(k, { doc: d, issues: [] });
      pages.get(k).issues.push(i);
    }
  }
  const attachments = list.flatMap((i) => i.attachments.map((a) => ({ ...a, issue: i })));

  const issueChip = (i) =>
    h('button', { class: 'issue-chip', title: i.summary, onClick: () => openDetail(i.key) }, h('span', { class: `dot tone-${tone(i.status)}` }), i.key);

  return h(
    'div',
    null,
    h('h2', { class: 'section-title' }, 'Trang Confluence', h('span', { class: 'muted small' }, pages.size)),
    pages.size
      ? h(
          'div',
          { class: 'doc-grid' },
          [...pages.values()]
            .sort((a, b) => b.issues.length - a.issues.length)
            .map(({ doc, issues }) =>
              h(
                'div',
                { class: 'doc-card' },
                h(
                  'div',
                  { class: 'doc-head' },
                  h('a', { class: 'doc-title', href: doc.url, target: '_blank', rel: 'noopener' }, icon('doc'), h('span', null, docTitle(doc))),
                  h(
                    'button',
                    { class: 'icon-btn sm', title: 'Copy link', onClick: () => copyText(`${docTitle(doc)}: ${doc.url}`, 'Đã copy link trang') },
                    icon('copy'),
                  ),
                ),
                h('div', { class: 'muted small doc-url', title: doc.url }, shortUrl(doc.url)),
                h('div', { class: 'issue-chips' }, issues.map(issueChip)),
              ),
            ),
        )
      : h('div', { class: 'empty-state', style: 'margin-bottom:28px' }, 'Chưa có task nào link tới trang Confluence.'),
    h('h2', { class: 'section-title' }, 'File đính kèm trên Jira', h('span', { class: 'muted small' }, attachments.length)),
    attachments.length
      ? h(
          'ul',
          { class: 'link-list' },
          attachments.map((a) =>
            h(
              'li',
              null,
              icon('clip'),
              h('a', { href: a.url, target: '_blank', rel: 'noopener', title: a.filename }, a.filename),
              h('span', { class: 'muted small' }, fmtSize(a.size)),
              h('span', { class: 'tag' }, issueChip(a.issue)),
            ),
          ),
        )
      : h('div', { class: 'empty-state' }, 'Không có file đính kèm.'),
  );
}

// ---------------------------------------------------------------------------
// Issue detail (in-app; any issue key, not only the listed ones)

async function openDetail(key) {
  if (!ISSUE_KEY_RE.test(key)) return;
  closeMenu();
  state.openKey = key;
  state.openIssue = state.issues.find((i) => i.key === key) || null;
  if (location.hash !== '#' + key) history.replaceState(null, '', '#' + key);
  
  // Track recently viewed
  state.recentlyViewed = [key, ...state.recentlyViewed.filter(k => k !== key)].slice(0, 10);
  LS.set('recentlyViewed', state.recentlyViewed);
  
  const drawer = $('#drawer');
  drawer.classList.toggle('wide', state.wide);
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;

  if (state.openIssue) renderDetail(state.openIssue, null);
  else drawer.replaceChildren(detailHead(null, key), h('div', { class: 'drawer-body' }, h('div', { class: 'muted' }, 'Đang tải…')));

  try {
    const d = await getDetail(key);
    if (state.openKey !== key) return;
    if (!state.openIssue) state.openIssue = d.issue;
    renderDetail(state.openIssue, d);
  } catch (e) {
    if (state.openKey !== key) return;
    const body = $('.drawer-body', drawer);
    body?.append(h('div', { class: 'error-box' }, e.message, e.login && h('a', { class: 'btn primary', href: '/oauth/login' }, 'Đăng nhập Atlassian')));
    $('[data-slot="loading"]', drawer)?.remove();
  }
}

function detailHead(issue, key) {
  const jiraUrl = issue?.url;
  return h(
    'div',
    { class: 'drawer-head' },
    h(
      'button',
      {
        class: 'icon-btn expand-toggle',
        title: state.wide ? 'Thu nhỏ' : 'Mở rộng toàn màn hình',
        onClick: () => {
          state.wide = !state.wide;
          LS.set('wide', state.wide);
          openDetail(key);
        },
      },
      icon(state.wide ? 'shrink' : 'expand'),
    ),
    issue && typeBadge(issue.type.name),
    h('span', { class: 'key' }, key),
    h('span', { id: 'drawer-status' }),
    h('span', { class: 'spacer' }),
    jiraUrl && h('button', { class: 'icon-btn', title: 'Copy link Jira', 'aria-label': 'Copy link Jira', onClick: () => copyText(jiraUrl, 'Đã copy link') }, icon('link')),
    issue &&
      h(
        'button',
        {
          class: 'icon-btn',
          title: 'Copy cho AI: link, tài liệu, MR, task con, mô tả, bình luận (Markdown)',
          'aria-label': 'Copy cho AI',
          onClick: async () => {
            const d = await getDetail(key).catch(() => null);
            copyText(issueMarkdown(issue, d), `Đã copy ${key} (kèm mô tả) — dán cho AI là đọc được`);
          },
        },
        icon('copy'),
      ),
    issue &&
      h(
        'button',
        {
          class: 'btn sm primary',
          title: 'Mở tab Claude Code mới trong Cursor với task này (kèm mô tả, bình luận)',
          onClick: async () => sendToClaude(issue, await getDetail(key).catch(() => null)),
        },
        icon('ai'),
        h('span', { class: 'btn-label' }, 'Claude Code'),
      ),
    jiraUrl && h('a', { class: 'icon-btn', href: jiraUrl, target: '_blank', rel: 'noopener', title: 'Mở trên Jira' }, icon('ext')),
    h('button', { class: 'icon-btn', title: 'Đóng (Esc)', onClick: closeDrawer }, icon('x')),
  );
}

function renderDetail(issue, d) {
  const drawer = $('#drawer');
  const scroll = $('.drawer-body', drawer)?.scrollTop || 0;
  const p = issue.parent;
  const loading = h('div', { class: 'muted small', 'data-slot': 'loading' }, 'Đang tải chi tiết…');

  const docs = [...(d?.issue?.docs || issue.docs), ...(d?.confluence || [])].filter(
    (x, idx, arr) => arr.findIndex((y) => (y.pageId || y.url) === (x.pageId || x.url)) === idx,
  );

  const block = (iconName, title, count, content) =>
    h('section', { class: 'block' }, h('h3', null, iconName && icon(iconName), title, count != null && h('span', { class: 'n' }, count)), content);

  const meta = h(
    'dl',
    { class: 'meta' },
    h('dt', null, 'Loại'), h('dd', null, typeBadge(issue.type.name), issue.type.name),
    h('dt', null, 'Ưu tiên'), h('dd', null, prio(issue.priority), issue.priority || '—'),
    issue.due && [h('dt', null, 'Hạn'), h('dd', null, fmtDay(issue.due), dueBadge(issue))],
    d && [h('dt', null, 'Người làm'), h('dd', null, d.assignee || '—')],
    d?.reporter && [h('dt', null, 'Người tạo'), h('dd', null, d.reporter)],
    p && [
      h('dt', null, 'Parent'),
      h(
        'dd',
        null,
        h('a', { class: 'key', href: '#' + p.key, onClick: (e) => (e.preventDefault(), openDetail(p.key)) }, p.key),
        h('span', null, p.summary),
      ),
    ],
    issue.project && [h('dt', null, 'Dự án'), h('dd', null, issue.project.name)],
    h('dt', null, 'Cập nhật'), h('dd', null, `${fmtDate(issue.updated)} (${rel(issue.updated)})`),
    h('dt', null, 'Tạo lúc'), h('dd', null, fmtDate(issue.created)),
    issue.labels.length > 0 && [h('dt', null, 'Nhãn'), h('dd', null, issue.labels.map((l) => h('span', { class: 'badge' }, l)))],
  );

  const docsList = h(
    'ul',
    { class: 'link-list' },
    docs.length
      ? docs.map((x) =>
          h(
            'li',
            null,
            icon('doc'),
            h('a', { href: x.url, target: '_blank', rel: 'noopener', title: x.url }, docTitle(x)),
            x.from && x.from !== issue.key && h('span', { class: 'tag muted small' }, `từ ${x.from}`),
            h('button', { class: 'icon-btn sm', title: 'Copy link', onClick: () => copyText(`${docTitle(x)}: ${x.url}`, 'Đã copy link trang') }, icon('copy')),
          ),
        )
      : h('li', { class: 'muted' }, 'Không có trang Confluence nào được link.'),
  );

  const side = h(
    'div',
    { class: 'detail-side' },
    meta,
    block('doc', 'Tài liệu Confluence', docs.length, docsList),
    issue.attachments.length > 0 &&
      block(
        'clip',
        'File đính kèm',
        issue.attachments.length,
        h(
          'ul',
          { class: 'link-list' },
          issue.attachments.map((a) =>
            h('li', null, icon('clip'), h('a', { href: a.url, target: '_blank', rel: 'noopener', title: a.filename }, a.filename), h('span', { class: 'tag muted small' }, fmtSize(a.size))),
          ),
        ),
      ),
    d?.children.length > 0 &&
      block(
        'tree',
        'Task con',
        d.children.length,
        h(
          'ul',
          { class: 'link-list' },
          d.children.map((c) =>
            h(
              'li',
              { class: 'child', onClick: () => openDetail(c.key) },
              typeBadge(c.type),
              h('span', { class: 'key' }, c.key),
              h('span', { class: 'child-summary', title: c.summary }, c.summary),
              h('span', { class: 'tag' }, statusPill(c.status)),
            ),
          ),
        ),
      ),
    d && block('link', 'Merge request & liên kết', null, renderLinks(d.links)),
  );

  const main = h(
    'div',
    { class: 'detail-main' },
    block(null, 'Mô tả', null, d ? (d.descriptionHtml ? htmlFrame(d.descriptionHtml, siteOf(issue)) : h('div', { class: 'muted small' }, 'Không có mô tả.')) : loading),
    d && block('chat', 'Bình luận', d.comments.length, d.comments.length ? htmlFrame(commentsHtml(d.comments), siteOf(issue)) : h('div', { class: 'muted small' }, 'Chưa có bình luận.')),
  );

  drawer.replaceChildren(
    detailHead(issue, issue.key),
    h(
      'div',
      { class: 'drawer-body' },
      h('h2', { class: 'detail-title' }, issue.summary),
      urgency(issue).reasons.length > 0 && h('div', { class: 'row-reasons' }, reasonChips(issue)),
      h('div', { class: 'detail-grid' }, side, main),
    ),
  );
  refreshDrawerStatus();
  $('.drawer-body', drawer).scrollTop = scroll;
}

function commentsHtml(comments) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return comments
    .map((c) => `<div class="c"><div class="c-head"><b>${esc(c.author)}</b> · ${esc(fmtDate(c.created))}</div>${c.html}</div>`)
    .join('');
}

function refreshDrawerStatus() {
  const slot = $('#drawer-status');
  const issue = state.issues.find((i) => i.key === state.openKey) || state.openIssue;
  if (slot && issue && issue.key === state.openKey) slot.replaceChildren(statusButton(issue));
}

function renderLinks(links) {
  if (!links.length) return h('div', { class: 'muted small' }, 'Không có liên kết.');
  const item = (l) =>
    h(
      'li',
      null,
      icon(l.kind === 'mr' ? 'mr' : l.kind === 'commit' ? 'commit' : 'link'),
      h('a', { href: l.url, target: '_blank', rel: 'noopener', title: l.url }, l.title),
      l.source && h('span', { class: 'tag muted small' }, l.source),
    );
  const mrs = links.filter((l) => l.kind === 'mr');
  const other = links.filter((l) => l.kind === 'other');
  const commits = links.filter((l) => l.kind === 'commit');
  return h(
    'div',
    null,
    mrs.length + other.length > 0 && h('ul', { class: 'link-list' }, [...mrs, ...other].map(item)),
    commits.length > 0 && h('details', null, h('summary', null, `${commits.length} commit`), h('ul', { class: 'link-list' }, commits.map(item))),
  );
}

// Jira-rendered HTML goes into a sandboxed iframe (no scripts), styled with our theme tokens.
function htmlFrame(html, site) {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const frame = h('iframe', {
    class: 'desc',
    title: 'Nội dung',
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  });
  const base = h('base', { href: site + '/', target: '_blank' }).outerHTML;
  frame.srcdoc = `<!doctype html><html><head>${base}<style>
    body{margin:0;padding:12px 14px;font:13.5px/1.6 system-ui,sans-serif;color:${v('--text')};background:${v('--surface')};word-wrap:break-word}
    a{color:${v('--accent')}} img{max-width:100%;height:auto}
    code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;background:${v('--surface-2')};border-radius:4px}
    code{padding:1px 4px} pre{padding:10px;overflow:auto}
    table{border-collapse:collapse} td,th{border:1px solid ${v('--border')};padding:4px 8px}
    h1,h2,h3,h4{margin:1em 0 .4em;line-height:1.3} h2{font-size:16px} h3{font-size:14.5px}
    p{margin:.4em 0} ul,ol{padding-left:1.4em}
    .c{padding:10px 0;border-bottom:1px solid ${v('--border')}} .c:last-child{border:0} .c-head{color:${v('--muted')};font-size:12.5px;margin-bottom:4px}
  </style></head><body>${html}</body></html>`;
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (doc) frame.style.height = doc.documentElement.scrollHeight + 2 + 'px';
  });
  return frame;
}

function closeDrawer() {
  state.openKey = null;
  state.openIssue = null;
  const drawer = $('#drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

// ---------------------------------------------------------------------------
// Status menu

async function openStatusMenu(anchor, issue) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' }, h('div', { class: 'menu-note' }, 'Đang tải transition…'));
  document.body.append(menu);
  state.menu = menu;
  placeMenu(menu, anchor);
  try {
    const ts = (await getTransitions(issue.key)).filter((t) => t.to.name !== issue.status.name);
    if (state.menu !== menu) return;
    menu.replaceChildren(
      ...(ts.length
        ? ts.map((t) =>
            h(
              'button',
              {
                class: 'menu-item',
                role: 'menuitem',
                onClick: () => {
                  closeMenu();
                  transition(issue, t);
                },
              },
              h('span', { class: `dot tone-${tone(t.to)}` }),
              h('span', null, t.name),
              t.name.toLowerCase() !== t.to.name.toLowerCase() && h('span', { class: 'muted small' }, `→ ${t.to.name}`),
            ),
          )
        : [h('div', { class: 'menu-note' }, 'Không có transition khả dụng.')]),
    );
    placeMenu(menu, anchor);
    menu.querySelector('button')?.focus();
  } catch (e) {
    if (state.menu === menu) menu.replaceChildren(h('div', { class: 'menu-note err' }, e.message));
  }
}

function placeMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const below = r.bottom + 4 + mh <= innerHeight;
  menu.style.top = (below ? r.bottom + 4 : Math.max(8, r.top - 4 - mh)) + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, innerWidth - mw - 8)) + 'px';
}

function closeMenu() {
  state.menu?.remove();
  state.menu = null;
}

// ---------------------------------------------------------------------------
// Toasts

function toast(message, kind = 'ok', link) {
  const el = h(
    'div',
    { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'spacer' }, message),
    link && h('a', { href: link.href, target: '_blank', rel: 'noopener' }, link.label),
  );
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 3500);
}

// ---------------------------------------------------------------------------
// Wiring

function setView(view) {
  state.view = view;
  LS.set('view', view);
  syncUrl();
  render();
}

function applyTheme() {
  const root = document.documentElement;

  // Clear first
  root.classList.remove('light', 'dark');

  if (state.theme === 'dark') {
    root.classList.add('dark');
  } else if (state.theme === 'light') {
    root.classList.add('light');
  } else { // auto
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) root.classList.add('dark');
  }

  // Update button icon
  const btn = $('#theme-toggle');
  if (btn) {
    const isDark = root.classList.contains('dark');
    btn.replaceChildren(icon(isDark ? 'sun' : 'moon'));
  }

  // Update theme menu
  if (window.__updateThemeMenu) window.__updateThemeMenu();
}

function setTheme(theme) {
  if (!['auto', 'light', 'dark'].includes(theme)) return;
  state.theme = theme;
  LS.set('theme', theme);
  applyTheme();
  closeThemePicker();
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    toast(`Theme: auto (${prefersDark ? 'dark' : 'light'})`);
  } else {
    toast(`Theme: ${theme}`);
  }
}

function toggleThemePicker() {
  const picker = $('#theme-picker');
  if (!picker) return;
  picker.classList.toggle('open');
}

function closeThemePicker() {
  const picker = $('#theme-picker');
  if (picker) picker.classList.remove('open');
}

// Listen for system theme changes
if (window.matchMedia) {
  const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  darkModeQuery.addEventListener('change', () => {
    if (state.theme === 'auto') {
      applyTheme();
    }
  });
}

// Close picker on outside click
document.addEventListener('click', (e) => {
  const picker = $('#theme-picker');
  if (!picker) return;
  if (!picker.contains(e.target) && !e.target.closest('#theme-toggle')) {
    closeThemePicker();
  }
});

function showKeyboardShortcuts() {
  const shortcuts = [
    ['/', 'Focus search box'],
    ['Esc', 'Close drawer/menu/panels or unfocus'],
    ['r', 'Refresh data'],
    ['?', 'Show keyboard shortcuts'],
    ['1-5', 'Switch to preset filter 1-5'],
    ['j / k', 'Navigate down / up in list'],
    ['Enter', 'Open focused issue'],
    ['Click issue', 'Open detail drawer'],
  ];
  
  const modal = h(
    'div',
    { class: 'shortcuts-modal', onClick: (e) => e.target.classList.contains('shortcuts-modal') && e.target.remove() },
    h(
      'div',
      { class: 'shortcuts-content' },
      h('div', { class: 'shortcuts-head' }, h('h2', null, 'Keyboard Shortcuts'), h('button', { class: 'icon-btn', onClick: (e) => e.target.closest('.shortcuts-modal').remove() }, icon('x'))),
      h(
        'div',
        { class: 'shortcuts-list' },
        shortcuts.map(([key, desc]) => h('div', { class: 'shortcut-row' }, h('kbd', null, key), h('span', null, desc))),
      ),
    ),
  );
  
  document.body.append(modal);
}

function applyJql(jql) {
  state.jql = jql.trim() === state.defaultJql ? '' : jql.trim();
  LS.set('jql', state.jql);
  syncPreset();
  load();
}

function syncPreset() {
  const idx = PRESETS.findIndex((p) => p.jql === state.jql);
  $('#preset').value = idx < 0 ? 'custom' : String(idx);
}

function viewedUserName() {
  return state.users?.users.find((u) => u.accountId === state.user)?.name || 'người đã chọn';
}

async function loadUsers() {
  const select = $('#user-filter');
  try {
    state.users = await api('/api/users');
  } catch (e) {
    select.title = `Không tải được danh sách người dùng: ${e.message}`;
    return;
  }
  // Sắp xếp theo tên
  const sorted = [...state.users.users].sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  const opts = sorted.map((u) => h('option', { value: u.accountId }, `${u.name} (${u.count})`));
  if (state.user && !state.users.users.some((u) => u.accountId === state.user)) {
    opts.unshift(h('option', { value: state.user }, 'Người đã chọn'));
  }
  select.replaceChildren(
    h('option', { value: '' }, 'Của tôi'),
    ...opts,
  );
  select.value = state.user;
  syncUrl();
  renderMeta();
}

function showAuth(me) {
  // Older servers returned { tokenExpiresAt } instead of { auth }.
  me.auth ??= { source: 'claude', expiresAt: me.tokenExpiresAt || null };
  state.me = me;
  const brand = $('.brand');
  if (brand) brand.title = `${me.name} · ${new URL(me.site).host}`;
  const login = $('#login');
  if (!login) return;
  login.hidden = me.auth.source === 'own';
  login.replaceChildren(icon('key'));
  login.title = 'Bật tự refresh: đăng nhập Atlassian một lần để dashboard có phiên riêng, không phụ thuộc token của Claude Code';
  login.setAttribute('aria-label', 'Bật tự refresh token');
  renderMeta();
}

function init() {
  $('#preset').replaceChildren(
    ...PRESETS.map((p, i) => h('option', { value: String(i) }, p.label)),
    h('option', { value: 'custom', disabled: true }, 'JQL tuỳ chỉnh'),
  );
  $('#jql').value = state.jql;
  $('#search').value = state.q;
  syncPreset();

  $('#preset').addEventListener('change', (e) => {
    const p = PRESETS[Number(e.target.value)];
    if (!p) return;
    $('#jql').value = p.jql || state.defaultJql;
    applyJql(p.jql);
  });
  $('#apply').addEventListener('click', () => applyJql($('#jql').value));
  $('#jql').addEventListener('keydown', (e) => e.key === 'Enter' && applyJql(e.target.value));
  $('#search').addEventListener('input', (e) => {
    state.q = e.target.value;
    syncUrl();
    render();
  });
  $('#refresh').append(icon('refresh'));
  $('#jql-toggle').append(icon('code'));
  $('[data-view="list"]').append(icon('list'));
  $('[data-view="docs"]').append(icon('doc'));
  $('#user-filter').addEventListener('change', (e) => {
    state.user = e.target.value;
    LS.set('user', state.user);
    state.status = null;
    state.urgentOnly = false;
    syncUrl();
    load();
  });
  $('#refresh').addEventListener('click', () => load());
  $('#type-filter').addEventListener('change', (e) => {
    state.type = e.target.value;
    syncUrl();
    render();
  });
  $('#sprint-filter').addEventListener('change', (e) => {
    state.sprint = e.target.value ? Number(e.target.value) : null;
    LS.set('sprint', state.sprint);
    syncUrl();
    render();
  });
  $('#jql-toggle').addEventListener('click', (e) => {
    const row = $('#jql-row');
    row.hidden = !row.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!row.hidden));
    if (!row.hidden) $('#jql').focus();
  });
  for (const b of document.querySelectorAll('#views button')) b.addEventListener('click', () => setView(b.dataset.view));
  $('#scrim').addEventListener('click', closeDrawer);

  $('#bell').prepend(icon('bell'));
  $('#bell').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNotif();
  });
  $('#recent-btn').replaceChildren(icon('clock'));
  $('#recent-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRecent();
  });
  $('#theme-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleThemePicker();
  });

  // Wire theme options
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const theme = btn.dataset.theme;
      setTheme(theme);
    });
  });

  // Update theme menu icons & check marks
  function updateThemeMenu() {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effectiveTheme = state.theme === 'auto'
      ? (prefersDark ? 'dark' : 'light')
      : state.theme;

    // Set icons for each option
    $('#theme-icon-auto').replaceChildren(icon('circle-half'));
    $('#theme-icon-light').replaceChildren(icon('sun'));
    $('#theme-icon-dark').replaceChildren(icon('moon'));

    // Update active state
    document.querySelectorAll('.theme-option').forEach(btn => {
      const t = btn.dataset.theme;
      btn.classList.toggle('active', t === state.theme);
      const check = btn.querySelector('.theme-check');
      if (check) check.replaceChildren(t === state.theme ? icon('check') : '');
    });
  }

  // Store updateThemeMenu for use in applyTheme
  window.__updateThemeMenu = updateThemeMenu;
  updateThemeMenu();
  applyTheme();
  document.addEventListener('click', (e) => {
    if (state.menu && !state.menu.contains(e.target)) closeMenu();
    if (state.notif.open && !e.target.closest('#notif')) toggleNotif(false);
    if (!$('#recent').hidden && !e.target.closest('#recent') && !e.target.closest('#recent-btn')) toggleRecent(false);
  });
  document.addEventListener('scroll', closeMenu, true);
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      if (state.menu) closeMenu();
      else if (state.notif.open) toggleNotif(false);
      else if (!$('#recent').hidden) toggleRecent(false);
      else if (state.openKey) closeDrawer();
      else if (typing) document.activeElement.blur();
    } else if (!typing && e.key === '/') {
      e.preventDefault();
      $('#search').focus();
    } else if (!typing && (e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey) {
      load();
    } else if (!typing && e.key === '?') {
      e.preventDefault();
      showKeyboardShortcuts();
    } else if (!typing && /^[1-5]$/.test(e.key)) {
      // Switch preset with numbers 1-5
      const idx = Number(e.key) - 1;
      if (PRESETS[idx]) {
        $('#preset').value = String(idx);
        $('#jql').value = PRESETS[idx].jql || state.defaultJql;
        applyJql(PRESETS[idx].jql);
      }
    } else if (!typing && (e.key === 'j' || e.key === 'k') && !state.openKey) {
      // j/k navigation in list view
      e.preventDefault();
      const list = $('.list');
      if (!list) return;
      const rows = [...list.querySelectorAll('.row:not(.child)')];
      if (!rows.length) return;
      
      const current = rows.findIndex(r => r.classList.contains('keyboard-focus'));
      let nextIdx;
      
      if (e.key === 'j') {
        nextIdx = current < 0 ? 0 : Math.min(current + 1, rows.length - 1);
      } else {
        nextIdx = current < 0 ? 0 : Math.max(current - 1, 0);
      }
      
      rows.forEach(r => r.classList.remove('keyboard-focus'));
      rows[nextIdx].classList.add('keyboard-focus');
      rows[nextIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else if (!typing && e.key === 'Enter' && !state.openKey) {
      // Open focused row
      const list = $('.list');
      if (!list) return;
      const focused = list.querySelector('.row.keyboard-focus');
      if (focused) focused.click();
    }
  });
  // Deep links: #VLEARN-123 opens that issue's detail.
  window.addEventListener('hashchange', () => {
    const key = decodeURIComponent(location.hash.slice(1));
    if (ISSUE_KEY_RE.test(key)) key !== state.openKey && openDetail(key);
    else if (state.openKey) closeDrawer();
  });

  // Quiet refresh every 5 minutes while the tab is visible and nothing is in flight.
  setInterval(() => {
    if (document.visibilityState === 'visible' && !state.menu && !state.issues.some((i) => i.pending)) {
      load({ silent: true });
      loadNotifications();
    }
  }, 5 * 60 * 1000);

  api('/api/me')
    .then(showAuth)
    .catch((e) => {
      toast(e.message, 'error');
      $('#login').hidden = !e.login;
    });
  load();
  loadNotifications();
  loadUsers();
  const initial = decodeURIComponent(location.hash.slice(1));
  if (ISSUE_KEY_RE.test(initial)) openDetail(initial);
}

init();
