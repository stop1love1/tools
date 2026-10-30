'use strict';

// 3D office: small canvas textures (clean floor tiles, screens, boards) and flat-colour skins for the blocky people.

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

function rng(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16), k = (v) => clamp(Math.round(v * f), 0, 255);
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => k(c).toString(16).padStart(2, '0')).join('');
}
function makeCanvas(w, h, fn) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; fn(cv.getContext('2d'), w, h); return cv; }
function tex(cv, rx, ry, crisp = false) {
  const t = new THREE.CanvasTexture(cv);
  t.magFilter = crisp ? THREE.NearestFilter : THREE.LinearFilter;
  t.minFilter = crisp ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  if (rx) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); }
  return t;
}
// A floor tile with a hairline joint on two edges, so repeats read as a grid.
const tile = (base, line) => makeCanvas(64, 64, (g) => { g.fillStyle = base; g.fillRect(0, 0, 64, 64); g.fillStyle = line; g.fillRect(0, 63, 64, 1); g.fillRect(63, 0, 1, 64); });

const CANVAS = {
  hall: tile('#e6e3dc', '#d3cfc6'),
  carpet: tile('#c9d3df', '#bcc7d4'),
  wood: makeCanvas(64, 64, (g) => { g.fillStyle = '#d8c3a5'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#c9b292'; for (let y = 15; y < 64; y += 16) g.fillRect(0, y, 64, 1); g.fillRect(20, 0, 1, 15); g.fillRect(48, 16, 1, 15); g.fillRect(10, 32, 1, 15); g.fillRect(36, 48, 1, 16); }),
  pantry: tile('#e9eee9', '#d5ddd6'),
  urgent: tile('#f0e1de', '#e3cdc8'),
  plan: tile('#e7e4ef', '#d8d4e3'),
  qa: tile('#d9e6e1', '#c8d8d1'),
  books: makeCanvas(64, 64, (g) => {
    const spines = ['#7d8fa6', '#a8796a', '#c9b37a', '#6f8f7d', '#8b7a9c', '#d9d4c8', '#55606b'], r = rng(12);
    g.fillStyle = '#8d7259'; g.fillRect(0, 0, 64, 64);
    for (let s = 0; s < 4; s++) { let x = 2; while (x < 62) { const w = 3 + Math.floor(r() * 3), h = 11 + Math.floor(r() * 3); g.fillStyle = spines[Math.floor(r() * spines.length)]; g.fillRect(x, s * 16 + 15 - h, w, h); x += w + 1; } }
  }),
  // Dev room whiteboard: a hand-drawn system sketch.
  arch: makeCanvas(256, 96, (g) => {
    g.fillStyle = '#fbfbf8'; g.fillRect(0, 0, 256, 96);
    g.strokeStyle = '#3c6db0'; g.fillStyle = '#3c6db0'; g.lineWidth = 2; g.font = `600 11px ${FONT}`; g.textAlign = 'center';
    const boxes = [['Web', 40, 24], ['Mobile', 40, 70], ['API', 128, 47], ['DB', 216, 24], ['Queue', 216, 70]];
    for (const [t, x, y] of boxes) { g.strokeRect(x - 26, y - 12, 52, 24); g.fillText(t, x, y + 4); }
    g.strokeStyle = '#7d8a96';
    for (const [a, b] of [[0, 2], [1, 2], [2, 3], [2, 4]]) { g.beginPath(); g.moveTo(boxes[a][1] + 26, boxes[a][2]); g.lineTo(boxes[b][1] - 26, boxes[b][2]); g.stroke(); }
  }),
};
function screenCanvas(seed) {
  return makeCanvas(64, 32, (g) => {
    const r = rng(seed), cols = ['#63a4fa', '#7fd1a4', '#c9d2dc', '#e2b86b'];
    g.fillStyle = '#121a22'; g.fillRect(0, 0, 64, 32);
    for (let y = 4; y < 30; y += 4) { let x = 4 + Math.floor(r() * 3) * 4; const end = 20 + Math.floor(r() * 40); while (x < end) { const w = 4 + Math.floor(r() * 10); g.fillStyle = cols[Math.floor(r() * cols.length)]; g.fillRect(x, y, Math.min(w, end - x), 2); x += w + 3; } }
  });
}

// ---- Blocky people: flat-colour skins. 8px head faces, 8x12 body, 4x12 limbs. Box face order: +x, -x, +y, -y, +z (front), -z. ----
const SKIN = ['#f1d3b8', '#e3b893', '#c99470', '#9a6848', '#734a31'];
const HAIR = ['#2a211c', '#4a3527', '#1b1b1b', '#6e4a2e', '#b39066', '#5d6066'];
const SHIRT = ['#33507a', '#4f74a8', '#5b7f6e', '#8a5c48', '#6b7078', '#e8e6e1', '#3d5a6c', '#7a5670', '#a88a55', '#2e3a46'];
const PANTS = ['#2b3442', '#3a3d42', '#5a4d3e', '#26414d', '#43473e'];
const SHOES = ['#1f1f1f', '#e9e9e6', '#4f3828'];
const SKIRT = ['#2b3442', '#7a5670', '#a8794f', '#3d5a6c', '#8a4b4b', '#5b6b52'];
const LIPS = ['#c4636a', '#b5545c', '#d2777c'];

function skinOf(u) {
  const r = rng(hash(u.id + u.name)), p = (a) => a[Math.floor(r() * a.length)];
  const S = { skin: p(SKIN), hair: p(HAIR), shirt: p(SHIRT), pants: p(PANTS), shoes: p(SHOES), long: r() < 0.35, shirtStyle: Math.floor(r() * 3), glasses: r() < 0.3 };
  // A woman: long hair to the shoulders, lips, and now and then a skirt. Unset gender: a woman when drawn with long hair.
  S.female = u.gender ? u.gender === 'female' : S.long;
  S.long = S.female;
  S.skirt = S.female && r() < 0.5 ? p(SKIRT) : null; S.lips = p(LIPS);
  return S;
}
function grid(w, h, fn) { return makeCanvas(w, h, (g) => fn((x, y, c, ww = 1, hh = 1) => { g.fillStyle = c; g.fillRect(x, y, ww, hh); })); }
function headFaces(S) {
  const side = (frontCol) => grid(8, 8, (P) => {
    P(0, 0, S.skin, 8, 8); P(0, 0, S.hair, 8, 2);
    if (frontCol === 0) P(4, 2, S.hair, 4, S.long ? 6 : 3); else P(0, 2, S.hair, 4, S.long ? 6 : 3);
  });
  const front = grid(8, 8, (P) => {
    P(0, 0, S.skin, 8, 8); P(0, 0, S.hair, 8, 2);
    if (S.long) { P(0, 2, S.hair, 1, 6); P(7, 2, S.hair, 1, 6); }
    P(2, 4, '#2a2f36'); P(5, 4, '#2a2f36');
    if (S.glasses) { P(1, 3, '#2a2f36', 3, 1); P(4, 3, '#2a2f36', 3, 1); }
    P(3, 6, S.female ? S.lips : shade(S.skin, 0.78), 2, 1);
    if (S.female) { P(1, 4, '#2a2f36'); P(6, 4, '#2a2f36'); } // lashes
  });
  const back = grid(8, 8, (P) => { P(0, 0, S.skin, 8, 8); P(0, 0, S.hair, 8, S.long ? 8 : 6); });
  const top = grid(8, 8, (P) => P(0, 0, S.hair, 8, 8));
  const bottom = grid(8, 8, (P) => P(0, 0, S.skin, 8, 8));
  return [side(0), side(7), top, bottom, front, back];
}
function bodyFaces(S) {
  const base = S.shirtStyle === 2 ? '#eeede8' : S.shirt;
  const front = grid(8, 12, (P) => {
    P(0, 0, base, 8, 12); P(3, 0, S.skin, 2, 1);
    if (S.shirtStyle === 1) { P(1, 0, shade(base, 0.85), 6, 1); P(1, 7, shade(base, 0.9), 6, 3); }
    if (S.shirtStyle === 2) { P(2, 0, '#ffffff'); P(5, 0, '#ffffff'); P(3, 1, S.shirt, 2, 7); }
    P(0, 11, shade(S.pants, 0.8), 8, 1);
  });
  const plain = (w, h) => grid(w, h, (P) => { P(0, 0, base, w, h); if (h === 12) P(0, 11, shade(S.pants, 0.8), w, 1); });
  return [plain(4, 12), plain(4, 12), plain(8, 4), plain(8, 4), front, plain(8, 12)];
}
function armFaces(S) {
  const base = S.shirtStyle === 2 ? '#eeede8' : S.shirt, sleeve = S.shirtStyle === 0 ? 4 : 10;
  const f = () => grid(4, 12, (P) => { P(0, 0, S.skin, 4, 12); P(0, 0, base, 4, sleeve); });
  return [f(), f(), grid(4, 4, (P) => P(0, 0, base, 4, 4)), grid(4, 4, (P) => P(0, 0, S.skin, 4, 4)), f(), f()];
}
function legFaces(S) {
  const top = S.skirt ? S.skin : S.pants; // bare legs under a skirt
  const f = () => grid(4, 12, (P) => { P(0, 0, top, 4, 12); P(0, 10, S.shoes, 4, 2); });
  return [f(), f(), grid(4, 4, (P) => P(0, 0, top, 4, 4)), grid(4, 4, (P) => P(0, 0, S.shoes, 4, 4)), f(), f()];
}
const solidFaces = (c) => Array.from({ length: 6 }, () => grid(4, 4, (P) => P(0, 0, c, 4, 4)));
