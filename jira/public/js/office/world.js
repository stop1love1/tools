'use strict';

// 3D office: renderer, cameras (isometric overview, perspective room view), lights, floors, walls (the ones facing
// the camera hide), furniture, and the room screens that follow the sprint (updateRooms).

const $ = (s) => document.querySelector(s);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const stage = $('#stage');
const scene = new THREE.Scene();
scene.background = new THREE.Color();
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.prepend(renderer.domElement);

const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
const view = { target: new THREE.Vector3(1, 0, 0), az: Math.PI / 4, azT: Math.PI / 4, zoom: 1, zoomT: 1, el: 0.6 };
// Room view: a perspective camera orbiting one room; everything outside it is clipped away.
const pcam = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
const rv = { room: null, center: new THREE.Vector3(), az: 0, azT: 0, el: 0.62, elT: 0.62, dist: 20, distT: 20, dw: 0, dh: 0 };
let viewCam = cam;
const camAz = () => (rv.room ? rv.az : view.az);
function clipToRoom(z) {
  if (!z) { renderer.clippingPlanes = []; return; }
  const [x0, x1, z0, z1] = ZONES[z].rect, m = 0.45;
  renderer.clippingPlanes = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -(x0 - m)), new THREE.Plane(new THREE.Vector3(-1, 0, 0), x1 + m),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -(z0 - m)), new THREE.Plane(new THREE.Vector3(0, 0, -1), z1 + m),
  ];
}
function updateCamera() {
  const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
  if (rv.room) {
    // Render a larger virtual frame and show the part the drawer leaves free, so the room stays centred there.
    const W = w + rv.dw, H = h + rv.dh;
    pcam.aspect = W / H; pcam.setViewOffset(W, H, rv.dw, rv.dh, w, h); pcam.updateProjectionMatrix();
    pcam.position.set(rv.center.x + Math.sin(rv.az) * Math.cos(rv.el) * rv.dist, Math.sin(rv.el) * rv.dist, rv.center.z + Math.cos(rv.az) * Math.cos(rv.el) * rv.dist);
    pcam.lookAt(rv.center);
    return;
  }
  const H = 30 / view.zoom, W = (H * w) / h, D = 90;
  Object.assign(cam, { left: -W / 2, right: W / 2, top: H / 2, bottom: -H / 2 });
  cam.updateProjectionMatrix();
  cam.position.set(view.target.x + Math.sin(view.az) * Math.cos(view.el) * D, Math.sin(view.el) * D, view.target.z + Math.cos(view.az) * Math.cos(view.el) * D);
  cam.lookAt(view.target);
}
function fitZoom() { const w = stage.clientWidth || 1, h = stage.clientHeight || 1; return clamp(Math.min(30 / 31, (30 * w) / (50 * h)), 0.45, 1); }

const hemi = new THREE.HemisphereLight(0xffffff, 0x9aa6b0, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 0.6);
sun.position.set(-12, 34, 18); sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 22, bottom: -22, near: 1, far: 90 });
sun.shadow.bias = -0.001; sun.shadow.radius = 3;
scene.add(sun);
const lamps = [[-14, -7], [2, -7], [16, -7], [-14, 7], [2, 7], [16, 7]].map(([x, z]) => { const l = new THREE.PointLight(0xffe2b8, 0, 13, 1.6); l.position.set(x, 3, z); scene.add(l); return l; });

