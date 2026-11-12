'use strict';

// Task list pieces: filters, urgent block, status pills, and the list grouped by epic / parent.
// The page render() lives in app-tasks.js.

// Counts here must ignore state.type itself (it's the option list for that filter) but still
// respect the sprint filter, so "All types (N)" matches the sprint currently selected.
function renderTypes() {
  // The tasks the "All" pill counts (no Epics, no Story whose subtasks are listed: they are only group headers).
  const bySprint = countable(state.issues.filter((i) => isSprintTask(i, state.sprint)), state.issues);
  const counts = new Map();
  for (const i of bySprint) counts.set(i.type.name, (counts.get(i.type.name) || 0) + 1);
  if (state.type !== 'all' && !counts.has(state.type)) state.type = 'all';
  const select = $('#type-filter');
  select.replaceChildren(
    h('option', { value: 'all' }, `All types (${state.sprintTasksLoading ? '…' : bySprint.length})`),
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => h('option', { value: name }, `${name} (${state.sprintTasksLoading ? '…' : n})`)),
  );
  select.value = state.type;
  select.hidden = counts.size < 2;
  syncUrl();
}

function renderFocus() {
  const el = $('#focus');
  const base = countedBySprint(); // same set as the pills, so "View all N" matches the Urgent pill
  if (state.error || !state.fetchedAt || !base.length) return el.replaceChildren();
  const urgent = base.filter(isUrgent).sort(byUrgency);
  if (!urgent.length) return el.replaceChildren();
  const row = (i) => {
    const u = sortUrgency(i);
    const isDone = i.status.category === 'done';
    return h(
      'div',
      { class: `focus-row lvl-${u.level || 'none'}${isDone ? ' done' : ''}`, onClick: (e) => !e.target.closest('a,button') && openDetail(i.key) },
      h('div', { class: 'focus-reasons' }, reasonChips(i)),
      h('div', { class: 'focus-main' }, typeBadge(i.type.name), keyLink(i), h('span', { class: 'focus-summary', title: i.summary }, i.summary)),
      h('div', { class: 'focus-actions' }, statusButton(i), claudeButton(i)),
    );
  };
  const open = LS.get('focusOpen', true);
  const toggle = () => (LS.set('focusOpen', !open), renderFocus());
  el.replaceChildren(
    h(
      'button',
      { class: `focus-head${open ? '' : ' closed'}`, 'aria-expanded': String(open), onClick: toggle },
      h('span', { class: 'fold-icon' }, icon('chevRight')),
      h('h2', null, icon('flame'), 'Urgent attention'),
      h('span', { class: `count ${urgent.length ? 'hot' : ''}` }, urgent.length),
      h('span', { class: 'muted small' }, 'Overdue, due within 3 days, High priority or above, or urgent label'),
    ),
    !open ? '' : urgent.length
      ? h(
          'div',
          { class: 'focus-list' },
          urgent.slice(0, 6).map(row),
          urgent.length > 6 &&
            h(
              'button',
              {
                class: 'link-btn',
                onClick: () => {
                  state.urgentOnly = true;
                  syncUrl();
                  render();
                },
              },
              `View all ${urgent.length} urgent tasks →`,
            ),
        )
      : h('div', { class: 'focus-empty' }, 'No overdue, due-soon, or high-priority tasks.'),
  );
}

function renderStats() {
  const all = countedBySprint(); // real statuses, so the pills follow a transition at once
  if (!all.length) return $('#stats').replaceChildren();
  // A pill with nothing behind it is hidden, unless it is the filter in use (so it can still be turned off). While the
  // sprints' older tasks load, the numbers are not final: "…" instead of them.
  const wait = state.sprintTasksLoading;
  const pill = (label, value, toneName, pressed, onClick) =>
    (value || pressed) &&
    h(
      'button',
      { class: `pill ${toneName ? 'tone-' + toneName : ''} ${toneName === 'hot' && value ? 'hot' : ''}`, 'aria-pressed': String(pressed), onClick },
      toneName && h('span', { class: 'dot' }),
      label,
      h('b', null, wait ? '…' : value),
    );
  const pills = [
    pill('All', all.length, null, !state.status && !state.urgentOnly, () => {
      state.status = null;
      state.urgentOnly = false;
      syncUrl();
      render();
    }),
    pill('Urgent', all.filter(isUrgentNow).length, 'hot', state.urgentOnly, () => {
      state.urgentOnly = !state.urgentOnly;
      syncUrl();
      render();
    }),
    ...statusList(all).map((s) =>
      pill(s.name, all.filter((i) => i.status.name === s.name).length, tone(s), state.status === s.name, () => toggleStatus(s.name)),
    ),
  ];
  $('#stats').replaceChildren(...pills.filter(Boolean));
}

