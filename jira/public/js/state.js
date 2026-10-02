'use strict';

// App state, URL sync, and loading issues / transitions / details from the server.

// ---------------------------------------------------------------------------
// State

// Saved filters (Settings → Jira); the first one is the default JQL (empty = let the server use it).
const presets = () => [{ label: 'Default', jql: '' }, ...CFG.jira.presets];
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

// Read URL params on init
const initParams = new URLSearchParams(location.search);
const initView = initParams.get('view') || LS.get('view', 'list');

const state = {
  issues: [],
  jql: LS.get('jql', ''),
  usedJql: '',
  defaultJql: '',
  view: ['docs', 'git', 'settings'].includes(initView) ? initView : 'list',
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
  docsQ: initParams.get('docsQ') || '',
  docsKind: ['pages', 'attachments'].includes(initParams.get('docsKind')) ? initParams.get('docsKind') : 'all',
  docsSort: ['name', 'date', 'size', 'task'].includes(initParams.get('docsSort')) ? initParams.get('docsSort') : 'date',
  docsOrder: initParams.get('docsOrder') === 'asc' ? 'asc' : 'desc',
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
  if (state.docsQ) params.set('docsQ', state.docsQ);
  if (state.docsKind !== 'all') params.set('docsKind', state.docsKind);
  if (state.docsSort !== 'date') params.set('docsSort', state.docsSort);
  if (state.docsOrder !== 'desc') params.set('docsOrder', state.docsOrder);
  const query = params.toString();
  const url = location.pathname + (query ? '?' + query : '') + location.hash;
  history.replaceState(null, '', url);
}

// ---------------------------------------------------------------------------
// Data

async function load({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $('#refresh').classList.add('spin');
  $('#refresh').disabled = true;
  if (!silent) render();
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
    if (silent && state.issues.length) toast(`Failed to reload: ${e.message}`, 'error');
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
  setStatus(issue, { ...t.to }, true);

  recentlyTransitioned.set(issue.key, Date.now());

  render();
  try {
    const d = await api(`/api/issues/${issue.key}/transitions`, { method: 'POST', body: JSON.stringify({ id: t.id }) });
    setStatus(issue, d.status, true);
    toast(`${issue.key} → ${d.status.name}`);
  } catch (e) {
    setStatus(issue, prev, true);
    recentlyTransitioned.delete(issue.key);
    toast(`${issue.key}: ${e.message}`, 'error', { href: issue.url || (state.issues[0] && `${siteOf(state.issues[0])}/browse/${issue.key}`), label: 'Open in Jira' });
  } finally {
    setStatus(issue, issue.status, false);
    cache.transitions.delete(issue.key);
    cache.details.delete(issue.key);
    render();
    
    setTimeout(() => {
      recentlyTransitioned.delete(issue.key);
      render();
    }, 3000);
  }
}