const lam = (c) => (typeof c === 'string' ? new THREE.MeshLambertMaterial({ color: c }) : new THREE.MeshLambertMaterial({ map: c }));
const M = {
  wall: lam('#eceae4'), desk: lam('#c9ae8c'), deskLeg: lam('#a7aeb3'), fabric: lam('#4a5560'), leaves: lam('#7aa886'),
  books: lam(tex(CANVAS.books)), tv: new THREE.MeshBasicMaterial({ map: tex(CANVAS.tv) }),
  metal: lam('#4a5357'), white: lam('#f4f3ef'), trim: lam('#8f969a'), pot: lam('#d9d4ca'), red: lam('#c0453f'), mug: lam('#e9e4da'),
  sofa: lam('#5f7f8c'), rug: lam('#d6cdbd'), screenOff: lam('#1a2026'),
  glass: new THREE.MeshLambertMaterial({ color: '#cfe6ec', transparent: true, opacity: 0.2, depthWrite: false }),
  pane: new THREE.MeshBasicMaterial({ color: '#d7eef7' }),
};
const SCREENS = [1, 2, 3].map((s) => new THREE.MeshBasicMaterial({ map: tex(screenCanvas(100 + s)) }));
const SOLIDS = [];
const blocked = (x, z, r) => SOLIDS.some((b) => x > b[0] - r && x < b[1] + r && z > b[2] - r && z < b[3] + r);

// B(w, h, d, mat, x, yBottom, z, { solid, parent, cast })
function B(w, h, d, mat, x, y, z, o = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z); m.castShadow = o.cast !== false && mat.transparent !== true; m.receiveShadow = true;
  (o.parent || scene).add(m);
  if (o.solid) SOLIDS.push([x - w / 2, x + w / 2, z - d / 2, z + d / 2]);
  return m;
}
function plane(w, h, mat, x, y, z, rotY = 0, parent = scene) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(x, y, z); m.rotation.y = rotY; parent.add(m); return m;
}
function floorPlane(rect, cv, y = 0.005) {
  const [x0, x1, z0, z1] = rect, w = x1 - x0, d = z1 - z0;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lam(tex(cv, w / 2, d / 2)));
  m.rotation.x = -Math.PI / 2; m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2); m.receiveShadow = true; scene.add(m); return m;
}
function plant(x, z, big = false) {
  B(0.55, 0.5, 0.55, M.pot, x, 0, z, { solid: true });
  B(0.75, 0.6, 0.75, M.leaves, x, 0.5, z);
  if (big) B(0.5, 0.45, 0.5, M.leaves, x, 1.1, z);
}
// A canvas shown on a plane (screens, boards), redrawn by updateRooms.
function screenAt(w, h, cw, ch, x, y, z, rotY, parent) {
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 4;
  plane(w, h, new THREE.MeshBasicMaterial({ map: t }), x, y, z, rotY, parent);
  return { g: cv.getContext('2d'), t };
}

// Floors
const floor = floorPlane([-21, 21, -13, 13], CANVAS.hall, 0);
const FLOORS = { urgent: CANVAS.urgent, dev: CANVAS.carpet, review: CANVAS.wood, todo: CANVAS.plan, qa: CANVAS.qa, done: CANVAS.pantry };
for (const [k, Z] of Object.entries(ZONES)) {
  const [x0, x1, z0, z1] = Z.rect;
  floorPlane([x0 + 0.15, x1 - 0.15, z0 + 0.15, z1 - 0.15], FLOORS[k], 0.01);
  Z.center = [(x0 + x1) / 2, (z0 + z1) / 2];
  // Highlight overlay used by the filters.
  Z.glow = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 - 0.3, z1 - z0 - 0.3), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
  Z.glow.rotation.x = -Math.PI / 2; Z.glow.position.set(Z.center[0], 0.02, Z.center[1]); scene.add(Z.glow);
}

