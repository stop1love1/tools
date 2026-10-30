'use strict';

// 3D office: the team's activity (/api/office/events: Jira changes and comments, GitLab pushes, merge requests and
// pipelines) as scenes between the people who did them, a replay of the day, and the build lamp. Loaded before app.js; everything here runs after app.js has set up (the first data load, timers).

const seenEvents = new Set();
const lastAct = new Map(); // accountId → ms of their latest event: who is really at work now
let ciState = null; // 'success' | 'failed' | null (no GitLab)
let evQueue = [], evBusy = false, replaying = null; // replaying: { list, i, timer }

const BOARD = (col) => v(-19.6, BOARD_COL_Z[col]);
const COFFEE = v(19.4, 4.9);
// At their own place and free for a walk (not in a meeting, standup or at lunch).
const atWork = (c) => !!c && !c.errand && c.group.visible && ['dev', 'qa', 'review', 'urgent', 'done'].includes(c.place);
const evCol = (to) => { const s = String(to || ''); return /done|closed|resolved|production/i.test(s) ? 'done' : REVIEW_RE.test(s) ? 'review' : /to ?do|open|backlog|new/i.test(s) ? 'todo' : 'prog'; };
const hhmm = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

// ---- Scenes: who walks to whom, what they say, cards flying between them ----
// Talk: `a` walks over to `b`, says `text`; `reply` comes back. Away / busy people just say it where they are.
function visit(a, b, text, { card, tone = '', reply = '', replyTone = 'ok' } = {}) {
  if (!a || !a.group.visible) return;
  if (!b || b === a || !b.group.visible || meeting || !atWork(a)) { say(a, text, tone); if (b && b !== a && b.group.visible && card) flow(a.pos, b.pos, card); return; }
  runErrands(a, [{ target: b, card, pose: 'talk', say: text, tone, dur: 2.6, onArrive: () => {
    a.card.visible = false; if (card) flow(a.pos, b.pos, card);
    if (reply) setTimeout(() => chars.includes(b) && say(b, reply, replyTone), 1100);
  } }]);
}
function playEvent(e) {
  const a = byId(e.actor?.id), t = byId(e.target?.id), key = e.key || '';
  if (!a) return; // someone outside the team
  if (e.kind === 'status') {
    const col = evCol(e.to), text = `${key} → ${e.to}`;
    if (t && t !== a) visit(a, t, text, { card: COL[col === 'done' ? 'done' : col === 'review' ? 'review' : col === 'todo' ? 'todo' : 'prog'], tone: col === 'done' ? 'ok' : '' });
    else if (atWork(a) && !meeting) runErrands(a, [{ to: BOARD(col), yaw: -Math.PI / 2, pose: 'board', card: COL[col === 'todo' ? 'todo' : col], say: text, tone: col === 'done' ? 'ok' : '', dur: 1.6, onArrive: () => (a.card.visible = false) }]);
    else say(a, text, col === 'done' ? 'ok' : '');
  } else if (e.kind === 'comment') {
    const m = (e.mentions || []).map(byId).find((x) => x && x !== a);
    visit(a, m || t, `💬 ${trunc(e.text || key, 90)}`, { reply: m ? '🔔' : '' });
  } else if (e.kind === 'assign') {
    visit(byId(e.from) || a, t, `${key}: yours now`, { card: COL.todo, reply: 'OK' });
    if (t && t.isPlayer) goBoard(t, key);
  } else if (e.kind === 'priority') {
    say(a, `🔥 ${key} → ${e.to}`, /highest|blocker|critical/i.test(e.to || '') ? 'bug' : '');
  } else if (e.kind === 'push') {
    a.burst = performance.now() + 30_000; // typing hard
    say(a, `${e.created ? '🌱 New branch' : `↑ ${e.count} commit${e.count > 1 ? 's' : ''}`} · ${key || trunc(e.ref || '', 28)}`);
  } else if (e.kind === 'mr-open') {
    visit(a, t, `Review MR !${e.iid}${key ? ` · ${key}` : ''}?`, { card: COL.review, reply: '👀 On it' });
  } else if (e.kind === 'mr-approve') {
    say(a, `👍 MR !${e.iid}`, 'ok'); if (t && t !== a && t.group.visible) flow(a.pos, t.pos, COL.done);
  } else if (e.kind === 'mr-comment') {
    visit(a, t, `💬 !${e.iid}: ${trunc(e.text || '', 80)}`);
  } else if (e.kind === 'mr-merge') {
    say(a, `Merged !${e.iid} → ${e.branch}`, 'ok'); flow(a.pos, BOARD('done'), COL.done);
    if (e.uat) { const q = chars.find((x) => x.u.role === 'qa' && atWork(x)); if (q) setTimeout(() => say(q, '🧪 New build on UAT'), 1600); }
  } else if (e.kind === 'pipeline') {
    say(a, e.status === 'failed' ? `❌ Pipeline failed · ${key || trunc(e.ref || '', 24)}` : '✅ Pipeline fixed', e.status === 'failed' ? 'bug' : 'ok');
  }
}
// Something new for you (assigned, or a new task or bug of yours): your character goes to the sprint board to look.
function goBoard(c, key) {
  setTimeout(() => chars.includes(c) && !c.errand && c.group.visible && !meeting && runErrands(c, [{ to: BOARD('todo'), yaw: -Math.PI / 2, pose: 'look', say: `📋 ${key}`, dur: 8 }]), 3500);
}
// Live events play one at a time, a moment apart, so each can be followed.
function enqueue(list) {
  evQueue.push(...list);
  if (!evBusy) nextQueued();
}
function nextQueued() {
  const e = evQueue.shift();
  if (!e) { evBusy = false; return; }
  evBusy = true; playEvent(e); record([e]);
  setTimeout(nextQueued, evQueue.length > 6 ? 900 : 2200);
}

