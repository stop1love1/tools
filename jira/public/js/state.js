'use strict';

const presets = () => [{ label: 'Default', jql: '' }, ...CFG.jira.presets];

function renderPresets() {
  const select = $('#preset');
  if (!select) return;
  const opts = presets().map((p, i) => h('option', { value: String(i) }, p.label || `Filter ${i + 1}`));
  select.replaceChildren(...opts, h('option', { value: 'custom', disabled: true }, 'Custom JQL'));
  const idx = presets().findIndex((p) => p.jql === state.jql);
  select.value = idx < 0 ? 'custom' : String(idx);
}

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

const initParams = new URLSearchParams(location.search);

if (window.PAGE !== 'settings' && initParams.get('view') === 'settings') {
  initParams.delete('view');
  const rest = initParams.toString();
  location.replace('/settings.html' + (rest ? '?' + rest : ''));
}

const state = {
  issues: [],
  jql: LS.get('jql', ''),
  usedJql: '',
  defaultJql: '',
  view: window.PAGE,
  me: null,
  user: initParams.get('user') || LS.get('user', ''),
  users: null,
  q: initParams.get('q') || '',
  type: initParams.get('type') || 'all',
  status: initParams.get('status') || null,
  sprint: initParams.get('sprint') ? Number(initParams.get('sprint')) : null,
  urgentOnly: initParams.get('urgent') === '1',
  loading: false,
  error: null,
  errorLogin: false,
  fetchedAt: null,
  loadedFor: null,
  openKey: null,
  openIssue: null,
  menu: null,
  wide: LS.get('wide', false),
  closedGroups: new Set(LS.get('groupFold', [])),
  notif: { events: [], days: 7, loaded: false, error: null, seen: LS.get('notifSeen', 0), seenBefore: 0, open: false },
  recentlyViewed: LS.get('recentlyViewed', []),
  theme: LS.get('theme', 'auto'),
  docsQ: initParams.get('docsQ') || '',
  docsKind: ['pages', 'attachments'].includes(initParams.get('docsKind')) ? initParams.get('docsKind') : 'all',
  docsSort: ['name', 'date', 'size', 'task', 'links'].includes(initParams.get('docsSort')) ? initParams.get('docsSort') : 'date',
  docsOrder: initParams.get('docsOrder') === 'asc' ? 'asc' : 'desc',
};
const cache = { transitions: new Map(), details: new Map() };
const recentlyTransitioned = new Map();
const HOLD_MS = 6000;
const HOLD_PENDING_MS = 30_000;

const issuesQuery = () => JSON.stringify([state.jql, state.user]);

const ISSUES_CACHE = 'jd:issues';
function saveIssues() {
  try {
    const { issues, defaultJql, usedJql, fetchedAt, loadedFor } = state;
    sessionStorage.setItem(ISSUES_CACHE, JSON.stringify({ issues, defaultJql, usedJql, fetchedAt, loadedFor }));
  } catch {
  }
}
(function restoreIssues() {
  try {
    const c = JSON.parse(sessionStorage.getItem(ISSUES_CACHE));
    if (c?.loadedFor !== issuesQuery()) return;
    Object.assign(state, { issues: c.issues, defaultJql: c.defaultJql, usedJql: c.usedJql, fetchedAt: new Date(c.fetchedAt), loadedFor: c.loadedFor });
  } catch {
  }
})();

function syncUrl() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.type !== 'all') params.set('type', state.type);
  if (state.status) params.set('status', state.status);
  if (state.urgentOnly) params.set('urgent', '1');
  if (state.user) params.set('user', state.user);
  if (state.sprint) params.set('sprint', String(state.sprint));
  if (state.docsQ) params.set('docsQ', state.docsQ);
  if (state.docsKind !== 'all') params.set('docsKind', state.docsKind);
  if (state.docsSort !== 'date') params.set('docsSort', state.docsSort);
  if (state.docsOrder !== 'desc') params.set('docsOrder', state.docsOrder);
  const query = params.toString();
  const url = location.pathname + (query ? '?' + query : '') + location.hash;
  history.replaceState(null, '', url);
  window.syncNavLinks?.();
}

async function loadIssues({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const query = issuesQuery();
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
    state.loadedFor = query;
    saveIssues();
    cache.transitions.clear();
    for (const k of [...recentlyTransitioned.keys()]) if (!heldMove(k)) recentlyTransitioned.delete(k);
    if (state.openKey) state.openIssue = state.issues.find((i) => i.key === state.openKey) || state.openIssue;
  } catch (e) {
    if (silent && state.issues.length) toast(`Failed to reload: ${e.message}`, 'error');
    else (state.error = e.message), (state.errorLogin = e.login);
  } finally {
    state.loading = false;
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

function setStatus(issue, status, pending) {
  const copies = [issue, state.openIssue];
  for (const i of state.issues) copies.push(i, i.parent, i.epic);
  for (const c of copies) {
    if (c?.key !== issue.key) continue;
    c.status = status;
    c.pending = pending;
  }
}

async function transition(issue, t) {
  const prev = issue.status;
  const move = { at: Date.now(), from: prev };
  setStatus(issue, { ...t.to }, true);
  recentlyTransitioned.set(issue.key, move);

  render();
  let failed = false;
  try {
    const d = await api(`/api/issues/${issue.key}/transitions`, { method: 'POST', body: JSON.stringify({ id: t.id }) });
    setStatus(issue, d.status, true);
    toast(`${issue.key}: ${prev.name} → ${d.status.name}`, 'ok', movedLink(issue, d.status));
  } catch (e) {
    failed = true;
    setStatus(issue, prev, true);
    recentlyTransitioned.delete(issue.key);
    toast(`${issue.key}: ${e.message}`, 'error', { href: issue.url || (state.issues[0] && `${siteOf(state.issues[0])}/browse/${issue.key}`), label: 'Open in Jira' });
  } finally {
    setStatus(issue, issue.status, false);
    saveIssues();
    cache.transitions.delete(issue.key);
    cache.details.delete(issue.key);
    if (!failed) Object.assign(move, { at: Date.now(), settled: true });
    render();
    if (!failed) releaseMove(issue.key, move, HOLD_MS + 50);
  }
}

function releaseMove(key, move, delay) {
  setTimeout(() => {
    if (recentlyTransitioned.get(key) !== move) return;
    if (state.menu) return releaseMove(key, move, 1000);
    recentlyTransitioned.delete(key);
    render();
  }, delay);
}

function movedLink(issue, status) {
  const hidden = (state.status && state.status !== status.name) || state.urgentOnly;
  if (!hidden || !state.issues.some((i) => i.key === issue.key)) return null;
  return {
    label: `Show in ${status.name}`,
    onClick: () => {
      state.status = status.name;
      state.urgentOnly = false;
      syncUrl();
      render();
      for (const r of document.querySelectorAll('.row[data-key]')) if (r.dataset.key === issue.key) r.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  };
}
