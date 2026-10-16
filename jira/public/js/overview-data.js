'use strict';

// Overview numbers: pure functions of the loaded issues (no DOM), so test/overview.test.js can run them in a vm.
// Needs format.js (tone, statusList, urgency, fmtDay) and progress.js (isCancelled, isEpicType, isSprintTask).

const OverviewData = (() => {
  const DAY = 86400000;
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const daysBetween = (a, b) => Math.round((startOf(b) - startOf(a)) / DAY);
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sp = (i) => i.storyPoints || 0;
  const sumSP = (list) => list.reduce((sum, i) => sum + sp(i), 0);
  const isOpen = (i) => i.status.category !== 'done';
  const isDone = (i) => i.status.category === 'done' && !isCancelled(i);
  const doneAt = (i) => new Date(i.resolved || i.updated);
  const dueIn = (i, now) => (i.due ? daysBetween(now, new Date(i.due + 'T00:00:00')) : null);
  const idleDays = (i, now) => daysBetween(new Date(i.updated), now);

  // Tasks the numbers are about: no Epics (only group headers), no cancelled ones, only the chosen sprint.
  const scope = (issues, sprintId) => issues.filter((i) => !isEpicType(i) && !isCancelled(i) && isSprintTask(i, sprintId));

  // Every sprint an issue has been in (issues cached before sprintIds existed only know their current one).
  const sprintIdsOf = (i) => i.sprintIds || (i.sprint ? [i.sprint.id] : []);
  const isBug = (i) => /bug/i.test(i.type.name);

  // Everything that was ever in the sprint, cancelled work included (the bug card counts it).
  const members = (issues, sprintId) => issues.filter((i) => !isEpicType(i) && sprintIdsOf(i).includes(Number(sprintId)));

  // The tasks one sprint is about, from /api/sprint. A closed sprint is read as it stood when it closed: work
  // finished later was carried over, so it counts as not done there.
  function sprintView(issues, sprint) {
    const list = planned(members(issues, sprint.id).filter((i) => !isCancelled(i)), sprint);
    const closedAt = sprint.state === 'closed' && (sprint.completeDate || sprint.endDate);
    if (!closedAt) return list;
    return list.map((i) => (isDone(i) && doneAt(i) > new Date(closedAt) ? { ...i, status: { ...i.status, category: 'indeterminate' }, carriedOver: true } : i));
  }

  // Bugs of the sprint on their own: they carry no story points, so the SP numbers never show them.
  function bugStats(all, list, sprint) {
    const bugs = list.filter(isBug);
    const start = sprint?.startDate ? new Date(sprint.startDate) : null;
    return {
      total: bugs.length,
      open: bugs.filter(isOpen).length,
      fixed: bugs.filter(isDone).length,
      cancelled: all.filter((i) => isBug(i) && isCancelled(i)).length,
      reported: start ? bugs.filter((i) => new Date(i.created) >= start).length : null,
    };
  }

  function pickSprint(issues, sprintId) {
    const all = issues.flatMap((i) => (i.sprint ? [i.sprint] : []));
    return sprintId ? all.find((s) => s.id === Number(sprintId)) || null : all.find((s) => s.state === 'active') || null;
  }

  function kpis(list, now) {
    const open = list.filter(isOpen);
    const done = list.filter(isDone);
    const due = open.filter((i) => dueIn(i, now) !== null);
    return {
      total: list.length,
      open: open.length,
      done: done.length,
      sp: { done: sumSP(done), total: sumSP(list) },
      overdue: due.filter((i) => dueIn(i, now) < 0).length,
      dueSoon: due.filter((i) => dueIn(i, now) >= 0 && dueIn(i, now) <= 3).length,
      doneWeek: done.filter((i) => daysBetween(doneAt(i), now) <= 6).length,
    };
  }

  function byEpic(list) {
    const rows = new Map();
    for (const i of list) {
      if (!i.epic) continue;
      const r = rows.get(i.epic.key) || { key: i.epic.key, name: i.epic.summary, total: 0, done: 0, spTotal: 0, spDone: 0 };
      r.total++;
      r.spTotal += sp(i);
      if (isDone(i)) (r.done++, (r.spDone += sp(i)));
      rows.set(i.epic.key, r);
    }
    return [...rows.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  }

  // Work finished before the sprint began was never part of its plan (a sub-task done last sprint still carries this
  // one when its Story was carried over): leave it out, or the sprint is credited with the last one's work.
  function planned(list, sprint) {
    if (!sprint?.startDate) return list;
    const start = startOf(new Date(sprint.startDate));
    return list.filter((i) => !(isDone(i) && daysBetween(start, startOf(doneAt(i))) < 0));
  }

  function burndown(all, sprint, now) {
    if (!sprint?.startDate || !sprint?.endDate) return null;
    const start = startOf(new Date(sprint.startDate));
    const end = startOf(new Date(sprint.endDate));
    const length = daysBetween(start, end);
    if (length < 1) return null;
    const list = planned(all, sprint);
    const useSP = sumSP(list) > 0;
    const weight = (i) => (useSP ? sp(i) : 1);
    const total = list.reduce((sum, i) => sum + weight(i), 0);
    const done = list.filter(isDone);
    const today = Math.min(daysBetween(start, now), length);
    const points = [];
    for (let d = 0; d <= length; d++) {
      const day = addDays(start, d);
      const burned = done.filter((i) => daysBetween(startOf(doneAt(i)), day) >= 0).reduce((sum, i) => sum + weight(i), 0);
      points.push({ date: isoDay(day), ideal: total * (1 - d / length), actual: d <= today ? Math.max(0, total - burned) : null });
    }
    return { unit: useSP ? 'SP' : 'tasks', total, length, today, points };
  }

  // How far the sprint (or the whole scope) is: work split by status category, in SP when anything is estimated.
  function progress(list, sprint, now) {
    const useSP = sumSP(list) > 0;
    const weight = (i) => (useSP ? sp(i) : 1);
    const sum = (cat) => list.filter((i) => i.status.category === cat && (cat !== 'done' || isDone(i))).reduce((n, i) => n + weight(i), 0);
    const end = sprint?.endDate ? startOf(new Date(sprint.endDate)) : null;
    return {
      unit: useSP ? 'SP' : 'tasks',
      done: sum('done'),
      prog: sum('indeterminate'),
      todo: sum('new'),
      total: list.reduce((n, i) => n + weight(i), 0),
      daysLeft: end ? Math.max(0, daysBetween(now, end)) : null,
      // Open work that weighs nothing in SP: the bar can read 100% while these are still left.
      unestimated: useSP ? list.filter((i) => isOpen(i) && !sp(i)).length : 0,
    };
  }

  // Where the burndown stands today: what is left against the ideal line, and the pace needed to finish on time.
  function pace(b) {
    if (!b || b.today < 0) return null;
    const p = b.points[b.today];
    const daysLeft = b.length - b.today;
    return { left: p.actual, ideal: Math.round(p.ideal * 10) / 10, behind: Math.round((p.actual - p.ideal) * 10) / 10, perDay: daysLeft > 0 ? Math.round((p.actual / daysLeft) * 10) / 10 : null };
  }

  // One verdict for the sprint strip. Work without story points weighs nothing on the burndown, so "done" there
  // only means the estimated part is done while any of it is still open.
  function paceStatus(sprint, pace, prog) {
    const n = prog.unestimated;
    const rest = n ? ` · ${n} open ${n === 1 ? 'task' : 'tasks'} without SP` : '';
    if (sprint?.state === 'closed') {
      const left = Math.round((prog.total - prog.done) * 10) / 10;
      const parts = [left > 0 && `${left} ${prog.unit}`, n && `${n} ${n === 1 ? 'task' : 'tasks'} without SP`].filter(Boolean);
      return parts.length ? { tone: 'warn', text: `Closed with ${parts.join(' and ')} not done` } : { tone: 'ok', text: 'Closed, all done' };
    }
    if (!pace) return n ? { tone: 'warn', text: rest.slice(3) } : null;
    if (!pace.left) return { tone: n ? 'warn' : 'ok', text: n ? `Estimated work done${rest}` : 'All planned work is done' };
    if (pace.behind > 0) return { tone: 'warn', text: `Behind plan by ${pace.behind} ${prog.unit}${rest}` };
    if (pace.behind < 0) return { tone: n ? 'warn' : 'ok', text: `Ahead of plan by ${-pace.behind} ${prog.unit}${rest}` };
    return { tone: n ? 'warn' : 'ok', text: `On track${rest}` };
  }

  // What needs attention, each open task in at most one group: overdue, due within 3 days, then idle for over a week.
  function lists(list, now) {
    const open = list.filter(isOpen);
    const byDue = (a, b) => dueIn(a, now) - dueIn(b, now) || Date.parse(b.updated) - Date.parse(a.updated);
    const overdue = open.filter((i) => dueIn(i, now) !== null && dueIn(i, now) < 0).sort(byDue);
    const dueSoon = open.filter((i) => dueIn(i, now) !== null && dueIn(i, now) >= 0 && dueIn(i, now) <= 3).sort(byDue);
    const urgent = new Set([...overdue, ...dueSoon]);
    return {
      overdue,
      dueSoon,
      stale: open.filter((i) => !urgent.has(i) && idleDays(i, now) > 7).sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated)),
      // Bugs are not estimated (the bug card counts them), so they are never "not planned".
      unplanned: open.filter((i) => !isBug(i) && (!i.storyPoints || !i.sprint)),
      carriedOver: list.filter((i) => i.carriedOver),
    };
  }

  // ---- Trends: one slot per day / week / month / year, from /api/history (a longer window than the task list).

  const PERIODS = {
    day: { slots: 30, days: 30, start: (d) => startOf(d), next: (d) => addDays(d, 1), label: (d) => `${d.getDate()}/${d.getMonth() + 1}` },
    week: { slots: 12, days: 84, start: (d) => addDays(startOf(d), -((d.getDay() + 6) % 7)), next: (d) => addDays(d, 7), label: (d) => `${d.getDate()}/${d.getMonth() + 1}` },
    month: { slots: 12, days: 366, start: (d) => new Date(d.getFullYear(), d.getMonth(), 1), next: (d) => new Date(d.getFullYear(), d.getMonth() + 1, 1), label: (d) => `${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}` },
    year: { slots: 5, days: 1830, start: (d) => new Date(d.getFullYear(), 0, 1), next: (d) => new Date(d.getFullYear() + 1, 0, 1), label: (d) => String(d.getFullYear()) },
  };
  const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
  const leadDays = (i) => Math.max(0, daysBetween(new Date(i.created), doneAt(i)));

  function trend(items, period, now) {
    const P = PERIODS[period];
    const tasks = items.filter((i) => !isEpicType(i));
    let start = P.start(now);
    const starts = [start];
    for (let k = 1; k < P.slots; k++) starts.unshift((start = P.start(addDays(start, -1))));
    return starts.map((s) => {
      const e = P.next(s);
      const until = e > now ? now : e;
      const inSlot = (d) => d >= s && d < e;
      const done = tasks.filter((i) => isDone(i) && inSlot(doneAt(i)));
      const withDue = done.filter((i) => i.due);
      const lead = done.map(leadDays).sort((a, b) => a - b);
      const pctOf = (n, of) => (of ? Math.round((n / of) * 100) : null);
      return {
        start: isoDay(s),
        label: P.label(s),
        partial: e > now,
        created: tasks.filter((i) => inSlot(new Date(i.created))).length,
        done: done.length,
        // Delivered work in story points: only tasks carry them, bugs are counted apart below.
        spDone: sumSP(done.filter((i) => !isBug(i))),
        tasksDone: done.filter((i) => !isBug(i)).length,
        bugsNew: tasks.filter((i) => isBug(i) && inSlot(new Date(i.created))).length,
        bugsDone: done.filter(isBug).length,
        // Open at the end of the slot (or now, for the current one): created by then and not yet resolved.
        backlog: tasks.filter((i) => new Date(i.created) < until && !(i.status.category === 'done' && doneAt(i) < until)).length,
        leadMedian: quantile(lead, 0.5),
        leadP85: quantile(lead, 0.85),
        onTime: pctOf(withDue.filter((i) => daysBetween(doneAt(i), new Date(i.due + 'T00:00:00')) >= 0).length, withDue.length),
        bugShare: pctOf(done.filter(isBug).length, done.length),
        withDue: withDue.length,
      };
    });
  }

  // One trend tile: the latest finished period (or now, for a running total like open work) against the average
  // of the periods before it.
  function metricSummary(slots, key, { current = false } = {}) {
    // Periods before there was any work at all would drag the average to zero: leave them out.
    const first = slots.findIndex((r) => r.created || r.done || r.backlog);
    const rows = slots.slice(Math.max(0, first)).filter((r) => current || !r.partial);
    let k = rows.length - 1;
    while (k >= 0 && rows[k][key] == null) k--;
    if (k < 0) return null;
    const before = rows.slice(0, k).map((r) => r[key]).filter((v) => v != null);
    const avg = before.length ? Math.round((before.reduce((a, b) => a + b, 0) / before.length) * 10) / 10 : null;
    return { value: rows[k][key], label: rows[k].label, avg, delta: avg == null ? null : Math.round((rows[k][key] - avg) * 10) / 10 };
  }

  // Rule-based advice from the trend and today's open work. Each tip carries the numbers behind it.
  function insights(slots, list, now, periodName) {
    const tips = [];
    const add = (level, title, detail, action) => tips.push({ level, title, detail, action });
    const sum = (key, rows = slots) => rows.reduce((n, r) => n + (r[key] || 0), 0);
    const avgOf = (key, rows) => {
      const vals = rows.map((r) => r[key]).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const full = slots.filter((r) => !r.partial);
    const half = Math.floor(full.length / 2);
    const earlier = full.slice(0, half);
    const recent = full.slice(half);
    const change = (key) => {
      const a = avgOf(key, earlier);
      const b = avgOf(key, recent);
      return a == null || b == null ? null : { from: Math.round(a * 10) / 10, to: Math.round(b * 10) / 10 };
    };
    const span = `the last ${slots.length} ${periodName}s`;

    const created = sum('created');
    const done = sum('done');
    const backlogFrom = slots[0].backlog;
    const backlogTo = slots[slots.length - 1].backlog;
    if (created > done * 1.1 && backlogTo > backlogFrom)
      add('bad', 'Backlog is growing', `${created} tasks came in, ${done} were finished over ${span}; open work went from ${backlogFrom} to ${backlogTo}.`, 'Finish before starting: take on less new work, and split big tasks so they close sooner.');
    else if (done >= created && done > 0) add('good', 'Finishing faster than work comes in', `${done} done vs ${created} new over ${span}; open work ${backlogFrom} → ${backlogTo}.`);

    const lead = change('leadMedian');
    if (lead && lead.to > lead.from * 1.2 && lead.to - lead.from >= 1)
      add('warn', 'Tasks take longer to finish', `Median lead time rose from ${lead.from}d to ${lead.to}d (earlier vs recent ${periodName}s).`, 'Look at what waits longest (review, QA, blocked) and split tasks bigger than ~3 days.');
    else if (lead && lead.to < lead.from * 0.8) add('good', 'Tasks finish faster', `Median lead time fell from ${lead.from}d to ${lead.to}d.`);

    const withDue = sum('withDue');
    const onTimeAll = withDue ? Math.round(slots.reduce((n, r) => n + ((r.onTime || 0) * r.withDue) / 100, 0) / withDue * 100) : null;
    if (onTimeAll != null && onTimeAll < 80)
      add(onTimeAll < 60 ? 'bad' : 'warn', 'Due dates are missed', `${onTimeAll}% of tasks with a due date were done on time over ${span}.`, 'Re-estimate when a task grows, and move the due date (or flag it) as soon as it is at risk, not after.');
    else if (onTimeAll != null && withDue >= 5) add('good', 'Due dates are kept', `${onTimeAll}% on time over ${span}.`);
    if (done >= 5 && withDue / done < 0.5) add('warn', 'Most finished tasks had no due date', `${done - withDue} of ${done} done tasks had none, so on-time delivery can't be judged.`, 'Set a due date when a task enters the sprint.');

    const bugs = done ? Math.round((slots.reduce((n, r) => n + ((r.bugShare || 0) * r.done) / 100, 0) / done) * 100) : 0;
    const bugTrend = change('bugShare');
    if (done >= 5 && bugs > 20)
      add('warn', 'A lot of the work is fixing bugs', `${bugs}% of finished tasks were bugs over ${span}${bugTrend ? ` (${bugTrend.from}% → ${bugTrend.to}%)` : ''}.`, 'Add tests for the areas that keep breaking, and check the acceptance criteria before a task moves to review.');

    const velocity = change(sum('spDone') ? 'spDone' : 'tasksDone');
    const unit = sum('spDone') ? 'SP' : 'tasks';
    if (velocity && velocity.to < velocity.from * 0.8)
      add('warn', 'Less work delivered', `Delivered ${unit} per ${periodName} fell from ${velocity.from} to ${velocity.to} (earlier vs recent ${periodName}s).`, 'Check what pulled time away: bug fixing, unplanned requests, or tasks too big to finish in one sprint.');
    else if (velocity && velocity.to > velocity.from * 1.2) add('good', 'More work delivered', `Delivered ${unit} per ${periodName} rose from ${velocity.from} to ${velocity.to}.`);

    const bugsIn = sum('bugsNew');
    const bugsOut = sum('bugsDone');
    if (bugsIn > bugsOut && bugsIn >= 3)
      add('bad', 'Bugs pile up', `${bugsIn} bugs were reported and ${bugsOut} fixed over ${span}.`, 'Reserve part of each sprint for bugs, and fix the most-hit areas first.');
    else if (bugsOut >= bugsIn && bugsOut > 0) add('good', 'Bugs are fixed as fast as they come in', `${bugsOut} fixed vs ${bugsIn} reported over ${span}.`);

    const open = list.filter(isOpen);
    const doing = open.filter((i) => i.status.category === 'indeterminate').length;
    if (doing > 3) add('warn', 'Too much in progress at once', `${doing} tasks are in progress right now.`, 'Cap work in progress at 2–3: finish or park the rest so each one moves faster.');
    const stale = open.filter((i) => idleDays(i, now) > 7).length;
    if (stale) add('warn', 'Tasks are stuck', `${stale} open tasks have not been updated in over 7 days.`, 'Close, re-plan or unblock them in the next stand-up.');

    const order = { bad: 0, warn: 1, good: 2 };
    return tips.sort((a, b) => order[a.level] - order[b.level]);
  }

  return { scope, planned, members, sprintView, bugStats, pickSprint, kpis, byEpic, burndown, progress, pace, paceStatus, lists, PERIODS, trend, metricSummary, insights, isOpen, isDone, doneAt, dueIn, idleDays, sumSP, sp, startOf, addDays, daysBetween, isoDay, DAY };
})();
