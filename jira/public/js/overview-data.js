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

  function byCategory(list) {
    const n = (cat) => list.filter((i) => i.status.category === cat).length;
    return [
      { name: 'To Do', tone: 'new', n: n('new') },
      { name: 'In progress', tone: 'prog', n: n('indeterminate') },
      { name: 'Done', tone: 'done', n: n('done') },
    ];
  }

  function byStatus(list) {
    return statusList(list).map((s) => ({ name: s.name, tone: tone(s), n: list.filter((i) => i.status.name === s.name).length }));
  }

  const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'];
  function byPriority(list) {
    const counts = new Map();
    for (const i of list) counts.set(i.priority || 'No priority', (counts.get(i.priority || 'No priority') || 0) + 1);
    const rank = (name) => (name === 'No priority' ? 99 : PRIORITIES.indexOf(name.toLowerCase()) < 0 ? 50 : PRIORITIES.indexOf(name.toLowerCase()));
    return [...counts].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n }));
  }

  function byType(list) {
    const rows = new Map();
    for (const i of list) {
      const r = rows.get(i.type.name) || { name: i.type.name, new: 0, prog: 0, done: 0 };
      r[{ new: 'new', indeterminate: 'prog', done: 'done' }[i.status.category] || 'prog']++;
      rows.set(i.type.name, r);
    }
    return [...rows.values()].sort((a, b) => b.new + b.prog + b.done - (a.new + a.prog + a.done));
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

  function bySprint(issues) {
    const rows = new Map();
    for (const i of issues) {
      if (!i.sprint || isEpicType(i) || isCancelled(i)) continue;
      const s = i.sprint;
      const r = rows.get(s.id) || { id: s.id, name: s.name, state: s.state, start: s.startDate, total: 0, done: 0, spTotal: 0, spDone: 0 };
      r.total++;
      r.spTotal += sp(i);
      if (isDone(i)) (r.done++, (r.spDone += sp(i)));
      rows.set(s.id, r);
    }
    return [...rows.values()].sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')) || a.id - b.id);
  }

  function dueTimeline(list, now, days = 14) {
    const open = list.filter((i) => isOpen(i) && i.due);
    const slots = Array.from({ length: days }, (_, k) => ({ date: isoDay(addDays(now, k)), n: 0 }));
    let overdue = 0;
    for (const i of open) {
      const d = dueIn(i, now);
      if (d < 0) overdue++;
      else if (d < days) slots[d].n++;
    }
    return { overdue, slots };
  }

  const AGE_BUCKETS = [['0-2 days', 0, 2], ['3-7 days', 3, 7], ['8-14 days', 8, 14], ['Over 14 days', 15, Infinity]];
  function ageBuckets(list, now) {
    const open = list.filter(isOpen);
    return AGE_BUCKETS.map(([name, lo, hi]) => ({ name, n: open.filter((i) => idleDays(i, now) >= lo && idleDays(i, now) <= hi).length }));
  }

  function burndown(all, sprint, now) {
    if (!sprint?.startDate || !sprint?.endDate) return null;
    const start = startOf(new Date(sprint.startDate));
    const end = startOf(new Date(sprint.endDate));
    const length = daysBetween(start, end);
    if (length < 1) return null;
    // Work finished before the sprint began was never part of its plan: leave it out so the lines start together.
    const list = all.filter((i) => !(isDone(i) && daysBetween(start, startOf(doneAt(i))) < 0));
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

  function weeklyDone(list, now, weeks = 8) {
    const monday = (d) => addDays(startOf(d), -((startOf(d).getDay() + 6) % 7));
    const first = addDays(monday(now), -7 * (weeks - 1));
    const slots = Array.from({ length: weeks }, (_, k) => ({ date: isoDay(addDays(first, 7 * k)), n: 0, sp: 0 }));
    for (const i of list.filter(isDone)) {
      const k = Math.floor(daysBetween(first, startOf(doneAt(i))) / 7);
      if (k >= 0 && k < weeks) (slots[k].n++, (slots[k].sp += sp(i)));
    }
    return slots;
  }

  const byDueThenUrgency = (now) => (a, b) => (dueIn(a, now) ?? 9999) - (dueIn(b, now) ?? 9999) || Date.parse(b.updated) - Date.parse(a.updated);
  function lists(list, now) {
    const open = list.filter(isOpen);
    return {
      attention: open.filter((i) => dueIn(i, now) !== null && dueIn(i, now) <= 3).sort(byDueThenUrgency(now)),
      doing: open.filter((i) => i.status.category === 'indeterminate').sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated)),
      stale: open.filter((i) => idleDays(i, now) > 7).sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated)),
      unplanned: open.filter((i) => !i.storyPoints || !i.sprint).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated)),
    };
  }

  return { scope, pickSprint, kpis, byCategory, byStatus, byPriority, byType, byEpic, bySprint, dueTimeline, ageBuckets, burndown, weeklyDone, lists, isOpen, isDone, doneAt, dueIn, idleDays, sumSP, sp, startOf, addDays, daysBetween, isoDay, DAY };
})();
