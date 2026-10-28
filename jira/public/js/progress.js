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
const isSubtask = (i) => !!i.type?.subtask || /sub-?task/i.test(i.type?.name || '');

// The tasks the numbers count, out of `list`: no Epics, and no Story whose own subtasks are in `all` (the whole list
// loaded). Both are only group headers in the list (list.js renderList); a Story's subtasks are its work, so counting
// the Story as well would count that work twice.
function countable(list, all = list) {
  const parents = new Set(all.filter((i) => isSubtask(i) && i.parent).map((i) => i.parent.key));
  return list.filter((i) => !isEpicType(i) && !parents.has(i.key));
}

// What the status pills and the progress strip total: the countable tasks of scopedBySprint(). "All sprints" lets
// Epics through isSprintTask, so counting them made N exceed the rows shown.
function countedBySprint() {
  return countable(scopedBySprint(), state.issues);
}

// An issue's own sprint plus, for an Epic (never in a sprint itself), the sprints its children are in.
const sprintsOf = (i) => [i.sprint, ...(i.childSprints || [])].filter(Boolean);
const inSprint = (i, id) => !id || (Number(id) === NO_SPRINT ? !sprintsOf(i).length : sprintsOf(i).some((s) => s.id === Number(id)));
// The one sprint a task counts for, so the sprints add up to "All sprints": the last one it was moved to (Jira keeps
// it in every sprint it was carried through, and a done sub-task goes along with its Story): the latest started, a
// future sprint (no start date yet) being later than any. null: in no sprint.
function homeSprintId(i) {
  const ids = i.sprintIds || (i.sprint ? [i.sprint.id] : []);
  if (!ids.length) return null;
  // Issues from an older server carry only their latest sprint: take the others from the sprints known.
  const known = i.sprints || ids.map((id) => (i.sprint?.id === id ? i.sprint : state.sprintMap?.get(id))).filter(Boolean);
  if (known.length < ids.length) return i.sprint?.id ?? ids[ids.length - 1];
  const start = (s) => (s.startDate ? Date.parse(s.startDate) : Infinity);
  return known.reduce((a, b) => (start(b) >= start(a) ? b : a)).id;
}

// A task of the sprint: the one it counts for (homeSprintId). NO_SPRINT keeps the tasks in none. An Epic that is there
// only through its children is no task of it (no row, no count); the list still shows it as the header of those
// children (list.js renderList).
function isSprintTask(i, id) {
  if (!id) return true;
  const home = homeSprintId(i);
  return Number(id) === NO_SPRINT ? home === null : home === Number(id);
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
      // Not final while the sprints' older tasks load: say so instead of showing partial totals.
      state.sprintTasksLoading
        ? h('span', { class: 'muted', title: "The sprints' older tasks are still loading" }, h('span', { class: 'spin' }, icon('refresh')), ' Loading sprint tasks…')
        : [
            h('b', null, `${done.length}/${counted}`),
            ' done ',
            h('span', { class: 'pct' }, `${pct(done.length, counted)}%`),
            countedSP > 0 && [h('span', { class: 'sep' }, '·'), h('b', null, `${doneSP}/${countedSP}`), ' SP ', h('span', { class: 'pct' }, `${pct(doneSP, countedSP)}%`)],
          ],
    ),
  );
}

function toggleStatus(name) {
  state.status = state.status === name ? null : name;
  state.urgentOnly = false;
  syncUrl();
  render();
}
