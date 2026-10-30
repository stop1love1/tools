'use strict';

// 3D office: hover card, drawer, meeting button, room view, toolbar, input, data loading (with the
// scenes a change plays between rooms), render loop. office-scene.html?sprint=<id> (in an iframe on office.html) shows that sprint, else the active one.

let COL = {};
let hovered = null, selected = null, follow = false, camGoal = null;
const SPRINT = new URLSearchParams(location.search).get('sprint');
const DEMO = typeof OFFICE_DEMO !== 'undefined' ? OFFICE_DEMO : null; // the static demo build (demo.js): made-up data, no server
const tryStore = (k, val) => { try { if (val === undefined) return localStorage.getItem(k); localStorage.setItem(k, val); } catch { return null; } };
const byId = (id) => chars.find((c) => c.u.id === id);
const whereText = (c) => (c.group.visible ? ZONES[c.zone || zoneOf(c.u)].name : 'Gone home');
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
  tip.innerHTML = `<b>${esc(fullName(c.u))}</b><span class="tiprow">${stateChip(c)}<span class="k">${ROLES[c.u.role]} · ${whereText(c)}</span></span>
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
function openDrawer(c) { roomOpen = null; teamOpen = false; selected = c; $('#drawer-kind').textContent = 'Person'; renderDrawer(); drawer.classList.add('open'); }
function closeDrawer() { selected = null; roomOpen = null; teamOpen = false; drawer.classList.remove('open'); }
function renderDrawer() {
  if (!selected) return;
  const c = selected, u = c.u, sp = spOf(u), open = u.tasks.filter(isOpen).length, late = u.tasks.filter(isLate).length;
  $('#drawer-body').innerHTML = `
    <div class="who">${avatarHTML(c, 'ava')}<div><h2>${esc(fullName(u))}</h2><span class="tiprow">${stateChip(c)}<span class="k">${ROLES[u.role]} · ${whereText(c)}</span></span></div></div>
    <div class="stats"><div><b>${sp.done}/${sp.total}</b><span>SP done</span></div><div><b>${open}</b><span>open</span></div><div><b class="${late ? 'late' : ''}">${late}</b><span>overdue</span></div></div>
    <div class="spbar"><span style="width:${sp.total ? (sp.done / sp.total) * 100 : 0}%"></span></div>
    <ul class="tasks">${sortTasks(u.tasks).map((t) => taskItem(t)).join('') || '<li class="k">No tasks in this sprint.</li>'}</ul>
    <div class="dact"><button class="btn" id="look">Look</button></div>`;
  $('#look').addEventListener('click', () => focusChar(c, false));
}
$('#close').addEventListener('click', closeDrawer);

// ---- Rooms: live screens, a card over each room, the room drawer ----
const ROOM_ORDER = ['urgent', 'dev', 'review', 'todo', 'qa', 'done'];
function roomData(z) {
  const all = chars.flatMap((c) => c.u.tasks.map((t) => ({ ...t, c })));
  const people = chars.filter((c) => c.group.visible && c.zone === z);
  const sp = (l) => l.reduce((s, t) => s + t.sp, 0);
  const bugs = all.filter((t) => isOpen(t) && t.type === 'bug');
  let tasks, line;
  if (z === 'urgent') { tasks = all.filter((t) => isOpen(t) && t.pr === 'highest'); line = `${tasks.length} Highest open`; }
  else if (z === 'dev') { tasks = all.filter((t) => t.st === 'prog' && zoneOf(t.c.u) === 'dev' && t.pr !== 'highest'); line = `${people.length} coding · ${sp(tasks)} SP`; }
  else if (z === 'qa') { tasks = all.filter((t) => t.pr !== 'highest' && (t.st === 'review' || (t.st === 'prog' && zoneOf(t.c.u) === 'qa') || (isOpen(t) && t.type === 'bug'))); line = `${people.length} testing · ${all.filter((t) => t.st === 'review').length} in the review queue · ${bugs.length} open bugs`; }
  else if (z === 'review') { tasks = all.filter((t) => isOpen(t) && zoneOf(t.c.u) === 'review'); line = meetLine(); }
  else if (z === 'todo') { tasks = all.filter((t) => t.st === 'todo'); line = `${tasks.length} not started · standup ${hmText(hm(schedule.standup) ?? 555)}`; }
  else { tasks = all.filter((t) => t.st === 'done'); line = `${tasks.length} done · ${sp(tasks)}/${sp(all)} SP`; }
  return { people, tasks, line };
}
// The sprint board shows what the dashboard's header filter (person, JQL) keeps of this sprint (office.html sets
// window.officeFilter); standing alone, the whole team.
function boardFilter(all) {
  let f = null;
  try { f = window.parent !== window ? window.parent.officeFilter?.() : null; } catch {}
  if (!f || !f.keys) return { tasks: all, label: 'Whole team' };
  const keep = new Set(f.keys);
  return { tasks: all.filter((t) => keep.has(t.k)), label: f.label };
}
function refreshRooms() {
  const all = chars.flatMap((c) => c.u.tasks.map((t) => ({ ...t, who: short(c.u) })));
  updateRooms({
    all,
    highest: all.filter((t) => isOpen(t) && t.pr === 'highest'),
    bugsOpen: all.filter((t) => isOpen(t) && t.type === 'bug').length,
    passed: all.filter((t) => !isOpen(t) && t.type === 'bug').length,
    board: boardFilter(all),
  });
  if (roomOpen) renderRoomDrawer();
  if (rv.room) { buildDetails(); renderRoomHead(); }
}
// Hovering a door sign lights the room's floor; clicking it looks into the room.
let signHover = null;
function hoverSign(zone) {
  if (signHover === zone) return;
  signHover = zone; resetGlow();
  if (zone) ZONES[zone].glow.material.opacity = 0.18;
}
function openRoom(z) { selected = null; teamOpen = false; roomOpen = z; $('#drawer-kind').textContent = 'Room'; renderRoomDrawer(); drawer.classList.add('open'); }
function renderRoomDrawer() {
  const z = roomOpen, d = roomData(z);
  $('#drawer-body').innerHTML = `
    <div class="who"><span class="ava room-ava" data-z="${z}"></span><div><h2>${ZONES[z].name}</h2><span class="k">${d.line}</span></div></div>
    <div><h3 class="eyebrow">Here now · ${d.people.length}</h3><div class="people">${d.people.map((c) => `<button data-id="${esc(c.u.id)}">${avatarHTML(c, 'pav sm')}${esc(short(c.u))}</button>`).join('') || '<span class="k">Nobody</span>'}</div></div>
    <ul class="tasks">${sortTasks(d.tasks).map((t) => taskItem(t, `${esc(short(t.c.u))} · ${ROLES[t.c.u.role]}`)).join('') || '<li class="k">No tasks here.</li>'}</ul>`;
  $('#drawer-body .people').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) focusChar(byId(b.dataset.id), true); });
}

// ---- Team panel: everyone's gender and role, and their order (drag to change): meeting seats and standup turns ----
let teamOpen = false, teamOrder = [];
const demoProfiles = {};
const options = (map, val, none) => (none ? `<option value="">${none}</option>` : '') + Object.entries(map).map(([k, l]) => `<option value="${k}"${k === val ? ' selected' : ''}>${l}</option>`).join('');
const ordered = () => [...chars].sort((a, b) => byOrder(teamOrder)(a.u, b.u));
function openTeam() { selected = null; roomOpen = null; teamOpen = true; $('#drawer-kind').textContent = 'Team'; renderTeam(); drawer.classList.add('open'); }
function renderTeam() {
  $('#drawer-body').innerHTML = `
    <ul class="team">${ordered().map((c, i) => `<li data-id="${esc(c.u.id)}">
      <div class="trow"><span class="grip" aria-hidden="true">⋮⋮</span><b class="tno">${i + 1}</b>
      <button class="tname" title="Show in the office">${avatarHTML(c, 'pav sm')}<span>${esc(fullName(c.u))}</span></button></div>
      <div class="tsel">
        <select data-f="gender" aria-label="Gender">${options(GENDERS, c.u.gender, 'Gender —')}</select>
        <select data-f="role" aria-label="Role">${options(ROLES, c.u.role)}</select>
      </div></li>`).join('') || '<li class="k">The team has not loaded yet.</li>'}</ul>`;
}
const body = $('#drawer-body');
async function put(url, data) {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Dashboard': '1' }, body: JSON.stringify(data) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}
// A server started before an update keeps only what it knows: say so instead of looking saved.
const STALE = 'the server did not keep it. Restart it (npm start or the app) to pick up the update';
body.addEventListener('click', (e) => {
  const b = teamOpen && e.target.closest('.tname');
  if (b) focusChar(byId(b.closest('li').dataset.id), false);
});
body.addEventListener('change', async (e) => {
  const sel = e.target.closest('.team select'); if (!sel) return;
  const c = byId(sel.closest('li').dataset.id); if (!c) return;
  const profile = { gender: c.u.gender, role: c.u.role, [sel.dataset.f]: sel.value || null };
  if (DEMO) demoProfiles[c.u.id] = profile; // no server: kept for this visit
  else {
    try {
      const kept = (await put('/api/office/people', { accountId: c.u.id, profile })).people?.[c.u.id] || {};
      if (Object.entries(profile).some(([k, val]) => val && kept[k] !== val)) throw new Error(STALE);
    } catch (err) {
      toast(`Could not save: ${err.message}`);
      return renderTeam();
    }
  }
  setProfile(c, profile);
  renderTeam();
});
// Reordering: drag a card by anything but its menus. It lifts and follows the pointer, the others slide out of its
// way, the list scrolls near its edges; dropping saves the new order.
async function saveOrder(order) {
  if (order.join() === ordered().map((c) => c.u.id).join()) return renderTeam();
  const was = teamOrder; teamOrder = order;
  if (!DEMO) {
    try {
      const kept = (await put('/api/office/order', { order })).order;
      if (!kept || kept.join() !== order.join()) throw new Error(STALE);
    } catch (err) {
      toast(`Could not save the order: ${err.message}`);
      teamOrder = was;
    }
  }
  renderTeam(); replan();
}
const domOrder = () => [...body.querySelectorAll('.team li[data-id]')].map((li) => li.dataset.id);
let sorting = null; // { li, id, x0, y0, y, on, ph, off, raf }
body.addEventListener('pointerdown', (e) => {
  const li = teamOpen && e.button === 0 && !sorting && e.target.closest('.team li[data-id]');
  if (!li || e.target.closest('select')) return;
  sorting = { li, id: e.pointerId, x0: e.clientX, y0: e.clientY, y: e.clientY, on: false };
});
function liftCard(e) {
  const S = sorting, r = S.li.getBoundingClientRect();
  S.on = true; S.off = e.clientY - r.top;
  S.ph = document.createElement('li'); S.ph.className = 'tph'; S.ph.style.height = `${r.height}px`;
  S.li.before(S.ph);
  Object.assign(S.li.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, zIndex: 50, pointerEvents: 'none' });
  S.li.classList.add('dragging'); body.classList.add('sorting');
  try { body.setPointerCapture(e.pointerId); } catch {}
  const scroll = () => { // keeps scrolling while the pointer rests near an edge
    if (sorting !== S) return;
    const b = body.getBoundingClientRect(), edge = 48;
    const v = S.y < b.top + edge ? -(b.top + edge - S.y) : S.y > b.bottom - edge ? S.y - (b.bottom - edge) : 0;
    if (v) { body.scrollTop += v * 0.35; placeHolder(); }
    S.raf = requestAnimationFrame(scroll);
  };
  S.raf = requestAnimationFrame(scroll);
}
// Moves the gap to where the pointer is; the cards it passes slide (FLIP).
function placeHolder() {
  const S = sorting, others = [...body.querySelectorAll('.team li[data-id]')].filter((x) => x !== S.li);
  const before = others.find((x) => { const b = x.getBoundingClientRect(); return S.y < b.top + b.height / 2; }) || null;
  if (S.ph.nextElementSibling === before && (before || !S.ph.nextElementSibling)) return;
  const tops = new Map(others.map((x) => [x, x.getBoundingClientRect().top]));
  S.li.parentNode.insertBefore(S.ph, before);
  for (const x of others) {
    const d = tops.get(x) - x.getBoundingClientRect().top; if (!d) continue;
    x.style.transition = 'none'; x.style.transform = `translateY(${d}px)`;
    x.getBoundingClientRect(); // apply before animating back
    x.style.transition = 'transform .16s ease'; x.style.transform = '';
  }
}
body.addEventListener('pointermove', (e) => {
  const S = sorting; if (!S || e.pointerId !== S.id) return;
  S.y = e.clientY;
  if (!S.on) { if (Math.hypot(e.clientX - S.x0, e.clientY - S.y0) < 4) return; liftCard(e); } // a click on the name stays a click
  e.preventDefault();
  S.li.style.top = `${e.clientY - S.off}px`;
  placeHolder();
});
function endDrag(e) {
  const S = sorting; if (!S || e.pointerId !== S.id) return;
  sorting = null;
  if (!S.on) return;
  cancelAnimationFrame(S.raf);
  const to = S.ph.getBoundingClientRect().top;
  S.li.style.transition = 'top .14s ease'; S.li.style.top = `${to}px`;
  setTimeout(() => {
    S.ph.replaceWith(S.li); S.li.removeAttribute('style'); S.li.classList.remove('dragging'); body.classList.remove('sorting');
    body.querySelectorAll('.team li[data-id]').forEach((x) => x.removeAttribute('style'));
    saveOrder(domOrder());
  }, 150);
}
body.addEventListener('pointerup', endDrag);
body.addEventListener('pointercancel', endDrag);
// A changed profile shows at once: a new look for a new gender, a walk to the other room for a new role.
function setProfile(c, p) {
  const look = c.u.gender !== p.gender;
  c.u = { ...c.u, gender: p.gender, role: p.role };
  if (look) reskin(c);
  retarget(c);
  updateTag(c); refreshRooms();
}
$('#t-team').addEventListener('click', () => (teamOpen ? closeDrawer() : openTeam()));

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
  hoverSign(null);
  $('.app').classList.toggle('room-mode', on);
  $('#roomhead').hidden = !on;
  if (on) renderRoomHead();
}
function renderRoomHead() {
  const z = rv.room; if (!z) return;
  $('#roomhead').dataset.z = z;
  $('#rh-name').textContent = ZONES[z].name;
  $('#rh-line').textContent = roomData(z).line + (z === 'dev' && ciState ? ` · build ${ciState === 'failed' ? 'red' : 'green'}` : '');
}
const stepRoom = (d) => viewRoom(ROOM_ORDER[(ROOM_ORDER.indexOf(rv.room) + d + ROOM_ORDER.length) % ROOM_ORDER.length]);
$('#room-exit').addEventListener('click', exitRoom);
$('#room-prev').addEventListener('click', () => stepRoom(-1));
$('#room-next').addEventListener('click', () => stepRoom(1));
function markFocus() {
  // In a room, hide people outside it, and the name tag of anyone sitting behind a desk badge.
  for (const c of chars) c.tag.classList.toggle('far', !!rv.room && (zoneAt(c.pos.x, c.pos.z) !== rv.room || (!!c.seat && !!c.seat.desk && c.sitting)));
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

// ---- The office's day: hours, standup, lunch, sprint planning / retro (scheduleAt); the red button calls a meeting ----
let schedule = {}, sprint = null;
// ?time=HH:MM shows the office at that time of today (to check the schedule).
const AT = hm(new URLSearchParams(location.search).get('time'));
const nowTime = () => { const d = new Date(); if (AT !== null) d.setHours(Math.floor(AT / 60), AT % 60, 0, 0); return d; };
function meetLine() {
  if (meeting) return 'Meeting now';
  if (sched.kind === 'planning' || sched.kind === 'retro') return `${sched.name} until ${sched.until}`;
  return sched.next && sched.next.kind !== 'lunch' ? `Next: ${sched.next.name} at ${sched.next.at}` : 'No meeting until tomorrow';
}
// Seats and spots for whoever is called in, in the Team panel's order; then everyone goes where they belong now.
function replan(teleport = false) {
  const list = ordered();
  const seated = list.filter((c) => placeOf(c) === 'meeting');
  const standing = list.filter((c) => placeOf(c) === 'standup');
  for (const c of list) {
    const seat = MEET_ORDER[seated.indexOf(c)] || null, spot = STAND_SPOTS[standing.indexOf(c)] || null;
    if (seat !== (c.meetSeat || null) || spot !== (c.standSpot || null)) { c.meetSeat = seat; c.standSpot = spot; if (c.place === 'meeting' || c.place === 'standup') c.place = null; }
  }
  for (const c of chars) retarget(c, teleport);
  refreshRooms(); updateLines();
}
function updateLines() { drawMeetScreen(meetLine(), sprint, chars); }
function tickSchedule(force = false) {
  const s = scheduleAt(nowTime(), schedule, sprint);
  if (DEMO && s.kind === 'off') Object.assign(s, { kind: 'work', name: 'Working' }); // the demo is always open
  const changed = s.kind !== sched.kind;
  sched = s;
  if (changed && !force) { chars.forEach(cancelErrands); replan(); } else updateLines();
}
setInterval(() => tickSchedule(), 20_000);

let pressedAt = -1;
function setMeeting(on) {
  if (!player) return; // the team has not loaded yet
  meeting = on;
  chars.forEach(cancelErrands);
  meetDome.material.color.set(on ? '#2f9e5b' : '#e0352b'); meetDome.material.emissive.set(on ? '#0c3d1f' : '#7a0d08');
  pressedAt = performance.now();
  replan();
  if (on) { setFollow(false); camGoal = v(TABLE.x, TABLE.z); view.zoomT = Math.max(view.zoomT, 1.4); }
}
// Pressed: the dome dips, then springs back.
function pressMeetButton() {
  const t = (performance.now() - pressedAt) / 250;
  meetDome.position.y = t < 1 ? 0.12 - 0.08 * Math.sin(t * Math.PI) : 0.12;
}
// Standup and meetings: one person at a time, in the Team panel's order, says what they are on.
let turn = 0;
setInterval(() => {
  if (document.hidden) return;
  const here = ordered().filter((c) => (c.place === 'standup' || c.place === 'meeting') && !c.path.length);
  if (!here.length) return;
  const c = here[turn++ % here.length], t = currentTask(c.u);
  say(c, t ? `${t.k} · ${trunc(t.s, 40)} (${t.statusName})` : 'All done, nothing open');
}, 4500);

// ---- Data: /api/team-sprint, polled; differences between two loads play as scenes ----
const POLL_MS = 90_000;
let loading = false, loadedOnce = false;
// Errors (loading, saving) show for a few seconds at the top.
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 6000);
}
async function load({ fresh = false } = {}) {
  if (DEMO) {
    const d = loadedOnce ? DEMO.tick() : DEMO.data();
    applyData({ ...d, order: teamOrder, members: d.members.map((m) => ({ ...m, ...demoProfiles[m.accountId] })) });
    return;
  }
  if (loading) return;
  loading = true;
  try {
    const params = new URLSearchParams();
    if (SPRINT) params.set('sprint', SPRINT);
    if (fresh) params.set('fresh', '1');
    const res = await fetch(`/api/team-sprint${params.size ? '?' + params : ''}`, { headers: { 'X-Dashboard': '1' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    applyData(data);
    $('#empty').hidden = chars.length > 1 || !!data.sprint;
  } catch (e) {
    toast(`Could not load the team: ${e.message}`);
  } finally {
    loading = false;
  }
}
function applyData(data) {
  sprint = data.sprint || null; schedule = data.schedule || {}; teamOrder = data.order || teamOrder;
  tickSchedule(true);
  const first = !loadedOnce;
  loadedOnce = true;
  const seen = new Set(), moves = [];
  for (const u of toPeople(data.members || [])) {
    seen.add(u.id);
    let c = byId(u.id);
    if (!c) {
      c = addPerson(u); c.state = stateOf(u);
      if (!first) c.group.visible = false; // walks in from the corridor's end
      updateTag(c);
      continue;
    }
    const changes = diffTasks(c.u.tasks, u.tasks);
    const look = c.u.gender !== u.gender;
    c.u = u; c.state = stateOf(u);
    if (look) reskin(c); // changed in another window
    const done = changes.find((ch) => ch.kind === 'move' && ch.task.st === 'done');
    updateTag(c, done ? `✓ ${done.task.k}` : ''); if (done) setTimeout(() => chars.includes(c) && updateTag(c), 2400);
    if (changes.length) moves.push([c, changes.find((ch) => ch.kind === 'move') || changes[0]]);
    const mine = !DEMO && c.isPlayer && changes.find((ch) => ch.kind === 'new');
    if (mine) goBoard(c, mine.task.k); // created for you: no "assigned" in the changelog
  }
  for (const c of [...chars]) if (!seen.has(c.u.id) && !c.isPlayer) { if (selected === c) closeDrawer(); removePerson(c); }
  for (const c of chars) c.lastAct = lastAct.get(c.u.id) || 0;
  replan(first);
  // Live, the activity (activity.js) plays what happened, with who did it; the demo has only its task moves.
  if (DEMO) enqueue(moves.map(([c, ch]) => demoEvent(c, ch)));
  else if (first) loadEvents();
  if (selected) renderDrawer();
  if (teamOpen && !sorting && !drawer.contains(document.activeElement)) renderTeam(); // not while a choice is open or a card is dragged
}
setInterval(() => { if (!document.hidden) load(); }, DEMO ? 6000 : POLL_MS); // the demo moves a task every few seconds

function stepEffects(dt, time) {
  stepFlows(dt);
  warLight.intensity = warLight.userData.on ? 0.35 + 0.35 * Math.sin(time * 2.2) : 0;
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
function signAt(x, y) {
  if (rv.room) return null;
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, viewCam);
  return ray.intersectObjects(signs, false)[0]?.object.userData.zone || null;
}
function hit(x, y) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, viewCam);
  const h = ray.intersectObjects(pickables, false).find((x) => x.object.userData.char.group.visible);
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
  if (drag && !drag.moved && drag.button === 0 && e.type === 'pointerup') {
    const h = hit(e.clientX, e.clientY);
    const inRoom = h.floor && zoneAt(h.floor.point.x, h.floor.point.z) === rv.room;
    const sign = signAt(e.clientX, e.clientY);
    if (sign) viewRoom(sign);
    else if (overMeetButton(e.clientX, e.clientY)) setMeeting(!meeting);
    else if (h.char) openDrawer(h.char);
    else if (rv.room && !inRoom) exitRoom(); // clicking outside the room leaves it
  }
  if (pointers.size < 2) pinch = null;
  if (!pointers.size) { drag = null; canvas.classList.remove('dragging'); }
}
canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('dblclick', (e) => { const h = hit(e.clientX, e.clientY), z = h.floor && zoneAt(h.floor.point.x, h.floor.point.z); if (z) viewRoom(z); });
canvas.addEventListener('pointerleave', () => { mouse = null; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

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
});
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
  ringMat.color.set(COL.accent); selRing.material.color.set(COL.fg);
  resetGlow();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
try { if (window.parent !== window) new MutationObserver(applyTheme).observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ['class'] }); } catch {}

// ---- Boot ----
applyTheme(); refreshRooms(); tickSchedule(true);
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
  for (const c of chars) stepChar(c, dt, time);
  stepEffects(dt, time);
  updateWalls();
  updateCamera();
  renderer.render(scene, viewCam);
  placeTags(); placeDetails(); pressMeetButton();
  if (frameN % 10 === 0) markFocus();
  if (rv.room && frameN % 90 === 0) buildDetails(); // people come and go
  if ((frameN++ & 1) === 0) {
    const h = mouse && !drag ? hit(mouse.x, mouse.y).char || null : null;
    hoverChar(h);
    const sign = mouse && !drag ? signAt(mouse.x, mouse.y) : null;
    if (!rv.room) hoverSign(sign);
    canvas.classList.toggle('over', !!h || !!sign || (!!mouse && !drag && overMeetButton(mouse.x, mouse.y)));
    showTip(h, mouse?.lx, mouse?.ly);
  }
}
requestAnimationFrame(frame);
