'use strict';

// workspace.html: repos, branch cleanup, recent jobs, and per-task git flow.
// window.PAGE = 'git' is set inline in workspace.html before this script loads.

var PAGE_SHORTCUTS = [
  ['r', 'Refresh data'],
];
window.PAGE_SHORTCUTS = PAGE_SHORTCUTS;

// Clicking an issue key here goes to the task list with that issue's drawer open,
// since the detail drawer only lives on tasks.html.
function openIssueChip(key) {
  showPageLoader();
  location.href = pageHref('/tasks.html', `#${encodeURIComponent(key)}`);
}

function render() {
  renderMeta();
  renderSprints();
  $('#settings-btn')?.setAttribute('aria-pressed', String(state.view === 'settings'));
  syncUrl();
  renderRepoPills();
  const el = state.view === 'settings' ? renderSettingsView() : renderGitView();
  if ($('#main').firstChild !== el) $('#main').replaceChildren(el);
}

window.onUserFilterChange = () => loadIssues({ silent: false }).then(render);
window.onJqlChange = () => loadIssues({ silent: false }).then(render);
window.onSprintFilterChange = () => render();

window.onShortcutR = () => {
  loadIssues({ silent: true }).then(render);
  return loadGit();
};
window.onShortcutExtra = () => {};

async function initPage() {
  // Start the load before the first render, which would otherwise kick off its own
  // (renderGitView loads when there's no overview yet) and leave nothing to wait on.
  const firstLoad = loadGit();
  render(); // doesn't wait for Jira issues
  // Jira issues only supply ticket → sprint for the branch cleanup filter; shown from the tab cache meanwhile.
  loadIssues({ silent: true }).then(render);
  loadUsers();
  return firstLoad;
}
window.initPage = initPage;
