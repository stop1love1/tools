'use strict';

// Filtering and the progress strip.

// Type + search only; status/urgency filters come on top in filtered().
function scoped() {
  const q = state.q.trim().toLowerCase();
  return state.issues.filter(
    (i) =>
      (state.type === 'all' || i.type.name === state.type) &&
      (!q ||
        i.key.toLowerCase().includes(q) ||
        i.summary.toLowerCase().includes(q) ||
        (i.parent && (i.parent.key.toLowerCase().includes(q) || i.parent.summary.toLowerCase().includes(q)))),
  );
}

// scoped() plus the sprint filter — the base for anything that should total "the selected sprint" rather
// than every issue (status pills, urgent block, progress strip); filtered() adds status/urgency on top.
function scopedBySprint() {
  return scoped().filter((i) => isSprintTask(i, state.sprint));
}

const isEpicType = (i) => /epic/i.test(i.type?.name || '');

// What the status pills and the progress strip total: scopedBySprint() without Epics. An Epic is only ever a group
// header in the list (never a row), and "All sprints" lets it through isSprintTask, so counting it made N exceed the rows shown.
function countedBySprint() {
  return scopedBySprint().filter((i) => !isEpicType(i));
}

// An issue's own sprint plus, for an Epic (never in a sprint itself), the sprints its children are in.
const sprintsOf = (i) => [i.sprint, ...(i.childSprints || [])].filter(Boolean);
const inSprint = (i, id) => !id || (Number(id) === NO_SPRINT ? !sprintsOf(i).length : sprintsOf(i).some((s) => s.id === Number(id)));
// A task of the sprint: any sprint Jira has it in, as the Jira sprint board counts it (i.sprint is only the latest,
// so work carried over would vanish from the sprint it started in). NO_SPRINT keeps the tasks in none. An Epic that
// is there only through its children is no task of it (no row, no count); the list still shows it as the header of
// those children (list.js renderList). Tasks added for one sprint only (loadSprintTasks) show under that sprint and
// nowhere else.
function isSprintTask(i, id) {
  if (i.onlySprint && i.onlySprint !== Number(id)) return false;
  if (!id) return true;
  const ids = i.sprintIds || (i.sprint ? [i.sprint.id] : []);
  return Number(id) === NO_SPRINT ? !ids.length : ids.includes(Number(id));
}

// A row whose status just changed (heldMove) stays under the filter it was in, so it does not vanish at once.
function filtered() {
  return scopedBySprint().filter((i) => (!state.status || i.status.name === state.status || heldMove(i.key)?.from.name === state.status) && (!state.urgentOnly || isUrgent(i)));
}

// ---------------------------------------------------------------------------
// Progress

const isCancelled = (i) => i.status.category === 'done' && /cancel|hủy|huỷ|reject|won.?t|invalid|duplicate/i.test(i.status.name);

// One thin bar under the status pills: a segment per status (click = filter by it), then done / story point totals.
function renderProgress() {
  const el = $('#progress-strip');
  const base = countedBySprint(); // real statuses: progress must move the moment a task does (the list alone holds the row)
  if (state.error || !state.fetchedAt || !base.length) return el.replaceChildren();
  const sumSP = (list) => list.reduce((sum, i) => sum + (i.storyPoints || 0), 0);
  // Cancelled work counts as done, as in the Done column of the Jira sprint board (and the Overview numbers).
  const cancelled = base.filter(isCancelled);
  const done = base.filter((i) => i.status.category === 'done');
  const counted = base.length;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const countedSP = sumSP(base);
  const doneSP = sumSP(done);

  // Cancelled-like statuses last, so the done segments sit together.
  const statuses = statusList(base).sort((a, b) => (tone(a) === 'void') - (tone(b) === 'void'));
  const segs = statuses.map((s) => {
    const n = base.filter((i) => i.status.name === s.name).length;
    return h('button', {
      class: `seg seg-${tone(s)}${state.status === s.name ? ' on' : ''}`,
      style: `flex-grow:${n}`,
      title: `${s.name}: ${n}${state.status === s.name ? ' — click to show all' : ' — click to filter'}`,
      'aria-label': `${s.name}: ${n}`,
      'aria-pressed': String(state.status === s.name),
      onClick: () => toggleStatus(s.name),
    });
  });
  el.classList.toggle('filtering', !!state.status);
  el.replaceChildren(
    h('div', { class: 'track', role: 'group', 'aria-label': 'Tasks by status' }, segs),
    h(
      'span',
      { class: 'progress-sum', title: cancelled.length ? `Done includes ${cancelled.length} cancelled task(s), as on Jira` : null },
      h('b', null, `${done.length}/${counted}`),
      ' done ',
      h('span', { class: 'pct' }, `${pct(done.length, counted)}%`),
      countedSP > 0 && [h('span', { class: 'sep' }, '·'), h('b', null, `${doneSP}/${countedSP}`), ' SP ', h('span', { class: 'pct' }, `${pct(doneSP, countedSP)}%`)],
    ),
  );
}

function toggleStatus(name) {
  state.status = state.status === name ? null : name;
  state.urgentOnly = false;
  syncUrl();
  render();
}
