'use strict';

// 3D office: blocky people with a name tag, walking between rooms along door / aisle waypoints to a seat or a spot,
// running errands to each other (hand-offs), and speech bubbles. People come from the data (addPerson).

const v = (x, z) => new THREE.Vector3(x, 0, z);
const SCALE = 0.8;
let meeting = false; // "Meeting": everyone takes a seat at the meeting table
let sched = { kind: 'work' }; // the office's day now (scheduleAt), set by app.js

function makeRig(u) {
  const S = skinOf(u), mats = [];
  const mk = (w, h, d, faces) => {
    const ms = faces.map((cv) => { const m = new THREE.MeshLambertMaterial({ map: tex(cv, 0, 0, true) }); mats.push(m); return m; });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), ms); mesh.castShadow = true; return mesh;
  };
  const rig = new THREE.Group(); rig.scale.setScalar(SCALE);
  const legF = legFaces(S), armF = armFaces(S);
  const legs = [-0.125, 0.125].map((x) => { const p = new THREE.Group(); p.position.set(x, 0.75, 0); const m = mk(0.25, 0.75, 0.25, legF); m.position.y = -0.375; p.add(m); rig.add(p); return p; });
  const body = mk(0.5, 0.75, 0.25, bodyFaces(S)); body.position.y = 1.125; rig.add(body);
  const arms = [-0.375, 0.375].map((x) => { const p = new THREE.Group(); p.position.set(x, 1.5, 0); const m = mk(0.25, 0.75, 0.25, armF); m.position.y = -0.33; p.add(m); rig.add(p); return p; });
  const headG = new THREE.Group(); headG.position.y = 1.5; rig.add(headG);
  const h = mk(0.5, 0.5, 0.5, headFaces(S)); h.position.y = 0.25; headG.add(h);
  if (S.female) { const hair = mk(0.54, 0.5, 0.14, solidFaces(S.hair)); hair.position.set(0, 0.06, -0.21); headG.add(hair); } // falls to the shoulders
  if (S.skirt) { const sk = mk(0.56, 0.34, 0.32, solidFaces(S.skirt)); sk.position.y = 0.6; rig.add(sk); }
  // A task card (right hand) for hand-offs, a test phone (left hand) for QA at their desk.
  const card = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, 0.04), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  card.position.set(0, -0.72, 0.16); card.visible = false; arms[1].add(card);
  const phone = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.34, 0.04), new THREE.MeshBasicMaterial({ color: '#9fd0ff' }));
  phone.position.set(0.04, -0.72, 0.16); phone.visible = false; arms[0].add(phone);
  return { rig, legs, arms, headG, mats, color: S.shirt, card, phone };
}
const initials = (u) => baseName(u.name).split(' ').slice(-2).map((w) => w[0] || '').join('').toUpperCase();
// Initials on the shirt colour: dark letters on the light shirts (white, beige), white on the rest.
const isLight = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 170; };
const avatarHTML = (c, cls = 'pav') => `<span class="${cls}" style="background:${c.color};color:${isLight(c.color) ? '#1d2a2c' : '#fff'};text-shadow:none">${esc(initials(c.u))}</span>`;

const pickables = [];
const tagsEl = $('#tags');
const chars = [];
let player = null;
const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
const playerRing = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 40), ringMat);
playerRing.rotation.x = -Math.PI / 2; playerRing.position.y = 0.04;
const selRing = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.6, 40), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false }));
selRing.rotation.x = -Math.PI / 2; selRing.visible = false; scene.add(selRing);

function addPerson(u) {
  const r = makeRig(u);
  const group = new THREE.Group(); group.add(r.rig); scene.add(group);
  const c = { u, ...r, group, pos: group.position, path: [], wait: rand(0, 3), zone: null, place: null, state: null, seat: null, sitting: false, phase: rand(0, 6), yaw: 0, yawT: 0, isPlayer: !!u.me, baseSpeed: rand(1.9, 2.4), speed: 2.2, dim: false, hi: false, errands: [], errand: null };
  r.rig.traverse((o) => { if (o.isMesh) { o.userData.char = c; pickables.push(o); } });
  c.tag = document.createElement('div'); tagsEl.append(c.tag);
  c.bubble = document.createElement('div'); c.bubble.className = 'say'; c.bubble.hidden = true; tagsEl.append(c.bubble);
  if (c.isPlayer) { player = c; group.add(playerRing); }
  chars.push(c);
  return c;
}
// A new look (gender changed): swap the rig, keep where they are and what they do.
function reskin(c) {
  c.rig.traverse((o) => { if (o.isMesh) { const i = pickables.indexOf(o); if (i >= 0) pickables.splice(i, 1); } });
  c.group.remove(c.rig);
  const r = makeRig(c.u); Object.assign(c, r, { hi: false, dim: false }); c.group.add(r.rig);
  r.rig.traverse((o) => { if (o.isMesh) { o.userData.char = c; pickables.push(o); } });
}
function removePerson(c) {
  releaseSeat(c); if (c.home) c.home.claim = null; scene.remove(c.group); c.tag.remove(); c.bubble.remove();
  c.rig.traverse((o) => { if (o.isMesh) { const i = pickables.indexOf(o); if (i >= 0) pickables.splice(i, 1); } });
  chars.splice(chars.indexOf(c), 1);
}