function keyLink(i) {
  return h(
    'a',
    {
      class: 'key',
      href: '#' + i.key,
      title: 'Open detail',
      onClick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let the browser open a new tab
        e.preventDefault();
        e.stopPropagation();
        openDetail(i.key);
      },
    },
    i.key,
  );
}

// Also used for Story / Epic stubs (parent, epic, drawer children): only `key` and `status` are needed.
function statusButton(issue) {
  if (!issue.status) return null;
  // Warm the transitions cache so the menu opens with its items already there. Hovering has to rest for a moment
  // first, so sweeping the mouse down the column does not fetch every row; keyboard focus is deliberate, so it is immediate.
  let hoverTimer = null;
  const warm = () => getTransitions(issue.key).catch(() => {});
  return h(
    'button',
    {
      class: `status tone-${tone(issue.status)}`,
      'data-key': issue.key,
      title: 'Change status',
      onMouseenter: () => (clearTimeout(hoverTimer), (hoverTimer = setTimeout(warm, 150))),
      onMouseleave: () => clearTimeout(hoverTimer),
      onFocus: warm,
      onClick: (e) => {
        e.stopPropagation();
        openStatusMenu(e.currentTarget, issue);
      },
    },
    issue.status.name,
    icon('chev'),
  );
}

function docBadges(issue) {
  return [
    issue.docs.length > 0 &&
      h('span', { class: 'badge doc', title: issue.docs.map(docTitle).join('\n') }, icon('doc'), issue.docs.length),
    issue.attachments.length > 0 &&
      h('span', { class: 'badge', title: issue.attachments.map((a) => a.filename).join('\n') }, icon('clip'), issue.attachments.length),
  ];
}

// --- hide done / selection ---

// The status a row is placed by: a just-moved task keeps its previous one for a moment (heldMove), so its group and
// epic do not jump away under the user.
const placedStatus = (i) => heldMove(i.key)?.from || i.status;

// "Hide done" toggle in the sub bar: hides Jira's Done category (QA done, cancelled) unless a status pill is picked.
function renderHideDone() {
  const btn = $('#hide-done');
  if (!btn) return;
  const n = countedBySprint().filter((i) => stageOf(i.status) === 'done').length;
  btn.hidden = !n && !state.hideDone;
  btn.setAttribute('aria-pressed', String(state.hideDone));
  btn.title = state.status ? 'Not applied while a status is picked' : state.hideDone ? 'Show done tasks again' : 'Hide done and cancelled tasks';
  btn.classList.toggle('inactive', !!state.status);
  btn.replaceChildren(icon(state.hideDone ? 'check' : 'list'), 'Hide done', h('b', null, state.sprintTasksLoading ? '…' : n));
}

function toggleHideDone() {
  state.hideDone = !state.hideDone;
  LS.set('hideDone', state.hideDone);
  syncUrl();
  render();
}

