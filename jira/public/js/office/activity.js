'use strict';

// 3D office: the team's activity (/api/office/events: Jira changes and comments, GitLab pushes, merge requests and
// pipelines) as scenes between the people who did them, a replay of the day, and the build lamp. Loaded before app.js; everything here runs after app.js has set up (the first data load, timers).

const seenEvents = new Set();
const lastAct = new Map(); // accountId → ms of their latest event: who is really at work now
let ciState = null; // 'success' | 'failed' | null (no GitLab)
let ciRepos = null, openMrs = []; // the Dev room's board: each repo's latest pipeline, the open merge requests
const approved = new Set(); // `${repo}:${iid}` approved today
let evQueue = [], evBusy = false, replaying = null; // replaying: { list, i, timer }

const BOARD = (col) => v(-19.6, BOARD_COL_Z[col]);
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
    a.burst = performance.now() + 30_000; // typing hard, the code screen bright for a while
    if (deskOf(a)) { setScreen(deskOf(a)); setTimeout(() => deskOf(a) && setScreen(deskOf(a)), 31_000); }
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
    if (e.kind === 'pipeline') {
      setCi(e.status);
      const a = byId(e.actor?.id); if (a) { a.ciFail = e.status === 'failed' ? e.ref : null; deskOf(a) && setScreen(deskOf(a)); }
    }
    if (e.kind === 'mr-approve') approved.add(`${e.repo}:${e.iid}`);
  }
  if (list.some((e) => /^mr-/.test(e.kind))) drawDev();
}
const deskOf = (c) => DESKS.find((d) => d.owner === c) || null;
// The team's own merge requests touched in the last two weeks: the open list has every old and outside one too.
const teamMrs = () => openMrs.filter((m) => m.author?.id && Date.now() - Date.parse(m.updated) < 14 * 86_400_000);
const drawDev = () => drawDevBoard(teamMrs().map((m) => ({ ...m, author: baseName(m.author?.name || ''), reviewer: m.reviewer ? baseName(m.reviewer.name) : '', approved: approved.has(`${m.repo}:${m.iid}`) })), ciRepos);

drawDevBoard([], null); // until the first load

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
const dayStartMs = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
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
    ciRepos = data.sources?.gitlab === 'ok' ? ci : null; openMrs = data.mrs || [];
    drawDev();
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
