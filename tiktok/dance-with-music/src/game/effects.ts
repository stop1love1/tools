import * as THREE from "three";
import type { Beat } from "./player";
import type { BannerStyle } from "./rules";

const NEON = [0xfe2c55, 0x25f4ee, 0x8a2be2, 0xffc94d, 0x2ecc71, 0x3498db];

/**
 * Tâm trạng bài hát cho hệ ánh sáng: hue chủ đạo (buồn = xanh tím, vui =
 * vàng cam, mạnh = đỏ hồng), energy 0..1 (êm → dữ dội), valence 0..1
 * (buồn → vui). Suy từ phổ tần trong MusicPlayer, đổi rất chậm.
 */
export type Mood = { hue: number; energy: number; valence: number };

/** Nội suy hue theo cung ngắn nhất trên vòng màu (0..1, có wrap). */
export function lerpHue(a: number, b: number, k: number): number {
  let d = b - a;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  return (((a + d * k) % 1) + 1) % 1;
}

let glowTexture: THREE.Texture | null = null;
/** Texture chấm tròn mờ dần ra mép — dùng chung cho lửa/khói/đèn bóng. */
export function makeGlowTexture(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}

let fogTexture: THREE.Texture | null = null;
/** Texture sương loang lổ mềm — nhiều mảng mờ chồng nhau, lặp kín để pan UV. */
export function makeFogTexture(): THREE.Texture {
  if (fogTexture) return fogTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  for (let i = 0; i < 42; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 30 + Math.random() * 70;
    const a = 0.05 + Math.random() * 0.12;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  }
  fogTexture = new THREE.CanvasTexture(canvas);
  fogTexture.wrapS = fogTexture.wrapT = THREE.RepeatWrapping;
  fogTexture.repeat.set(2, 2);
  return fogTexture;
}

/** Kiểu hoạ tiết sàn nhảy — director đổi luân phiên theo câu nhạc cho đỡ chán. */
export type FloorPattern =
  | "ring" // vòng tròn lan từ tâm ra mép (cổ điển)
  | "ripple" // vòng lan từ một ô ngẫu nhiên (tâm lệch)
  | "sweep" // dải sáng quét ngang qua sàn, đảo chiều mỗi ô nhịp
  | "checker" // hai nhóm ô cờ vua chớp so le mỗi phách (disco kinh điển)
  | "spiral" // chong chóng xoay quanh tâm
  | "rows" // sáng đuổi theo hàng từ trước ra sau
  | "sparkle"; // lấp lánh ngẫu nhiên (hợp đoạn nhạc lắng)

const FLOOR_PATTERNS: FloorPattern[] = [
  "ring",
  "ripple",
  "sweep",
  "checker",
  "spiral",
  "rows",
  "sparkle",
];

export class DiscoFloor {
  readonly mesh: THREE.InstancedMesh;
  private readonly tileChecker: Uint8Array;
  private readonly tileDist: Float32Array;
  private readonly tileRow: Uint8Array;
  private readonly tileNX: Float32Array; // toạ độ X chuẩn hoá -1..1
  private readonly tileNZ: Float32Array; // toạ độ Z chuẩn hoá -1..1
  private readonly tileAng: Float32Array; // góc quanh tâm (cho chong chóng)
  private readonly twinkle: Float32Array; // pha lấp lánh riêng từng ô
  private readonly rows: number;
  private readonly maxDist: number;
  private readonly count: number;
  private readonly color = new THREE.Color();
  private acc = 0;

  private pattern: FloorPattern = "ring";
  private dir = 1;
  private originX = 0; // tâm vòng "ripple" (chuẩn hoá)
  private originZ = 0;
  private flash = 0; // loé toàn sàn khi drop, tự tắt dần
  private flashHue = 0;