function updateTag(c, flash) {
  c.tag.className = 'tag' + (c.isPlayer ? ' me' : '') + (c.hi ? ' hi' : '') + (c.dim ? ' dim' : '') + (c.state === 'urgent' ? ' urgent' : '');
  c.tag.dataset.z = c.state; // coloured like the state badge
  c.tag.innerHTML = esc(short(c.u)) + (flash ? `<b class="flash">${esc(flash)}</b>` : '');
}
function setHighlight(c, on) {
  if (c.hi === on) return; c.hi = on;
  for (const m of c.mats) m.emissive.setHex(on ? 0x2a2a2a : 0x000000);
  updateTag(c);
}
function setDim(c, on) {
  if (c.dim === on) return; c.dim = on;
  for (const m of c.mats) { m.transparent = on; m.opacity = on ? 0.25 : 1; m.needsUpdate = true; }
  updateTag(c);
}

// ---- Seats: desk chairs in the Dev / QA rooms, meeting chairs (Review, or everyone during a meeting), the sofa ----
const SEATS = [
  ...DESKS.map((d) => ({ kind: d.room, x: d.x, z: d.seatZ, yaw: Math.PI, via: [v(d.aisleX, d.entryZ), v(d.aisleX, d.seatZ)], desk: d, owner: null })),
  ...MEET_SEATS.map((s) => ({ kind: 'meet', x: s.x, z: s.z, yaw: s.yaw, via: s.via.map(([x, z]) => v(x, z)), owner: null })),
  ...SOFA_SEATS.map((s) => ({ kind: 'sofa', x: s.x, z: s.z, yaw: s.yaw, via: s.via.map(([x, z]) => v(x, z)), owner: null })),
];
function takeSeat(c, s) { s.owner = c; c.seat = s; if (s.desk) { s.desk.owner = c; setScreen(s.desk); } }
function releaseSeat(c) {
  const s = c.seat; if (!s) return;
  c.seat = null; c.sitting = false;
  if (s.owner !== c) return; // someone higher up took it for a meeting
  s.owner = null;
  if (s.desk) { s.desk.owner = null; setScreen(s.desk); }
}
// Meeting seats, best first: the head of the table (by the screen), then pair by pair down both sides, the foot last.
const MEET_ORDER = SEATS.filter((s) => s.kind === 'meet').sort((a, b) => a.z - b.z || a.x - b.x);
// Standup: three rows facing the sprint board, front row first.
const STAND_SPOTS = [-18.6, -17.3, -16].flatMap((x) => [4.4, 5.3, 6.2, 7.1, 8, 8.9, 9.8].map((z) => v(x, z)));
// Everyone keeps their own desk in their role's room; it stays theirs (screen off) while they are elsewhere.
function homeSeat(c, kind) {
  if (c.home && c.home.kind === kind) return c.home;
  if (c.home) c.home.claim = null;
  c.home = SEATS.find((s) => s.kind === kind && !s.claim) || null;
  if (c.home) c.home.claim = c;
  return c.home;
}
// Where a person should be now (you too: your character goes where your work and the day take it).
function placeOf(c) {
  if (meeting) return 'meeting';
  const z = zoneOf(c.u);
  if (sched.kind === 'off') return isActive(c.u) || Date.now() - (c.lastAct || 0) < 3_600_000 ? z : 'away';
  if (z === 'urgent') return z; // Highest-priority work skips meetings and lunch
  if (sched.kind === 'lunch') return 'lunch';
  if (sched.kind === 'standup') return 'standup';
  if (sched.kind === 'planning' || sched.kind === 'retro') return 'meeting';
  return z;
}
const PLACE_ZONE = { meeting: 'review', lunch: 'done', standup: 'todo' };

