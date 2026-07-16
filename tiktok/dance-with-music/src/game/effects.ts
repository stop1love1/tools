import * as THREE from "three";
import type { Beat } from "./player";

const NEON = [0xfe2c55, 0x25f4ee, 0x8a2be2, 0xffc94d, 0x2ecc71, 0x3498db];

export class DiscoFloor {
  readonly mesh: THREE.InstancedMesh;

  constructor(width: number, depth: number, cols = 16, rows = 12) {
    const tileW = width / cols;
    const tileD = depth / rows;
    const geometry = new THREE.BoxGeometry(tileW * 0.92, 0.1, tileD * 0.92);
    const material = new THREE.MeshStandardMaterial({
      metalness: 0.55,
      roughness: 0.35,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, cols * rows);

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        dummy.position.set(
          (c + 0.5 - cols / 2) * tileW,
          0.05,
          (r + 0.5 - rows / 2) * tileD,
        );
        dummy.updateMatrix();
        this.mesh.setMatrixAt(i, dummy.matrix);
        color.setHex((c + r) % 2 === 0 ? 0x262b3d : 0x171a28);
        this.mesh.setColorAt(i, color);
        i++;
      }
    }
  }

  update(_dt: number, _hype: number, _beat: Beat) {
  }
}

export class LedWall {
  readonly mesh: THREE.InstancedMesh;
  private readonly cols: number;
  private readonly rows: number;
  private readonly color = new THREE.Color();
  private acc = 0;

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

  update(dt: number, hype: number, beat: Beat, level = 0, musicOn = true) {
    this.acc += dt;
    if (this.acc < 0.05) return;
    this.acc = 0;
    const t = performance.now() / 1000;
    const kick =
      Math.max(0, 1 - beat.pulse * 3) * (0.1 + hype * 0.15 + level * 0.25) +
      level * 0.08;
    const dim = musicOn ? 1 : 0.22;
    let i = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const wave =
          Math.sin(c * 0.55 - t * (musicOn ? 0.7 + hype * 1.4 : 0.25) + r * 0.35) *
            0.5 +
          0.5;
        const hue = (0.9 + c * 0.012 + t * 0.03) % 1;
        this.color.setHSL(
          hue,
          0.85,
          Math.min(0.42, (0.07 + wave * (0.14 + hype * 0.2) + kick) * dim),
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

  update(dt: number, hype: number, beat: Beat, level = 0, musicOn = true) {
    const t = performance.now() / 1000;
    const kick = Math.max(0, 1 - beat.pulse * 3);
    const swing = musicOn
      ? (beat.index % 2 === 0 ? 1 : -1) * (0.42 + hype * 0.25)
      : 0;
    this.beams.forEach((beam, i) => {
      const target = i % 2 === 0 ? swing : -swing;
      beam.rotation.z += (target - beam.rotation.z) * Math.min(1, dt * 5);
      const targetX = musicOn
        ? Math.cos(t * (0.18 + hype * 0.35) + i) * 0.25
        : 0;
      beam.rotation.x += (targetX - beam.rotation.x) * Math.min(1, dt * 5);
      (beam.material as THREE.MeshBasicMaterial).opacity = musicOn
        ? 0.05 + hype * 0.06 + level * 0.16 + kick * (0.04 + level * 0.14)
        : 0.015;
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

  update(dt: number, hype: number) {
    this.ball.rotation.y += dt * (0.4 + hype * 1.2);
    this.sparkles.rotation.y -= dt * (0.15 + hype * 0.5);
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

  constructor() {
    const colors = [0xfe2c55, 0x25f4ee, 0x8a2be2, 0xffc94d];
    for (let i = 0; i < colors.length; i++) {
      const light = new THREE.PointLight(colors[i], 60, 44, 1.6);
      light.position.set(0, 6, 0);
      this.group.add(light);
      this.lights.push(light);
    }
  }

  update(dt: number, hype: number, beat: Beat, level = 0, musicOn = true) {
    const t = performance.now() / 1000;
    const kick = Math.max(0, 1 - beat.pulse * 3);
    if (beat.index !== this.lastBeat) {
      this.lastBeat = beat.index;
      this.angleTarget += Math.PI / 6;
    }
    this.angle += (this.angleTarget - this.angle) * Math.min(1, dt * 7);
    this.lights.forEach((light, i) => {
      const a = this.angle + (i / this.lights.length) * Math.PI * 2;
      light.position.set(
        Math.cos(a) * 12,
        5.2 + Math.sin(t * 0.3 + i) * 1.2,
        Math.sin(a) * 8,
      );
      const target = musicOn
        ? 35 + hype * 35 + level * 110 + kick * (25 + level * 80 + hype * 25)
        : 8;
      light.intensity += (target - light.intensity) * Math.min(1, dt * 6);
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