  constructor(width: number, depth: number, cols = 16, rows = 12) {
    const tileW = width / cols;
    const tileD = depth / rows;
    this.rows = rows;
    this.count = cols * rows;
    this.maxDist = Math.hypot(width / 2, depth / 2);
    this.tileChecker = new Uint8Array(this.count);
    this.tileDist = new Float32Array(this.count);
    this.tileRow = new Uint8Array(this.count);
    this.tileNX = new Float32Array(this.count);
    this.tileNZ = new Float32Array(this.count);
    this.tileAng = new Float32Array(this.count);
    this.twinkle = new Float32Array(this.count);
    const geometry = new THREE.BoxGeometry(tileW * 0.92, 0.1, tileD * 0.92);
    // Mặt gạch phải NHÁM — bóng quá sẽ phản xạ dàn đèn thành vũng lóa giữa sàn
    const material = new THREE.MeshStandardMaterial({
      metalness: 0.25,
      roughness: 0.7,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, cols * rows);

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5 - cols / 2) * tileW;
        const z = (r + 0.5 - rows / 2) * tileD;
        dummy.position.set(x, 0.05, z);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(i, dummy.matrix);
        color.setHex((c + r) % 2 === 0 ? 0x262b3d : 0x171a28);
        this.mesh.setColorAt(i, color);
        this.tileChecker[i] = (c + r) % 2;
        this.tileDist[i] = Math.hypot(x, z);
        this.tileRow[i] = r;
        this.tileNX[i] = x / (width / 2);
        this.tileNZ[i] = z / (depth / 2);
        this.tileAng[i] = Math.atan2(z, x);
        this.twinkle[i] = Math.random() * Math.PI * 2;
        i++;
      }
    }
  }

  /** Director đổi hoạ tiết; đảo chiều quét/xoay + chọn tâm ripple ngẫu nhiên. */
  setPattern(p: FloorPattern) {
    this.pattern = p;
    this.dir = Math.random() < 0.5 ? 1 : -1;
    this.originX = (Math.random() - 0.5) * 1.6;
    this.originZ = (Math.random() - 0.5) * 1.6;
  }

  get currentPattern(): FloorPattern {
    return this.pattern;
  }

  static randomPattern(): FloorPattern {
    return FLOOR_PATTERNS[Math.floor(Math.random() * FLOOR_PATTERNS.length)];
  }

  /** Loé sáng cả sàn một phát (drop) — phủ lên hoạ tiết đang chạy rồi tắt dần. */
  burst(strength = 1, hue?: number) {
    this.flash = Math.max(this.flash, strength);
    if (hue !== undefined) this.flashHue = hue;
  }

  update(
    dt: number,
    _hype: number,
    beat: Beat,
    level = 0,
    musicOn = true,
    mood?: Mood,
  ) {
    this.acc += dt;
    if (this.acc < 0.04) return;
    const step = this.acc;
    this.acc = 0;
    this.flash = Math.max(0, this.flash - step * 2.4);
    const hue = mood?.hue ?? 0.6;
    const energy = mood?.energy ?? 0.5;
    const valence = mood?.valence ?? 0.4;
    const t = performance.now() / 1000;
    // Nhịp sáng nhẹ toàn sàn theo kick — nền chung cho mọi hoạ tiết
    const kick = Math.max(0, 1 - beat.pulse * 2.5);
    const glow = musicOn ? kick * level * 0.1 + level * 0.02 : 0;
    // Biên độ hoạ tiết: phách 1 rõ hơn, nhạc mạnh thì rực hơn
    const amp =
      (0.04 + level * 0.14) *
      (beat.index % 4 === 0 ? 1.7 : 1) *
      (0.5 + energy * 0.9);
    const p = musicOn ? this.pattern : "ring";
    // Tham số dùng chung tính trước ngoài vòng lặp cho nhẹ
    const ringR = beat.pulse * this.maxDist; // ring: bán kính theo pulse
    const ringRN = beat.pulse * 1.35; // ripple: bán kính chuẩn hoá
    const sweepPos = (-1.2 + beat.pulse * 2.4) * this.dir; // sweep: vị trí dải
    const checkerOn = beat.index % 2; // checker: nhóm nào sáng phách này
    const checkerK = Math.max(0, 1 - beat.pulse * 2.5);
    const rowsHead = ((beat.index & 3) + beat.pulse) / 4; // rows: đầu sóng 0..1
    const flashHue = this.flashHue;
    const flash = this.flash;

    for (let i = 0; i < this.count; i++) {
      let g = 0;
      if (musicOn) {
        switch (p) {
          case "ring":
            g = Math.max(0, 1 - Math.abs(this.tileDist[i] - ringR) / 2) * amp;
            break;
          case "ripple": {
            const d = Math.hypot(
              this.tileNX[i] - this.originX,
              this.tileNZ[i] - this.originZ,
            );
            g = Math.max(0, 1 - Math.abs(d - ringRN) / 0.28) * amp;
            break;
          }
          case "sweep":
            g = Math.max(0, 1 - Math.abs(this.tileNX[i] - sweepPos) / 0.3) * amp;
            break;
          case "checker":
            g = this.tileChecker[i] === checkerOn ? checkerK * amp * 1.1 : 0;
            break;
          case "spiral": {
            const s =
              Math.sin(this.tileAng[i] * 3 - t * (1.4 + energy * 2) * this.dir);
            g = Math.max(0, s) * amp * (0.6 + kick * 0.8);
            break;
          }
          case "rows": {
            const rN = this.dir > 0 ? this.tileRow[i] / (this.rows - 1)
                                    : 1 - this.tileRow[i] / (this.rows - 1);
            g = Math.max(0, 1 - Math.abs(rN - rowsHead) / 0.16) * amp * 1.2;
            break;
          }
          case "sparkle": {
            const tw = Math.sin(t * 3 + this.twinkle[i]);
            g = Math.max(0, tw - 0.55) * amp * (0.8 + kick * 0.6) * 2;
            break;
          }
        }
      }
      const base = this.tileChecker[i] === 0 ? 0.058 : 0.038;
      // Loé drop phủ lên trên: cả sàn bừng theo màu flash
      const useHue = flash > 0.02 ? flashHue : hue;
      this.color.setHSL(
        useHue,
        0.3 + valence * 0.25 + g * 0.5,
        base + glow + g + flash * 0.5,
      );
      this.mesh.setColorAt(i, this.color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export class LedWall {
  readonly mesh: THREE.InstancedMesh;
  private readonly cols: number;
  private readonly rows: number;
  private readonly color = new THREE.Color();
  private acc = 0;
  private lastBeat = -1;
  private flashCol = -1;
  private flashHue = 0;

  constructor(width: number, height: number, z: number, cols = 26, rows = 9) {
    this.cols = cols;
    this.rows = rows;
    const w = width / cols;
    const h = height / rows;
    const geometry = new THREE.PlaneGeometry(w * 0.92, h * 0.88);
    const material = new THREE.MeshBasicMaterial();
    this.mesh = new THREE.InstancedMesh(geometry, material, cols * rows);

    const dummy = new THREE.Object3D();
    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        dummy.position.set((c + 0.5 - cols / 2) * w, 1.2 + (r + 0.5) * h, z);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(i, dummy.matrix);
        i++;
      }
    }
  }

  update(
    dt: number,
    hype: number,
    beat: Beat,
    level = 0,
    musicOn = true,
    mid = 0,
    mood?: Mood,
  ) {
    this.acc += dt;
    if (this.acc < 0.05) return;
    this.acc = 0;
    const energy = mood?.energy ?? 0.5;
    // Mỗi beat chọn một dải cột ngẫu nhiên lóe sáng rồi tắt dần theo pulse —
    // màu lóe xoay quanh hue tâm trạng để cả tường cùng tông
    if (musicOn && beat.index !== this.lastBeat) {
      this.lastBeat = beat.index;
      this.flashCol = Math.floor(Math.random() * this.cols);
      this.flashHue = mood
        ? (((mood.hue + (Math.random() - 0.5) * 0.24) % 1) + 1) % 1
        : Math.random();
    }
    const t = performance.now() / 1000;
    const kick =
      Math.max(0, 1 - beat.pulse * 3) * (0.1 + hype * 0.15 + level * 0.25) +
      level * 0.08;
    const flashK = musicOn ? Math.max(0, 1 - beat.pulse * 2.2) : 0;
    const dim = musicOn ? 1 : 0.22;
    // Nhạc êm: sóng trôi chậm, tường tối lại; nhạc mạnh: chạy nhanh, rực hơn
    const waveSpeed = musicOn ? (0.5 + hype * 1.0) * (0.5 + energy) : 0.25;
    const cap = 0.26 + energy * 0.16;
    let i = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const wave =
          Math.sin(c * 0.55 - t * waveSpeed + r * 0.35) * 0.5 + 0.5;
        const flash =
          this.flashCol >= 0
            ? Math.max(0, 1 - Math.abs(c - this.flashCol) / 3.2) *
              flashK *
              (0.2 + level * 0.5 + mid * 0.4)
            : 0;
        const hue =
          flash > 0.06
            ? this.flashHue
            : (((mood?.hue ?? 0.9) +
                c * 0.012 +
                Math.sin(t * 0.3 + r * 0.2) * 0.05) %
                1 +
                1) %
              1;
        this.color.setHSL(
          hue,
          0.85,
          Math.min(
            cap,
            (0.07 + wave * (0.14 + hype * 0.2 + mid * 0.12) + kick + flash) *
              dim,
          ),
        );
        this.mesh.setColorAt(i, this.color);
        i++;
      }
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export class LightBeams {
  readonly group = new THREE.Group();
  private beams: THREE.Mesh[] = [];
  private scratch = new THREE.Color();

  constructor() {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(6.2, 0.12, 10, 60),
      new THREE.MeshStandardMaterial({
        color: 0x30364f,
        metalness: 0.8,
        roughness: 0.4,
      }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 10.6, -2);
    this.group.add(ring);

    const geometry = new THREE.ConeGeometry(0.75, 12, 18, 1, true);
    geometry.translate(0, -6, 0);
    for (let i = 0; i < 6; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: NEON[i % NEON.length],
        transparent: true,
        opacity: 0.1,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const beam = new THREE.Mesh(geometry, material);
      const angle = (i / 6) * Math.PI * 2;
      beam.position.set(
        Math.cos(angle) * 6.2,
        10.4,
        -2 + Math.sin(angle) * 6.2,
      );
      this.group.add(beam);
      this.beams.push(beam);
    }
  }

  update(
    dt: number,
    hype: number,
    beat: Beat,
    level = 0,
    musicOn = true,
    mood?: Mood,
    haze = 0.5,
    active = 1,
  ) {
    const t = performance.now() / 1000;
    const kick = Math.max(0, 1 - beat.pulse * 3);
    const energy = mood?.energy ?? 0.5;
    // Phách 1 của ô nhịp vung rộng hơn — nhìn là thấy nhịp; nhạc buồn/êm
    // thì vung hẹp và lướt chậm như đang ru, nhạc mạnh thì giật dứt khoát
    const accent = beat.index % 4 === 0 ? 1.3 : 1;
    const swing = musicOn
      ? (beat.index % 2 === 0 ? 1 : -1) *
        (0.42 + hype * 0.25) *
        accent *
        (0.55 + energy * 0.7)
      : 0;
    const snap = 3 + energy * 6;
    this.beams.forEach((beam, i) => {
      const target = i % 2 === 0 ? swing : -swing;
      beam.rotation.z += (target - beam.rotation.z) * Math.min(1, dt * snap);
      const targetX = musicOn
        ? Math.cos(t * (0.18 + hype * 0.35) + i) * 0.25
        : 0;
      beam.rotation.x += (targetX - beam.rotation.x) * Math.min(1, dt * 5);
      const mat = beam.material as THREE.MeshBasicMaterial;
      // Beam chỉ rực khi có khói (haze) và khi lighting director BẬT nhóm
      // này (active) — không còn auto sáng cả dàn suốt bài
      mat.opacity = musicOn
        ? (0.04 + hype * 0.05 + level * 0.13 + kick * (0.03 + level * 0.11)) *
          (0.4 + energy * 0.7) *
          (0.35 + haze * 0.9) *
          active
        : 0.015;
      if (mood) {
        // Màu beam bám theo hue tâm trạng, tỏa nhẹ hai bên cho có chiều sâu
        this.scratch.setHSL(
          (((mood.hue + (i - 2.5) * 0.06) % 1) + 1) % 1,
          0.9,
          0.55,
        );
        mat.color.lerp(this.scratch, Math.min(1, dt * 1.5));
      }
    });
  }
}

export class DiscoBall {
  readonly group = new THREE.Group();
  private ball: THREE.Mesh;
  private sparkles: THREE.Points;

  constructor() {
    this.ball = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.05, 2),
      new THREE.MeshStandardMaterial({
        color: 0xdfe6ff,
        metalness: 1,
        roughness: 0.15,
        flatShading: true,
      }),
    );
    this.ball.position.set(0, 9.1, 0);

    const wire = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 2.6),
      new THREE.MeshBasicMaterial({ color: 0x333a55 }),
    );
    wire.position.set(0, 11.4, 0);

    const count = 90;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1.6 + Math.random() * 2.4;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = 9.1 + (Math.random() - 0.5) * 2.4;
      positions[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.sparkles = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.07,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

    this.group.add(this.ball, wire, this.sparkles);
  }

  update(dt: number, hype: number, energy = 0.5) {
    // Nhạc êm quay chậm rãi, nhạc mạnh quay tít + lấp lánh rõ hơn
    this.ball.rotation.y += dt * (0.25 + hype * 0.9 + energy * 0.9);
    this.sparkles.rotation.y -= dt * (0.1 + hype * 0.4 + energy * 0.4);
    (this.sparkles.material as THREE.PointsMaterial).opacity =
      0.35 + energy * 0.5;
  }
}

export class SpeakerStack {
  readonly group = new THREE.Group();
  private woofers: THREE.Mesh[] = [];

