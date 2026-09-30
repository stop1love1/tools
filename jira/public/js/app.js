'use strict';

// Wiring: theme, keyboard shortcuts, filters, init. Loaded last.

// ---------------------------------------------------------------------------
// Wiring

function setView(view) {
  state.view = view;
  if (view !== 'settings') LS.set('view', view); // Settings is a detour: the gear button goes back to the last view
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

function showKeyboardShortcuts() {
  const shortcuts = [
    ['/', 'Focus search box'],
    ['Esc', 'Close drawer/menu/panels or unfocus'],
    ['r', 'Refresh data'],
    ['?', 'Show keyboard shortcuts'],
    ['1-9', 'Switch to saved filter 1-9'],
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
  const idx = presets().findIndex((p) => p.jql === state.jql);
  $('#preset').value = idx < 0 ? 'custom' : String(idx);
}

function viewedUserName() {
  return state.users?.users.find((u) => u.accountId === state.user)?.name || 'selected user';
}

async function loadUsers() {
  const select = $('#user-filter');
  try {
    state.users = await api('/api/users');
  } catch (e) {
    select.title = `Failed to load user list: ${e.message}`;
    return;
  }
  // Sort by name
  const sorted = [...state.users.users].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const opts = sorted.map((u) => h('option', { value: u.accountId }, `${u.name} (${u.count})`));
  if (state.user && !state.users.users.some((u) => u.accountId === state.user)) {
    opts.unshift(h('option', { value: state.user }, 'Selected user'));
  }
  select.replaceChildren(
    h('option', { value: '' }, 'Mine'),
    ...opts,
  );
  select.value = state.user;
  syncUrl();
  renderMeta();
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

// The filter dropdown; rebuilt when the saved filters change on the Settings page.
function renderPresets() {
  $('#preset').replaceChildren(
    ...presets().map((p, i) => h('option', { value: String(i) }, p.label)),
    h('option', { value: 'custom', disabled: true }, 'Custom JQL'),
  );
  syncPreset();
}

// Quiet refresh while the tab is visible and nothing is in flight (Settings → Jira → Auto refresh).
let refreshTimer = null;
function scheduleRefresh() {
  clearInterval(refreshTimer);
  const minutes = CFG.jira.autoRefreshMinutes;
  if (!minutes) return;
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !state.menu && !state.issues.some((i) => i.pending)) {
      load({ silent: true });
      loadNotifications();
    }
  }, minutes * 60 * 1000);
}

async function init() {
  await loadClientConfig();
  renderPresets();
  $('#jql').value = state.jql;
  $('#search').value = state.q;

  $('#preset').addEventListener('change', (e) => {
    const p = presets()[Number(e.target.value)];
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
  $('[data-view="list"]').append(icon('list'), h('span', null, 'Tasks'));
  $('[data-view="docs"]').append(icon('doc'), h('span', null, 'Docs'));
  $('[data-view="git"]').append(icon('branch'), h('span', null, 'Workspace'));
  $('#theme-toggle').append(icon('more'));
  $('#login').append(h('span', { class: 'theme-icon' }, icon('key')), h('span', { class: 'theme-label' }, 'Enable token auto-refresh'));
  $('#login').title = 'Sign in to Atlassian once to give the dashboard its own session, independent of Claude Code tokens';
  $('#settings-btn').append(h('span', { class: 'theme-icon' }, icon('gear')), h('span', { class: 'theme-label' }, 'Settings'));
  $('#settings-btn').addEventListener('click', () => {
    closeThemePicker();
    setView(state.view === 'settings' ? LS.get('view', 'list') : 'settings');
  });
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
  document.querySelectorAll('.theme-option[data-theme]').forEach(btn => {
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
    document.querySelectorAll('.theme-option[data-theme]').forEach(btn => {
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
      if (state.view === 'git') loadGit();
      else load();
    } else if (!typing && e.key === '?') {
      e.preventDefault();
      showKeyboardShortcuts();
    } else if (!typing && /^[1-9]$/.test(e.key)) {
      // Switch saved filter with numbers 1-9
      const p = presets()[Number(e.key) - 1];
      if (p) {
        $('#preset').value = String(Number(e.key) - 1);
        $('#jql').value = p.jql || state.defaultJql;
        applyJql(p.jql);
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
  // Deep links: #KEY-123 opens that issue's detail.
  window.addEventListener('hashchange', () => {
    const key = decodeURIComponent(location.hash.slice(1));
    if (ISSUE_KEY_RE.test(key)) key !== state.openKey && openDetail(key);
    else if (state.openKey) closeDrawer();
  });

  scheduleRefresh();

  api('/api/me')
    .then(showAuth)
    .catch((e) => {
      toast(e.message, 'error');
      showLogin(e.login);
    });
  if (state.view === 'git' || state.view === 'settings') render(); // these views don't wait for Jira
  load();
  loadNotifications();
  loadUsers();
  const initial = decodeURIComponent(location.hash.slice(1));
  if (ISSUE_KEY_RE.test(initial)) openDetail(initial);
}

init();
