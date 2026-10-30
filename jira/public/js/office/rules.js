'use strict';

// 3D office (office-scene.html): where each person stands, from their sprint tasks. Pure functions of the data (no DOM),
// so test/office.test.js can run them in a vm. Loaded first; the other office scripts build on these globals.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const STATUS = { todo: 'To Do', prog: 'In Progress', review: 'In Review', done: 'Done' };
const PRIORITY = { highest: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };
const ROLES = { dev: 'Dev', qa: 'QA' };

// What a person is doing: drives colours, filters and grouping. `urgent` = an open Highest-priority task or bug.
const STATES = {
  urgent: { name: 'Urgent', sub: 'Highest-priority task or bug', short: 'Urgent', color: 'overdue' },
  review: { name: 'In review', sub: 'Waiting for review', short: 'Review', color: 'review' },
  desk: { name: 'Working', sub: 'In Progress', short: 'Working', color: 'prog' },
  todo: { name: 'Not started', sub: 'Only To Do left', short: 'To Do', color: 'todo' },
  done: { name: 'All done', sub: 'Nothing left open', short: 'Done', color: 'done' },
};
const SORDER = ['urgent', 'review', 'desk', 'todo', 'done'];

// Where people stand. Floor plan x -21..21, z -13..13; corridor along z=0. Doors list the inner point first.
const ZONES = {
  urgent: { name: 'War room', sub: 'Highest priority', color: 'overdue', rect: [-21, -7, -13, -2], doors: [[-14, -1.2]], wander: [-16.2, -11.8, -9, -5] },
  dev: { name: 'Dev room', sub: 'Devs at work', color: 'prog', rect: [-7, 11, -13, -2], doors: [[2, -3], [2, -1.2]], wander: [-5, 9, -3.5, -2.8] },
  review: { name: 'Meeting room', sub: 'In review', color: 'review', rect: [11, 21, -13, -2], doors: [[16, -3], [16, -1.2]], wander: [19.3, 20.4, -11.5, -3.5] },
  todo: { name: 'Planning board', sub: 'Only To Do left', color: 'todo', rect: [-21, -7, 2, 13], doors: [[-14, 1.2]], wander: [-17.5, -10.5, 4, 10], face: -Math.PI / 2 },
  qa: { name: 'QA room', sub: 'QA testing', color: 'prog', rect: [-7, 11, 2, 13], doors: [[2, 3], [2, 1.2]], wander: [-5, 9, 2.8, 3.5] },
  done: { name: 'Pantry', sub: 'All done', color: 'done', rect: [11, 21, 2, 13], doors: [[16, 1.2]], wander: [13, 17.5, 3, 8] },
};
const TABLE = { x: 16, z: -7.5 }; // meeting table; its seats are built in world.js

// ---- From /api/team-sprint to the office's model ----
const DAY = 86_400_000;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// In-progress statuses that mean "waiting for someone else to look at it" (In Review, Ready for Test, In Testing,
// Ready for Production…). "Selftest" is the developer still testing their own work: that is in progress.
const REVIEW_RE = /review|\bqa\b|verif|uat|(in|ready for)\s+test|ready for prod/i;

function toTask(t, now = new Date()) {
  const cat = t.status?.category;
  const name = t.status?.name || '';
  const p = t.priority || '';
  return {
    k: t.key,
    s: t.summary || '',
    st: cat === 'done' ? 'done' : cat === 'new' ? 'todo' : REVIEW_RE.test(name) ? 'review' : 'prog',
    statusName: name,
    sp: t.storyPoints || 0,
    due: t.due ? Math.round((dayStart(new Date(`${t.due}T00:00:00`)) - dayStart(now)) / DAY) : null,
    idle: t.updated ? Math.max(0, Math.floor((now - new Date(t.updated)) / DAY)) : 0,
    pr: /highest|blocker|critical/i.test(p) ? 'highest' : /high|major/i.test(p) ? 'high' : /low|minor|trivial/i.test(p) ? 'low' : 'medium',
    type: /bug/i.test(t.type || '') ? 'bug' : 'task',
  };
}
const toPeople = (members, now = new Date()) =>
  members.map((m) => ({ id: m.accountId, name: m.name, me: !!m.me, role: m.role === 'qa' ? 'qa' : 'dev', tasks: m.tasks.map((t) => toTask(t, now)) }));

// ---- Rules ----
const isLate = (t) => t.st !== 'done' && t.due !== null && t.due < 0;
const isOpen = (t) => t.st !== 'done';
function stateOf(u) {
  const open = u.tasks.filter(isOpen);
  if (open.some((t) => t.pr === 'highest')) return 'urgent';
  if (open.some((t) => t.st === 'review')) return 'review';
  if (open.some((t) => t.st === 'prog')) return 'desk';
  return open.length ? 'todo' : 'done';
}
// The room for a state: people at work sit in their role's room.
const zoneOf = (u) => { const s = stateOf(u); return s === 'desk' ? (u.role === 'qa' ? 'qa' : 'dev') : s; };
const placeName = (u) => ZONES[zoneOf(u)].name;
const isIdle = (u) => u.tasks.some((t) => t.st === 'prog' && t.idle >= 3);
const spOf = (u) => ({ done: u.tasks.filter((t) => t.st === 'done').reduce((s, t) => s + t.sp, 0), total: u.tasks.reduce((s, t) => s + t.sp, 0) });
const RANK = { review: 1, prog: 2, todo: 3, done: 4 };
const sortTasks = (tasks) => [...tasks].sort((a, b) => (b.pr === 'highest' && isOpen(b)) - (a.pr === 'highest' && isOpen(a)) || RANK[a.st] - RANK[b.st] || isLate(b) - isLate(a));
const currentTask = (u) => sortTasks(u.tasks).find(isOpen) || null;
const fullName = (u) => (u.me ? `${u.name} (you)` : u.name);
// Jira display names often carry a team suffix ("Nguyễn Văn Huy - (huyn…)", "Cù Huy Toàn (VSF-…)"): drop it.
const baseName = (name) => name.split(/\s+-\s+|\s*\(/)[0].trim() || name;
const short = (u) => (u.me ? 'You' : baseName(u.name).split(' ').slice(-2).join(' '));
const dueText = (t) => (t.st === 'done' ? 'Done' : t.due === null ? 'No due date' : t.due < 0 ? `${-t.due}d overdue` : t.due === 0 ? 'Due today' : `${t.due}d left`);
function zoneAt(x, z) {
  for (const [k, Z] of Object.entries(ZONES)) { const [x0, x1, z0, z1] = Z.rect; if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return k; }
  return null;
}

// What changed between two loads of the same person: new tasks and status moves, for the scenes between rooms.
function diffTasks(before, after) {
  const old = new Map(before.map((t) => [t.k, t]));
  const out = [];
  for (const t of after) {
    const o = old.get(t.k);
    if (!o) out.push({ kind: 'new', task: t });
    else if (o.st !== t.st) out.push({ kind: 'move', task: t, was: o.st });
  }
  return out;
}