// What an event tells beyond its scene: who is really at work (their latest event), and the build lamp.
function record(list) {
  for (const e of list) {
    if (e.actor?.id) lastAct.set(e.actor.id, Math.max(lastAct.get(e.actor.id) || 0, Date.parse(e.at)));
    if (e.kind === 'pipeline') setCi(e.status);
  }
}

// ---- Build lamp: the latest finished pipeline of each repo; red while any is failing ----
function setCi(status) {
  ciState = status;
  ciLamp.material.color.set(status === 'failed' ? '#f05a5a' : status === 'success' ? '#4cd27f' : '#7d8a96');
}

// ---- Replay: today's events, quickly, with the time shown; any live ones wait their turn ----
function startReplay(list) {
  stopReplay();
  if (!list.length) return;
  const step = clamp(60_000 / list.length, 450, 1400); // about a minute however busy the day was
  replaying = { list, i: 0, timer: 0 };
  $('#replay').hidden = false;
  const tick = () => {
    const R = replaying; if (!R) return;
    const e = R.list[R.i++];
    if (!e) return stopReplay();
    $('#replay-time').textContent = hhmm(e.at); playEvent(e); record([e]);
    R.timer = setTimeout(tick, step);
  };
  tick();
}
function stopReplay() {
  if (!replaying) return;
  clearTimeout(replaying.timer);
  const rest = replaying.list.slice(replaying.i); replaying = null;
  record(rest); // skipped
  $('#replay').hidden = true;
}
$('#replay-skip').addEventListener('click', stopReplay);

