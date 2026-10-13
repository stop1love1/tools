'use strict';

// Wiring shared by all three pages (tasks.html, docs.html, workspace.html): theme, auth banner,
// settings, notif/recent panels, and the keyboard shortcuts that make sense everywhere.
// Each page's own script (app-tasks.js / app-docs.js / app-workspace.js) defines initPage()
// and onShortcut(e) hooks that this file calls.

// Settings is a detour from whichever page you're on; it renders over #main without navigating away.
function setView(view) {
  state.view = view;
  document.body.dataset.view = view; // settings.css / git-flow.css hide the task subbar by this
  syncUrl();
  render();
}

// The full-screen cover in each page's markup (page-loader.css): up from first paint until
// initPage()'s first data render, and raised again when leaving for another page.
function hidePageLoader() {
  $('#page-loader')?.classList.add('done');
}
function showPageLoader() {
  $('#page-loader')?.classList.remove('done');
}
// Back/forward cache restores the page as it was left, cover included.
window.addEventListener('pageshow', (e) => e.persisted && hidePageLoader());

// Who's signed in, token expiry and last refresh, shown as the tooltip of the sign-in entry.
function renderMeta() {
  const parts = [];
  if (state.me) {
    parts.push(state.me.name);
    if (state.me.auth.source === 'own') parts.push('own refresh token');
    else if (state.me.auth.expiresAt) {
      parts.push(`Claude Code token expires ${new Date(state.me.auth.expiresAt).toLocaleString('en-US', { timeStyle: 'short', dateStyle: 'short' })}`);
    }
  }
  if (state.fetchedAt) parts.push(`updated ${state.fetchedAt.toLocaleTimeString('en-US', { timeStyle: 'short' })}`);
  const login = $('#login');
  if (login && parts.length) login.title = parts.join(' · ');
}

function applyTheme() {
  const root = document.documentElement;

  root.classList.remove('light', 'dark');

  if (state.theme === 'dark') {
    root.classList.add('dark');
  } else if (state.theme === 'light') {
    root.classList.add('light');
  } else { // auto
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) root.classList.add('dark');
  }

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
  $('#theme-toggle').setAttribute('aria-expanded', String(picker.classList.contains('open')));
}

