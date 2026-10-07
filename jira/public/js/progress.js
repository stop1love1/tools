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
  return scoped().filter((i) => !state.sprint || (i.sprint && i.sprint.id === Number(state.sprint)));
}

function filtered() {
  return scopedBySprint().filter((i) => (!state.status || i.status.name === state.status) && (!state.urgentOnly || isUrgent(i)));
}

// ---------------------------------------------------------------------------
// Progress

const isCancelled = (i) => i.status.category === 'done' && /cancel|hủy|huỷ|reject|won.?t|invalid|duplicate/i.test(i.status.name);

// One thin bar under the status pills: a segment per status (click = filter by it), then done / story point totals.
function renderProgress() {
  const el = $('#progress-strip');
  const base = scopedBySprint();
  if (state.error || !state.fetchedAt || !base.length) return el.replaceChildren();
  const sumSP = (list) => list.reduce((sum, i) => sum + (i.storyPoints || 0), 0);
  const cancelled = base.filter(isCancelled);
  const done = base.filter((i) => i.status.category === 'done' && !isCancelled(i));
  const counted = base.length - cancelled.length;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const countedSP = sumSP(base) - sumSP(cancelled);
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
      { class: 'progress-sum', title: cancelled.length ? `${cancelled.length} cancelled task(s) not counted` : null },
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