// Selection for bulk status changes. The Select button (or x) turns it on: then each row has a checkbox (Shift+click:
// range) and each group one for all its tasks. Turning it off drops the selection.
let lastPicked = null;
function renderSelectMode() {
  const btn = $('#select-mode');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(state.selectMode));
  btn.replaceChildren(icon('check'), state.selectMode ? 'Selecting' : 'Select', state.selectMode && state.selected.size ? h('b', null, state.selected.size) : '');
}
function setSelectMode(on) {
  state.selectMode = on;
  if (!on) state.selected.clear();
  render();
}
function setSelected(keys, on) {
  for (const k of keys) on ? state.selected.add(k) : state.selected.delete(k);
  render();
}
function pickRange(toKey) {
  const keys = $$('.list .row[data-key]').map((r) => r.dataset.key);
  const a = keys.indexOf(lastPicked), b = keys.indexOf(toKey);
  if (a < 0 || b < 0) return false;
  setSelected(keys.slice(Math.min(a, b), Math.max(a, b) + 1), true);
  return true;
}
function selectBox(keys, label) {
  if (!state.selectMode) return null;
  const on = keys.length > 0 && keys.every((k) => state.selected.has(k));
  const box = h('input', {
    type: 'checkbox',
    class: 'sel',
    'aria-label': label,
    title: keys.length > 1 ? `Select its ${keys.length} tasks` : 'Select (Shift+click: range, x)',
    onClick: (e) => {
      e.stopPropagation();
      if (e.shiftKey && keys.length === 1 && lastPicked && pickRange(keys[0])) return (lastPicked = keys[0]);
      if (keys.length === 1) lastPicked = keys[0];
      setSelected(keys, e.currentTarget.checked);
    },
  });
  box.checked = on;
  box.indeterminate = !on && keys.some((k) => state.selected.has(k));
  return box;
}

// The bar at the bottom while tasks are selected: how many, change all their statuses at once, clear.
function renderBulk() {
  const shown = new Set(filtered().map((i) => i.key));
  for (const k of [...state.selected]) if (!shown.has(k)) state.selected.delete(k); // filtered out: not acted on unseen
  let bar = $('#bulk-bar');
  if (!state.selectMode) return bar?.remove();
  if (!bar) document.body.append((bar = h('div', { id: 'bulk-bar', class: 'bulk-bar', role: 'toolbar', 'aria-label': 'Selected tasks' })));
  const n = state.selected.size;
  bar.replaceChildren(
    h('b', null, n ? `${n} selected` : 'Tick tasks to change their status together'),
    n > 0 && h('button', { class: 'btn primary sm', id: 'bulk-status', onClick: (e) => (e.stopPropagation(), openBulkMenu(e.currentTarget)) }, 'Change status', icon('chev')),
    n > 0 && h('button', { class: 'btn sm', title: 'Untick all', onClick: () => (state.selected.clear(), render()) }, 'Clear'),
    h('button', { class: 'btn sm', title: 'Stop selecting (Esc)', onClick: () => setSelectMode(false) }, 'Done'),
  );
}
// Esc: untick all first, then leave select mode.
function clearSelection() {
  if (state.selected.size) return (state.selected.clear(), render(), true);
  if (state.selectMode) return (setSelectMode(false), true);
  return false;
}

// One menu for every selected task: the target statuses their transitions lead to, with how many of them can go there.
async function openBulkMenu(anchor) {
  closeMenu();
  const issues = [...state.selected].map((k) => state.issues.find((i) => i.key === k)).filter(Boolean);
  const menu = h('div', { class: 'menu', role: 'menu' }, h('div', { class: 'menu-note' }, `Loading transitions of ${issues.length} tasks…`));
  document.body.append(menu);
  state.menu = menu;
  placeMenu(menu, anchor);
  try {
    const all = await Promise.all(issues.map((i) => getTransitions(i.key).then((ts) => [i, ts])));
    if (state.menu !== menu) return;
    const targets = new Map(); // status name → { to, moves: [[issue, transition]] }
    for (const [i, ts] of all) {
      for (const t of ts) {
        if (t.to.name === i.status.name) continue;
        if (!targets.has(t.to.name)) targets.set(t.to.name, { to: t.to, moves: [] });
        const tg = targets.get(t.to.name);
        if (!tg.moves.some(([x]) => x.key === i.key)) tg.moves.push([i, t]);
      }
    }
    const list = [...targets.values()].sort((a, b) => b.moves.length - a.moves.length || STAGE_ORDER[stageOf(a.to)] - STAGE_ORDER[stageOf(b.to)] || rank(a.to.name) - rank(b.to.name));
    menu.replaceChildren(
      ...(list.length
        ? list.map((tg) =>
            h(
              'button',
              { class: 'menu-item', role: 'menuitem', onClick: () => (closeMenu(), bulkMove(tg)) },
              h('span', { class: `dot tone-${tone(tg.to)}` }),
              h('span', null, tg.to.name),
              h('span', { class: 'muted small' }, tg.moves.length === issues.length ? `all ${issues.length}` : `${tg.moves.length} of ${issues.length}`),
            ),
          )
        : [h('div', { class: 'menu-note' }, 'No transition shared by these tasks.')]),
    );
    placeMenu(menu, anchor);
    menu.querySelector('button')?.focus();
  } catch (e) {
    if (state.menu === menu) menu.replaceChildren(h('div', { class: 'menu-note err' }, e.message));
  }
}

