'use strict';

function syncViewTabs() {
  for (const a of document.querySelectorAll('#views a')) {
    a.setAttribute('aria-selected', String(a.dataset.view === window.PAGE));
  }
}

function hidePageLoader() {
  $('#page-loader')?.classList.add('done');
}
function showPageLoader() {
  $('#page-loader')?.classList.remove('done');
}
window.addEventListener('pageshow', (e) => e.persisted && hidePageLoader());

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
  } else {
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

if (window.matchMedia) {
  const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  darkModeQuery.addEventListener('change', () => {
    if (state.theme === 'auto') {
      applyTheme();
    }
  });
}

document.addEventListener('click', (e) => {
  const picker = $('#theme-picker');
  if (!picker) return;
  if (!picker.contains(e.target) && !e.target.closest('#theme-toggle')) {
    closeThemePicker();
  }
});

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

function showLogin(show) {
  $('#login').hidden = !show;
  $('#theme-toggle').classList.toggle('attn', !!show);
}

function showAuth(me) {
  me.auth ??= { source: 'claude', expiresAt: me.tokenExpiresAt || null };
  state.me = me;
  const brand = $('.brand');
  if (brand) brand.title = `${me.name} · ${new URL(me.site).host}`;
  const login = $('#login');
  if (!login) return;
  showLogin(me.auth.source !== 'own');
  renderMeta();
}

function headerQuery() {
  const params = new URLSearchParams();
  if (state.user) params.set('user', state.user);
  if (state.sprint) params.set('sprint', String(state.sprint));
  const query = params.toString();
  return query ? '?' + query : '';
}

function pageHref(path, hash = '') {
  return path + headerQuery() + hash;
}

function syncNavLinks() {
  for (const a of $$('#views a, #settings-btn, #back-btn')) a.href = pageHref(new URL(a.getAttribute('href'), location.origin).pathname);
}
window.syncNavLinks = syncNavLinks;

const ALL_USERS = '__all__';
const UNASSIGNED = '__unassigned__';

function viewedUserName() {
  if (state.user === ALL_USERS) return 'everyone';
  if (state.user === UNASSIGNED) return 'nobody (unassigned)';
  return state.users?.users.find((u) => u.accountId === state.user)?.name || 'selected user';
}

const userLabel = () => ({ [ALL_USERS]: 'All', [UNASSIGNED]: 'Unassigned', '': 'Mine' })[state.user] ?? 'Loading…';

async function loadUsers() {
  const select = $('#user-filter');
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
    ...opts,
    h('option', { value: UNASSIGNED }, 'Unassigned'),
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
    if (i.sprint) counts.set(i.sprint.id, (counts.get(i.sprint.id) || 0) + 1);
  }
  for (const sp of state.extraSprints || []) if (!sprints.has(sp.id)) sprints.set(sp.id, sp);
  const select = $('#sprint-filter');
  state.sprintMap = sprints;
  if (sprints.size === 0) {
    select.hidden = true;
    renderSprintLeft();
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
      h('option', { value: s.id, selected: state.sprint === s.id }, `${s.name}${s.state === 'active' ? ' 🟢' : ''}${counts.has(s.id) ? ` (${counts.get(s.id)})` : ''}`)
    ),
  );
  select.hidden = false;
  renderSprintLeft();
  syncUrl();
}

function renderSprintLeft() {
  const el = $('#sprint-left');
  if (!el) return;
  const sprint = state.sprint ? state.sprintMap?.get(state.sprint) : null;
  const end = sprint?.endDate ? new Date(sprint.endDate) : null;
  if (!end || Number.isNaN(end.getTime())) {
    el.hidden = true;
    return;
  }
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(end) - startOfDay(new Date())) / 86400000);
  let text;
  let tone;
  if (days > 1) [text, tone] = [`${days} days left`, days <= 3 ? 'warn' : 'ok'];
  else if (days === 1) [text, tone] = ['1 day left', 'warn'];
  else if (days === 0) [text, tone] = ['Ends today', 'warn'];
  else [text, tone] = [`Ended ${-days} day${days === -1 ? '' : 's'} ago`, 'over'];
  el.textContent = text;
  el.dataset.tone = tone;
  el.title = `${sprint.name} ends ${end.toLocaleDateString('en-US', { dateStyle: 'medium' })}`;
  el.hidden = false;
}

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
    renderSprintLeft();
    syncUrl();
    if (window.onSprintFilterChange) window.onSprintFilterChange();
  });
}

async function init() {
  await loadClientConfig();

  document.body.dataset.view = state.view;
  syncViewTabs();

  $('#views [data-view="overview"]')?.append(icon('chart'), h('span', null, 'Overview'));
  $('#views [data-view="list"]').append(icon('list'), h('span', null, 'Tasks'));
  $('#views [data-view="docs"]').append(icon('doc'), h('span', null, 'Docs'));
  $('#views [data-view="git"]').append(icon('branch'), h('span', null, 'Workspace'));
  for (const a of $$('#views a')) {
    a.addEventListener('click', (e) => {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (a.dataset.view === window.PAGE) {
        e.preventDefault();
        return;
      }
      showPageLoader();
    });
  }
  $('#theme-toggle').append(icon('more'));
  $('#login').append(h('span', { class: 'theme-icon' }, icon('key')), h('span', { class: 'theme-label' }, 'Enable token auto-refresh'));
  $('#login').title = 'Sign in to Atlassian once to give the dashboard its own session, independent of Claude Code tokens';
  $('#settings-btn').append(h('span', { class: 'theme-icon' }, icon('gear')), h('span', { class: 'theme-label' }, 'Settings'));
  if (window.PAGE === 'settings') $('#settings-btn').setAttribute('aria-current', 'page');
  else {
    $('#settings-btn').addEventListener('click', (e) => {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      showPageLoader();
    });
  }

  $('#refresh')?.append(icon('refresh'));
  $('#refresh')?.addEventListener('click', () => window.onShortcutR?.());

  $('#bell').prepend(icon('bell'));
  $('#bell').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNotif();
  });
  $('#recent-btn')?.replaceChildren(icon('clock'));
  $('#recent-btn')?.addEventListener('click', (e) => {
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
    if ($('#recent')?.hidden === false && !e.target.closest('#recent') && !e.target.closest('#recent-btn')) toggleRecent(false);
  });
  document.addEventListener('scroll', closeMenu, true);
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      if (state.menu) closeMenu();
      else if (state.notif.open) toggleNotif(false);
      else if ($('#recent')?.hidden === false) toggleRecent(false);
      else if (state.openKey) window.closeDrawer?.();
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

  await window.initPage();
}

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

setTimeout(hidePageLoader, 8000);
init()
  .catch((e) => toast(e.message, 'error'))
  .finally(hidePageLoader);