// Outer walls: a group per side so the one between camera and room can hide.
const WALL_H = 3;
const walls = [
  { n: [0, -1], g: new THREE.Group() }, { n: [0, 1], g: new THREE.Group() },
  { n: [-1, 0], g: new THREE.Group() }, { n: [1, 0], g: new THREE.Group() },
];
walls.forEach((w) => scene.add(w.g));
const [wBack, wFront, wLeft, wRight] = walls;
B(42.8, WALL_H, 0.4, M.wall, 0, 0, -13.2, { parent: wBack.g, solid: true });
B(42.8, WALL_H, 0.4, M.wall, 0, 0, 13.2, { parent: wFront.g, solid: true });
B(0.4, WALL_H, 26, M.wall, -21.2, 0, 0, { parent: wLeft.g, solid: true });
B(0.4, WALL_H, 26, M.wall, 21.2, 0, 0, { parent: wRight.g, solid: true });
for (const [x, z, w, d] of [[0, -13.2, 42.8, 0.42], [0, 13.2, 42.8, 0.42], [-21.2, 0, 0.42, 26], [21.2, 0, 0.42, 26]]) B(w, 0.15, d, M.trim, x, 0, z, { cast: false });
// Frame on the inner face of the wall, pane just in front of it, facing into the room.
function windowAt(wall, along) {
  const [nx, nz] = wall.n, g = wall.g;
  if (nz) { B(2.6, 1.7, 0.12, M.white, along, 0.95, nz * 12.98, { parent: g, cast: false }); plane(2.3, 1.4, M.pane, along, 1.8, nz * 12.91, nz < 0 ? 0 : Math.PI, g); }
  else { B(0.12, 1.7, 2.6, M.white, nx * 20.98, 0.95, along, { parent: g, cast: false }); plane(2.3, 1.4, M.pane, nx * 20.91, 1.8, along, nx < 0 ? Math.PI / 2 : -Math.PI / 2, g); }
}
[-18.5, -9.5, -4, 9, 19.3].forEach((x) => windowAt(wBack, x));
[-14, -2, 6, 18].forEach((x) => windowAt(wFront, x));
[-8, 0.5, 6].forEach((z) => windowAt(wRight, z));
B(0.5, 2.4, 3, M.books, -20.75, 0, -9, { parent: wLeft.g, solid: true });
B(0.5, 2.4, 3, M.books, -20.75, 0, 0, { parent: wLeft.g, solid: true });
// Low partitions around the Dev and QA rooms, each with a 2-unit door at x=2 on the corridor side.
for (const [x0, x1, z] of [[-7, 1, -2], [3, 11, -2], [-7, 1, 2], [3, 11, 2]]) { B(x1 - x0, 1.1, 0.16, M.wall, (x0 + x1) / 2, 0, z, { solid: true }); B(x1 - x0, 0.06, 0.2, M.trim, (x0 + x1) / 2, 1.1, z, { cast: false }); }
for (const [x, z0, z1] of [[-7, -13, -2], [-7, 2, 13], [11, 2, 13]]) { B(0.16, 1.1, z1 - z0, M.wall, x, 0, (z0 + z1) / 2, { solid: true }); B(0.2, 0.06, z1 - z0, M.trim, x, 1.1, (z0 + z1) / 2, { cast: false }); }
function updateWalls() {
  const cx = Math.sin(camAz()), cz = Math.cos(camAz());
  for (const w of walls) w.g.visible = w.n[0] * cx + w.n[1] * cz < 0.25;
}

// Floor labels: lie on the floor, turn with the camera so they read left to right.
const labels = [];
function floorLabel(x, z, title, sub, w = 7.6) {
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 256;
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 4;
  const pivot = new THREE.Group(); pivot.position.set(x, 0.03, z); scene.add(pivot);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; pivot.add(m);
  labels.push({ pivot, draw: (fg) => {
    const g = cv.getContext('2d'); g.clearRect(0, 0, 1024, 256); g.textAlign = 'center'; g.fillStyle = fg;
    g.globalAlpha = 0.85; g.font = `700 92px ${FONT}`; g.fillText(title.toUpperCase(), 512, 125);
    g.globalAlpha = 0.6; g.font = `500 58px ${FONT}`; g.fillText(sub, 512, 210);
    t.needsUpdate = true;
  } });
}
for (const [k, Z] of Object.entries(ZONES)) if (k !== 'review') floorLabel(Z.center[0], Z.rect[3] < 0 ? -3.0 : 3.0, Z.name, Z.sub);
floorLabel(16, -1.0, ZONES.review.name, ZONES.review.sub, 6.4);