// One task at a time, so Jira is not hit with a burst and each row moves visibly in turn.
async function bulkMove(tg) {
  state.selected.clear();
  for (const [issue, t] of tg.moves) await transition(state.issues.find((i) => i.key === issue.key) || issue, t);
}

// Progress of a parent: tasks dev done (the rule of the progress strip, workflow.js isDevDone).
function miniProgress(items, noun = 'tasks') {
  const n = items.length, done = items.filter((i) => isDevDone(i.status)).length;
  const wait = state.sprintTasksLoading;
  return [
    h('span', { class: 'mini-prog', title: wait ? 'Loading…' : `${done} of ${n} ${noun} dev done (Ready for SIT on)` }, h('i', { style: `width:${n && !wait ? Math.round((done / n) * 100) : 0}%` })),
    h('span', { class: 'muted small nowrap' }, wait ? '…' : `${done}/${n}`),
  ];
}

// --- list (grouped by parent; parents fold/unfold on click) ---

// Epic → Story/Task → Sub-task, the same levels as the git flow (epic branch → task branch).
function renderList(list) {
  if (!list.length) return h('div', { class: 'empty-state' }, state.hideDone && !state.status ? 'Nothing left here: every task is done.' : 'No tasks match this filter.');
  const byKey = new Map(state.issues.map((i) => [i.key, i]));
  const isEpicIssue = (i) => /epic/i.test(i.type?.name || '');
  const top = (g) => Math.max(...g.items.map((i) => sortUrgency(i).score));
  const latest = (g) => Math.max(...g.items.map((i) => Date.parse(i.updated)));
  const byGroupUrgency = (a, b) => top(b) - top(a) || latest(b) - latest(a);

  // Every task of the sprint under each parent, whatever the status filter / Hide done: a parent's progress is about
  // all its work, not just the rows shown.
  const scope = scopedBySprint();
  const underEpic = new Map(), underParent = new Map();
  for (const i of scope) {
    if (i.epic?.key) (underEpic.get(i.epic.key) || underEpic.set(i.epic.key, []).get(i.epic.key)).push(i);
    if (i.parent?.key) (underParent.get(i.parent.key) || underParent.set(i.parent.key, []).get(i.parent.key)).push(i);
  }
  const epicTasks = (key) => countable(underEpic.get(key) || [], state.issues);

  // Epic buckets; an Epic that is itself in the list becomes its bucket's header.
  // An Epic that is not (e.g. assigned to someone else) is still the header, from the stub on its tasks.
  const buckets = new Map();
  for (const i of list) {
    const ek = isEpicIssue(i) ? i.key : i.epic?.key || null;
    if (!buckets.has(ek)) buckets.set(ek, { epic: ek && (byKey.get(ek) || i.epic || { key: ek, summary: '' }), items: [] });
    if (!(isEpicIssue(i) && ek === i.key)) buckets.get(ek).items.push(i);
  }

  // Inside a bucket: sub-tasks grouped under their parent; items hanging straight off the epic stay loose.
  const groupBucket = (items, epicKey) => {
    const groups = new Map();
    // A parent that is not in the list (someone else's Story) is still the group header, from the stub.
    const hasGroup = (i) => i.parent && i.parent.key !== epicKey;
    for (const i of items) {
      if (!hasGroup(i)) continue;
      if (!groups.has(i.parent.key)) groups.set(i.parent.key, { parent: byKey.get(i.parent.key) || i.parent, items: [] });
      groups.get(i.parent.key).items.push(i);
    }
    // A parent that is itself one of my issues is shown as its group's header.
    const loose = items.filter((i) => !hasGroup(i) && !groups.has(i.key)).sort(byUrgency);
    for (const g of groups.values()) g.items.sort(byUrgency);
    return { groups: [...groups.values()].sort(byGroupUrgency), loose };
  };

  // loose: a task with no group row of its own, next to Stories that have one (it lines up with their badge).
  const row = (i, child, deep, loose) => {
    const u = urgency(i);
    const isDone = i.status.category === 'done';
    const moved = heldMove(i.key);
    // The outline flash plays once per move: render() rebuilds every row, which would restart it each time.
    const flash = moved && !moved.flashed;
    if (flash) moved.flashed = true;
    const stale = staleDays(i);
    const picked = state.selected.has(i.key);
    return h(
      'div',
      {
        class: `row lvl-${u.level || 'none'}${child ? ' child' : ''}${deep ? ' deep' : ''}${loose ? ' loose' : ''}${i.pending ? ' pending' : ''}${isDone ? ' done' : ''}${moved ? ' moved' : ''}${flash ? ' moved-flash' : ''}${picked ? ' picked' : ''}`,
        'data-key': i.key,
        'data-nav': 'row:' + i.key,
        // While selecting, a click anywhere on the row ticks it (the key link still opens the detail).
        onClick: (e) => {
          if (e.target.closest('a,button,input')) return;
          if (state.selectMode) e.currentTarget.querySelector('input.sel')?.click();
          else openDetail(i.key);
        },
      },
      h('div', { class: 'c-key' }, selectBox([i.key], `Select ${i.key}`), typeBadge(i.type.name), keyLink(i)),
      h(
        'div',
        { class: 'c-sum' },
        h('span', { class: 'sum-text', title: i.summary }, i.summary),
        moved && h('span', { class: 'moved-chip', title: 'Status just changed' }, `${moved.from.name} → ${i.status.name}`),
        u.reasons.length ? reasonChips(i) : dueBadge(i),
      ),
      h('div', { class: 'c-status' }, statusButton(i)),
      h('div', { class: 'c-prio' }, prio(i.priority), ' ', i.priority || ''),
      h('div', { class: 'c-docs' }, docBadges(i)),
      h(
        'div',
        { class: `c-upd small${stale ? (stale >= 7 ? ' stale very' : ' stale') : ' muted'}`, title: stale ? `${fmtDate(i.updated)} — no change for ${stale} days while in ${i.status.name}` : fmtDate(i.updated) },
        rel(i.updated),
      ),
      h('div', { class: 'c-act' }, claudeButton(i)),
    );
  };

  // Groups whose subtasks are all finished (Done or Cancelled) start collapsed; everything else starts expanded.
  // A just-moved task counts with its previous status, so its group does not fold away under the user.
  // An override (the user's click) flips whatever the auto default would be.
  const isClosed = (parent, items) => {
    const allDone = items.every((i) => placedStatus(i).category === 'done');
    return state.closedGroups.has(parent.key) ? !allDone : allDone;
  };
  const foldToggle = (key) => () => {
    state.closedGroups.has(key) ? state.closedGroups.delete(key) : state.closedGroups.add(key);
    LS.set('groupFold', [...state.closedGroups]);
    render();
  };

  const groupRow = (parent, items, nested) => {
    const mine = parent.url ? parent : null; // full issue DTO when the parent is also assigned to me
    const closed = isClosed(parent, items);
    const toggle = foldToggle(parent.key);
    const children = underParent.get(parent.key) || items;

    const typeCounts = new Map();
    for (const i of children) {
      const n = i.type.name.toLowerCase();
      const c = n.includes('task') ? 'task' : n.includes('bug') ? 'bug' : n.includes('story') ? 'story' : 'other';
      typeCounts.set(c, (typeCounts.get(c) || 0) + 1);
    }
    const plural = { task: 'tasks', bug: 'bugs', story: 'stories', other: 'other' };
    const parts = [...typeCounts].map(([c, n]) => `${n} ${n > 1 ? plural[c] : c}`);
    const lastUpd = Math.max(...[...children, mine].filter(Boolean).map((i) => Date.parse(i.updated) || 0));

    // Same flow as a regular item's Claude button: the Start dialog (task_brief/MCP builds the context
    // server-side) for a Task/Story parent, or straight to Cursor for an Epic parent. Only an Epic parent that's a
    // stub (no url/docs) can't safely use the "open straight in Cursor" path, so it keeps the combined-text fallback.
    const isEpicParent = /epic/i.test(parent.type?.name || parent.type || '');
    const claudeGroupButton =
      mine || !isEpicParent
        ? claudeButton(mine || parent)
        : h(
            'button',
            {
              class: 'icon-btn sm claude-btn',
              title: `Open ${parent.key} + ${items.length} subtasks in Claude Code`,
              'aria-label': `Open group ${parent.key} in Claude Code`,
              onClick: (e) => {
                e.stopPropagation();
                startWithClaude(parent);
              },
            },
            icon('ai'),
          );

    return h(
      'div',
      {
        class: `group${closed ? ' closed' : ''}${nested ? ' nested' : ''}`,
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(!closed),
        'data-nav': 'group:' + parent.key,
        title: closed ? 'Expand' : 'Collapse',
        onClick: (e) => !e.target.closest('a,button,input') && toggle(),
        onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), toggle()),
      },
      h(
        'div',
        { class: 'c-key' },
        h('span', { class: 'fold-icon' }, icon('chevRight')),
        selectBox(items.map((i) => i.key), `Select the tasks of ${parent.key}`),
        typeBadge(parent.type?.name || parent.type),
        mine ? keyLink(mine) : h('a', { class: 'key', href: '#' + parent.key, title: 'Open detail', onClick: (e) => (e.preventDefault(), openDetail(parent.key)) }, parent.key),
      ),
      h(
        'div',
        { class: 'c-sum', title: parts.join(', ') },
        h('span', { class: 'group-title', title: parent.summary }, parent.summary),
        miniProgress(children, parts.length === 1 ? plural[[...typeCounts.keys()][0]] : 'tasks'),
      ),
      h('div', { class: 'c-status' }, statusButton(mine || parent)),
      h('div', { class: 'c-prio' }, mine?.priority && [prio(mine.priority), ' ', mine.priority]),
      h('div', { class: 'c-docs' }, mine && docBadges(mine)),
      h('div', { class: 'c-upd muted small', title: lastUpd ? `Last change in this story: ${fmtDate(new Date(lastUpd).toISOString())}` : null }, lastUpd ? rel(new Date(lastUpd).toISOString()) : ''),
      h('div', { class: 'c-act' }, claudeGroupButton),
    );
  };

  const out = h(
    'div',
    { class: `list${state.selectMode ? ' selecting' : ''}` },
    h('div', { class: 'list-head' }, ['Key', 'Summary', 'Status', 'Priority', 'Docs', 'Updated', ''].map((t, idx) => h('div', { class: idx === 3 ? 'h-prio' : null }, t))),
  );
  const appendBucket = (items, epicKey, nested) => {
    const { groups, loose } = groupBucket(items, epicKey);
    for (const g of groups) {
      out.append(groupRow(g.parent, g.items, nested));
      if (!isClosed(g.parent, g.items)) out.append(...g.items.map((i) => row(i, true, nested)));
    }
    out.append(...loose.map((i) => row(i, nested, false, groups.length > 0 || nested)));
  };
  const appendEpic = (b) => {
    const tasks = epicTasks(b.epic.key);
    const foldKey = 'epic:' + b.epic.key;
    const closed = isClosed({ key: foldKey }, b.items.length ? b.items : [b.epic]);
    out.append(epicRow(b.epic, b.items, tasks, closed, foldToggle(foldKey)));
    if (!closed) appendBucket(b.items, b.epic.key, true);
  };

  // Epics with work left first, the most left on top; an epic whose tasks are all QA done goes into one folded
  // "completed" row at the end, so finished work does not push the open work down.
  const left = (b) => epicTasks(b.epic.key).filter((i) => !isDevDone(placedStatus(i))).length;
  const finished = (b) => {
    const t = epicTasks(b.epic.key);
    return t.length > 0 && t.every((i) => stageOf(placedStatus(i)) === 'done');
  };
  const epics = [...buckets.entries()].filter(([k]) => k).map(([, b]) => b);
  const openEpics = epics.filter((b) => !finished(b)).sort((a, b) => left(b) - left(a) || byGroupUrgency(a, b));
  const doneEpics = epics.filter(finished).sort(byGroupUrgency);
  openEpics.forEach(appendEpic);
  if (doneEpics.length) {
    const shown = LS.get('doneEpicsOpen', false);
    const toggle = () => (LS.set('doneEpicsOpen', !shown), render());
    out.append(
      h(
        'div',
        {
          class: `group done-epics${shown ? '' : ' closed'}`,
          role: 'button',
          tabindex: '0',
          'aria-expanded': String(shown),
          'data-nav': 'done-epics',
          onClick: toggle,
          onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), toggle()),
        },
        h('div', { class: 'c-key' }, h('span', { class: 'fold-icon' }, icon('chevRight')), icon('check')),
        h(
          'div',
          { class: 'c-sum' },
          h('span', { class: 'group-title' }, `${doneEpics.length} completed epic${doneEpics.length > 1 ? 's' : ''}`),
          h('span', { class: 'muted small nowrap' }, doneEpics.map((b) => b.epic.key).join(', ')),
        ),
      ),
    );
    if (shown) doneEpics.forEach(appendEpic);
  }
  const noEpic = buckets.get(null);
  if (noEpic?.items.length) {
    if (epics.length) out.append(h('div', { class: 'group plain epic-none' }, h('span', { class: 'muted' }, 'No epic')));
    appendBucket(noEpic.items, null, false);
  }
  return out;
}

