import * as THREE from "three";
import type { Beat } from "./player";

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
/** Texture chấm tròn mờ dần ra mép — dùng chung cho lửa/khói. */
function makeGlowTexture(): THREE.Texture {
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

export class DiscoFloor {
  readonly mesh: THREE.InstancedMesh;
  private readonly tileChecker: Uint8Array;
  private readonly tileDist: Float32Array;
  private readonly count: number;
  private readonly color = new THREE.Color();
  private acc = 0;

  constructor(width: number, depth: number, cols = 16, rows = 12) {
    const tileW = width / cols;
    const tileD = depth / rows;
    this.count = cols * rows;
    this.tileChecker = new Uint8Array(this.count);
    this.tileDist = new Float32Array(this.count);
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
        i++;
      }
    }
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
    this.acc = 0;
    const hue = mood?.hue ?? 0.6;
    const energy = mood?.energy ?? 0.5;
    // Nhịp sáng nhẹ theo kick + một vòng tỏa mảnh lan từ tâm ra mép mỗi beat
    const kick = Math.max(0, 1 - beat.pulse * 2.5);
    const glow = musicOn ? kick * level * 0.1 + level * 0.02 : 0;
    const ringR = beat.pulse * 17;
    // Vòng ở phách 1 sáng rõ hơn hẳn — nhịp 4/4 hiện rõ trên sàn;
    // nhạc êm thì vòng lan dịu lại cho hợp không khí
    const ringAmp =
      (0.04 + level * 0.14) *
      (beat.index % 4 === 0 ? 1.7 : 1) *
      (0.5 + energy * 0.9);
    for (let i = 0; i < this.count; i++) {
      const ringGlow = musicOn
        ? Math.max(0, 1 - Math.abs(this.tileDist[i] - ringR) / 2) * ringAmp
        : 0;
      const base = this.tileChecker[i] === 0 ? 0.058 : 0.038;
      this.color.setHSL(
        hue,
        0.3 + (mood?.valence ?? 0.4) * 0.25 + ringGlow * 0.5,
        base + glow + ringGlow,
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

const PARTICLES_PER_BURST = 140;
const BURST_LIFE = 1.6;

type Burst = {
  points: THREE.Points;
  velocities: Float32Array;
  age: number;
};

export class Fireworks {
  readonly group = new THREE.Group();
  private bursts: Burst[] = [];

  spawn(origin: THREE.Vector3, count = 1) {
    for (let b = 0; b < count; b++) {
      const positions = new Float32Array(PARTICLES_PER_BURST * 3);
      const velocities = new Float32Array(PARTICLES_PER_BURST * 3);
      const center = origin
        .clone()
        .add(
          new THREE.Vector3(
            (Math.random() - 0.5) * 3,
            2.5 + Math.random() * 2.5,
            (Math.random() - 0.5) * 2,
          ),
        );
      for (let i = 0; i < PARTICLES_PER_BURST; i++) {
        positions[i * 3] = center.x;
        positions[i * 3 + 1] = center.y;
        positions[i * 3 + 2] = center.z;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const speed = 2.2 + Math.random() * 2.4;
        velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
        velocities[i * 3 + 1] = Math.cos(phi) * speed;
        velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3),
      );
      const material = new THREE.PointsMaterial({
        color: new THREE.Color().setHSL(Math.random(), 0.95, 0.62),
        size: 0.14,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const points = new THREE.Points(geometry, material);
      points.frustumCulled = false;
      this.group.add(points);
      this.bursts.push({ points, velocities, age: 0 });
    }
  }

  update(dt: number) {
    for (let b = this.bursts.length - 1; b >= 0; b--) {
      const burst = this.bursts[b];
      burst.age += dt;
      if (burst.age >= BURST_LIFE) {
        this.group.remove(burst.points);
        burst.points.geometry.dispose();
        (burst.points.material as THREE.Material).dispose();
        this.bursts.splice(b, 1);
        continue;
      }
      const positions = burst.points.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      const array = positions.array as Float32Array;
      for (let i = 0; i < PARTICLES_PER_BURST; i++) {
        burst.velocities[i * 3 + 1] -= 4.5 * dt;
        array[i * 3] += burst.velocities[i * 3] * dt;
        array[i * 3 + 1] += burst.velocities[i * 3 + 1] * dt;
        array[i * 3 + 2] += burst.velocities[i * 3 + 2] * dt;
      }
      positions.needsUpdate = true;
      (burst.points.material as THREE.PointsMaterial).opacity =
        1 - burst.age / BURST_LIFE;
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
        // Camera đứng xa ~30 đơn vị — hạt phải to cỡ này mới thấy rõ;
        // tia spark mảnh hơn cột lửa
        size: style === "spark" ? 0.45 : 0.8,
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

  /** strength ~0.6 (nhẹ) → 1.6 (drop); which: index các vòi, bỏ trống = tất cả. */
  fire(strength = 1, which?: number[]) {
    const idxs = which ?? this.nozzles.map((_, i) => i);
    const per = Math.round(24 * Math.min(2, strength));
    // Đặt đèn lóe tại trung tâm các vòi vừa bắn
    let ax = 0;
    let ay = 0;
    let az = 0;
    let cnt = 0;
    for (const n of idxs) {
      const noz = this.nozzles[n];
      if (!noz) continue;
      ax += noz.x;
      ay += noz.y;
      az += noz.z;
      cnt++;
    }
    if (cnt) {
      this.flash.position.set(ax / cnt, ay / cnt + 1.6, az / cnt);
      this.flash.intensity = Math.min(
        130,
        this.flash.intensity + 50 * strength,
      );
    }
    for (const n of idxs) {
      const nozzle = this.nozzles[n];
      if (!nozzle) continue;
      const spark = this.style === "spark";
      for (let k = 0; k < per; k++) {
        const i = this.cursor;
        this.cursor = (this.cursor + 1) % FLAME_MAX;
        this.positions[i * 3] = nozzle.x + (Math.random() - 0.5) * 0.22;
        this.positions[i * 3 + 1] = nozzle.y;
        this.positions[i * 3 + 2] = nozzle.z + (Math.random() - 0.5) * 0.22;
        // Spark: tia mảnh phụt cao và thẳng; flame: cột lửa tỏa rộng hơn
        this.velocities[i * 3] = (Math.random() - 0.5) * (spark ? 0.5 : 1.2);
        this.velocities[i * 3 + 1] = spark
          ? (9 + Math.random() * 4) * (0.75 + strength * 0.3)
          : (6.5 + Math.random() * 3.5) * (0.7 + strength * 0.4);
        this.velocities[i * 3 + 2] =
          (Math.random() - 0.5) * (spark ? 0.5 : 1.2);
        this.maxLife[i] = this.life[i] = spark
          ? 0.5 + Math.random() * 0.35
          : 0.45 + Math.random() * 0.3;
      }
    }
  }

  update(dt: number) {
    const t = performance.now() / 1000;
    // Đèn lóe tắt nhanh như ánh lửa thật
    this.flash.intensity *= Math.max(0, 1 - dt * 7);
    let any = false;
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
