'use strict';

// 3D office: blocky people with a name tag, walking between rooms along door / aisle waypoints to a seat or a spot,
// running errands to each other (hand-offs), and speech bubbles. People come from the data (addPerson).

const v = (x, z) => new THREE.Vector3(x, 0, z);
const SCALE = 0.8;
let meeting = false; // "Meeting": everyone takes a seat at the meeting table

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
const marker = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.26, 32), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
marker.rotation.x = -Math.PI / 2; marker.position.y = 0.04; scene.add(marker);

function addPerson(u) {
  const r = makeRig(u);
  const group = new THREE.Group(); group.add(r.rig); scene.add(group);
  const c = { u, ...r, group, pos: group.position, path: [], wait: rand(0, 3), zone: null, place: null, state: null, seat: null, sitting: false, phase: rand(0, 6), yaw: 0, yawT: 0, isPlayer: !!u.me, baseSpeed: u.me ? 4.2 : rand(1.9, 2.4), speed: 4.2, dim: false, hi: false, errands: [], errand: null };
  r.rig.traverse((o) => { if (o.isMesh) { o.userData.char = c; pickables.push(o); } });
  c.tag = document.createElement('div'); tagsEl.append(c.tag);
  c.bubble = document.createElement('div'); c.bubble.className = 'say'; c.bubble.hidden = true; tagsEl.append(c.bubble);
  if (c.isPlayer) { player = c; group.add(playerRing); }
  chars.push(c);
  return c;
}
function removePerson(c) {
  releaseSeat(c); scene.remove(c.group); c.tag.remove(); c.bubble.remove();
  c.rig.traverse((o) => { if (o.isMesh) { const i = pickables.indexOf(o); if (i >= 0) pickables.splice(i, 1); } });
  chars.splice(chars.indexOf(c), 1);
}

function updateTag(c, flash) {
  const late = c.u.tasks.some(isLate);
  c.tag.className = 'tag' + (c.isPlayer ? ' me' : '') + (c.hi ? ' hi' : '') + (c.dim ? ' dim' : '') + (c.state === 'urgent' ? ' urgent' : '');
  c.tag.innerHTML = `<i style="background:var(--${STATES[c.state].color})"></i>${esc(short(c.u))}<small>${ROLES[c.u.role]}</small>`
    + (late ? '<span class="late">Overdue</span>' : '') + (isIdle(c.u) ? '<span class="idle">stale</span>' : '')
    + (flash ? `<b class="flash">${esc(flash)}</b>` : '');
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
  s.owner = null; c.seat = null; c.sitting = false;
  if (s.desk) { s.desk.owner = null; setScreen(s.desk); }
}

