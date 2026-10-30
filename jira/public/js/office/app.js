'use strict';

// 3D office: hover card, drawer, meeting button, room view, toolbar, input, data loading (with the
// scenes a change plays between rooms), render loop. office-scene.html?sprint=<id> (in an iframe on office.html) shows that sprint, else the active one.

let COL = {};
let hovered = null, selected = null, follow = false, camGoal = null;
const SPRINT = new URLSearchParams(location.search).get('sprint');
const DEMO = typeof OFFICE_DEMO !== 'undefined' ? OFFICE_DEMO : null; // the static demo build (demo.js): made-up data, no server
const tryStore = (k, val) => { try { if (val === undefined) return localStorage.getItem(k); localStorage.setItem(k, val); } catch { return null; } };
const byId = (id) => chars.find((c) => c.u.id === id);
const stateChip = (c) => `<span class="zchip" data-z="${c.state}">${STATES[c.state].name}</span>`;
const typeChip = (t) => `<span class="ttype${t.type === 'bug' ? ' bug' : ''}">${t.type === 'bug' ? 'Bug' : 'Task'}</span>`;
const prioChip = (t) => (t.pr === 'highest' || t.pr === 'high' ? `<span class="prio ${t.pr}">${PRIORITY[t.pr]}</span>` : '');
const taskLink = (t) => (DEMO ? `<code>${t.k}</code>` : `<a href="/tasks.html#${encodeURIComponent(t.k)}" target="_top"><code>${t.k}</code></a>`);

// ---- Highlights: room floors light up while their card is hovered ----
function resetGlow() {
  for (const Z of Object.values(ZONES)) { Z.glow.material.color.set(COL[Z.color]); Z.glow.material.opacity = 0; }
}
function hoverChar(c) {
  if (hovered === c) return;
  if (hovered && chars.includes(hovered)) setHighlight(hovered, false);
  hovered = c; if (c) setHighlight(c, true);
}
function focusChar(c, open) {
  if (!c) return;
  setFollow(false); camGoal = c.pos; view.zoomT = Math.max(view.zoomT, 1.5);
  if (open) openDrawer(c);
}

// ---- Hover card ----
const tip = $('#tip');
function showTip(c, x, y) {
  if (!c) { tip.hidden = true; return; }
  const t = currentTask(c.u), sp = spOf(c.u);
  tip.innerHTML = `<b>${esc(fullName(c.u))}</b><span class="tiprow">${stateChip(c)}<span class="k">${ROLES[c.u.role]} · ${placeName(c.u)}</span></span>
    ${t ? `<span class="tiprow">${typeChip(t)}${prioChip(t)}<span class="k">${t.k} · ${esc(t.statusName)}</span></span><span>${esc(t.s)}</span>` : '<span>Nothing open</span>'}
    <span class="k">${sp.done}/${sp.total} SP · click for details</span>`;
  tip.hidden = false;
  const W = stage.clientWidth, H = stage.clientHeight, w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.transform = `translate(${Math.min(x + 16, W - w - 8)}px, ${Math.min(y + 16, H - h - 8)}px)`;
}

// ---- Drawer: a person or a room ----
const drawer = $('#drawer');
let roomOpen = null;
const taskItem = (t, who) => `<li class="${t.pr === 'highest' && isOpen(t) ? 'hot' : ''}">
  <div class="row1"><span class="tiprow">${typeChip(t)}${taskLink(t)}${prioChip(t)}</span><span class="st" data-st="${t.st}">${esc(t.statusName)}</span></div>
  <p>${esc(t.s)}</p>
  <div class="row2">${who ? `<span>${who}</span>` : ''}<span>${t.sp} SP</span><span class="${isLate(t) ? 'late' : ''}">${dueText(t)}</span>${t.st === 'prog' && t.idle >= 3 ? `<span>${t.idle}d without an update</span>` : ''}</div>
</li>`;
function openDrawer(c) { roomOpen = null; selected = c; $('#drawer-kind').textContent = 'Person'; renderDrawer(); drawer.classList.add('open'); }
function closeDrawer() { selected = null; roomOpen = null; drawer.classList.remove('open'); }
function renderDrawer() {
  if (!selected) return;
  const c = selected, u = c.u, sp = spOf(u), open = u.tasks.filter(isOpen).length, late = u.tasks.filter(isLate).length;
  $('#drawer-body').innerHTML = `
    <div class="who">${avatarHTML(c, 'ava')}<div><h2>${esc(fullName(u))}</h2><span class="tiprow">${stateChip(c)}<span class="k">${ROLES[u.role]} · ${placeName(u)}</span></span></div></div>
    <div class="stats"><div><b>${sp.done}/${sp.total}</b><span>SP done</span></div><div><b>${open}</b><span>open</span></div><div><b class="${late ? 'late' : ''}">${late}</b><span>overdue</span></div></div>
    <div class="spbar"><span style="width:${sp.total ? (sp.done / sp.total) * 100 : 0}%"></span></div>
    <ul class="tasks">${sortTasks(u.tasks).map((t) => taskItem(t)).join('') || '<li class="k">No tasks in this sprint.</li>'}</ul>
    <div class="dact">${c.isPlayer ? '' : `<button class="btn primary" id="walk-to">Walk over to ${esc(short(u))}</button>`}<button class="btn" id="look">Look</button></div>`;
  const walk = $('#walk-to');
  if (walk) walk.addEventListener('click', () => {
    const dx = player.pos.x - c.pos.x, dz = player.pos.z - c.pos.z, d = Math.hypot(dx, dz) || 1;
    goTo(v(c.pos.x + (dx / d) * 1.3, c.pos.z + (dz / d) * 1.3)); setFollow(true);
  });
  $('#look').addEventListener('click', () => focusChar(c, false));
}
$('#close').addEventListener('click', closeDrawer);