  constructor(x: number, z: number) {
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0x14161f,
      metalness: 0.3,
      roughness: 0.7,
    });
    const wooferMat = new THREE.MeshStandardMaterial({
      color: 0x23273a,
      metalness: 0.6,
      roughness: 0.35,
    });
    for (let i = 0; i < 3; i++) {
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.9, 1.7), boxMat);
      cab.position.set(x, 1.0 + i * 1.95, z);
      this.group.add(cab);

      const woofer = new THREE.Mesh(
        new THREE.CylinderGeometry(0.66, 0.82, 0.2, 24),
        wooferMat,
      );
      woofer.rotation.x = Math.PI / 2;
      woofer.position.set(x, 1.0 + i * 1.95, z + 0.92);
      this.group.add(woofer);
      this.woofers.push(woofer);

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.82, 0.055, 8, 28),
        new THREE.MeshBasicMaterial({ color: 0xfe2c55 }),
      );
      rim.position.copy(woofer.position);
      this.group.add(rim);
    }
  }

  update(_dt: number, hype: number, beat: Beat) {
    const punch = Math.max(0, 1 - beat.pulse * 4) * (0.12 + hype * 0.25);
    this.woofers.forEach((w) => {
      w.scale.setScalar(1 + punch);
    });
  }
}

export class ClubLights {
  readonly group = new THREE.Group();
  private lights: THREE.PointLight[] = [];
  private lastBeat = -1;
  private angleTarget = 0;
  private angle = 0;
  private scratch = new THREE.Color();

  constructor() {
    const colors = [0xfe2c55, 0x25f4ee, 0x8a2be2, 0xffc94d];
    for (let i = 0; i < colors.length; i++) {
      // Decay 2 (vật lý thật) — đèn tô màu không gian chứ không nướng sàn
      const light = new THREE.PointLight(colors[i], 60, 40, 2);
      light.position.set(0, 6, 0);
      this.group.add(light);
      this.lights.push(light);
    }
  }

  update(
    dt: number,
    hype: number,
    beat: Beat,
    level = 0,
    musicOn = true,
    mood?: Mood,
    active = 1,
  ) {
    const t = performance.now() / 1000;
    const kick = Math.max(0, 1 - beat.pulse * 3);
    const energy = mood?.energy ?? 0.5;
    if (beat.index !== this.lastBeat) {
      this.lastBeat = beat.index;
      this.angleTarget += Math.PI / 6;
    }
    // Nhạc êm đèn xoay lững lờ, nhạc mạnh bắt beat gắt
    this.angle +=
      (this.angleTarget - this.angle) * Math.min(1, dt * (3 + energy * 6));
    this.lights.forEach((light, i) => {
      const a = this.angle + (i / this.lights.length) * Math.PI * 2;
      light.position.set(
        Math.cos(a) * 12,
        5.2 + Math.sin(t * 0.3 + i) * 1.2,
        Math.sin(a) * 8,
      );
      // Cap cứng để không bao giờ rửa trắng nhân vật hay đốt lóa sàn;
      // active = lighting director bật/giảm nhóm đèn màu theo đoạn nhạc
      const target = musicOn
        ? Math.min(
            80,
            (22 + hype * 22 + level * 60 + kick * (15 + level * 45 + hype * 15)) *
              (0.35 + energy * 0.65),
          ) *
          (0.25 + active * 0.75)
        : 8;
      light.intensity += (target - light.intensity) * Math.min(1, dt * 6);
      if (mood) {
        // Cả dàn đèn cùng tông tâm trạng, mỗi bóng lệch hue một chút
        this.scratch.setHSL(
          (((mood.hue + i * 0.07) % 1) + 1) % 1,
          0.8,
          0.55,
        );
        light.color.lerp(this.scratch, Math.min(1, dt * 1.2));
      }
    });
  }
}

// Quả pháo giờ nở rộng gấp mấy lần nên cần nhiều hạt hơn, không thì mặt cầu
// thưa ra và chỉ còn lác đác đốm sáng.
const PARTICLES_PER_BURST = 240;
const BURST_LIFE = 1.6;

/**
 * Kiểu nổ pháo hoa — director chọn xoay vòng cho đỡ lặp:
 *  burst   = cầu hạt tỏa đều (cổ điển)
 *  willow  = liễu rủ, hạt nặng vàng ấm rơi chậm buông xuống
 *  ring    = nổ thành vòng phẳng nghiêng
 *  crackle = nổ xong cuối đời tách ra lấp lánh lần hai
 *  comet   = sao chổi vọt lên kéo đuôi rồi nổ nhỏ ở đỉnh (2 tầng)
 */
export type FireworkType = "burst" | "willow" | "ring" | "crackle" | "comet";

const FIREWORK_TYPES: FireworkType[] = [
  "burst",
  "willow",
  "ring",
  "crackle",
  "comet",
];

/**
 * Texture đốm sáng dùng chung cho MỌI quả pháo. Không có `map` thì three.js vẽ
 * mỗi hạt thành một Ô VUÔNG đặc — quả pháo trông như mớ confetti vuông chứ
 * không phải tia lửa. Tạo lười vì `makeGlowTexture` cần `document`, mà module
 * này bị import cả ở phía server lúc build.
 */
let sparkGlow: THREE.Texture | null = null;
function getSparkGlow(): THREE.Texture {
  if (!sparkGlow) sparkGlow = makeGlowTexture();
  return sparkGlow;
}

type Burst = {
  points: THREE.Points;
  velocities: Float32Array;
  age: number;
  life: number; // tổng thời gian sống (theo kiểu)
  type: FireworkType;
  gravity: number;
  count: number;
  exploded: boolean; // comet: đã nổ ở đỉnh chưa
  crackled: boolean; // crackle: đã bung lấp lánh lần hai chưa
};

export class Fireworks {
  readonly group = new THREE.Group();
  private bursts: Burst[] = [];
  /** Cú loé ở tâm quả pháo lúc bung — pháo thật soi sáng cả vùng trời quanh nó. */
  private flash = new THREE.PointLight(0xffffff, 0, 42, 2);

  constructor() {
    this.group.add(this.flash);
  }

  /** Chọn kiểu ngẫu nhiên, tránh lặp lại kiểu vừa bắn. */
  static randomType(exclude?: FireworkType | null): FireworkType {
    let t: FireworkType;
    do {
      t = FIREWORK_TYPES[Math.floor(Math.random() * FIREWORK_TYPES.length)];
    } while (t === exclude && FIREWORK_TYPES.length > 1);
    return t;
  }

  /** count quả; opts.type để ép kiểu, opts.hue để lấy màu theo tâm trạng bài. */
  spawn(
    origin: THREE.Vector3,
    count = 1,
    opts: { type?: FireworkType; hue?: number } = {},
  ) {
    for (let b = 0; b < count; b++) {
      this.spawnShell(origin, opts.type ?? Fireworks.randomType(), opts.hue);
    }
  }