function chair(x, z, rotY) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY; scene.add(g);
  B(0.5, 0.05, 0.5, M.metal, 0, 0, 0, { parent: g }); B(0.08, 0.38, 0.08, M.metal, 0, 0.05, 0, { parent: g });
  B(0.56, 0.1, 0.56, M.fabric, 0, 0.42, 0, { parent: g }); B(0.56, 0.62, 0.1, M.fabric, 0, 0.52, -0.32, { parent: g });
}

// Desks: 2 rows of 4 in the Dev room, 2 rows of 4 in the QA room. Seat in front of each, aisle to its right,
// `entryZ` = the aisle's end just inside the room's door.
const DESKS = [];
for (const [room, dz, entryZ] of [['dev', -10, -3.4], ['dev', -6, -3.4], ['qa', 5.2, 3.4], ['qa', 9.2, 3.4]]) for (const dx of [-4, 0, 4, 8]) {
  B(1.9, 0.08, 1, M.desk, dx, 0.67, dz, { solid: true });
  B(0.08, 0.67, 0.9, M.deskLeg, dx - 0.85, 0, dz); B(0.08, 0.67, 0.9, M.deskLeg, dx + 0.85, 0, dz);
  B(0.1, 0.25, 0.1, M.metal, dx, 0.75, dz - 0.3);
  // Dev desks get two monitors, QA desks one.
  const screens = (room === 'dev' ? [dx - 0.42, dx + 0.42] : [dx]).map((sx) => {
    const w = room === 'dev' ? 0.8 : 1;
    B(w, 0.55, 0.06, M.metal, sx, 0.95, dz - 0.33);
    return plane(w - 0.08, 0.47, M.screenOff, sx, 1.225, dz - 0.295);
  });
  B(0.7, 0.03, 0.22, M.white, dx, 0.75, dz + 0.12);
  chair(dx, dz + 0.9, Math.PI);
  if (room === 'qa') { B(0.18, 0.3, 0.02, M.metal, dx + 0.6, 0.75, dz - 0.05); B(0.3, 0.02, 0.4, M.metal, dx - 0.6, 0.75, dz + 0.05); } // test phone, tablet
  DESKS.push({ room, x: dx, z: dz, seatZ: dz + 0.9, aisleX: dx + 2, entryZ, owner: null, screens, i: DESKS.length });
}
function setScreen(d) { d.screens.forEach((s, j) => (s.material = d.owner ? SCREENS[(d.i + j) % 3] : M.screenOff)); }
plant(10.2, -12.2, true); plant(-6.2, -12.2, true);

