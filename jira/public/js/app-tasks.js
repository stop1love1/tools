'use strict';

// tasks.html: task list, filters, JQL, search, j/k navigation, detail drawer.
// window.PAGE = 'list' is set inline in tasks.html before this script loads.

var PAGE_SHORTCUTS = [
  ['/', 'Focus search box'],
  ['r', 'Refresh data'],
  ['1-9', 'Switch to saved filter 1-9'],
  ['j / k', 'Move down / up the list (tasks, stories, epics)'],
  ['Enter', 'Open the task, or fold / unfold the group'],
  ['x', 'Select / unselect the task, turning Select on (Shift+click a checkbox: range)'],
  ['s', 'Change status: of the selected tasks, else of the focused one'],
  ['e', 'Fold / unfold the group of the focused row'],
  ['h', 'Hide / show done tasks'],
  ['Esc', 'Untick all, then leave Select'],
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
  renderHideDone();
  renderSelectMode();
  renderBulk();
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
  main.replaceChildren(...[viewingBanner(), renderList(list)].filter(Boolean));
  markKbFocus();
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
  } else if (typing || state.openKey || e.metaKey || e.ctrlKey || e.altKey || $('.shortcuts-modal')) {
    // the shortcuts below act on the list only
  } else if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    const rows = navRows();
    if (!rows.length) return;
    const cur = rows.findIndex((r) => r.dataset.nav === state.kbNav);
    const next = cur < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, cur + (e.key === 'j' ? 1 : -1)));
    state.kbNav = rows[next].dataset.nav;
    markKbFocus(true);
  } else if (e.key === 'Enter' && !state.menu) {
    const el = kbFocused();
    if (!el) return;
    e.preventDefault();
    el.classList.contains('row') ? openDetail(el.dataset.key) : el.click();
  } else if (e.key === 'x') {
    const el = kbFocused();
    if (!el) return state.selectMode || setSelectMode(true);
    if (!state.selectMode) {
      state.selectMode = true;
      render();
    }
    kbFocused()?.querySelector('input.sel')?.click();
  } else if (e.key === 's') {
    e.preventDefault();
    if (state.selected.size) return $('#bulk-status') && openBulkMenu($('#bulk-status'));
    const btn = kbFocused()?.querySelector('button.status');
    const issue = btn && (state.issues.find((i) => i.key === btn.dataset.key) || null);
    if (btn) openStatusMenu(btn, issue || { key: btn.dataset.key, status: { name: btn.textContent } });
  } else if (e.key === 'e') {
    let el = kbFocused();
    while (el && !el.matches('.group[data-nav]')) el = el.previousElementSibling;
    if (!el) return;
    state.kbNav = el.dataset.nav;
    el.click();
  } else if (e.key === 'h') {
    toggleHideDone();
  }
};

// j/k move over task rows and the group rows (story, epic, completed epics).
const navRows = () => $$('#main .list .row[data-nav], #main .list .group[data-nav]');
const kbFocused = () => (state.kbNav ? navRows().find((r) => r.dataset.nav === state.kbNav) : null);
// The list is rebuilt on every render: put the keyboard focus back on the same row.
function markKbFocus(scroll) {
  for (const r of $$('#main .keyboard-focus')) r.classList.remove('keyboard-focus');
  const el = kbFocused();
  if (!el) return;
  el.classList.add('keyboard-focus');
  if (scroll) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
window.onEscape = () => clearSelection();

// The list has no search box (the header holds Auto Claude). A "?q=" from elsewhere (the Overview's "jump to a task")
// still filters it: shown as a chip, × clears it.
function renderQueryChip() {
  const slot = $('#auto-claude-slot');
  if (!slot) return;
  slot.querySelector('.q-chip')?.remove();
  if (!state.q) return;
  slot.append(
    h(
      'span',
      { class: 'q-chip', title: `The list is filtered by "${state.q}"` },
      h('span', null, 'Filter: ', h('b', null, state.q)),
      h('button', { class: 'icon-btn sm', title: 'Clear the filter', 'aria-label': 'Clear the filter', onClick: () => ((state.q = ''), syncUrl(), renderQueryChip(), render()) }, icon('x')),
    ),
  );
}

async function initPage() {
  renderPresets();
  $('#jql').value = state.jql;
  renderQueryChip();

  $('#preset').addEventListener('change', (e) => {
    const p = presets()[Number(e.target.value)];
    if (!p) return;
    $('#jql').value = p.jql || state.defaultJql;
    applyJql(p.jql);
  });
  $('#scrim').addEventListener('click', closeDrawer);
  $('#hide-done').addEventListener('click', toggleHideDone);
  $('#select-mode').addEventListener('click', () => setSelectMode(!state.selectMode));
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