function closeThemePicker() {
  const picker = $('#theme-picker');
  if (picker) picker.classList.remove('open');
  $('#theme-toggle')?.setAttribute('aria-expanded', 'false');
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

// Each page lists only the shortcuts that apply to it (PAGE_SHORTCUTS in its app-*.js),
// followed by the common set below.
function showKeyboardShortcuts() {
  const shortcuts = (window.PAGE_SHORTCUTS || []).concat([
    ['Esc', 'Close drawer/menu/panels or unfocus'],
    ['?', 'Show keyboard shortcuts'],
  ]);

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

// The sign-in entry of the ⋯ menu; while it's offered, a dot on the ⋯ button points at it.
function showLogin(show) {
  $('#login').hidden = !show;
  $('#theme-toggle').classList.toggle('attn', !!show);
}

function showAuth(me) {
  // Older servers returned { tokenExpiresAt } instead of { auth }.
  me.auth ??= { source: 'claude', expiresAt: me.tokenExpiresAt || null };
  state.me = me;
  const brand = $('.brand');
  if (brand) brand.title = `${me.name} · ${new URL(me.site).host}`;
  const login = $('#login');
  if (!login) return;
  showLogin(me.auth.source !== 'own');
  renderMeta();
}

// Header filters that travel with you between pages (the search boxes are per page and stay behind).
// The JQL already persists in localStorage, so only the URL-only ones are carried here.
function headerQuery() {
  const params = new URLSearchParams();
  if (state.user) params.set('user', state.user);
  if (state.sprint) params.set('sprint', String(state.sprint));
  const query = params.toString();
  return query ? '?' + query : '';
}

// Page link that keeps the header filters, e.g. pageHref('/tasks.html', '#PROJ-1').
function pageHref(path, hash = '') {
  return path + headerQuery() + hash;
}

// The view tabs are static links; keep their query in step with the active header filters.
function syncNavLinks() {
  for (const a of $$('#views a')) a.href = pageHref(new URL(a.getAttribute('href'), location.origin).pathname);
}
window.syncNavLinks = syncNavLinks;

// ---------------------------------------------------------------------------
// Shared header controls: user filter, sprint filter, and their logic.
// These are identical across all three pages.

// Value of the user filter that means "every assignee" (the server swaps it into the JQL).
const ALL_USERS = '__all__';
// Value that means "tasks nobody is assigned to" (the server swaps it into the JQL).
const UNASSIGNED = '__unassigned__';

function viewedUserName() {
  if (state.user === ALL_USERS) return 'everyone';
  if (state.user === UNASSIGNED) return 'nobody (unassigned)';
  return state.users?.users.find((u) => u.accountId === state.user)?.name || 'selected user';
}

// What the select shows for the current choice before the user list has arrived.
const userLabel = () => ({ [ALL_USERS]: 'All', [UNASSIGNED]: 'Unassigned', '': 'Mine' })[state.user] ?? 'Loading…';

async function loadUsers() {
  const select = $('#user-filter');
  // Until the list arrives the select holds just the current choice, with a spinner, so the first paint
  // does not show a wrong "Mine" and then jump when the real options replace it.
  select.replaceChildren(h('option', { value: state.user }, userLabel()));
  select.value = state.user;
  select.classList.add('loading');
  select.setAttribute('aria-busy', 'true');
  try {
    state.users = await api('/api/users');
  } catch (e) {
    select.title = `Failed to load user list: ${e.message}`;
    return;
  } finally {
    select.classList.remove('loading');
    select.removeAttribute('aria-busy');
  }
  const sorted = [...state.users.users].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const opts = sorted.map((u) => h('option', { value: u.accountId }, `${u.name} (${u.count})`));
  if (state.user && state.user !== ALL_USERS && state.user !== UNASSIGNED && !state.users.users.some((u) => u.accountId === state.user)) {
    opts.unshift(h('option', { value: state.user }, 'Selected user'));
  }
  select.replaceChildren(
    h('option', { value: ALL_USERS }, 'All'),
    h('option', { value: '' }, 'Mine'),
    h('option', { value: UNASSIGNED }, 'Unassigned'),
    ...opts,
  );
  select.value = state.user;
  syncUrl();
  renderMeta();
}

function renderSprints() {
  const sprints = new Map();
  const counts = new Map();
  for (const i of state.issues) {
    for (const sp of sprintsOf(i)) sprints.set(sp.id, sp);
    // Count tasks only, as the list does: an Epic in a sprint through its children is not one.
    if (i.sprint) counts.set(i.sprint.id, (counts.get(i.sprint.id) || 0) + 1);
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
  select.replaceChildren(
    h('option', { value: '', selected: !state.sprint }, 'All sprints'),
    ...sorted.map((s) => 
      h('option', { value: s.id, selected: state.sprint === s.id }, `${s.name}${s.state === 'active' ? ' 🟢' : ''} (${counts.get(s.id) || 0})`)
    ),
  );
  select.hidden = false;
  syncUrl();
}

// Each page defines window.onUserFilterChange and window.onSprintFilterChange
// to handle their own data reloading / rendering logic.
// state.jql is shared by all pages (issuesQuery() keys on it), so the JQL row works everywhere.
// Pages hook window.onJqlChange to reload their own data.
function applyJql(jql) {
  state.jql = jql.trim() === state.defaultJql ? '' : jql.trim();
  LS.set('jql', state.jql);
  window.onJqlChange?.();
}

function setupSharedFilters() {
  const jqlInput = $('#jql');
  const toggle = $('#jql-toggle');
  if (jqlInput && toggle) {
    toggle.replaceChildren(icon('code'));
    jqlInput.value = state.jql;
    $('#apply').addEventListener('click', () => applyJql(jqlInput.value));
    jqlInput.addEventListener('keydown', (e) => e.key === 'Enter' && applyJql(e.target.value));
    toggle.addEventListener('click', (e) => {
      const row = $('#jql-row');
      row.hidden = !row.hidden;
      e.currentTarget.setAttribute('aria-expanded', String(!row.hidden));
      if (!row.hidden) {
        if (!state.jql && state.defaultJql) jqlInput.value = state.defaultJql;
        jqlInput.focus();
      }
    });
  }

  $('#user-filter')?.addEventListener('change', (e) => {
    state.user = e.target.value;
    LS.set('user', state.user);
    syncUrl();
    if (window.onUserFilterChange) window.onUserFilterChange();
  });
  $('#sprint-filter')?.addEventListener('change', (e) => {
    state.sprint = e.target.value ? Number(e.target.value) : null;
    syncUrl();
    if (window.onSprintFilterChange) window.onSprintFilterChange();
  });
}

// ---------------------------------------------------------------------------
// Shared init: wires the header chrome that's the same on every page, then
// hands off to the page's own initPage() for its subbar/filters/data loading.
// Each page sets window.PAGE ('list' | 'docs' | 'git') inline and its script defines
// render(), initPage(), and onShortcutR() for the "r" shortcut and the refresh button.

async function init() {
  await loadClientConfig();

  for (const b of document.querySelectorAll('#views a')) {
    b.setAttribute('aria-selected', String(b.dataset.view === window.PAGE));
  }
  document.body.dataset.view = state.view;

  // Scoped to #views: <body> carries the same data-view attribute.
  $('#views [data-view="list"]').append(icon('list'), h('span', null, 'Tasks'));
  $('#views [data-view="docs"]').append(icon('doc'), h('span', null, 'Docs'));
  $('#views [data-view="git"]').append(icon('branch'), h('span', null, 'Workspace'));
  for (const a of $$('#views a')) {
    a.addEventListener('click', (e) => {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // opening in a new tab
      if (a.dataset.view === window.PAGE) {
        // Already here: just leave the Settings detour instead of reloading.
        e.preventDefault();
        if (state.view === 'settings') setView(window.PAGE);
        return;
      }
      showPageLoader();
    });
  }
  $('#theme-toggle').append(icon('more'));
  $('#login').append(h('span', { class: 'theme-icon' }, icon('key')), h('span', { class: 'theme-label' }, 'Enable token auto-refresh'));
  $('#login').title = 'Sign in to Atlassian once to give the dashboard its own session, independent of Claude Code tokens';
  $('#settings-btn').append(h('span', { class: 'theme-icon' }, icon('gear')), h('span', { class: 'theme-label' }, 'Settings'));
  $('#settings-btn').addEventListener('click', () => {
    closeThemePicker();
    setView(state.view === 'settings' ? window.PAGE : 'settings');
  });

  $('#refresh').append(icon('refresh'));
  $('#refresh').addEventListener('click', () => window.onShortcutR?.());

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

  document.querySelectorAll('.theme-option[data-theme]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setTheme(btn.dataset.theme);
    });
  });

  function updateThemeMenu() {
    $('#theme-icon-auto').replaceChildren(icon('circle-half'));
    $('#theme-icon-light').replaceChildren(icon('sun'));
    $('#theme-icon-dark').replaceChildren(icon('moon'));
    document.querySelectorAll('.theme-option[data-theme]').forEach((btn) => {
      const t = btn.dataset.theme;
      btn.classList.toggle('active', t === state.theme);
      const check = btn.querySelector('.theme-check');
      if (check) check.replaceChildren(t === state.theme ? icon('check') : '');
    });
  }
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
      else if (state.openKey) window.closeDrawer?.(); // the drawer only exists on tasks.html
      else if (typing) document.activeElement.blur();
    } else if (!typing && e.key === '?') {
      e.preventDefault();
      showKeyboardShortcuts();
    } else if (!typing && (e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey) {
      if (window.onShortcutR) window.onShortcutR();
    } else if (window.onShortcutExtra) {
      window.onShortcutExtra(e, typing);
    }
  });

  scheduleRefresh();
  setupSharedFilters();
  syncNavLinks();

  api('/api/me')
    .then(showAuth)
    .catch((e) => {
      toast(e.message, 'error');
      showLogin(e.login);
    });
  loadNotifications();

  await window.initPage(); // resolves after the page's first data render
}

// Quiet refresh while the tab is visible and nothing is in flight (Settings → Jira → Auto refresh).
let refreshTimer = null;
function scheduleRefresh() {
  clearInterval(refreshTimer);
  const minutes = CFG.jira.autoRefreshMinutes;
  if (!minutes || !window.onShortcutR) return;
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !state.menu && !(state.issues && state.issues.some((i) => i.pending))) {
      window.onShortcutR({ silent: true });
      loadNotifications();
    }
  }, minutes * 60 * 1000);
}

// A slow Jira/GitLab shouldn't hold the whole page hostage: past this the page's own
// in-place "Loading…" state takes over.
setTimeout(hidePageLoader, 8000);
init()
  .catch((e) => toast(e.message, 'error'))
  .finally(hidePageLoader);