// ---- Paths ----
// A free spot in the rect, away from where others are headed when there is room.
function freeSpot([x0, x1, z0, z1], self = null) {
  let any = null;
  for (let i = 0; i < 40; i++) {
    const p = v(rand(x0, x1), rand(z0, z1)); if (blocked(p.x, p.z, 0.5)) continue;
    if (!chars.some((o) => o !== self && o.goal && o.goal.distanceTo(p) < 0.9)) return p;
    any ??= p;
  }
  return any || v((x0 + x1) / 2, (z0 + z1) / 2);
}
const doorsOut = (z) => ZONES[z].doors.map(([x, zz]) => v(x, zz));
const doorsIn = (z) => doorsOut(z).reverse();
// Waypoints from where c stands to `target` in zone `to`: up out of a seat, out through the doors of the
// current zone, in through the doors of the next one (doors are skipped when staying in the same zone).
function route(c, to, via, target) {
  const from = zoneAt(c.pos.x, c.pos.z), pts = c.seat && c.sitting ? [...c.seat.via].reverse() : [];
  if (from !== to) { if (from) pts.push(...doorsOut(from)); if (to) pts.push(...doorsIn(to)); }
  return [...pts, ...via, target];
}
// Send a person where they belong now (placeOf): their desk, the war room, the pantry, the standup in front of the
// sprint board, their seat at the meeting table (c.meetSeat, c.standSpot: app.js replan), or home (hidden).
function retarget(c, teleport = false) {
  const place = placeOf(c);
  if (c.errand || (place === c.place && !teleport)) return; // an errand sends them home when it ends
  const prev = { pos: c.pos, seat: c.seat, sitting: c.sitting };
  releaseSeat(c); c.place = place;
  if (place === 'away') { c.group.visible = false; c.path = []; c.goal = null; c.zone = null; return; }
  if (!c.group.visible) { c.group.visible = true; if (!teleport) { c.pos.set(20.4, 0, 0); prev.seat = null; } } // in from the corridor's end
  c.speed = c.baseSpeed * (place === 'meeting' || place === 'standup' ? 1.5 : 1); // don't keep the others waiting
  const z = PLACE_ZONE[place] || place; c.zone = z;
  // PO and PM work at the meeting table from its foot, leaving the head free.
  const seat = place === 'meeting' ? c.meetSeat : z === 'dev' || z === 'qa' ? homeSeat(c, z) : z === 'review' ? [...MEET_ORDER].reverse().find((s) => !s.owner) : z === 'done' ? SEATS.find((s) => s.kind === 'sofa' && !s.owner) : null;
  let target;
  if (seat) { takeSeat(c, seat); target = v(seat.x, seat.z); } else target = (place === 'standup' && c.standSpot) || freeSpot(ZONES[z].wander, c);
  c.goal = target;
  if (teleport) { c.pos.copy(target); c.path = []; if (seat) { c.sitting = true; c.yaw = c.yawT = seat.yaw; } return; }
  c.path = route(prev, z, seat ? seat.via : [], target);
  c.sitting = false; c.wait = rand(6, 12);
}
// Only people with nothing left to do drift around the pantry; everyone else stays where their work is.
function wander(c) {
  if (!c.seat && c.place === 'done') { c.path = [freeSpot(ZONES.done.wander, c)]; c.goal = c.path[0]; }
  c.wait = rand(8, 16) * (reduceMotion ? 2 : 1);
}
// ---- Errands: walk somewhere (a spot or another person), do something there, then go back to one's place ----
// step: { to: Vector3 | target: person, via?, yaw?, say?, tone?, dur?, pose?: 'board'|'talk', card?: colour, onArrive? }
function nearPerson(t, from) {
  if (t.seat && t.seat.desk) { const d = t.seat.desk; return { to: v(t.seat.x + 1, t.seat.z), via: [v(d.aisleX, d.entryZ), v(d.aisleX, d.seatZ)] }; }
  const dx = from.x - t.pos.x, dz = from.z - t.pos.z, d = Math.hypot(dx, dz) || 1;
  let p = v(t.pos.x + (dx / d) * 1.1, t.pos.z + (dz / d) * 1.1);
  if (blocked(p.x, p.z, 0.3)) p = freeSpot([p.x - 1.2, p.x + 1.2, p.z - 1.2, p.z + 1.2]);
  return { to: p, via: [] };
}
function runErrands(c, steps, carryHome = null) {
  if (meeting) return;
  c.errands = steps; c.carryHome = carryHome; nextErrand(c);
}
function nextErrand(c) {
  const e = c.errands.shift();
  if (!e) { c.errand = null; c.place = null; c.card.visible = !!c.carryHome; if (c.carryHome) c.card.material.color.set(c.carryHome); retarget(c); return; }
  const dest = e.target ? nearPerson(e.target, c.pos) : { to: e.to, via: e.via || [] };
  c.path = route(c, zoneAt(dest.to.x, dest.to.z), dest.via, dest.to);
  releaseSeat(c); c.errand = e; c.errandT = null; c.place = 'errand';
  c.card.visible = !!e.card; if (e.card) c.card.material.color.set(e.card);
}
function cancelErrands(c) { c.errands = []; c.errand = null; c.card.visible = false; }
function arriveErrand(c) {
  const e = c.errand; c.errandT = e.dur ?? 1.8;
  if (e.target) c.yawT = Math.atan2(e.target.pos.x - c.pos.x, e.target.pos.z - c.pos.z); else if (e.yaw !== undefined) c.yawT = e.yaw;
  if (e.say) say(c, e.say, e.tone);
  if (e.onArrive) e.onArrive();
}