  private spawnShell(origin: THREE.Vector3, type: FireworkType, hue?: number) {
    const n = type === "comet" ? 90 : PARTICLES_PER_BURST;
    const positions = new Float32Array(n * 3);
    const velocities = new Float32Array(n * 3);
    // Nổ CAO hẳn trên giàn truss. Trước đây chỉ cộng 2.5–5 nên quả pháo bung
    // ngay ngang tầm màn LED, lọt thỏm vào giữa sân khấu thay vì ở trên trời.
    const center = origin
      .clone()
      .add(
        new THREE.Vector3(
          (Math.random() - 0.5) * 9,
          // Màn LED cao 10.4 — tâm quả phải đủ cao để nửa dưới của chùm hạt
          // (bán kính nở ~6) vẫn nằm trên nóc giàn chứ không trùm vào tường
          9.5 + Math.random() * 4.5,
          (Math.random() - 0.5) * 4,
        ),
      );
    // Comet xuất phát thấp hơn rồi vọt lên, nổ ở giữa đời
    if (type === "comet") center.y -= 5;

    const baseHue = hue ?? Math.random();
    // Trọng lực NHẸ để pháo nở & lơ lửng trên trời rồi tắt, không mưa sao rơi
    // ào xuống sân khấu (trước đây trọng lực nặng làm rơi khá nhiều)
    let gravity = 2.6;
    let life = BURST_LIFE;
    const color = new THREE.Color();
    if (type === "willow") {
      // Liễu rủ vẫn buông xuống nhưng dịu hơn hẳn + tắt sớm hơn
      gravity = 4;
      life = 2;
      color.setHSL(0.11 + Math.random() * 0.03, 0.9, 0.62); // vàng ấm cố định
    } else if (type === "ring") {
      gravity = 2;
      life = 1.4;
      color.setHSL(baseHue, 0.95, 0.62);
    } else if (type === "crackle") {
      gravity = 2.4;
      life = 1.7;
      color.setHSL(baseHue, 0.9, 0.66);
    } else if (type === "comet") {
      gravity = 2.8;
      life = 2;
      color.setHSL(baseHue, 0.95, 0.66);
    } else {
      color.setHSL(baseHue, 0.95, 0.62);
    }

    const ringTilt = Math.random() * Math.PI;
    for (let i = 0; i < n; i++) {
      positions[i * 3] = center.x + (Math.random() - 0.5) * 0.1;
      // Comet: rải hạt thành cột dọc → nhìn như vệt sao chổi có đuôi
      positions[i * 3 + 1] =
        type === "comet" ? center.y - (i / n) * 1.8 : center.y;
      positions[i * 3 + 2] = center.z + (Math.random() - 0.5) * 0.1;
      if (type === "comet") {
        velocities[i * 3] = (Math.random() - 0.5) * 0.5;
        velocities[i * 3 + 1] = 15 + Math.random() * 3;
        velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
      } else if (type === "ring") {
        // Vòng trong mặt phẳng XZ rồi nghiêng quanh trục X
        const a = (i / n) * Math.PI * 2;
        const speed = 8 + Math.random() * 1.4;
        const rx = Math.cos(a) * speed;
        const rz = Math.sin(a) * speed;
        velocities[i * 3] = rx;
        velocities[i * 3 + 1] =
          -rz * Math.sin(ringTilt) + (Math.random() - 0.5) * 0.4;
        velocities[i * 3 + 2] = rz * Math.cos(ringTilt);
      } else {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        // Có lực cản nên bán kính nở ≈ v/k. Tốc độ cũ (2.2–4.6) chỉ cho quả
        // pháo rộng ~2.7 đơn vị, tức nhỉnh hơn một nhân vật (cao 1.875) — nhìn
        // ra cục sáng chứ không ra pháo hoa.
        const speed =
          type === "willow" ? 5 + Math.random() * 3 : 7 + Math.random() * 5;
        velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
        velocities[i * 3 + 1] = Math.cos(phi) * speed;
        velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
      }
    }
    // Quả nào bung ngay (không phải comet đang bay lên) thì loé sáng ở tâm
    if (type !== "comet") {
      this.flash.color.copy(color);
      this.flash.position.copy(center);
      this.flash.intensity = Math.min(240, this.flash.intensity + 150);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color,
      // Cỡ hạt lệch nhau chút giữa các quả cho đỡ đều tăm tắp
      size: (type === "willow" ? 0.34 : 0.3) + Math.random() * 0.1,
      map: getSparkGlow(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.group.add(points);
    this.bursts.push({
      points,
      velocities,
      age: 0,
      life,
      type,
      gravity,
      count: n,
      exploded: type !== "comet",
      crackled: false,
    });
  }

  update(dt: number) {
    // Cú loé lúc bung tắt rất nhanh, như ánh chớp của quả pháo thật
    this.flash.intensity *= Math.max(0, 1 - dt * 9);
    for (let b = this.bursts.length - 1; b >= 0; b--) {
      const burst = this.bursts[b];
      burst.age += dt;
      if (burst.age >= burst.life) {
        this.group.remove(burst.points);
        burst.points.geometry.dispose();
        (burst.points.material as THREE.Material).dispose();
        this.bursts.splice(b, 1);
        continue;
      }
      const n = burst.count;
      const vel = burst.velocities;
      const positions = burst.points.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      const array = positions.array as Float32Array;

      // Comet: tới đỉnh (giữa đời) thì cột hạt bung ra thành cầu nổ
      if (!burst.exploded && burst.age >= 0.55) {
        burst.exploded = true;
        for (let i = 0; i < n; i++) {
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(2 * Math.random() - 1);
          const speed = 6 + Math.random() * 4.5;
          vel[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
          vel[i * 3 + 1] = Math.cos(phi) * speed + 1;
          vel[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
        }
        // Comet nổ ở đỉnh: loé tại chỗ nó vừa tới, không phải chỗ xuất phát
        this.flash.color.copy(
          (burst.points.material as THREE.PointsMaterial).color,
        );
        this.flash.position.set(array[0], array[1], array[2]);
        this.flash.intensity = Math.min(240, this.flash.intensity + 150);
      }
      // Crackle: về cuối đời phần lớn hạt được đá thêm một cú → lấp lánh lần hai
      if (
        burst.type === "crackle" &&
        !burst.crackled &&
        burst.age >= burst.life * 0.55
      ) {
        burst.crackled = true;
        for (let i = 0; i < n; i++) {
          if (Math.random() < 0.6) {
            vel[i * 3] += (Math.random() - 0.5) * 5;
            vel[i * 3 + 1] += (Math.random() - 0.5) * 5;
            vel[i * 3 + 2] += (Math.random() - 0.5) * 5;
          }
        }
      }

      // Lực cản không khí: hạt vọt ra thật nhanh rồi hãm lại và lơ lửng —
      // chính nhịp "bung rồi treo" này mới ra dáng pháo hoa. Không có nó thì
      // hạt bay đều một mạch, nhìn như vụn sáng trôi ngang.
      const drag = Math.max(0, 1 - dt * (burst.type === "willow" ? 0.8 : 1.4));
      for (let i = 0; i < n; i++) {
        vel[i * 3] *= drag;
        vel[i * 3 + 1] = vel[i * 3 + 1] * drag - burst.gravity * dt;
        vel[i * 3 + 2] *= drag;
        array[i * 3] += vel[i * 3] * dt;
        array[i * 3 + 1] += vel[i * 3 + 1] * dt;
        array[i * 3 + 2] += vel[i * 3 + 2] * dt;
      }
      positions.needsUpdate = true;
      // Giữ sáng gần hết đời rồi tắt gấp, thay vì mờ tuyến tính ngay từ đầu
      (burst.points.material as THREE.PointsMaterial).opacity = Math.pow(
        1 - burst.age / burst.life,
        0.55,
      );
    }
  }
}

const FLAME_MAX = 900;

/**
 * Đài phun lửa dọc mép sân khấu — bắn cột lửa vào phách mạnh của đoạn cao
 * trào và drop, giống pyro sân khấu thật. Hạt lửa vàng-trắng phụt lên rồi
 * đỏ sậm dần và tắt.
 */
export class FlameJets {
  readonly group = new THREE.Group();
  private readonly nozzles: THREE.Vector3[] = [];
  // Lửa thật CHIẾU SÁNG xung quanh — một PointLight lóe theo mỗi loạt bắn
  private flash!: THREE.PointLight;
  private positions = new Float32Array(FLAME_MAX * 3);
  private velocities = new Float32Array(FLAME_MAX * 3);
  private life = new Float32Array(FLAME_MAX);
  private maxLife = new Float32Array(FLAME_MAX);
  private colors = new Float32Array(FLAME_MAX * 3);
  private points: THREE.Points;
  private cursor = 0;
  private color = new THREE.Color();
  /**
   * Trạng thái CHÁY của từng vòi. Vòi pyro thật cháy liên tục non một giây chứ
   * không nổ một phát: nhả trọn loạt hạt tại một điểm ở cùng một thời điểm thì
   * chúng chồng lên nhau theo kiểu additive và ra một QUẢ CẦU sáng, không ra
   * cột lửa. Giữ thời gian cháy còn lại + cường độ rồi rắc hạt dần mỗi frame.
   */
  private burnLeft: Float32Array;
  private burnStr: Float32Array;
  /** Phần lẻ số hạt chưa nhả được của frame trước (rate × dt hiếm khi tròn). */
  private emitAcc: Float32Array;

  /** "flame" = cột lửa cam bùng; "spark" = tia lửa vàng-trắng mảnh phụt cao
   *  như máy sparkular đặt trước sân khấu thật. */
  private readonly style: "flame" | "spark";

  constructor(
    spots: Array<{ x: number; y: number; z: number }>,
    style: "flame" | "spark" = "flame",
  ) {
    this.style = style;
    const nozzleMat = new THREE.MeshStandardMaterial({
      color: 0x11141f,
      metalness: 0.7,
      roughness: 0.4,
    });
    // Họng phun phát sáng — nhìn là biết đài phun ngay cả khi chưa bắn
    const portMat = new THREE.MeshBasicMaterial({
      color: style === "spark" ? 0xffd27a : 0xff7733,
    });
    for (const s of spots) {
      this.nozzles.push(new THREE.Vector3(s.x, s.y + 0.24, s.z));
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.52, 0.3, 0.52),
        nozzleMat,
      );
      box.position.set(s.x, s.y + 0.15, s.z);
      const port = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.17, 0.06, 12),
        portMat,
      );
      port.position.set(s.x, s.y + 0.32, s.z);
      this.group.add(box, port);
    }
    this.burnLeft = new Float32Array(this.nozzles.length);
    this.burnStr = new Float32Array(this.nozzles.length);
    this.emitAcc = new Float32Array(this.nozzles.length);
    for (let i = 0; i < FLAME_MAX; i++) this.positions[i * 3 + 1] = -50;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        // Hạt nhỏ nhưng NHIỀU và rải đều dọc thân cột → ra hình cột lửa. Cỡ
        // hạt to (0.8) như trước làm vài chục hạt gộp thành một khối tròn.
        size: style === "spark" ? 0.3 : 0.5,
        map: makeGlowTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    // Pool hạt "giấu" ở y=-50 nên bounding sphere nằm ngoài khung hình →
    // PHẢI tắt frustum culling, không thì cả cột lửa bị loại khỏi render
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.flash = new THREE.PointLight(
      style === "spark" ? 0xffd27a : 0xff8a3c,
      0,
      26,
      2,
    );
    this.group.add(this.flash);
  }

