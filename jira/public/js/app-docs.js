'use strict';

// docs.html: Confluence pages & attachments across all tasks. Loads issues (for their
// docs/attachments) but has none of the task-list filter subbar.
// window.PAGE = 'docs' is set inline in docs.html before this script loads.

var PAGE_SHORTCUTS = [
  ['/', 'Focus search box'],
  ['r', 'Refresh data'],
];
window.PAGE_SHORTCUTS = PAGE_SHORTCUTS;

// Clicking an issue chip here goes to the task list with that issue's drawer open,
// since the detail drawer only lives on tasks.html.
function openIssueChip(key) {
  showPageLoader();
  location.href = `/tasks.html#${encodeURIComponent(key)}`;
}

function load(opts) {
  return loadIssues(opts).then(render);
}

function render() {
  renderMeta();
  $('#settings-btn')?.setAttribute('aria-pressed', String(state.view === 'settings'));
  renderSprints();
  syncUrl();
  const main = $('#main');
  if (state.view === 'settings') {
    const el = renderSettingsView();
    if (main.firstChild !== el) main.replaceChildren(el);
    return;
  }
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
    main.replaceChildren(h('div', { class: 'empty-state loading-state' }, h('span', { class: 'spin' }, icon('refresh')), 'Loading docs…'));
    return;
  }
  if (!state.fetchedAt) return;
  const filtered = state.sprint ? state.issues.filter((i) => inSprint(i, state.sprint)) : state.issues;
  main.replaceChildren(renderDocs(filtered));
}

window.onUserFilterChange = () => load();
window.onJqlChange = () => load();
window.onSprintFilterChange = () => render();

window.onShortcutR = (opts) => load(opts);
window.onShortcutExtra = (e, typing) => {
  if (!typing && e.key === '/') {
    e.preventDefault();
    $('#search').focus();
  }
};

async function initPage() {
  // The search box lives in the header (same slot as on tasks.html), outside render().
  $('#search').value = state.docsQ;
  $('#search').addEventListener('input', (e) => {
    state.docsQ = e.target.value;
    render();
  });

  // Issues cached by the previous page (state.js): show them now and refresh behind them.
  const cached = !!state.fetchedAt;
  if (cached || state.view === 'settings') render();
  const firstLoad = load({ silent: cached });
  loadUsers();
  return cached ? undefined : firstLoad;
}
window.initPage = initPage;
