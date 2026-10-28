'use strict';

// Task list pieces: filters, urgent block, status pills, and the list grouped by epic / parent.
// The page render() lives in app-tasks.js.

// Counts here must ignore state.type itself (it's the option list for that filter) but still
// respect the sprint filter, so "All types (N)" matches the sprint currently selected.
function renderTypes() {
  const bySprint = state.issues.filter((i) => isSprintTask(i, state.sprint));
  const counts = new Map();
  for (const i of bySprint) counts.set(i.type.name, (counts.get(i.type.name) || 0) + 1);
  if (state.type !== 'all' && !counts.has(state.type)) state.type = 'all';
  const select = $('#type-filter');
  select.replaceChildren(
    h('option', { value: 'all' }, `All types (${bySprint.length})`),
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => h('option', { value: name }, `${name} (${n})`)),
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
  // A pill with nothing behind it is hidden, unless it is the filter in use (so it can still be turned off).
  const pill = (label, value, toneName, pressed, onClick) =>
    (value || pressed) &&
    h(
      'button',
      { class: `pill ${toneName ? 'tone-' + toneName : ''} ${toneName === 'hot' && value ? 'hot' : ''}`, 'aria-pressed': String(pressed), onClick },
      toneName && h('span', { class: 'dot' }),
      label,
      h('b', null, value),
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

// --- list (grouped by parent; parents fold/unfold on click) ---

// Epic → Story/Task → Sub-task, the same levels as the git flow (epic branch → task branch).
function renderList(list) {
  if (!list.length) return h('div', { class: 'empty-state' }, 'No tasks match this filter.');
  const byKey = new Map(state.issues.map((i) => [i.key, i]));
  const isEpicIssue = (i) => /epic/i.test(i.type?.name || '');
  const top = (g) => Math.max(...g.items.map((i) => sortUrgency(i).score));
  const latest = (g) => Math.max(...g.items.map((i) => Date.parse(i.updated)));
  const byGroupUrgency = (a, b) => top(b) - top(a) || latest(b) - latest(a);

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

  const row = (i, child, deep) => {
    const u = urgency(i);
    const isDone = i.status.category === 'done';
    const moved = heldMove(i.key);
    // The outline flash plays once per move: render() rebuilds every row, which would restart it each time.
    const flash = moved && !moved.flashed;
    if (flash) moved.flashed = true;
    return h(
      'div',
      {
        class: `row lvl-${u.level || 'none'}${child ? ' child' : ''}${deep ? ' deep' : ''}${i.pending ? ' pending' : ''}${isDone ? ' done' : ''}${moved ? ' moved' : ''}${flash ? ' moved-flash' : ''}`,
        'data-key': i.key,
        onClick: (e) => !e.target.closest('a,button') && openDetail(i.key),
      },
      h('div', { class: 'c-key' }, typeBadge(i.type.name), keyLink(i)),
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
      h('div', { class: 'c-upd muted small', title: fmtDate(i.updated) }, rel(i.updated)),
      h('div', { class: 'c-act' }, claudeButton(i)),
    );
  };

  // Groups whose subtasks are all finished (Done or Cancelled) start collapsed; everything else starts expanded.
  const isClosed = (parent, items) => {
    // Check if all subtasks in this group are done (including cancelled)
    // A just-moved task counts with its previous status, so its group does not fold away under the user.
    const allDone = items.every((i) => (heldMove(i.key)?.from || i.status).category === 'done');
    const override = state.closedGroups.has(parent.key);
    // An override flips whatever the auto default would be.
    const result = override ? !allDone : allDone;
    return result;
  };

  const groupRow = (parent, items, nested) => {
    const mine = parent.url ? parent : null; // full issue DTO when the parent is also assigned to me
    const closed = isClosed(parent, items);
    const toggle = () => {
      // Any click flips the current state; store/remove the override accordingly
      state.closedGroups.has(parent.key) ? state.closedGroups.delete(parent.key) : state.closedGroups.add(parent.key);
      LS.set('groupFold', [...state.closedGroups]);
      render();
    };
    
    const typeCounts = new Map();
    for (const i of items) {
      const typeName = i.type.name.toLowerCase();
      let category = 'other';
      if (typeName.includes('task')) category = 'task';
      else if (typeName.includes('bug')) category = 'bug';
      else if (typeName.includes('story')) category = 'story';
      typeCounts.set(category, (typeCounts.get(category) || 0) + 1);
    }
    
    const parts = [];
    const taskCount = typeCounts.get('task') || 0;
    const bugCount = typeCounts.get('bug') || 0;
    const storyCount = typeCounts.get('story') || 0;
    const otherCount = typeCounts.get('other') || 0;
    
    if (taskCount > 0) parts.push(`${taskCount} task${taskCount > 1 ? 's' : ''}`);
    if (bugCount > 0) parts.push(`${bugCount} bug${bugCount > 1 ? 's' : ''}`);
    if (storyCount > 0) parts.push(`${storyCount} stor${storyCount > 1 ? 'ies' : 'y'}`);
    if (otherCount > 0) parts.push(`${otherCount} other`);
    
    // Same flow as a regular item's Claude button: the Start dialog (task_brief/MCP builds the context
    // server-side) for a Task/Story parent, or straight to Cursor for an Epic parent. The Start dialog only
    // needs key/summary/type, which the parent stub always has even when it's not one of my own issues —
    // only an Epic parent that's a stub (no url/docs) can't safely use the "open straight in Cursor" path,
    // so that one case keeps the plain combined-text fallback.
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
        title: closed ? 'Expand' : 'Collapse',
        onClick: (e) => !e.target.closest('a,button') && toggle(),
        onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), toggle()),
      },
      // c-key: fold icon + type badge + key
      h('div', { class: 'c-key' }, 
        h('span', { class: 'fold-icon' }, icon('chevRight')),
        typeBadge(parent.type?.name || parent.type),
        mine ? keyLink(mine) : h('a', { class: 'key', href: '#' + parent.key, title: 'Open detail', onClick: (e) => (e.preventDefault(), openDetail(parent.key)) }, parent.key)
      ),
      h('div', { class: 'c-sum' }, h('span', { class: 'group-title' }, parent.summary), h('span', { class: 'muted small nowrap' }, parts.join(', '))),
      h('div', { class: 'c-status' }, statusButton(mine || parent)),
      h('div', { class: 'c-prio' }),
      h('div', { class: 'c-docs' }),
      h('div', { class: 'c-upd' }),
      h('div', { class: 'c-act' }, claudeGroupButton),
    );
  };

  const out = h(
    'div',
    { class: 'list' },
    h('div', { class: 'list-head' }, ['Key', 'Summary', 'Status', 'Priority', 'Docs', 'Updated', ''].map((t, idx) => h('div', { class: idx === 3 ? 'h-prio' : null }, t))),
  );
  const appendBucket = (items, epicKey, nested) => {
    const { groups, loose } = groupBucket(items, epicKey);
    for (const g of groups) {
      out.append(groupRow(g.parent, g.items, nested));
      if (!isClosed(g.parent, g.items)) out.append(...g.items.map((i) => row(i, true, nested)));
    }
    out.append(...loose.map((i) => row(i, nested, false)));
  };

  const epics = [...buckets.entries()].filter(([k]) => k).map(([, b]) => b).sort(byGroupUrgency);
  for (const b of epics) {
    out.append(epicRow(b.epic, b.items, isClosed));
    if (!isClosed({ key: 'epic:' + b.epic.key }, b.items.length ? b.items : [b.epic])) appendBucket(b.items, b.epic.key, true);
  }
  const noEpic = buckets.get(null);
  if (noEpic?.items.length) {
    if (epics.length) out.append(h('div', { class: 'group plain epic-none' }, h('span', { class: 'muted' }, 'No epic')));
    appendBucket(noEpic.items, null, false);
  }
  return out;
}