// ---- Rooms: live screens, a card over each room, the room drawer ----
const ROOM_ORDER = ['urgent', 'dev', 'review', 'todo', 'qa', 'done'];
function roomData(z) {
  const all = chars.flatMap((c) => c.u.tasks.map((t) => ({ ...t, c })));
  const people = chars.filter((c) => !c.isPlayer && zoneOf(c.u) === z || (c.isPlayer && zoneAt(c.pos.x, c.pos.z) === z));
  const sp = (l) => l.reduce((s, t) => s + t.sp, 0);
  const bugs = all.filter((t) => isOpen(t) && t.type === 'bug');
  let tasks, line;
  if (z === 'urgent') { tasks = all.filter((t) => isOpen(t) && t.pr === 'highest'); line = `${tasks.length} Highest open`; }
  else if (z === 'dev') { tasks = all.filter((t) => t.st === 'prog' && t.c.u.role === 'dev' && t.pr !== 'highest'); line = `${people.length} coding · ${sp(tasks)} SP`; }
  else if (z === 'qa') { tasks = all.filter((t) => t.pr !== 'highest' && ((t.st === 'prog' && t.c.u.role === 'qa') || (isOpen(t) && t.type === 'bug'))); line = `${people.length} testing · ${bugs.length} open bugs`; }
  else if (z === 'review') { tasks = all.filter((t) => t.st === 'review'); line = `${tasks.length} waiting for review`; }
  else if (z === 'todo') { tasks = all.filter((t) => t.st === 'todo'); line = `${tasks.length} not started`; }
  else { tasks = all.filter((t) => t.st === 'done'); line = `${tasks.length} done · ${sp(tasks)}/${sp(all)} SP`; }
  return { people, tasks, line };
}
function refreshRooms() {
  const all = chars.flatMap((c) => c.u.tasks.map((t) => ({ ...t, who: short(c.u) })));
  updateRooms({
    all,
    highest: all.filter((t) => isOpen(t) && t.pr === 'highest'),
    bugsOpen: all.filter((t) => isOpen(t) && t.type === 'bug').length,
    passed: all.filter((t) => !isOpen(t) && t.type === 'bug').length,
  });
  for (const z of ROOM_ORDER) roomCards[z].querySelector('small').textContent = roomData(z).line;
  if (roomOpen) renderRoomDrawer();
  if (rv.room) { buildDetails(); renderRoomHead(); }
}
const roomCards = {};
for (const z of ROOM_ORDER) {
  const b = document.createElement('button'); b.className = 'room'; b.dataset.z = z;
  b.innerHTML = `<i></i><span>${ZONES[z].name}<small></small></span>`;
  b.addEventListener('click', () => viewRoom(z));
  b.addEventListener('pointerenter', () => { ZONES[z].glow.material.color.set(COL[ZONES[z].color]); ZONES[z].glow.material.opacity = 0.18; });
  b.addEventListener('pointerleave', resetGlow);
  $('#rooms').append(b); roomCards[z] = b;
}
function placeRoomCards() {
  if (rv.room) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  for (const z of ROOM_ORDER) {
    // Pin each card to the room corner farthest from the camera, so it sits behind the people.
    const [x0, x1, z0, z1] = ZONES[z].rect, sx = Math.sin(view.az) > 0 ? x0 : x1, sz = Math.cos(view.az) > 0 ? z0 : z1;
    proj.set(sx + (sx === x0 ? 0.6 : -0.6), 2.4, sz + (sz === z0 ? 0.6 : -0.6)).project(viewCam);
    // Keep it on screen (y is the card's bottom edge).
    const x = clamp(((proj.x + 1) / 2) * w, 30, w - 150), y = clamp(((1 - proj.y) / 2) * h, 60, h - 70);
    roomCards[z].style.transform = `translate(${x}px, ${y}px) translate(-15%, -100%)`;
  }
}
function openRoom(z) { selected = null; roomOpen = z; $('#drawer-kind').textContent = 'Room'; renderRoomDrawer(); drawer.classList.add('open'); }
function renderRoomDrawer() {
  const z = roomOpen, d = roomData(z);
  $('#drawer-body').innerHTML = `
    <div class="who"><span class="ava room-ava" data-z="${z}"></span><div><h2>${ZONES[z].name}</h2><span class="k">${d.line}</span></div></div>
    <div><h3 class="eyebrow">Here now · ${d.people.length}</h3><div class="people">${d.people.map((c) => `<button data-id="${esc(c.u.id)}">${avatarHTML(c, 'pav sm')}${esc(short(c.u))}</button>`).join('') || '<span class="k">Nobody</span>'}</div></div>
    <ul class="tasks">${sortTasks(d.tasks).map((t) => taskItem(t, `${esc(short(t.c.u))} · ${ROLES[t.c.u.role]}`)).join('') || '<li class="k">No tasks here.</li>'}</ul>`;
  $('#drawer-body .people').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) focusChar(byId(b.dataset.id), true); });
}