  /** Số vòi — dùng cho các pattern đuổi/cặp bên ngoài. */
  get count(): number {
    return this.nozzles.length;
  }

  /**
   * Châm các vòi cháy trong một khoảng thời gian; hạt do `update()` rắc dần.
   * strength ~0.6 (nhẹ) → 1.6 (drop); which: index các vòi, bỏ trống = tất cả.
   */
  fire(strength = 1, which?: number[]) {
    const idxs = which ?? this.nozzles.map((_, i) => i);
    const s = Math.min(2, strength);
    const spark = this.style === "spark";
    // Tia sparkular cháy lâu hơn cột lửa gas một chút, đúng như máy thật
    const burn = spark ? 0.7 + s * 0.45 : 0.5 + s * 0.35;
    for (const n of idxs) {
      if (!this.nozzles[n]) continue;
      // Bắn chồng lên loạt đang cháy thì nối dài chứ không cắt ngang
      this.burnLeft[n] = Math.max(this.burnLeft[n], burn);
      this.burnStr[n] = Math.max(this.burnStr[n], s);
    }
  }

  /** Rắc `k` hạt từ vòi `n` với cường độ `s`. */
  private emit(n: number, k: number, s: number) {
    const nozzle = this.nozzles[n];
    const spark = this.style === "spark";
    for (let j = 0; j < k; j++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % FLAME_MAX;
      this.positions[i * 3] = nozzle.x + (Math.random() - 0.5) * 0.22;
      this.positions[i * 3 + 1] = nozzle.y;
      this.positions[i * 3 + 2] = nozzle.z + (Math.random() - 0.5) * 0.22;
      // Spark: tia mảnh phụt cao và thẳng; flame: cột lửa tỏa rộng hơn
      this.velocities[i * 3] = (Math.random() - 0.5) * (spark ? 0.5 : 1.2);
      this.velocities[i * 3 + 1] = spark
        ? (9 + Math.random() * 4) * (0.75 + s * 0.3)
        : (6.5 + Math.random() * 3.5) * (0.7 + s * 0.4);
      this.velocities[i * 3 + 2] = (Math.random() - 0.5) * (spark ? 0.5 : 1.2);
      this.maxLife[i] = this.life[i] = spark
        ? 0.5 + Math.random() * 0.35
        : 0.45 + Math.random() * 0.3;
    }
  }

  update(dt: number) {
    const t = performance.now() / 1000;

    // 1) Các vòi đang cháy: rắc hạt đều tay suốt thời gian cháy
    const spark = this.style === "spark";
    const rate = spark ? 90 : 70;
    const rateStr = spark ? 50 : 40;
    let burnSum = 0;
    let fx = 0;
    let fy = 0;
    let fz = 0;
    for (let n = 0; n < this.nozzles.length; n++) {
      if (this.burnLeft[n] <= 0) continue;
      const s = this.burnStr[n];
      this.burnLeft[n] -= dt;
      this.emitAcc[n] += (rate + rateStr * s) * dt;
      const k = Math.floor(this.emitAcc[n]);
      if (k > 0) {
        this.emitAcc[n] -= k;
        this.emit(n, k, s);
      }
      if (this.burnLeft[n] <= 0) {
        this.burnLeft[n] = 0;
        this.burnStr[n] = 0;
        this.emitAcc[n] = 0;
      }
      const noz = this.nozzles[n];
      burnSum += s;
      fx += noz.x * s;
      fy += noz.y * s;
      fz += noz.z * s;
    }
    // Đèn lóe bám theo cụm vòi đang cháy, sáng suốt loạt rồi tắt nhanh
    if (burnSum > 0) {
      this.flash.position.set(
        fx / burnSum,
        fy / burnSum + 1.6,
        fz / burnSum,
      );
      const target = Math.min(130, 55 * burnSum);
      this.flash.intensity += (target - this.flash.intensity) * Math.min(1, dt * 14);
    } else {
      this.flash.intensity *= Math.max(0, 1 - dt * 7);
    }

    let any = burnSum > 0;
    for (let i = 0; i < FLAME_MAX; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.positions[i * 3 + 1] = -50;
        this.colors[i * 3] = this.colors[i * 3 + 1] = this.colors[i * 3 + 2] = 0;
        continue;
      }
      if (this.style === "spark") {
        // Tia vọt lên rồi rơi xuống theo trọng lực như sparkular thật
        this.velocities[i * 3 + 1] -= 7 * dt;
      } else {
        // Lửa hụt đà dần + tạt nhẹ như bị gió
        this.velocities[i * 3 + 1] *= 1 - dt * 1.1;
      }
      this.positions[i * 3] +=
        this.velocities[i * 3] * dt + Math.sin(t * 18 + i) * 0.25 * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      const r = 1 - this.life[i] / this.maxLife[i];
      if (this.style === "spark") {
        // Tia vàng-trắng lấp lánh, tắt dần chứ không ngả đỏ
        this.color.setHSL(
          0.13 - r * 0.04,
          0.9,
          Math.max(0.05, 0.85 - r * 0.75),
        );
      } else {
        // Trắng-vàng lúc phụt → cam → đỏ sậm rồi tắt
        this.color.setHSL(
          Math.max(0, 0.14 - r * 0.13),
          1,
          Math.max(0.04, 0.72 - r * 0.66),
        );
      }
      this.colors[i * 3] = this.color.r;
      this.colors[i * 3 + 1] = this.color.g;
      this.colors[i * 3 + 2] = this.color.b;
    }
    if (!any) return;
    const geo = this.points.geometry;
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }
}

const SMOKE_MAX = 520;

/**
 * Máy phun khói: blast() = cột CO2 trắng phụt chéo từ mép sân khấu (drop/cao
 * trào), puff() = khói haze là đà lan chậm dưới sàn cho đoạn trầm/nhạc buồn.
 */
export class SmokeJets {
  readonly group = new THREE.Group();
  /**
   * Mật độ khói toàn sàn 0..1 — tăng khi phun, tự tan dần. Beam đèn nhân
   * theo giá trị này: có khói beam mới rực, đúng vật lý club thật.
   */
  density = 0;
  private readonly nozzles: { pos: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  private positions = new Float32Array(SMOKE_MAX * 3);
  private velocities = new Float32Array(SMOKE_MAX * 3);
  private life = new Float32Array(SMOKE_MAX);
  private maxLife = new Float32Array(SMOKE_MAX);
  private intensity = new Float32Array(SMOKE_MAX);
  private colors = new Float32Array(SMOKE_MAX * 3);
  private points: THREE.Points;
  private cursor = 0;

  constructor(spots: Array<{ x: number; y: number; z: number; tilt: number }>) {
    const nozzleMat = new THREE.MeshStandardMaterial({
      color: 0x161a28,
      metalness: 0.6,
      roughness: 0.5,
    });
    // Đầu phun sáng xanh lạnh — thấy rõ máy CO2 đặt quanh sân khấu
    const tipMat = new THREE.MeshBasicMaterial({ color: 0x9fd8ff });
    for (const s of spots) {
      this.nozzles.push({
        pos: new THREE.Vector3(s.x, s.y + 0.3, s.z),
        dir: new THREE.Vector3(s.tilt, 1, 0.22).normalize(),
      });
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(0.44, 0.26, 0.44),
        nozzleMat,
      );
      base.position.set(s.x, s.y + 0.13, s.z);
      const pipe = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.13, 0.4, 10),
        nozzleMat,
      );
      pipe.position.set(s.x, s.y + 0.36, s.z);
      pipe.rotation.z = -s.tilt * 0.6;
      const tip = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.08, 0.05, 10),
        tipMat,
      );
      tip.position.set(s.x - s.tilt * 0.12, s.y + 0.56, s.z);
      tip.rotation.z = -s.tilt * 0.6;
      this.group.add(base, pipe, tip);
    }
    for (let i = 0; i < SMOKE_MAX; i++) this.positions[i * 3 + 1] = -50;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 2,
        map: makeGlowTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    // Như FlameJets — pool giấu dưới sàn, phải tắt frustum culling mới render
    this.points.frustumCulled = false;
    this.group.add(this.points);
  }

  private emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    intensity: number,
  ) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % SMOKE_MAX;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    this.maxLife[i] = this.life[i] = life;
    this.intensity[i] = intensity;
  }

  /** Cột CO2 phụt chéo từ mọi vòi — dùng cho drop và phách mạnh cao trào. */
  blast(strength = 1) {
    this.density = Math.min(1, this.density + 0.12 * strength);
    const per = Math.round(16 * Math.min(2, strength));
    for (const { pos, dir } of this.nozzles) {
      for (let k = 0; k < per; k++) {
        const speed = (6 + Math.random() * 3.5) * (0.7 + strength * 0.35);
        this.emit(
          pos.x + (Math.random() - 0.5) * 0.2,
          pos.y,
          pos.z + (Math.random() - 0.5) * 0.2,
          dir.x * speed + (Math.random() - 0.5) * 1.6,
          dir.y * speed,
          dir.z * speed + (Math.random() - 0.5) * 1.6,
          0.7 + Math.random() * 0.5,
          0.4 + strength * 0.2,
        );
      }
    }
  }

  /** Một cụm khói haze mỏng bò chậm từ RÌA sàn (trước sân khấu hoặc hai
   *  bên) trôi vào giữa — đoạn trầm/nhạc buồn. */
  puff() {
    let x: number;
    let z: number;
    if (Math.random() < 0.4) {
      // Từ chân sân khấu (ngoài mép gạch phía sau) tràn ra sàn
      x = (Math.random() - 0.5) * 22;
      z = -7.4 + Math.random() * 0.8;
    } else {
      // Từ NGOÀI hai rìa sàn bò vào giữa
      x = (Math.random() < 0.5 ? -1 : 1) * (14.5 + Math.random() * 1.4);
      z = -6 + Math.random() * 12;
    }
    this.emit(
      x,
      0.25,
      z,
      -x * 0.035 + (Math.random() - 0.5) * 0.4,
      0.18 + Math.random() * 0.2,
      -z * 0.03 + (Math.random() - 0.5) * 0.4,
      4 + Math.random() * 2.5,
      0.085,
    );
    this.density = Math.min(1, this.density + 0.03);
  }

  update(dt: number) {
    this.density = Math.max(0, this.density - dt * 0.035);
    const drag = Math.exp(-dt * 1.9);
    let any = false;
    for (let i = 0; i < SMOKE_MAX; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.positions[i * 3 + 1] = -50;
        this.colors[i * 3] = this.colors[i * 3 + 1] = this.colors[i * 3 + 2] = 0;
        continue;
      }
      this.velocities[i * 3] *= drag;
      this.velocities[i * 3 + 1] *= drag;
      this.velocities[i * 3 + 2] *= drag;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      const r = 1 - this.life[i] / this.maxLife[i];
      // Hiện nhanh lúc phụt, tan chậm về cuối; trắng hơi ngả xanh
      const v = this.intensity[i] * Math.min(1, r * 6) * (1 - r);
      this.colors[i * 3] = v * 0.82;
      this.colors[i * 3 + 1] = v * 0.9;
      this.colors[i * 3 + 2] = v;
    }
    if (!any) return;
    const geo = this.points.geometry;
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }
}