// Meeting room (Review): glass walls with a door at x=16, long table along z with 12 seats.
B(0.08, 2.5, 11, M.glass, 11, 0, -7.5);
B(4, 2.5, 0.08, M.glass, 13, 0, -2); B(4, 2.5, 0.08, M.glass, 19, 0, -2);
for (const [x, z] of [[11, -2], [15, -2], [17, -2], [11, -7.5], [11, -12.8]]) B(0.12, 2.5, 0.12, M.trim, x, 0, z);
B(0.1, 0.1, 11, M.trim, 11, 2.5, -7.5); B(10, 0.1, 0.1, M.trim, 16, 2.5, -2);
SOLIDS.push([10.9, 11.1, -13, -2], [11, 15, -2.1, -1.9], [17, 21, -2.1, -1.9]);
B(2, 0.08, 6.2, M.white, TABLE.x, 0.67, TABLE.z, { solid: true });
for (const dz of [-2.8, 2.8]) B(1.6, 0.67, 0.1, M.deskLeg, TABLE.x, 0, TABLE.z + dz);
for (const [x, z] of [[15.6, -8.6], [16.3, -6.5], [15.8, -5]]) B(0.36, 0.02, 0.26, M.white, x, 0.75, z);
const MEET_SEATS = [];
{ // 5 per long side, 1 at each end. `via` = waypoints from the room's inner door (16,-3) to the seat.
  for (const z of [-9.9, -8.7, -7.5, -6.3, -5.1]) {
    chair(14.3, z, Math.PI / 2); MEET_SEATS.push({ x: 14.3, z, yaw: Math.PI / 2, via: [[13.4, -3.4], [13.4, z]] });
    chair(17.7, z, -Math.PI / 2); MEET_SEATS.push({ x: 17.7, z, yaw: -Math.PI / 2, via: [[18.6, -3.4], [18.6, z]] });
  }
  chair(16, -11.4, 0); MEET_SEATS.push({ x: 16, z: -11.4, yaw: 0, via: [[13.4, -3.4], [13.4, -11.4]] });
  chair(16, -3.6, Math.PI); MEET_SEATS.push({ x: 16, z: -3.6, yaw: Math.PI, via: [] });
}
// The meeting button: a big red button in the middle of the table; pressing it calls everyone in (app.js setMeeting).
const meetButton = new THREE.Group(); meetButton.position.set(TABLE.x, 0.75, TABLE.z); scene.add(meetButton);
const meetDome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#e0352b', emissive: '#7a0d08' }));
{
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 0.12, 24), M.metal);
  base.position.y = 0.06; base.castShadow = true; meetDome.position.y = 0.12; meetDome.castShadow = true;
  meetButton.add(base, meetDome);
}
B(3.4, 1.9, 0.1, M.metal, 16, 0.8, -12.9, { parent: wBack.g });
plane(3.2, 1.7, M.tv, 16, 1.75, -12.84, 0, wBack.g);
plant(20.2, -2.8); plant(11.8, -12.2);

// Planning board (To Do): real task cards, drawn in updateRooms().
B(0.08, 1.9, 6.6, M.metal, -20.95, 0.75, 7, { parent: wLeft.g });
const boardScreen = screenAt(6.3, 1.7, 1024, 276, -20.9, 1.7, 7, Math.PI / 2, wLeft.g);
const BOARD_COL_Z = { todo: 4.45, prog: 6.05, review: 7.65, done: 9.25 };
B(2.4, 0.45, 0.7, M.desk, -13, 0, 12, { solid: true }); B(2.4, 0.45, 0.7, M.desk, -17, 0, 12, { solid: true });
plant(-7.6, 12.3, true);

// Pantry (Done)
B(0.9, 0.9, 5, M.white, 20.45, 0, 6, { solid: true }); B(0.95, 0.05, 5.05, M.desk, 20.45, 0.9, 6);
B(0.5, 0.6, 0.45, M.metal, 20.45, 0.95, 4.6);
B(0.9, 2.1, 0.9, M.white, 20.45, 0, 10.2, { solid: true });
B(1.4, 0.06, 1.4, M.desk, 15, 0.7, 9.4, { solid: true }); B(0.12, 0.7, 0.12, M.metal, 15, 0, 9.4);
for (const [x, z] of [[13.9, 9.4], [16.1, 9.4], [15, 10.5]]) B(0.42, 0.45, 0.42, M.fabric, x, 0, z);
B(4.2, 0.02, 2, M.rug, 15, 0.012, 11.6, { cast: false });
const SOFA_SEATS = [14.1, 15, 15.9].map((x) => ({ x, z: 12.3, yaw: Math.PI, via: [[18.5, 4], [18.5, 11.2], [x, 11.2]] }));
B(3.6, 0.42, 1, M.sofa, 15, 0, 12.4, { solid: true }); B(3.6, 0.55, 0.3, M.sofa, 15, 0.42, 12.85); B(0.3, 0.65, 1, M.sofa, 13.05, 0, 12.4); B(0.3, 0.65, 1, M.sofa, 16.95, 0, 12.4);
plant(11.8, 12.3, true);