// Epic header: folds everything under it; shows progress (dev done, as the progress strip).
// items: its rows shown; tasks: all its tasks of the sprint (countable), whatever the filters.
function epicRow(epic, items, tasks, closed, toggle) {
  const mine = epic.url ? epic : null;
  return h(
    'div',
    {
      class: `group epic-row${closed ? ' closed' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(!closed),
      'data-nav': 'epic:' + epic.key,
      title: closed ? 'Expand' : 'Collapse',
      onClick: (e) => !e.target.closest('a,button,input') && toggle(),
      onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), toggle()),
    },
    h(
      'div',
      { class: 'c-key' },
      h('span', { class: 'fold-icon' }, icon('chevRight')),
      selectBox(items.map((i) => i.key), `Select the tasks of ${epic.key}`),
      typeBadge('Epic'),
      h('a', { class: 'key', href: '#' + epic.key, title: 'Open detail', onClick: (e) => (e.preventDefault(), openDetail(epic.key)) }, epic.key),
    ),
    h(
      'div',
      { class: 'c-sum' },
      h('span', { class: 'group-title', title: epic.summary }, epic.summary || 'Epic'),
      miniProgress(tasks),
    ),
    h('div', { class: 'c-status' }, statusButton(mine || epic)),
    h('div', { class: 'c-prio' }),
    h('div', { class: 'c-docs' }),
    h('div', { class: 'c-upd' }),
    h('div', { class: 'c-act' }),
  );
}

// Above the list when looking at someone else's tasks: whose, and the way back.
function viewingBanner() {
  if (!state.user) return null;
  return h(
    'div',
    { class: 'viewing-banner', role: 'status' },
    h('span', null, 'Viewing the tasks of ', h('b', null, viewedUserName())),
    h(
      'button',
      {
        class: 'btn sm',
        onClick: () => {
          state.user = '';
          LS.set('user', '');
          const sel = $('#user-filter');
          if (sel) sel.value = '';
          window.onUserFilterChange?.();
        },
      },
      'Back to my tasks',
    ),
  );
}
