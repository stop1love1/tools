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
  return loadIssues(opts).then(() => loadSprintTasks({ fresh: opts.fresh })).finally(() => {
    $('#refresh').classList.remove('spin');
    $('#refresh').disabled = false;
    render();
  });
}

function render() {
  queueMicrotask(holdMenu());
  renderMeta();
  renderSprints();
  const list = filtered();
  renderTypes();
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

window.onJqlChange = () => {
  syncPreset();
  load();
};

function syncPreset() {
  const idx = presets().findIndex((p) => p.jql === state.jql);
  $('#preset').value = idx < 0 ? 'custom' : String(idx);
}

// Used by docs.js's issue chips: on tasks.html, clicking one opens the detail drawer in place.
function openIssueChip(key) {
  openDetail(key);
}

// "r" and the extra shortcuts (search focus, saved filters, j/k nav) are wired through
// app-shared's keydown handler via these hooks.
window.onUserFilterChange = () => {
  state.status = null;
  state.urgentOnly = false;
  load();
};
window.onSprintFilterChange = () => {
  render();
  loadSprintTasks().then(render);
};

// No opts: the refresh button or "r", which also skips the server's sprint cache.
window.onShortcutR = (opts) => load(opts || { fresh: true });
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
  $('#search').addEventListener('input', (e) => {
    state.q = e.target.value;
    syncUrl();
    render();
  });
  $('#scrim').addEventListener('click', closeDrawer);
  $('#type-filter').addEventListener('change', (e) => {
    state.type = e.target.value;
    syncUrl();
    render();
  });

  // Issues cached by the previous page (state.js): show them now and refresh behind them.
  const cached = !!state.fetchedAt;
  if (cached) render();
  const firstLoad = load({ silent: cached }).then(() => {
    if (!state.jql && state.defaultJql) $('#jql').value = state.defaultJql;
  });
  loadUsers();
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