// War room (Highest-priority work): a shared desk, paper stacks, a wall screen and a light that breathes while busy.
B(1.8, 0.08, 1, M.desk, -14, 0.67, -7, { solid: true });
B(0.08, 0.67, 0.9, M.deskLeg, -14.8, 0, -7); B(0.08, 0.67, 0.9, M.deskLeg, -13.2, 0, -7);
B(0.6, 0.03, 0.4, M.metal, -14, 0.75, -7); B(0.6, 0.38, 0.03, M.metal, -14, 0.78, -7.2);
for (const [x, z, h] of [[-14.6, -6.8, 0.25], [-18, -11.8, 0.6], [-17.4, -11.9, 0.45]]) B(0.42, h, 0.32, M.white, x, x > -16 ? 0.75 : 0, z, { solid: x < -16 });
B(0.3, 0.7, 0.3, M.red, -20.4, 0, -12.4);
B(3.8, 2.1, 0.1, M.metal, -14, 0.65, -12.9, { parent: wBack.g });
const warScreen = screenAt(3.6, 1.9, 384, 204, -14, 1.7, -12.84, 0, wBack.g);
const warLight = new THREE.PointLight(0xff4a4a, 0, 12, 1.6); warLight.position.set(-14, 2.6, -8); scene.add(warLight);

// Dev room: build lamp and an architecture whiteboard.
const ciLamp = B(0.6, 0.6, 0.1, new THREE.MeshBasicMaterial({ color: '#4cd27f' }), -1, 2.0, -12.93, { parent: wBack.g, cast: false });
B(4, 1.6, 0.06, M.white, 3, 0.9, -12.95, { parent: wBack.g });
plane(3.8, 1.45, new THREE.MeshBasicMaterial({ map: tex(CANVAS.arch) }), 3, 1.7, -12.91, 0, wBack.g);

// QA room: test-run screen and a device wall, both on the partition facing into the room.
B(0.1, 1.3, 2.4, M.metal, -6.8, 0.9, 4.6); B(0.12, 0.9, 0.12, M.metal, -6.8, 0, 4.6);
const qaScreen = screenAt(2.25, 1.15, 288, 148, -6.74, 1.55, 4.6, Math.PI / 2);
B(0.4, 1.7, 2.8, M.white, -6.7, 0, 9.6, { solid: true });
for (let i = 0; i < 8; i++) {
  B(0.04, 0.34, 0.2, M.metal, -6.49, 0.45 + Math.floor(i / 4) * 0.6, 8.55 + (i % 4) * 0.7, { cast: false });
  plane(0.16, 0.28, new THREE.MeshBasicMaterial({ color: ['#7fb8ff', '#9fe0c0', '#ffd27f', '#c4b5fd'][i % 4] }), -6.465, 0.62 + Math.floor(i / 4) * 0.6, 8.55 + (i % 4) * 0.7, Math.PI / 2);
}
for (const [x, z] of [[-6.2, 12.3], [10.2, 12.3]]) plant(x, z, true);