// ---- Paths ----
function freeSpot([x0, x1, z0, z1]) {
  for (let i = 0; i < 30; i++) { const p = v(rand(x0, x1), rand(z0, z1)); if (!blocked(p.x, p.z, 0.5)) return p; }
  return v((x0 + x1) / 2, (z0 + z1) / 2);
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
// Send a person where they belong now: a seat or spot in their zone, or the meeting table during a meeting.
function retarget(c, teleport = false) {
  const place = meeting ? 'meeting' : zoneOf(c.u);
  if (c.errand || (place === c.place && !teleport)) return; // an errand sends them home when it ends
  const prev = { pos: c.pos, seat: c.seat, sitting: c.sitting };
  releaseSeat(c); c.place = place;
  c.speed = c.baseSpeed * (meeting ? 1.7 : 1); // hurry to the meeting
  const z = place === 'meeting' ? 'review' : place; c.zone = z;
  const kind = z === 'review' ? 'meet' : z === 'dev' || z === 'qa' ? z : z === 'done' ? 'sofa' : null;
  const seat = kind && SEATS.find((s) => s.kind === kind && !s.owner);
  let target;
  if (seat) { takeSeat(c, seat); target = v(seat.x, seat.z); } else target = freeSpot(ZONES[z].wander);
  if (teleport) { c.pos.copy(target); c.path = []; if (seat) { c.sitting = true; c.yaw = c.yawT = seat.yaw; } return; }
  c.path = route(prev, z, seat ? seat.via : [], target);
  c.sitting = false; c.wait = rand(2, 5);
}
function wander(c) {
  if (!c.seat) c.path = [freeSpot(ZONES[c.zone].wander)];
  c.wait = (c.zone === 'done' ? rand(5, 10) : rand(3, 7)) * (reduceMotion ? 2 : 1);
}
function goTo(p) {
  let x = clamp(p.x, -20.5, 20.5), z = clamp(p.z, -12.5, 12.5);
  if (blocked(x, z, 0.3)) { const s = freeSpot([x - 1.2, x + 1.2, z - 1.2, z + 1.2]); x = s.x; z = s.z; }
  player.path = route(player, zoneAt(x, z), [], v(x, z));
  releaseSeat(player); player.place = null;
  marker.position.x = x; marker.position.z = z; marker.material.opacity = 1;
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
  if (c.isPlayer || meeting) return;
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
  let moving = !!c.keyMoving;
  if (moving && c.seat) { releaseSeat(c); c.place = null; }
  if (c.path.length) {
    const p = c.path[0], dx = p.x - c.pos.x, dz = p.z - c.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.06) c.path.shift();
    else { const s = Math.min(d, c.speed * dt); c.pos.x += (dx / d) * s; c.pos.z += (dz / d) * s; c.yawT = Math.atan2(dx, dz); moving = true; }
    c.sitting = false;
  } else if (c.errand) {
    if (c.errandT === null) arriveErrand(c);
    if ((c.errandT -= dt) <= 0) nextErrand(c);
  } else if (c.seat) { c.sitting = true; c.yawT = c.seat.yaw; c.card.visible = false; }
  else if (!c.isPlayer) {
    c.card.visible = false;
    c.wait -= dt; if (c.wait <= 0) wander(c);
    if (ZONES[c.zone].face !== undefined) c.yawT = ZONES[c.zone].face;
  }
  if (!c.isPlayer && !c.errand && !moving && !c.sitting && player && Math.hypot(player.pos.x - c.pos.x, player.pos.z - c.pos.z) < 2.4) c.yawT = Math.atan2(player.pos.x - c.pos.x, player.pos.z - c.pos.z);
  c.yaw = lerpAngle(c.yaw, c.yawT, Math.min(1, dt * 10)); c.group.rotation.y = c.yaw;

  const k = Math.min(1, dt * 10);
  let leg = 0, armL = 0, armR = 0, bob = 0, head = 0, turn = 0;
  if (moving) {
    c.phase += dt * c.speed * 3.4; const s = Math.sin(c.phase);
    leg = s * 0.7; armL = -s * 0.55; armR = s * 0.55; bob = Math.abs(Math.cos(c.phase)) * 0.04;
  } else if (c.sitting) {
    leg = -Math.PI / 2; bob = -0.12;
    // At the meeting table: listening, now and then talking with one hand.
    if (c.seat.kind === 'meet') { armL = -0.9; armR = -0.9 + Math.max(0, Math.sin(time * 0.9 + c.phase)) * -0.5; turn = Math.sin(time * 0.4 + c.phase) * 0.35; }
    else if (c.seat.kind === 'sofa') { armL = -0.35; armR = -0.6; turn = Math.sin(time * 0.5 + c.phase) * 0.5; } // chatting on the sofa
    else if (isIdle(c.u)) { armL = armR = -0.3; head = 0.35; }
    else if (c.seat.kind === 'qa') { armL = -1.5 + Math.sin(time * 3 + c.phase) * 0.08; armR = -1.2 + Math.sin(time * 9 + c.phase) * 0.12; head = 0.25; } // testing on a phone
    else { armL = -1.2 + Math.sin(time * 16 + c.phase) * 0.05; armR = -1.2 + Math.sin(time * 16 + c.phase + 1.7) * 0.05; }
  } else if (c.errand && c.errandT !== null) {
    if (c.errand.pose === 'board') armR = -2.7 + Math.sin(time * 4) * 0.1; // putting a card on the board
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