const CROWD_MAX = 140;
const WARM_WHITE = new THREE.Color(1, 0.93, 0.8);

/**
 * Biển ánh sáng trên tay đám đông: ballad → ánh đèn pin điện thoại trắng ấm
 * giơ cao lắc chậm; nhạc mạnh → que neon đủ màu nhấp nháy nhanh. Số đèn
 * hiện theo số người đang chơi (visibleCount).
 */
export class CrowdLights {
  readonly points: THREE.Points;
  visibleCount = 0;
  private base: Float32Array;
  private phase: Float32Array;
  private hue: Float32Array;
  private positions: Float32Array;
  private colors: Float32Array;
  private color = new THREE.Color();

  constructor() {
    this.base = new Float32Array(CROWD_MAX * 3);
    this.phase = new Float32Array(CROWD_MAX);
    this.hue = new Float32Array(CROWD_MAX);
    this.positions = new Float32Array(CROWD_MAX * 3);
    this.colors = new Float32Array(CROWD_MAX * 3);
    for (let i = 0; i < CROWD_MAX; i++) {
      // 40% ở khán đài phía sau, còn lại rải trên sàn nhảy
      const inAudience = Math.random() < 0.4;
      this.base[i * 3] = (Math.random() - 0.5) * (inAudience ? 27 : 26);
      this.base[i * 3 + 1] = inAudience ? 1.15 : 1.85;
      this.base[i * 3 + 2] = inAudience
        ? 10 + Math.random() * 3
        : -4 + Math.random() * 13;
      this.phase[i] = Math.random() * Math.PI * 2;
      this.hue[i] = Math.random();
      this.positions[i * 3 + 1] = -50;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 0.28,
        map: makeGlowTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.points.frustumCulled = false;
  }

  update(energy: number, valence: number, musicOn: boolean) {
    const t = performance.now() / 1000;
    // calm cao = ballad → biển đèn pin trắng; calm thấp = quẩy → que neon
    const calm = musicOn
      ? Math.max(0, 1 - energy * 1.4) * (1 - valence * 0.4)
      : 0.35;
    const n = Math.min(CROWD_MAX, this.visibleCount);
    for (let i = 0; i < CROWD_MAX; i++) {
      if (i >= n) {
        this.positions[i * 3 + 1] = -50;
        this.colors[i * 3] = this.colors[i * 3 + 1] = this.colors[i * 3 + 2] = 0;
        continue;
      }
      const p = this.phase[i];
      const swaySpeed = 0.9 + (1 - calm) * 2.4;
      const swayAmp = 0.14 + calm * 0.32;
      this.positions[i * 3] =
        this.base[i * 3] + Math.sin(t * swaySpeed + p) * swayAmp;
      // Ballad giơ đèn cao hơn hẳn — đúng dáng biển đèn pin concert
      this.positions[i * 3 + 1] =
        this.base[i * 3 + 1] +
        calm * 0.3 +
        Math.sin(t * 0.8 + p) * 0.1;
      this.positions[i * 3 + 2] = this.base[i * 3 + 2];
      const flicker = musicOn
        ? 0.55 + 0.45 * Math.sin(t * (2 + (1 - calm) * 6) + p * 3)
        : 0.5;
      this.color.setHSL(this.hue[i], 0.85, 0.6);
      this.color.lerp(WARM_WHITE, calm);
      const bright = flicker * (0.35 + energy * 0.35 + calm * 0.45);
      this.colors[i * 3] = this.color.r * bright;
      this.colors[i * 3 + 1] = this.color.g * bright;
      this.colors[i * 3 + 2] = this.color.b * bright;
    }
    const geo = this.points.geometry;
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }
}

type Heart = {
  sprite: THREE.Sprite;
  vy: number;
  sway: number;
  age: number;
  life: number;
};

function makeHeartTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "52px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("❤️", 32, 36);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class Hearts {
  readonly group = new THREE.Group();
  private hearts: Heart[] = [];
  private texture = makeHeartTexture();
  private static readonly MAX = 160;

  spawn(count: number) {
    const n = Math.min(count, Hearts.MAX - this.hearts.length);
    for (let i = 0; i < n; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.texture,
          transparent: true,
          depthWrite: false,
        }),
      );
      const s = 0.35 + Math.random() * 0.4;
      sprite.scale.set(s, s, 1);
      sprite.position.set(
        6.5 + Math.random() * 3.5,
        0.4 + Math.random() * 0.8,
        4.5 + Math.random() * 2,
      );
      this.group.add(sprite);
      this.hearts.push({
        sprite,
        vy: 1.6 + Math.random() * 1.4,
        sway: Math.random() * Math.PI * 2,
        age: 0,
        life: 2.4 + Math.random(),
      });
    }
  }

  update(dt: number) {
    const t = performance.now() / 1000;
    for (let i = this.hearts.length - 1; i >= 0; i--) {
      const h = this.hearts[i];
      h.age += dt;
      if (h.age >= h.life) {
        this.group.remove(h.sprite);
        h.sprite.material.dispose();
        this.hearts.splice(i, 1);
        continue;
      }
      h.sprite.position.y += h.vy * dt;
      h.sprite.position.x += Math.sin(t * 3 + h.sway) * 0.4 * dt;
      h.sprite.material.opacity = 1 - h.age / h.life;
    }
  }
}

type MemePop = {
  sprite: THREE.Sprite;
  vy: number;
  spin: number;
  size: number;
  sway: number;
  age: number;
  life: number;
};

/**
 * Meme bung lên theo phách: mượn chính texture nhân vật đang có trên sàn, bắn
 * ra hai mép sàn ở phách mạnh của đoạn cao trào rồi bay lên, xoay và tan dần.
 * Bám mép trái/phải nên khung dọc TikTok (nhân vật ở giữa) không bị che.
 */
export class MemePops {
  readonly group = new THREE.Group();
  private textures: THREE.Texture[] = [];
  private pops: MemePop[] = [];
  private static readonly MAX = 28;

  /** Đổi kho ảnh dùng để bung (gọi lại mỗi khi nạp bộ skin mới). */
  setTextures(textures: THREE.Texture[]) {
    this.textures = textures;
  }