// Speech bubbles
function say(c, text, tone = '') {
  c.bubble.textContent = text; c.bubble.className = 'say' + (tone ? ' ' + tone : ''); c.bubble.hidden = false;
  c.sayUntil = performance.now() + 2800;
}

// Hand-off arcs: a card flies along a tube between two places, then the tube fades.
const flows = [];
function flow(a, b, color) {
  if (reduceMotion) return;
  const p0 = v(a.x, a.z).setY(1.2), p2 = v(b.x, b.z).setY(1.2), mid = p0.clone().lerp(p2, 0.5); mid.y = 2.8 + p0.distanceTo(p2) * 0.18;
  const curve = new THREE.QuadraticBezierCurve3(p0, mid, p2);
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.05, 6), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false }));
  const card = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 0.05), new THREE.MeshBasicMaterial({ color }));
  scene.add(tube, card); flows.push({ curve, tube, card, t: 0 });
}
function stepFlows(dt) {
  for (let i = flows.length - 1; i >= 0; i--) {
    const f = flows[i]; f.t += dt / 1.4;
    f.card.position.copy(f.curve.getPoint(Math.min(1, f.t))); f.card.rotation.y += dt * 3; f.card.visible = f.t < 1.05;
    if (f.t > 1) f.tube.material.opacity = Math.max(0, 0.75 * (1 - (f.t - 1) / 1.6));
    if (f.t > 2.6) { scene.remove(f.tube, f.card); f.tube.geometry.dispose(); flows.splice(i, 1); }
  }
}

