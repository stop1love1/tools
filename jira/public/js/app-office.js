'use strict';

// office.html: the team's sprint as a 3D office. The scene is office-scene.html in an iframe (three.js and the scene
// load with it); this page keeps the dashboard's header, and its sprint filter picks the sprint the office shows.
// window.PAGE = 'office' is set inline in office.html before this script loads.

window.PAGE_SHORTCUTS = [['r', 'Reload the team'], ['/', 'Jump to a task']];

let frame = null;

// The sprint picked in the header, else the team's active sprint (office-scene.html finds it).
const sceneSrc = () => (state.sprint && state.sprint !== NO_SPRINT ? `/office-scene.html?sprint=${encodeURIComponent(state.sprint)}` : '/office-scene.html');

function render() {
  renderMeta();
  renderSprints();
  syncUrl();
  const main = $('#main');
  // Moving an iframe in the DOM reloads it: build it once, then only point it at another sprint.
  if (!frame || !main.contains(frame)) {
    frame = h('iframe', { class: 'office-frame', title: '3D office: the team in this sprint', src: sceneSrc() });
    main.replaceChildren(frame);
  } else if (frame.getAttribute('src') !== sceneSrc()) frame.setAttribute('src', sceneSrc());
  main.style.setProperty('--office-top', `${$('.topbar')?.offsetHeight || 56}px`);
}

// Header search: jump to the task list filtered by the text (a key opens straight on it there).
$('#search')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const u = new URL(pageHref('/tasks.html'), location.origin);
  if (e.target.value.trim()) u.searchParams.set('q', e.target.value.trim());
  showPageLoader();
  location.href = u.pathname + u.search;
});
window.onShortcutExtra = (e, typing) => {
  if (!typing && e.key === '/') {
    e.preventDefault();
    $('#search').focus();
  }
};

// The header's filters: the sprint picks the office's sprint; the person and the JQL pick what its sprint board shows
// (office-scene.html asks officeFilter when it redraws its rooms).
window.officeFilter = () => {
  if (!state.fetchedAt) return null; // not loaded yet: the board shows the whole team meanwhile
  const who = $('#user-filter')?.selectedOptions[0]?.textContent || 'Mine';
  return { keys: state.issues.map((i) => i.key), label: state.jql ? `${who} · JQL` : who };
};
const redrawBoard = () => frame?.contentWindow?.refreshRooms?.();
window.onSprintFilterChange = render;
window.onUserFilterChange = () => { render(); loadIssues().then(redrawBoard); };
window.onJqlChange = () => loadIssues().then(() => { render(); redrawBoard(); });
window.onShortcutR = () => frame?.contentWindow?.load?.({ fresh: true });

async function initPage() {
  render();
  loadUsers();
  // The task list fills the sprint filter's choices.
  return loadIssues({ silent: !!state.fetchedAt }).then(() => { render(); redrawBoard(); });
}
window.initPage = initPage;