  /** Bung `count` ảnh. `intensity` 0..1 quyết định cỡ và độ vọt cao. */
  burst(count: number, intensity = 0.6) {
    if (!this.textures.length) return;
    const n = Math.min(count, MemePops.MAX - this.pops.length);
    for (let i = 0; i < n; i++) {
      const map = this.textures[
        Math.floor(Math.random() * this.textures.length)
      ];
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }),
      );
      const size = 1.1 + intensity * 1.5 + Math.random() * 0.5;
      const side = Math.random() < 0.5 ? -1 : 1;
      sprite.center.set(0.5, 0.5);
      sprite.scale.set(size, size, 1);
      sprite.position.set(
        side * (9 + Math.random() * 4),
        0.8 + Math.random() * 1.6,
        -2 + Math.random() * 8,
      );
      this.group.add(sprite);
      this.pops.push({
        sprite,
        vy: 2.4 + intensity * 2.2 + Math.random() * 1.2,
        spin: (Math.random() - 0.5) * 3.2,
        size,
        sway: Math.random() * Math.PI * 2,
        age: 0,
        life: 1.5 + Math.random() * 0.7,
      });
    }
  }

  update(dt: number, beat: Beat) {
    // Đúng đầu phách thì phóng to giật một cái rồi co về — ảnh "nảy" theo tiếng
    const punch = 1 + Math.max(0, 1 - beat.pulse * 4) * 0.22;
    const t = performance.now() / 1000;
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.group.remove(p.sprite);
        p.sprite.material.dispose();
        this.pops.splice(i, 1);
        continue;
      }
      const k = p.age / p.life;
      p.sprite.position.y += p.vy * (1 - k * 0.55) * dt;
      p.sprite.position.x += Math.sin(t * 2.4 + p.sway) * 0.8 * dt;
      p.sprite.material.rotation += p.spin * dt;
      // Bung to lúc mới ra rồi giữ cỡ, cộng cú giật theo phách
      const grow = Math.min(1, p.age / 0.14);
      const s = p.size * grow * punch;
      p.sprite.scale.set(s, s, 1);
      p.sprite.material.opacity = Math.min(1, (1 - k) * 2.2);
    }
  }

  dispose() {
    for (const p of this.pops) {
      this.group.remove(p.sprite);
      p.sprite.material.dispose();
    }
    this.pops = [];
  }
}

const CONFETTI_MAX = 400;

export class Confetti {
  readonly points: THREE.Points;
  private positions: Float32Array;
  private velocities: Float32Array;
  private life: Float32Array;
  private cursor = 0;

  constructor() {
    this.positions = new Float32Array(CONFETTI_MAX * 3);
    this.velocities = new Float32Array(CONFETTI_MAX * 3);
    this.life = new Float32Array(CONFETTI_MAX);
    const colors = new Float32Array(CONFETTI_MAX * 3);
    const color = new THREE.Color();
    for (let i = 0; i < CONFETTI_MAX; i++) {
      this.positions[i * 3 + 1] = -10;
      color.setHex(NEON[i % NEON.length]);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 0.16,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      }),
    );
    // Hạt nghỉ nằm ở y=-10 → bounding sphere lệch khỏi khung, phải tắt culling
    this.points.frustumCulled = false;
  }

  burst(count: number) {
    for (let i = 0; i < count; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % CONFETTI_MAX;
      this.positions[idx * 3] = (Math.random() - 0.5) * 20;
      this.positions[idx * 3 + 1] = 10 + Math.random() * 3;
      this.positions[idx * 3 + 2] = (Math.random() - 0.5) * 12;
      this.velocities[idx * 3] = (Math.random() - 0.5) * 1.4;
      this.velocities[idx * 3 + 1] = -(1.6 + Math.random() * 1.6);
      this.velocities[idx * 3 + 2] = (Math.random() - 0.5) * 1.4;
      this.life[idx] = 6;
    }
  }

  update(dt: number, hype: number) {
    if (hype > 0.55 && Math.random() < hype * 0.5) {
      this.burst(Math.ceil(hype * 6));
    }
    const t = performance.now() / 1000;
    for (let i = 0; i < CONFETTI_MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.positions[i * 3] +=
        (this.velocities[i * 3] + Math.sin(t * 2 + i) * 0.5) * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      if (this.positions[i * 3 + 1] < 0.05 || this.life[i] <= 0) {
        this.positions[i * 3 + 1] = -10;
        this.life[i] = 0;
      }
    }
    (
      this.points.geometry.getAttribute("position") as THREE.BufferAttribute
    ).needsUpdate = true;
  }
}

/**
 * Lớp sương mù mỏng bò SÁT mặt sàn — chỉ hiện ở đoạn trầm/ballad để tạo
 * không khí mơ màng, đủ mờ cho beam đèn ăn khói mà KHÔNG che chân vũ công.
 * Cao trào thì tự tan gần hết. Vài mặt phẳng chồng nhau pan UV chậm cho có
 * chuyển động cuộn nhẹ, rẻ hơn nhiều so với phun hạt.
 */
export class GroundFog {
  readonly group = new THREE.Group();
  private layers: THREE.Mesh[] = [];
  private amount = 0; // độ hiện hữu đã làm mượt 0..1
  private color = new THREE.Color();

  constructor(width: number, depth: number) {
    const tex = makeFogTexture();
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex.clone(), // mỗi lớp pan UV riêng
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
      });
      mat.map!.needsUpdate = true;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width * 1.35, depth * 1.35),
        mat,
      );
      // Xoay nằm ngang, nâng thấp sát sàn (gạch cao ~0.1)
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.14 + i * 0.16;
      this.group.add(mesh);
      this.layers.push(mesh);
    }
  }

  /** target 0..1 — mật độ sương mong muốn (game.ts đã tính theo nhạc/mood). */
  update(dt: number, target: number, mood?: Mood) {
    this.amount += (target - this.amount) * Math.min(1, dt * 0.6);
    const t = performance.now() / 1000;
    this.color.setHSL(mood?.hue ?? 0.6, 0.15, 0.7);
    for (let i = 0; i < this.layers.length; i++) {
      const mat = this.layers[i].material as THREE.MeshBasicMaterial;
      // Mờ, cap thấp dần theo lớp trên — nâng nhẹ để ballad/buồn nhìn rõ sương
      mat.opacity = this.amount * (0.22 - i * 0.04);
      mat.color.copy(this.color);
      if (mat.map) {
        const dir = i % 2 === 0 ? 1 : -1;
        mat.map.offset.x = Math.sin(t * 0.03 + i) * 0.12;
        mat.map.offset.y = t * 0.012 * dir;
      }
    }
  }
}

/** Cue do PyroDirector phát ra mỗi beat, game.ts thi hành lên các hệ hiệu ứng. */
export type PyroCue =
  | { kind: "firework"; type: FireworkType; pos: THREE.Vector3; strength: number; hue: number }
  | { kind: "flame"; strength: number; which?: number[] }
  | { kind: "spark"; strength: number }
  | { kind: "smoke"; strength: number };

export type DirectorCtx = {
  beat: Beat;
  level: number;
  section: number;
  drop: number;
  energyRise: number; // độ leo năng lượng gần đây (dò buildup)
  inClimax: boolean;
  inQuietSection: boolean;
  beatConfidence: number;
  mood: Mood;
  flameCount: number;
};

const FLAME_PATTERNS = 5;

/**
 * "Người chạy pyro" ảo — bản ỔN ĐỊNH: điều phối LỬA / TIA / CO2 bắn ĐỀU theo
 * nhịp và bám ĐOẠN nhạc (verse êm → im, điệp khúc → bung), pattern lửa xoay
 * VÒNG tuần tự cho đa dạng mà đoán trước được. PHÁO HOA KHÔNG thuộc director —
 * chỉ dành cho khoảnh khắc đặc biệt (donate / drop-cao trào), xử lý ở game.ts.
 */
export class PyroDirector {
  private pattern = 0;
  private patternUntil = 0; // giữ pattern lửa tới ô nhịp này rồi xoay tiếp

  /** Không còn quỹ năng lượng — giữ chữ ký cho vòng update của game. */
  update(_dt: number) {}

  /** Gọi mỗi beat MỚI → trả về danh sách cue cần thi hành. */
  cue(ctx: DirectorCtx): PyroCue[] {
    const cues: PyroCue[] = [];
    const { beat, level, section, beatConfidence } = ctx;
    const bar = beat.index;

    // Chưa bắt được nhịp rõ → im, tránh bắn sai phách
    if (level < 0.08 || beatConfidence < 0.35) return cues;

    // Ngưỡng đoạn nhạc — liên tục, ổn định (không dùng buildup noisy nữa)
    const energetic = section > 0.5; // verse mạnh trở lên: có lửa
    const chorus = section > 0.68; // điệp khúc: thêm tia + CO2

    // LỬA — trong đoạn mạnh, chạy pattern ĐỀU; xoay pattern tuần tự mỗi 8 ô
    // nhịp (không random) nên đa dạng mà không giật
    if (energetic) {
      if (bar >= this.patternUntil) {
        this.pattern = (this.pattern + 1) % FLAME_PATTERNS;
        this.patternUntil = bar + 32;
      }
      this.flamePattern(this.pattern, ctx, cues);
    }

    // SPARKULAR mặt tiền — điệp khúc: mỗi phách một đợt tia, đều tay
    if (chorus) {
      cues.push({ kind: "spark", strength: 0.5 + level * 0.35 });
    }

    // CO2 nhấn — phách 1 mỗi 2 ô nhịp khi đoạn mạnh (đều, không tuỳ quỹ)
    if (energetic && bar % 8 === 0) {
      cues.push({ kind: "smoke", strength: 0.5 + level * 0.4 });
    }

    // PHÁO HOA KHÔNG do director bắn định kỳ nữa — chỉ dành cho khoảnh khắc
    // ĐẶC BIỆT: khi có người donate hoặc vào cú drop/cao trào lớn nhất (xử lý
    // trực tiếp trong game.ts). Ở đây pháo hoa im để không "rơi" suốt bài.

    return cues;
  }