// ---- Per-frame ----
const lerpAngle = (a, b, k) => a + (((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * k;
function stepChar(c, dt, time) {
  if (!c.group.visible) return; // gone home
  let moving = false;
  if (c.path.length) {
    const p = c.path[0], dx = p.x - c.pos.x, dz = p.z - c.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.06) c.path.shift();
    else { const s = Math.min(d, c.speed * dt); c.pos.x += (dx / d) * s; c.pos.z += (dz / d) * s; c.yawT = Math.atan2(dx, dz); moving = true; }
    c.sitting = false;
  } else if (c.errand) {
    if (c.errandT === null) arriveErrand(c);
    if ((c.errandT -= dt) <= 0) nextErrand(c);
  } else if (c.seat) { c.sitting = true; c.yawT = c.seat.yaw; c.card.visible = false; }
  else {
    c.card.visible = false;
    c.wait -= dt; if (c.wait <= 0) wander(c);
    if (ZONES[c.zone].face !== undefined) c.yawT = ZONES[c.zone].face;
  }
  c.yaw = lerpAngle(c.yaw, c.yawT, Math.min(1, dt * 10)); c.group.rotation.y = c.yaw;

  const k = Math.min(1, dt * 10);
  let leg = 0, armL = 0, armR = 0, bob = 0, head = 0, turn = 0;
  if (moving) {
    c.phase += dt * c.speed * 3.4; const s = Math.sin(c.phase);
    leg = s * 0.7; armL = -s * 0.55; armR = s * 0.55; bob = Math.abs(Math.cos(c.phase)) * 0.04;
  } else if (c.sitting) {
    leg = -Math.PI / 2; bob = -0.12;
    // At the meeting table: listening, now and then talking with one hand.
    if (c.seat.kind === 'meet' && c.place === 'meeting') { armL = -0.9; armR = -0.9 + Math.max(0, Math.sin(time * 0.9 + c.phase)) * -0.5; turn = Math.sin(time * 0.4 + c.phase) * 0.35; }
    else if (c.seat.kind === 'sofa') { armL = -0.35; armR = -0.6; turn = Math.sin(time * 0.5 + c.phase) * 0.5; } // chatting on the sofa
    else if (isIdle(c.u)) { armL = armR = -0.3; head = 0.35; }
    else if (c.seat.kind === 'qa') { armL = -1.5 + Math.sin(time * 3 + c.phase) * 0.08; armR = -1.2 + Math.sin(time * 9 + c.phase) * 0.12; head = 0.25; } // testing on a phone
    else { // typing: hard right after a push, steadily while their work moves, slowly otherwise
      const f = c.burst > performance.now() ? 22 : Date.now() - (c.lastAct || 0) < 1_800_000 ? 14 : 6, a = f > 14 ? 0.09 : 0.05;
      armL = -1.2 + Math.sin(time * f + c.phase) * a; armR = -1.2 + Math.sin(time * f + c.phase + 1.7) * a;
    }
  } else if (c.errand && c.errandT !== null) {
    const p = c.errand.pose;
    if (p === 'board') armR = -2.7 + Math.sin(time * 4) * 0.1; // putting a card on the board
    else if (p === 'exercise') { const j = Math.abs(Math.sin(time * 5 + c.phase)); armL = armR = -2.9 * j; bob = 0.18 * j; } // jumping jacks
    else if (p === 'stretch') { armL = armR = -3 + Math.sin(time * 1.2 + c.phase) * 0.15; head = -0.25; turn = Math.sin(time * 0.8) * 0.3; }
    else if (p === 'meditate') { armL = armR = -1.25; head = 0.3; bob = Math.sin(time * 1.1) * 0.02; } // hands together, breathing
    else if (p === 'drink') { armR = -1.9 + Math.max(0, Math.sin(time * 0.9 + c.phase)) * 0.6; armL = -0.15; }
    else if (p === 'look') { turn = Math.sin(time * 0.5 + c.phase) * 0.6; head = -0.1; } // looking around, out of the window
    else { armR = -0.6 + Math.sin(time * 5 + c.phase) * 0.35; armL = -0.2; } // talking
  } else { const br = Math.sin(time * 1.6 + c.phase) * 0.04; armL = br; armR = -br; }
  if (c.card.visible && !(c.errand && c.errandT !== null)) armR = -0.95; // holding the card out
  c.phone.visible = c.sitting && c.seat.kind === 'qa' && !isIdle(c.u);
  if (moving) { c.legs[0].rotation.x = leg; c.legs[1].rotation.x = -leg; c.arms[0].rotation.x = armL; c.arms[1].rotation.x = armR; }
  else for (const [o, t] of [[c.legs[0], leg], [c.legs[1], leg], [c.arms[0], armL], [c.arms[1], armR]]) o.rotation.x += (t - o.rotation.x) * k;
  c.headG.rotation.x += (head - c.headG.rotation.x) * k;
  c.headG.rotation.y += (turn - c.headG.rotation.y) * k;
  c.rig.position.y += (bob - c.rig.position.y) * Math.min(1, dt * 20);
}

const proj = new THREE.Vector3();
function placeTags() {
  const w = stage.clientWidth, h = stage.clientHeight, now = performance.now();
  for (const c of chars) {
    c.tag.hidden = !c.group.visible; if (c.tag.hidden) { c.bubble.hidden = true; continue; }
    proj.set(c.pos.x, c.sitting ? 1.95 : 2.1, c.pos.z).project(viewCam);
    const x = ((proj.x + 1) / 2) * w, y = ((1 - proj.y) / 2) * h;
    c.tag.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    c.tag.style.zIndex = String(1000 - Math.round(proj.z * 500));
    if (!c.bubble.hidden) {
      if (now > c.sayUntil) c.bubble.hidden = true;
      else { c.bubble.style.transform = `translate(${x}px, ${y - 26}px) translate(-50%, -100%)`; c.bubble.style.zIndex = '2000'; }
    }
  }
}