// ---- Loading: every 30s, today's events since midnight; new ones play ----
const dayStartMs = () => { const d = nowTime(); d.setHours(0, 0, 0, 0); return d.getTime(); };
let evLoading = false, evFirst = true;
const warned = new Set();
async function loadEvents() {
  if (DEMO || evLoading || !loadedOnce) return;
  evLoading = true;
  try {
    const params = new URLSearchParams({ since: String(dayStartMs()) });
    if (SPRINT) params.set('sprint', SPRINT);
    const res = await fetch(`/api/office/events?${params}`, { headers: { 'X-Dashboard': '1' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const fresh = (data.events || []).filter((e) => !seenEvents.has(e.id));
    fresh.forEach((e) => seenEvents.add(e.id));
    const ci = data.ci || [];
    setCi(ci.length ? (ci.some((x) => x.status === 'failed') ? 'failed' : 'success') : null);
    const gl = data.sources?.gitlab;
    if (gl && gl !== 'ok' && !warned.has('gitlab')) { warned.add('gitlab'); toast(`GitLab offline (VPN?): ${gl}`); }
    if (evFirst) {
      evFirst = false;
      // The day's first visit replays it; later visits just list it.
      const today = new Date(dayStartMs()).toDateString();
      if (fresh.length && tryStore('jd:officeReplayed') !== today) { tryStore('jd:officeReplayed', today); startReplay(fresh); } else record(fresh);
    } else if (replaying) replaying.list.push(...fresh);
    else enqueue(fresh);
    for (const c of chars) c.lastAct = lastAct.get(c.u.id) || 0;
  } catch (err) {
    if (!warned.has(err.message)) { warned.add(err.message); toast(`Could not load the activity: ${err.message}`); } // once per kind of error
  } finally {
    evLoading = false;
  }
}
setInterval(() => { if (!document.hidden) loadEvents(); }, 30_000);

// The demo has no server: its task moves become events of the person who made them.
function demoEvent(c, ch) {
  const t = ch.task;
  return { id: `demo:${Date.now()}:${t.k}`, at: new Date().toISOString(), src: 'jira', kind: ch.kind === 'new' ? 'assign' : 'status', actor: { id: c.u.id, name: c.u.name }, target: { id: c.u.id, name: c.u.name }, key: t.k, to: t.statusName, text: t.s };
}

// ---- Idle people: nothing of theirs has moved for a while, so they get up ----
// Every few seconds, someone idle at their place (no Jira or GitLab activity for IDLE_MS, nothing urgent) may go for a
// coffee or water, stretch or exercise, meditate on the pantry rug, look out of a window, stroll the corridor or chat
// with another idle person, then sit back down for a few minutes. Icons only: none of it claims a fact. Busy people
// stay at work, apart from a coffee now and then.
const IDLE_MS = 40 * 60_000;
const lastWork = (c) => Math.max(c.lastAct || 0, ...c.u.tasks.map((t) => t.at || 0));
const isIdleNow = (c) => Date.now() - lastWork(c) > IDLE_MS;
const spot = (x, z, r = 0.6) => freeSpot([x - r, x + r, z - r, z + r], null);
const WINDOWS = [[-2, 12.2, 0], [6, 12.2, 0], [20.2, 0.5, Math.PI / 2], [20.2, 6, Math.PI / 2]]; // spot in front, facing out
const IDLE_ACTS = [
  { w: 3, steps: () => [{ to: COFFEE, yaw: Math.PI / 2, say: '☕', dur: 5, pose: 'drink' }], cup: '#e9e4da' },
  { w: 2, steps: () => [{ to: v(19.5, 10.2), yaw: Math.PI / 2, say: '💧', dur: 4, pose: 'drink' }], cup: '#cfe6ec' },
  { w: 2, steps: () => [{ to: spot(15, 6.5, 1.5), yaw: rand(-1, 1), say: '🏃', dur: 9, pose: 'exercise' }] },
  { w: 2, steps: () => [{ to: spot(rand(-16, 16), 0, 0.5), yaw: rand(-3, 3), say: '🙆', dur: 7, pose: 'stretch' }] },
  { w: 2, steps: () => [{ to: spot(15, 11.2, 1.2), yaw: Math.PI, say: '🧘', dur: 12, pose: 'meditate' }] },
  { w: 1, steps: () => { const [x, z, yaw] = pick(WINDOWS); return [{ to: spot(x, z, 0.4), yaw, say: '🌤️', dur: 8, pose: 'look' }]; } },
  { w: 2, steps: () => { const x = rand(-18, 18); return [{ to: v(x, 0.2), dur: 0.3, pose: 'look' }, { to: v(clamp(x + pick([-9, 9]), -19, 19), -0.2), say: '🚶', dur: 2, pose: 'look' }]; } },
  { w: 2, pair: true },
];
const weighted = (list) => { let r = Math.random() * list.reduce((s, a) => s + a.w, 0); return list.find((a) => (r -= a.w) < 0) || list[0]; };
function idleTick() {
  if (document.hidden || reduceMotion || replaying || meeting || sched.kind !== 'work') return;
  const now = Date.now(), free = chars.filter((c) => atWork(c) && c.place !== 'urgent');
  const out = chars.filter((c) => c.errand?.ambient).length;
  if (out >= Math.max(2, Math.ceil(chars.length * 0.4))) return; // the office never empties
  const idle = free.filter((c) => isIdleNow(c) && now >= (c.nextIdle || 0));
  const c = pick(idle);
  if (!c) {
    // Busy people: a coffee about every 45 minutes each.
    const b = pick(free.filter((x) => !isIdleNow(x) && x.place !== 'done'));
    if (b && Math.random() < free.length / 45 / 6) runErrands(b, [{ ...IDLE_ACTS[0].steps()[0], ambient: true }], IDLE_ACTS[0].cup);
    return;
  }
  c.nextIdle = now + rand(120_000, 300_000); // back at their place for a few minutes after this
  let act = weighted(IDLE_ACTS);
  if (act.pair) {
    const o = pick(idle.filter((x) => x !== c));
    if (o) {
      o.nextIdle = c.nextIdle;
      const meet = spot(rand(-12, 12), 0, 0.5);
      runErrands(o, [{ to: meet, yaw: Math.PI / 2, dur: 8, pose: 'look', ambient: true }]);
      runErrands(c, [{ to: v(meet.x + 1.1, meet.z), yaw: -Math.PI / 2, say: '😄', dur: 7, pose: 'talk', ambient: true, onArrive: () => setTimeout(() => chars.includes(o) && say(o, '😂'), 1500) }]);
      return;
    }
    act = IDLE_ACTS[0];
  }
  runErrands(c, act.steps().map((s) => ({ ...s, ambient: true })), act.cup || null);
}
setInterval(idleTick, 8_000);