// ---- Room view: a perspective shot of one room, the rest clipped away ----
let focusRoom = null;
// Opening shot per room: face the thing worth reading (screen, board), otherwise the whole room.
const ROOM_SHOT = {
  urgent: { az: 0.3, center: [-14, -8.6], dist: 15, el: 0.5 }, // war-room screen on the back wall
  review: { az: 0.35, center: [16, -8], dist: 15, el: 0.6 }, // table + burndown TV
  todo: { az: Math.PI / 2, center: [-19.5, 7], dist: 11, el: 0.48 }, // kanban board on the left wall, above people's heads
  qa: { az: 1.1, center: [-1, 7.5], dist: 20, el: 0.55 }, // bug screen and device wall
};
function viewRoom(z) {
  const [x0, x1, z0, z1] = ZONES[z].rect, shot = ROOM_SHOT[z] || {};
  if (!rv.room) { rv.az = rv.azT = view.az; rv.el = 1.2; } // swoop down from above on entry
  const az = shot.az ?? Math.PI / 4;
  rv.azT = rv.az + ((((az - rv.az) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI; // shortest turn
  const [cx, cz] = shot.center || [(x0 + x1) / 2, (z0 + z1) / 2];
  rv.center.set(cx, 0.8, cz);
  rv.elT = shot.el ?? 0.62; rv.distT = shot.dist ?? Math.max(x1 - x0, z1 - z0) * 1.15 + 3; if (!rv.room) rv.dist = rv.distT * 1.6;
  focusRoom = z; rv.room = z; viewCam = pcam; clipToRoom(z);
  setFollow(false); camGoal = null; tip.hidden = true;
  if (stage.clientWidth > 760) openRoom(z); else closeDrawer(); // on phones the room gets the screen; the list is one tap away
  setRoomMode(true); buildDetails(); markFocus();
}
function exitRoom() {
  if (!rv.room) return;
  focusRoom = null; rv.room = null; viewCam = cam; clipToRoom(null);
  if (roomOpen) closeDrawer();
  setRoomMode(false); buildDetails(); markFocus();
  camGoal = v(0, 0); setZoom(fitZoom());
}
function setRoomMode(on) {
  $('.app').classList.toggle('room-mode', on);
  $('#roomhead').hidden = !on;
  labels.forEach((l) => (l.pivot.visible = !on)); // the big floor lettering is only for the overview
  if (on) renderRoomHead();
}
function renderRoomHead() {
  const z = rv.room; if (!z) return;
  $('#roomhead').dataset.z = z;
  $('#rh-name').textContent = ZONES[z].name;
  $('#rh-line').textContent = roomData(z).line + (z === 'dev' ? ` · build ${warLight.userData.on ? 'red' : 'green'}` : '');
}
const stepRoom = (d) => viewRoom(ROOM_ORDER[(ROOM_ORDER.indexOf(rv.room) + d + ROOM_ORDER.length) % ROOM_ORDER.length]);
$('#room-exit').addEventListener('click', exitRoom);
$('#room-prev').addEventListener('click', () => stepRoom(-1));
$('#room-next').addEventListener('click', () => stepRoom(1));
function markFocus() {
  // In a room, hide people outside it, and the name tag of anyone sitting behind a desk badge.
  for (const c of chars) c.tag.classList.toggle('far', !!rv.room && (zoneAt(c.pos.x, c.pos.z) !== rv.room || (!!c.seat && !!c.seat.desk && c.sitting)));
  for (const z of ROOM_ORDER) roomCards[z].hidden = !!rv.room;
}
// Desk badges in the Dev / QA rooms: "Name · KEY", details on hover, the person on click.
// Other rooms show their information on their own screens and boards, and in the drawer.
const details = [];
let detailsSig = '';
function buildDetails() {
  const z = rv.room;
  // Rebuild only when who sits where (or their work) changed, so an open hover card is not torn down.
  const sig = z + DESKS.map((d) => (d.owner ? d.owner.u.id + d.owner.state + (currentTask(d.owner.u)?.k || '') : '-')).join();
  if (sig === detailsSig) return;
  detailsSig = sig; $('#details').innerHTML = ''; details.length = 0;
  if (z !== 'dev' && z !== 'qa') return;
  for (const d of DESKS.filter((x) => x.room === z && x.owner)) {
    const c = d.owner, t = currentTask(c.u), idle = isIdle(c.u), alert = idle || c.u.tasks.some(isLate);
    const el = document.createElement('div'); el.className = 'detail';
    el.innerHTML = `<span class="pill"><i style="background:var(--${STATES[c.state].color})"></i>${esc(short(c.u))}${t ? ` · <code>${t.k}</code>` : ''}${alert ? '<b class="alert" title="Needs attention"></b>' : ''}</span>`
      + `<span class="more">${t ? `<span>${esc(t.s)}</span><em>${esc(t.statusName)} · ${t.sp} SP · <b class="${isLate(t) ? 'late' : ''}">${dueText(t)}</b></em>` : '<em>Nothing open</em>'}`
      + `${idle ? `<em class="warn">${Math.max(...c.u.tasks.map((x) => x.idle))}d without an update</em>` : ''}</span>`;
    el.addEventListener('click', () => openDrawer(c));
    $('#details').append(el); details.push({ p: v(d.x, d.z - 0.3).setY(1.7), el });
  }
}
function placeDetails() {
  const w = stage.clientWidth, h = stage.clientHeight;
  for (const d of details) {
    proj.copy(d.p).project(viewCam);
    d.el.hidden = proj.z > 1;
    d.el.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px) translate(-50%, -100%)`;
  }
}

// ---- Meeting: the red button on the meeting table calls everyone in; pressing it again sends them back ----
const meetTag = $('#meet');
let pressedAt = -1;
function setMeeting(on) {
  if (!player) return; // the team has not loaded yet
  meeting = on;
  chars.forEach(cancelErrands);
  meetTag.textContent = on ? 'End meeting' : 'Meeting'; meetTag.setAttribute('aria-pressed', String(on));
  meetDome.material.color.set(on ? '#2f9e5b' : '#e0352b'); meetDome.material.emissive.set(on ? '#0c3d1f' : '#7a0d08');
  pressedAt = performance.now();
  for (const c of chars) if (!c.isPlayer) retarget(c);
  if (on) { retarget(player); setFollow(false); camGoal = v(TABLE.x, TABLE.z); view.zoomT = Math.max(view.zoomT, 1.4); }
  else if (player.seat) { player.path = route(player, null, [], v(16, 0)); releaseSeat(player); player.place = null; }
}
meetTag.addEventListener('click', () => setMeeting(!meeting));
// The tag floats over the button; inside another room's view the button is clipped away, and so is the tag.
function placeMeetTag() {
  meetTag.hidden = !!rv.room && rv.room !== 'review';
  proj.set(TABLE.x, 1.55, TABLE.z).project(viewCam);
  meetTag.style.transform = `translate(${((proj.x + 1) / 2) * stage.clientWidth}px, ${((1 - proj.y) / 2) * stage.clientHeight}px) translate(-50%, -100%)`;
  // Pressed: the dome dips, then springs back.
  const t = (performance.now() - pressedAt) / 250;
  meetDome.position.y = t < 1 ? 0.12 - 0.08 * Math.sin(t * Math.PI) : 0.12;
}

// ---- Scenes between rooms: what a change on Jira looks like in the office ----
const BOARD = (col) => v(-19.6, BOARD_COL_Z[col]);
const COFFEE = v(19.5, 4.6);
const pickOther = (list, not) => pick(list.filter((x) => x !== not && !x.errand && !x.isPlayer)) || null;
function playChange(c, ch) {
  if (meeting || c.isPlayer || c.errand) return;
  const t = ch.task, qas = chars.filter((x) => x.u.role === 'qa');
  if (ch.kind === 'new') {
    flow(BOARD('todo'), c.pos, t.pr === 'highest' ? COL.overdue : t.type === 'bug' ? COL.review : COL.todo);
    setTimeout(() => say(c, t.pr === 'highest' ? 'On it!' : `Got ${t.k}`, t.pr === 'highest' ? 'bug' : ''), 1300);
  } else if (ch.was === 'todo' && t.st !== 'done') { // pick the card up from the board, then go to work
    runErrands(c, [{ to: BOARD('todo'), yaw: -Math.PI / 2, pose: 'board', say: `Taking ${t.k}`, dur: 1.4 }], COL.prog);
  } else if (ch.was === 'prog' && t.st === 'review' && c.u.role === 'dev') { // hand the card to QA
    const q = pickOther(qas, c);
    if (q) runErrands(c, [{ target: q, card: COL.review, pose: 'talk', say: `Can you test ${t.k}?`, dur: 2,
      onArrive: () => { c.card.visible = false; flow(c.pos, q.pos, COL.review); setTimeout(() => say(q, 'Sure, on it', 'ok'), 900); } }]);
  } else if (ch.was === 'review' && t.st === 'prog') { // QA walks over to report a problem
    const q = pickOther(qas, c);
    if (q) runErrands(q, [{ target: c, card: COL.overdue, pose: 'talk', say: `Found a bug in ${t.k}`, tone: 'bug', dur: 2,
      onArrive: () => { q.card.visible = false; flow(q.pos, c.pos, COL.overdue); setTimeout(() => say(c, 'Fixing it'), 900); } }]);
  } else if (t.st === 'done') { // put the card in the Done column
    runErrands(c, [{ to: BOARD('done'), yaw: -Math.PI / 2, card: COL.done, pose: 'board', say: `${t.k} done`, tone: 'ok', dur: 1.4, onArrive: () => (c.card.visible = false) }]);
  }
}
// Ambient life between rooms: coffee runs and quick questions.
const CHATS = [['New build is on staging', 'Great, testing it now'], ['Do we test this on iOS too?', 'Yes, Android as well'], ['Could you review my MR?', 'In 10 minutes'], ['Did the API response change?', 'Yes, check the docs']];
function ambient() {
  const npcs = chars.filter((c) => !c.isPlayer && !c.errand);
  if (meeting || npcs.length < 2) return;
  if (Math.random() < 0.45) {
    const c = pick(npcs.filter((x) => x.zone === 'dev' || x.zone === 'qa' || x.zone === 'todo')); if (!c) return;
    runErrands(c, [{ to: COFFEE, yaw: Math.PI / 2, say: 'Coffee break', dur: 2.2 }], '#e9e4da');
  } else {
    const devs = npcs.filter((x) => x.u.role === 'dev' && x.zone !== 'urgent'), qas = npcs.filter((x) => x.u.role === 'qa');
    if (!devs.length || !qas.length) return;
    const [a, b] = Math.random() < 0.5 ? [pick(devs), pick(qas)] : [pick(qas), pick(devs)], [q1, q2] = pick(CHATS);
    runErrands(a, [{ target: b, pose: 'talk', say: q1, dur: 2.6, onArrive: () => setTimeout(() => say(b, q2, 'ok'), 1000) }]);
  }
}
// Always on, except for people who asked their system for less motion.
setInterval(() => { if (!reduceMotion && !document.hidden) ambient(); }, 9000);

// ---- Data: /api/team-sprint, polled; differences between two loads play as scenes ----
const POLL_MS = 90_000;
let loading = false, loadedOnce = false;
function sprintLine(s) {
  if (!s) return 'No active sprint';
  if (!s.endDate || s.state === 'closed') return s.name;
  const left = Math.ceil((new Date(s.endDate) - Date.now()) / 86_400_000);
  return `${s.name} · ${left > 0 ? `${left}d left` : 'ends today'}`;
}
async function load({ fresh = false } = {}) {
  if (DEMO) {
    applyData(loadedOnce ? DEMO.tick() : DEMO.data());
    $('#status').textContent = 'Demo: made-up team and tasks';
    return;
  }
  if (loading) return;
  loading = true;
  $('#status').textContent = 'Loading…';
  try {
    const params = new URLSearchParams();
    if (SPRINT) params.set('sprint', SPRINT);
    if (fresh) params.set('fresh', '1');
    const res = await fetch(`/api/team-sprint${params.size ? '?' + params : ''}`, { headers: { 'X-Dashboard': '1' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    applyData(data);
    $('#status').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    $('#empty').hidden = chars.length > 1 || !!data.sprint;
  } catch (e) {
    $('#status').textContent = `Could not load the team: ${e.message}`;
  } finally {
    loading = false;
  }
}
function applyData(data) {
  $('#sprint').textContent = sprintLine(data.sprint);
  const first = !loadedOnce;
  loadedOnce = true;
  const seen = new Set();
  for (const u of toPeople(data.members || [])) {
    seen.add(u.id);
    let c = byId(u.id);
    if (!c) {
      c = addPerson(u); c.state = stateOf(u);
      if (c.isPlayer) { c.pos.set(2, 0, 0); c.yaw = c.yawT = 0; } else if (first) retarget(c, true); else { c.pos.set(2, 0, 0); retarget(c); }
      updateTag(c);
      continue;
    }
    const changes = diffTasks(c.u.tasks, u.tasks);
    c.u = u; c.state = stateOf(u);
    if (!c.isPlayer) retarget(c);
    const done = changes.find((ch) => ch.kind === 'move' && ch.task.st === 'done');
    updateTag(c, done ? `✓ ${done.task.k}` : ''); if (done) setTimeout(() => chars.includes(c) && updateTag(c), 2400);
    if (changes.length) playChange(c, changes.find((ch) => ch.kind === 'move') || changes[0]);
  }
  for (const c of [...chars]) if (!seen.has(c.u.id) && !c.isPlayer) { if (selected === c) closeDrawer(); removePerson(c); }
  refreshRooms();
  if (selected) renderDrawer();
}
setInterval(() => { if (!document.hidden) load(); }, DEMO ? 6000 : POLL_MS); // the demo moves a task every few seconds

function stepEffects(dt, time) {
  stepFlows(dt);
  warLight.intensity = warLight.userData.on ? 0.35 + 0.35 * Math.sin(time * 2.2) : 0;
  marker.material.opacity = Math.max(0, marker.material.opacity - dt * 1.2);
  selRing.visible = !!selected; if (selected) selRing.position.set(selected.pos.x, 0.045, selected.pos.z);
}

// ---- Camera input: drag to pan (orbit in a room), wheel / pinch to zoom, Q/E to rotate ----
const canvas = renderer.domElement, pointers = new Map();
let drag = null, pinch = null, mouse = null;
const setZoom = (z) => (view.zoomT = clamp(z, 0.45, 3));
function rotate(dir) { if (rv.room) rv.azT += (dir * Math.PI) / 2; else view.azT += (dir * Math.PI) / 2; }
// In a room, zoom moves the camera closer; in the office it scales the isometric view.
function zoomBy(f) { if (rv.room) rv.distT = clamp(rv.distT / f, 5, 50); else setZoom(view.zoomT * f); }
function pan(dx, dy) {
  const upp = (cam.top - cam.bottom) / stage.clientHeight, fx = -Math.sin(view.az), fz = -Math.cos(view.az), rx = -fz, rz = fx, k = 1 / Math.sin(view.el);
  view.target.x = clamp(view.target.x + (-dx * rx + dy * fx * k) * upp, -22, 22);
  view.target.z = clamp(view.target.z + (-dx * rz + dy * fz * k) * upp, -14, 14);
  camGoal = null; setFollow(false);
}
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function overMeetButton(x, y) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, viewCam);
  return ray.intersectObject(meetButton, true).length > 0 && !(rv.room && rv.room !== 'review');
}
function hit(x, y) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, viewCam);
  const h = ray.intersectObjects(pickables, false)[0];
  return h ? { char: h.object.userData.char } : { floor: ray.intersectObject(floor)[0] };
}
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, button: e.button };
  else if (pointers.size === 2) { drag = null; const [a, b] = [...pointers.values()]; pinch = { last: Math.hypot(a.x - b.x, a.y - b.y) }; }
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect(); mouse = { x: e.clientX, y: e.clientY, lx: e.clientX - r.left, ly: e.clientY - r.top };
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y); zoomBy(d / pinch.last); pinch.last = d; return; }
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) { drag.moved = true; canvas.classList.add('dragging'); }
  if (drag.moved) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (rv.room) { rv.azT -= dx * 0.008; rv.elT = clamp(rv.elT + dy * 0.005, 0.2, 1.3); } else pan(dx, dy); // orbit in a room, pan in the office
    drag.x = e.clientX; drag.y = e.clientY;
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (drag && !drag.moved && drag.button === 0 && e.type === 'pointerup' && player) {
    const h = hit(e.clientX, e.clientY);
    const inRoom = h.floor && zoneAt(h.floor.point.x, h.floor.point.z) === rv.room;
    if (overMeetButton(e.clientX, e.clientY)) setMeeting(!meeting);
    else if (h.char) openDrawer(h.char);
    else if (rv.room && !inRoom) exitRoom(); // clicking outside the room leaves it
    else if (h.floor) goTo(h.floor.point);
  }
  if (pointers.size < 2) pinch = null;
  if (!pointers.size) { drag = null; canvas.classList.remove('dragging'); }
}
canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('dblclick', (e) => { const h = hit(e.clientX, e.clientY), z = h.floor && zoneAt(h.floor.point.x, h.floor.point.z); if (z) viewRoom(z); });
canvas.addEventListener('pointerleave', () => { mouse = null; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

const keys = new Set();
addEventListener('keydown', (e) => {
  const typing = e.target.closest && e.target.closest('input, textarea, select');
  if (e.key === 'Escape') {
    if (typing) e.target.blur(); else if (!$('#help').hidden) $('#help').hidden = true; else if (focusRoom) exitRoom(); else closeDrawer();
    return;
  }
  if (typing || !player) return;
  const k = e.key.toLowerCase();
  if (k === 'm') return setMeeting(!meeting);
  if (k === 'q') return rotate(-1);
  if (k === 'e') return rotate(1);
  if (k === '+' || k === '=') return zoomBy(1.25);
  if (k === '-') return zoomBy(1 / 1.25);
  if (k === 'f') return setFollow(!follow);
  if ((k === ' ' || k === 'enter') && nearest && e.target === document.body) { e.preventDefault(); return openDrawer(nearest); }
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) { if (k.startsWith('arrow')) e.preventDefault(); keys.add(k); }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());
function movePlayerKeys(dt) {
  let f = 0, s = 0;
  if (keys.has('w') || keys.has('arrowup')) f += 1; if (keys.has('s') || keys.has('arrowdown')) f -= 1;
  if (keys.has('d') || keys.has('arrowright')) s += 1; if (keys.has('a') || keys.has('arrowleft')) s -= 1;
  player.keyMoving = !!(f || s);
  if (!player.keyMoving) { if (!player.path.length) player.speed = 4.2; return; }
  const fx = -Math.sin(camAz()), fz = -Math.cos(camAz()), mx = fx * f - fz * s, mz = fz * f + fx * s, n = Math.hypot(mx, mz);
  player.path = []; player.speed = keys.has('shift') ? 7 : 4.2;
  const nx = clamp(player.pos.x + (mx / n) * player.speed * dt, -20.6, 20.6), nz = clamp(player.pos.z + (mz / n) * player.speed * dt, -12.6, 12.6);
  if (!blocked(nx, player.pos.z, 0.25)) player.pos.x = nx;
  if (!blocked(player.pos.x, nz, 0.25)) player.pos.z = nz;
  player.yawT = Math.atan2(mx, mz);
}

// ---- Toolbar ----
function setFollow(on) { follow = on; $('#t-follow').setAttribute('aria-pressed', String(on)); if (on) camGoal = null; }
$('#t-rotl').addEventListener('click', () => rotate(-1));
$('#t-rotr').addEventListener('click', () => rotate(1));
$('#t-zin').addEventListener('click', () => zoomBy(1.25));
$('#t-zout').addEventListener('click', () => zoomBy(1 / 1.25));
$('#t-fit').addEventListener('click', () => { setFollow(false); if (rv.room) exitRoom(); else { camGoal = v(0, 0); setZoom(fitZoom()); } });
$('#t-follow').addEventListener('click', () => setFollow(!follow));
$('#t-tags').addEventListener('click', (e) => { const off = $('#tags').classList.toggle('off'); e.currentTarget.setAttribute('aria-pressed', String(!off)); });
$('#t-help').addEventListener('click', () => ($('#help').hidden = !$('#help').hidden));
$('#help-ok').addEventListener('click', () => { $('#help').hidden = true; tryStore('jd:officeHelp', '1'); });

// ---- Nearby prompt ----
const promptEl = $('#prompt');
let nearest = null;
promptEl.addEventListener('click', () => nearest && openDrawer(nearest));
function checkNearby() {
  let best = null, bd = 2.4;
  for (const c of chars) { if (c.isPlayer) continue; const d = Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z); if (d < bd) { bd = d; best = c; } }
  if (best !== nearest) { nearest = best; if (best) promptEl.innerHTML = `<kbd>Space</kbd> See ${esc(short(best.u))}'s tasks`; }
  promptEl.hidden = !nearest || selected === nearest || !$('#help').hidden;
}

// ---- Theme: follows the dashboard page around it (html.light / html.dark), else the system ----
function syncTheme() {
  let cls = null;
  try { cls = window.parent !== window ? window.parent.document.documentElement.classList : null; } catch {}
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('jd:theme')); } catch {}
  for (const t of ['light', 'dark']) document.documentElement.classList.toggle(t, cls ? cls.contains(t) : saved === t);
}
function applyTheme() {
  syncTheme();
  COL = Object.fromEntries(['fg', 'accent', 'todo', 'prog', 'review', 'done', 'overdue'].map((n) => [n, css('--' + n)]));
  const bg = new THREE.Color(css('--bg')), dark = bg.r + bg.g + bg.b < 1.2;
  applyWorldTheme(dark, COL.fg);
  ringMat.color.set(COL.accent); selRing.material.color.set(COL.fg); marker.material.color.set(COL.accent);
  resetGlow();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
try { if (window.parent !== window) new MutationObserver(applyTheme).observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ['class'] }); } catch {}