  /** Sinh cue lửa theo pattern; trả về true nếu có bắn phách này. */
  private flamePattern(p: number, ctx: DirectorCtx, cues: PyroCue[]): boolean {
    const { beat, level } = ctx;
    const n = ctx.flameCount;
    const str = 0.7 + level * 0.5;
    switch (p) {
      case 0: // đuổi vòng quanh sàn
        cues.push({ kind: "flame", strength: str, which: [beat.index % n] });
        return true;
      case 1: // từ giữa tỏa ra hai bên theo cặp, mỗi 2 phách
        if (beat.index % 2 === 0) {
          const pairs = [
            [2, 3],
            [1, 4],
            [0, 5],
          ];
          cues.push({
            kind: "flame",
            strength: str,
            which: pairs[(beat.index >> 1) % pairs.length].filter((x) => x < n),
          });
          return true;
        }
        return false;
      case 2: // cả dàn dậm phách 1 của mỗi ô nhịp
        if (beat.index % 4 === 0) {
          cues.push({ kind: "flame", strength: str + 0.2 });
          return true;
        }
        return false;
      case 3: // bắn lẻ một vòi ngẫu nhiên (mới)
        if (beat.index % 2 === 0) {
          cues.push({
            kind: "flame",
            strength: str,
            which: [Math.floor(Math.random() * n)],
          });
          return true;
        }
        return false;
      default: {
        // sóng từ hai đầu dồn vào giữa (mới)
        if (beat.index % 2 === 0) {
          const step = (beat.index >> 1) % Math.ceil(n / 2);
          const which = [step, n - 1 - step].filter(
            (x, i, a) => a.indexOf(x) === i,
          );
          cues.push({ kind: "flame", strength: str, which });
          return true;
        }
        return false;
      }
    }
  }
}

const BANNER_W = 1024;
const BANNER_H = 256;

/** Vẽ dòng chữ nghệ thuật lên canvas theo phông đã chọn (co chữ vừa bề ngang). */
function renderBannerCanvas(
  canvas: HTMLCanvasElement,
  text: string,
  style: BannerStyle,
) {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, BANNER_W, BANNER_H);
  if (!text.trim()) return;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = BANNER_W / 2;
  const cy = BANNER_H / 2;
  const fontFor = (s: number) => {
    switch (style) {
      case "script":
        return `italic 700 ${s}px "Segoe Script","Brush Script MT",cursive`;
      case "gold":
        return `900 ${s}px Georgia,"Times New Roman",serif`;
      case "outline":
        return `900 ${s}px "Arial Black",Impact,sans-serif`;
      default:
        return `italic 900 ${s}px "Arial Black",Impact,sans-serif`;
    }
  };
  // Co cỡ chữ cho vừa bề ngang bảng, chừa lề hai bên như bảng khắc tên
  let fontSize = 108;
  ctx.font = fontFor(fontSize);
  const maxW = BANNER_W - 150;
  while (ctx.measureText(text).width > maxW && fontSize > 20) {
    fontSize -= 4;
    ctx.font = fontFor(fontSize);
  }
  ctx.lineJoin = "round";

  if (style === "script") {
    // Khắc tên: chữ viết tay ánh kim vàng, bóng chìm xuống + vệt sáng trên
    // nét cho cảm giác khắc lõm vào khung (dùng normal blend, không phát sáng)
    const grad = ctx.createLinearGradient(0, cy - fontSize / 2, 0, cy + fontSize / 2);
    grad.addColorStop(0, "#fff2c4");
    grad.addColorStop(0.45, "#e6b34a");
    grad.addColorStop(0.55, "#c9902f");
    grad.addColorStop(1, "#8a5c14");
    ctx.shadowColor = "rgba(0,0,0,0.7)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 1.5;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = grad;
    ctx.fillText(text, cx, cy);
    ctx.shadowColor = "transparent";
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = "rgba(255,250,225,0.4)";
    ctx.fillText(text, cx, cy - 1.5);
  } else if (style === "gold") {
    const grad = ctx.createLinearGradient(0, cy - fontSize / 2, 0, cy + fontSize / 2);
    grad.addColorStop(0, "#fff3b0");
    grad.addColorStop(0.5, "#e8b13a");
    grad.addColorStop(0.52, "#9c6a15");
    grad.addColorStop(1, "#ffe9a8");
    ctx.lineWidth = 7;
    ctx.strokeStyle = "#3a2606";
    ctx.strokeText(text, cx, cy);
    ctx.shadowColor = "rgba(255,200,80,0.6)";
    ctx.shadowBlur = 18;
    ctx.fillStyle = grad;
    ctx.fillText(text, cx, cy);
  } else if (style === "outline") {
    // Chữ rỗng viền neon kép
    ctx.shadowColor = "#fe2c55";
    ctx.shadowBlur = 30;
    ctx.lineWidth = 7;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText(text, cx, cy);
    ctx.shadowColor = "#8a2be2";
    ctx.shadowBlur = 16;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ff5c8a";
    ctx.strokeText(text, cx, cy);
  } else {
    // neon: gradient TikTok + quầng sáng + lõi trắng
    const grad = ctx.createLinearGradient(0, 0, BANNER_W, 0);
    grad.addColorStop(0, "#25f4ee");
    grad.addColorStop(0.5, "#ffffff");
    grad.addColorStop(1, "#fe2c55");
    ctx.shadowColor = "#25f4ee";
    ctx.shadowBlur = 34;
    ctx.lineWidth = 8;
    ctx.strokeStyle = "rgba(37,244,238,0.5)";
    ctx.strokeText(text, cx, cy);
    ctx.shadowColor = "#fe2c55";
    ctx.shadowBlur = 24;
    ctx.fillStyle = grad;
    ctx.fillText(text, cx, cy);
  }
  ctx.shadowBlur = 0;
}

/**
 * Bảng tên nghệ thuật gắn trên đỉnh khung truss sân khấu — dòng chữ tuỳ chỉnh
 * trong settings (nội dung + phông), phát sáng nhè nhẹ theo nhịp. Rỗng thì ẩn.
 */
export class StageBanner {
  readonly mesh: THREE.Mesh;
  private canvas: HTMLCanvasElement;
  private texture: THREE.CanvasTexture;
  private text = "";
  private style: BannerStyle = "neon";
  private t = 0;

  constructor(width = 14) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = BANNER_W;
    this.canvas.height = BANNER_H;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const height = width * (BANNER_H / BANNER_W);
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthWrite: false,
        // Bảng treo cao trên khung — luôn vẽ đè để không bị kết cấu sân khấu
        // che khuất (chìm sau khung); không có gì tiền cảnh ở độ cao này
        depthTest: false,
        blending: THREE.NormalBlending,
        fog: false,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
  }

  /** Đổi nội dung/phông (bỏ qua nếu không đổi) — vẽ lại canvas. */
  setText(text: string, style: BannerStyle) {
    if (text === this.text && style === this.style) return;
    this.text = text;
    this.style = style;
    renderBannerCanvas(this.canvas, text, style);
    this.texture.needsUpdate = true;
    // Neon/viền rỗng thì cộng sáng như biển hiệu; script/vàng khắc thì blend
    // thường để bóng chìm đọc đúng kiểu khắc tên vào khung
    const mat = this.mesh.material as THREE.MeshBasicMaterial;
    mat.blending =
      style === "neon" || style === "outline"
        ? THREE.AdditiveBlending
        : THREE.NormalBlending;
    mat.needsUpdate = true;
    this.mesh.visible = !!text.trim();
  }

  /** Ánh kim/quầng sáng thở nhẹ theo phách. */
  update(dt: number, beat?: Beat, energy = 0.4) {
    if (!this.mesh.visible) return;
    this.t += dt;
    const pulse = beat ? Math.max(0, 1 - beat.pulse * 3) : 0;
    const shimmer = 0.04 * Math.sin(this.t * 1.6);
    (this.mesh.material as THREE.MeshBasicMaterial).opacity =
      0.9 + shimmer + pulse * 0.1 * (0.5 + energy);
  }
}
