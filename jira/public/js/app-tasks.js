'use strict';

// tasks.html: task list, filters, JQL, search, j/k navigation, detail drawer.
// window.PAGE = 'list' is set inline in tasks.html before this script loads.

var PAGE_SHORTCUTS = [
  ['/', 'Focus search box'],
  ['r', 'Refresh data'],
  ['1-9', 'Switch to saved filter 1-9'],
  ['j / k', 'Navigate down / up in list'],
  ['Enter', 'Open focused issue'],
  ['Click issue', 'Open detail drawer'],
];
window.PAGE_SHORTCUTS = PAGE_SHORTCUTS;

function load(opts = {}) {
  $('#refresh').classList.add('spin');
  $('#refresh').disabled = true;
  if (!opts.silent) render();
  return loadIssues(opts).finally(() => {
    $('#refresh').classList.remove('spin');
    $('#refresh').disabled = false;
    render();
  });
}

function render() {
  closeMenu();
  renderMeta();
  $('#settings-btn')?.setAttribute('aria-pressed', String(state.view === 'settings'));
  if (state.view === 'settings') {
    syncUrl();
    const el = renderSettingsView();
    if ($('#main').firstChild !== el) $('#main').replaceChildren(el);
    return;
  }
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
        h('div', null, h('strong', null, 'Failed to load data. '), state.error),
        state.errorLogin && h('a', { class: 'btn primary', href: '/oauth/login' }, 'Sign in to Atlassian'),
      ),
    );
    return;
  }
  if (state.loading && state.loadedFor !== issuesQuery()) {
    main.replaceChildren(h('div', { class: 'empty-state loading-state' }, h('span', { class: 'spin' }, icon('refresh')), 'Loading tasks…'));
    return;
  }
  if (!state.fetchedAt) return;
  if (!state.issues.length) {
    main.replaceChildren(h('div', { class: 'empty-state' }, 'No tasks match this JQL.'));
    return;
  }
  main.replaceChildren(renderList(list));
  if (state.openKey) refreshDrawerStatus();
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

// Used by docs.js's issue chips: on tasks.html, clicking one opens the detail drawer in place.
function openIssueChip(key) {
  openDetail(key);
}

// "r" and the extra shortcuts (search focus, saved filters, j/k nav) are wired through
// app-shared's keydown handler via these hooks.
window.onShortcutR = (opts) => load(opts);
window.onShortcutExtra = (e, typing) => {
  if (!typing && /^[1-9]$/.test(e.key)) {
    const p = presets()[Number(e.key) - 1];
    if (p) {
      $('#preset').value = String(Number(e.key) - 1);
      $('#jql').value = p.jql || state.defaultJql;
      applyJql(p.jql);
    }
  } else if (!typing && e.key === '/') {
    e.preventDefault();
    $('#search').focus();
  } else if (!typing && (e.key === 'j' || e.key === 'k') && !state.openKey) {
    e.preventDefault();
    const list = $('.list');
    if (!list) return;
    const rows = [...list.querySelectorAll('.row:not(.child)')];
    if (!rows.length) return;
    const current = rows.findIndex((r) => r.classList.contains('keyboard-focus'));
    let nextIdx;
    if (e.key === 'j') nextIdx = current < 0 ? 0 : Math.min(current + 1, rows.length - 1);
    else nextIdx = current < 0 ? 0 : Math.max(current - 1, 0);
    rows.forEach((r) => r.classList.remove('keyboard-focus'));
    rows[nextIdx].classList.add('keyboard-focus');
    rows[nextIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else if (!typing && e.key === 'Enter' && !state.openKey) {
    const list = $('.list');
    if (!list) return;
    const focused = list.querySelector('.row.keyboard-focus');
    if (focused) focused.click();
  }
};

async function initPage() {
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
  $('#jql-toggle').append(icon('code'));
  $('#scrim').addEventListener('click', closeDrawer);
  $('#user-filter').addEventListener('change', (e) => {
    state.user = e.target.value;
    LS.set('user', state.user);
    state.status = null;
    state.urgentOnly = false;
    syncUrl();
    load();
  });
  $('#type-filter').addEventListener('change', (e) => {
    state.type = e.target.value;
    syncUrl();
    render();
  });
  $('#sprint-filter').addEventListener('change', (e) => {
    state.sprint = e.target.value ? Number(e.target.value) : null;
    syncUrl();
    render();
  });
  $('#jql-toggle').addEventListener('click', (e) => {
    const row = $('#jql-row');
    row.hidden = !row.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!row.hidden));
    if (!row.hidden) $('#jql').focus();
  });

  // Issues cached by the previous page (state.js): show them now and refresh behind them.
  const cached = !!state.fetchedAt;
  if (cached) render();
  const firstLoad = load({ silent: cached }).then(() => {
    if (!state.jql && state.defaultJql) $('#jql').value = state.defaultJql;
  });
  loadUsers();
  if (state.view === 'settings') render(); // detour: don't wait for the task list
  const initial = decodeURIComponent(location.hash.slice(1));
  if (ISSUE_KEY_RE.test(initial)) openDetail(initial);
  window.addEventListener('hashchange', () => {
    const key = decodeURIComponent(location.hash.slice(1));
    if (ISSUE_KEY_RE.test(key)) key !== state.openKey && openDetail(key);
    else if (state.openKey) closeDrawer();
  });
  return cached ? undefined : firstLoad;
}
window.initPage = initPage;