// ---- Boot ----
applyTheme(); refreshRooms();
if (tryStore('jd:officeHelp') !== '1') $('#help').hidden = false;
load();

let sized = false;
new ResizeObserver(() => {
  const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h, false); canvas.style.width = '100%'; canvas.style.height = '100%';
  if (!sized) { sized = true; view.zoom = view.zoomT = fitZoom(); }
  updateCamera();
}).observe(stage);

let last = performance.now(), time = 0, frameN = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (document.hidden) return; // the empty office still draws while the team loads
  time += dt;
  const k = Math.min(1, dt * 8);
  view.az += (view.azT - view.az) * k; view.zoom += (view.zoomT - view.zoom) * k;
  if (rv.room) {
    rv.az += (rv.azT - rv.az) * k; rv.el += (rv.elT - rv.el) * k * 0.7; rv.dist += (rv.distT - rv.dist) * k * 0.7;
    // Leave room for the drawer: on the right on wide screens, at the bottom on phones.
    const open = drawer.classList.contains('open'), wide = stage.clientWidth > 760;
    rv.dw += ((open && wide ? Math.min(360, stage.clientWidth * 0.4) : 0) - rv.dw) * k;
    rv.dh += ((open && !wide ? stage.clientHeight * 0.62 : 0) - rv.dh) * k;
  }
  const goal = follow && player ? player.pos : camGoal;
  if (goal) {
    const dx = goal.x - view.target.x, dz = goal.z - view.target.z;
    view.target.x += dx * Math.min(1, dt * 4); view.target.z += dz * Math.min(1, dt * 4);
    if (!follow && Math.hypot(dx, dz) < 0.05) camGoal = null;
  }
  if (player) movePlayerKeys(dt);
  for (const c of chars) stepChar(c, dt, time);
  stepEffects(dt, time);
  updateWalls();
  for (const l of labels) l.pivot.rotation.y = camAz(); // text reads left to right from any side
  updateCamera();
  renderer.render(scene, viewCam);
  placeTags(); placeRoomCards(); placeDetails(); placeMeetTag(); if (player) checkNearby();
  if (frameN % 10 === 0) markFocus();
  if (rv.room && frameN % 90 === 0) buildDetails(); // people come and go
  if ((frameN++ & 1) === 0) {
    const h = mouse && !drag ? hit(mouse.x, mouse.y).char || null : null;
    hoverChar(h);
    canvas.classList.toggle('over', !!h || (!!mouse && !drag && overMeetButton(mouse.x, mouse.y)));
    showTip(h, mouse?.lx, mouse?.ly);
  }
}
requestAnimationFrame(frame);