// Epic header: folds everything under it; shows progress and the epic branch the tasks merge into.
function epicRow(epic, items, isClosed) {
  const mine = epic.url ? epic : null;
  const foldKey = 'epic:' + epic.key;
  const closed = isClosed({ key: foldKey }, items.length ? items : [epic]);
  const toggle = () => {
    state.closedGroups.has(foldKey) ? state.closedGroups.delete(foldKey) : state.closedGroups.add(foldKey);
    LS.set('groupFold', [...state.closedGroups]);
    render();
  };
  const counted = items.filter((i) => !isCancelled(i));
  const done = counted.filter((i) => i.status.category === 'done').length;
  return h(
    'div',
    {
      class: `group epic-row${closed ? ' closed' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(!closed),
      title: closed ? 'Expand' : 'Collapse',
      onClick: (e) => !e.target.closest('a,button') && toggle(),
      onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), toggle()),
    },
    h(
      'div',
      { class: 'c-key' },
      h('span', { class: 'fold-icon' }, icon('chevRight')),
      typeBadge('Epic'),
      h('a', { class: 'key', href: '#' + epic.key, title: 'Open detail', onClick: (e) => (e.preventDefault(), openDetail(epic.key)) }, epic.key),
    ),
    h(
      'div',
      { class: 'c-sum' },
      h('span', { class: 'group-title', title: epic.summary }, epic.summary || 'Epic'),
      h('span', { class: 'mini-prog', title: `${done} of ${counted.length} done` }, h('i', { style: `width:${counted.length ? Math.round((done / counted.length) * 100) : 0}%` })),
      h('span', { class: 'muted small nowrap' }, `${done}/${counted.length}`),
    ),
    h('div', { class: 'c-status' }, statusButton(mine || epic)),
    h('div', { class: 'c-prio' }),
    h('div', { class: 'c-docs' }),
    h('div', { class: 'c-upd' }),
    h('div', { class: 'c-act' }),
  );
}
