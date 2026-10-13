'use strict';

// App state, URL sync, and loading issues / transitions / details from the server.

// ---------------------------------------------------------------------------
// State

// Saved filters (Settings → Jira); the first one is the default JQL (empty = let the server use it).
const presets = () => [{ label: 'Default', jql: '' }, ...CFG.jira.presets];

// Fills #preset with an <option> per saved filter plus a trailing "Custom" slot, then
// selects whichever one matches the active JQL. Called on page init and after Settings saves.
// Note: tasks.html additionally defines syncPreset() (app-tasks.js) to re-sync this select
// whenever state.jql changes later; this function only handles the initial render + selection.
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

const state = {
  issues: [],
  jql: LS.get('jql', ''),
  usedJql: '',
  defaultJql: '',
  // 'settings' is a detour overlay available from any page; otherwise it mirrors window.PAGE.
  view: initParams.get('view') === 'settings' ? 'settings' : window.PAGE,
  me: null,
  user: initParams.get('user') || LS.get('user', ''),
  users: null,
  q: initParams.get('q') || '',
  type: initParams.get('type') || 'all',
  status: initParams.get('status') || null,
  // URL-only (like type/status): a sprint ends, so there's no reason to carry last session's choice forward.
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
// key → { at, from, to }: issues whose status just changed. For HOLD_MS they stay in the list, filter and
// group they were in (format.js heldMove) so the user can follow where the task went.
const recentlyTransitioned = new Map();
const HOLD_MS = 6000;
const HOLD_PENDING_MS = 30_000; // a request that never answers must not hold its row forever

// What a load asks for. state.loadedFor records it for the issues on screen, so a page shows
// "Loading…" only when those belong to another query, not on every refresh.
const issuesQuery = () => JSON.stringify([state.jql, state.user]);

// The last issue list of this browser tab, so switching pages shows it at once and
// refreshes behind it instead of starting from an empty page.
const ISSUES_CACHE = 'jd:issues';
function saveIssues() {
  try {
    const { issues, defaultJql, usedJql, fetchedAt, loadedFor } = state;
    sessionStorage.setItem(ISSUES_CACHE, JSON.stringify({ issues, defaultJql, usedJql, fetchedAt, loadedFor }));
  } catch {
    // Storage full or unavailable: the next page just loads from scratch.
  }
}
(function restoreIssues() {
  try {
    const c = JSON.parse(sessionStorage.getItem(ISSUES_CACHE));
    if (c?.loadedFor !== issuesQuery()) return;
    Object.assign(state, { issues: c.issues, defaultJql: c.defaultJql, usedJql: c.usedJql, fetchedAt: new Date(c.fetchedAt), loadedFor: c.loadedFor });
  } catch {
    // Unreadable cache: load as usual.
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
  if (state.view === 'settings') params.set('view', 'settings');
  if (state.docsQ) params.set('docsQ', state.docsQ);
  if (state.docsKind !== 'all') params.set('docsKind', state.docsKind);
  if (state.docsSort !== 'date') params.set('docsSort', state.docsSort);
  if (state.docsOrder !== 'desc') params.set('docsOrder', state.docsOrder);
  const query = params.toString();
  const url = location.pathname + (query ? '?' + query : '') + location.hash;
  history.replaceState(null, '', url);
  window.syncNavLinks?.();
}

// ---------------------------------------------------------------------------
// Data

// Fetches issues into state.issues. Pure data + state; DOM-specific bits (spinner, jql field,
// render()) are layered on by each page's load() wrapper (see app-tasks.js / app-docs.js).
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

// A Story / Epic is also carried as a stub (`parent`, `epic`) on every issue under it: keep all copies in step.
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
    saveIssues(); // so the next page doesn't flash the old status
    cache.transitions.delete(issue.key);
    cache.details.delete(issue.key);
    if (!failed) Object.assign(move, { at: Date.now(), settled: true }); // the hold runs from the moment Jira confirmed
    render();
    if (!failed) releaseMove(issue.key, move, HOLD_MS + 50);
  }
}

// Drops the hold on an issue after `delay` ms and redraws. A newer move of the same issue owns the entry
// then, so it is left alone; and an open status menu is never closed under the user (render() closes it):
// the release is retried a second later.
function releaseMove(key, move, delay) {
  setTimeout(() => {
    if (recentlyTransitioned.get(key) !== move) return;
    if (state.menu) return releaseMove(key, move, 1000);
    recentlyTransitioned.delete(key);
    render();
  }, delay);
}

// Toast action: drop the status / urgent filter that hides the task at its new status and scroll to it.
// null when nothing hides it.
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
