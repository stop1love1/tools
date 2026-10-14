'use strict';

window.PAGE_SHORTCUTS = [];

const backBtn = $('#back-btn');
backBtn.append(icon('arrowLeft'));
backBtn.addEventListener('click', (e) => {
  if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  let cameFromApp = false;
  try {
    const ref = new URL(document.referrer);
    cameFromApp = ref.origin === location.origin && ref.pathname !== location.pathname;
  } catch {}
  if (!settingsState.dirty) showPageLoader();
  if (cameFromApp) {
    e.preventDefault();
    history.back();
  }
});

function openIssueChip(key) {
  showPageLoader();
  location.href = pageHref('/tasks.html', `#${encodeURIComponent(key)}`);
}

function render() {
  renderMeta();
  syncUrl();
  const el = renderSettingsView();
  if ($('#main').firstChild !== el) $('#main').replaceChildren(el);
}

function initPage() {
  return loadSettings();
}
window.initPage = initPage;