// info: { all: [{k, s, st, pr, type, who}], highest: [same], bugsOpen, passed }
function updateRooms(info) {
  let g = warScreen.g;
  g.fillStyle = '#1b1517'; g.fillRect(0, 0, 384, 204);
  g.fillStyle = info.highest.length ? '#d9534f' : '#3f8f68'; g.fillRect(0, 0, 384, 36);
  g.fillStyle = '#fff'; g.font = `700 18px ${FONT}`;
  g.fillText(info.highest.length ? `Highest priority · ${info.highest.length}` : 'Nothing urgent', 14, 24);
  info.highest.slice(0, 4).forEach((t, i) => {
    const y = 66 + i * 36;
    g.fillStyle = '#f6b9b9'; g.font = `600 14px ${MONO}`; g.fillText(t.k, 14, y);
    g.fillStyle = '#eceaea'; g.font = `500 14px ${FONT}`; g.fillText(trunc(t.s, 30), 118, y);
    g.fillStyle = '#9aa3a8'; g.font = `500 12px ${FONT}`; g.fillText(t.who, 118, y + 15);
  });
  warScreen.t.needsUpdate = true;
  warLight.userData.on = info.highest.length > 0;

  g = qaScreen.g;
  const total = info.passed + info.bugsOpen, pass = total ? info.passed / total : 1;
  g.fillStyle = '#121a22'; g.fillRect(0, 0, 288, 148);
  g.fillStyle = '#c9d2dc'; g.font = `600 15px ${FONT}`; g.fillText('Sprint bugs', 14, 26);
  g.fillStyle = '#2a3440'; g.fillRect(14, 44, 260, 18);
  g.fillStyle = '#4cd27f'; g.fillRect(14, 44, 260 * pass, 18);
  g.fillStyle = '#f47272'; g.fillRect(14 + 260 * pass, 44, 260 * (1 - pass), 18);
  g.font = `700 26px ${FONT}`; g.fillStyle = '#4cd27f'; g.fillText(`${info.passed} fixed`, 14, 100);
  g.fillStyle = info.bugsOpen ? '#f47272' : '#7d8a96'; g.fillText(`${info.bugsOpen} open`, 160, 100);
  g.fillStyle = '#7d8a96'; g.font = `500 12px ${FONT}`; g.fillText('bugs in this sprint', 14, 128);
  qaScreen.t.needsUpdate = true;

  ciLamp.material.color.set(info.highest.length ? '#f05a5a' : '#4cd27f');

  // Planning board: one column per status, up to 5 cards each (key, summary, owner).
  g = boardScreen.g;
  g.fillStyle = '#fbfbf8'; g.fillRect(0, 0, 1024, 276);
  const cols = [['todo', 'To Do', '#64748b'], ['prog', 'In Progress', '#2563eb'], ['review', 'Review', '#7c3aed'], ['done', 'Done', '#15924a']];
  cols.forEach(([s, label, color], i) => {
    const x = i * 256 + 8, list = info.all.filter((t) => t.st === s);
    g.fillStyle = color; g.fillRect(x, 8, 240, 5);
    g.fillStyle = '#1d2a2c'; g.font = `700 16px ${FONT}`; g.fillText(`${label} · ${list.length}`, x, 34);
    list.slice(0, 5).forEach((t, r) => {
      const y = 44 + r * 44;
      g.fillStyle = '#ffffff'; g.fillRect(x, y, 240, 38); g.strokeStyle = '#d6dbdd'; g.strokeRect(x + 0.5, y + 0.5, 239, 37);
      g.fillStyle = t.pr === 'highest' ? '#d9534f' : t.type === 'bug' ? '#e0a33a' : color; g.fillRect(x, y, 4, 38);
      g.fillStyle = '#5b6a6b'; g.font = `600 11px ${MONO}`; g.fillText(t.k, x + 10, y + 15);
      g.textAlign = 'right'; g.font = `600 11px ${FONT}`; g.fillText(t.who, x + 232, y + 15); g.textAlign = 'left';
      g.fillStyle = '#1d2a2c'; g.font = `500 12.5px ${FONT}`; g.fillText(trunc(t.s, 32), x + 10, y + 31);
    });
    if (list.length > 5) { g.fillStyle = '#5b6a6b'; g.font = `500 12px ${FONT}`; g.fillText(`+${list.length - 5} more`, x, 268); }
  });
  boardScreen.t.needsUpdate = true;
}

function applyWorldTheme(dark, fg) {
  scene.background.set(css('--scene-bg'));
  hemi.intensity = dark ? 0.34 : 0.85; hemi.groundColor.set(dark ? '#1a2235' : '#9aa6b0');
  sun.intensity = dark ? 0.2 : 0.6; sun.color.set(dark ? '#9fb4ff' : '#ffffff');
  lamps.forEach((l) => (l.intensity = dark ? 0.7 : 0));
  M.pane.color.set(dark ? '#1c2f52' : '#d7eef7');
  labels.forEach((l) => l.draw(fg));
}
