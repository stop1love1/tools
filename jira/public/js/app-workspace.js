'use strict';

var PAGE_SHORTCUTS = [
  ['r', 'Refresh data'],
];
window.PAGE_SHORTCUTS = PAGE_SHORTCUTS;

function openIssueChip(key) {
  showPageLoader();
  location.href = pageHref('/tasks.html', `#${encodeURIComponent(key)}`);
}

function render() {
  renderMeta();
  renderSprints();
  syncUrl();
  renderRepoPills();
  const el = renderGitView();
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
  const firstLoad = loadGit();
  render();
  loadIssues({ silent: true }).then(render);
  loadUsers();
  return firstLoad;
}
window.initPage = initPage;
