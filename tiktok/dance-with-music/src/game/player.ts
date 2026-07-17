import * as THREE from "three";
import type { LiveUser } from "@/shared/live-events";
import { makeBubbleTexture, makeLabelTexture, type Skin } from "./skins";

const BASE_H = 1.875;
const BUBBLE_MS = 3200;

const DANCE_START_MS = 30_000;
const DANCE_EXTEND_MS = 15_000;
const DANCE_MAX_AHEAD_MS = 90_000;

const DROP_HEIGHT = 9;
const DROP_SECONDS = 1.1;

export type DanceMove =
  | "bounce"
  | "two-step"
  | "lean-back"
  | "double-bounce"
  | "spin"
  | "squat"
  | "shoulder"
  | "hop"
  | "wave"
  | "cross-step"
  | "roll"
  | "freeze"
  | "charleston"
  | "fan"
  | "sway"
  | "slide"
  | "kick"
  | "twist"
  | "headbang"
  | "robot"
  | "grapevine"
  | "moonwalk"
  | "shuffle"
  | "pogo"
  | "clap"
  | "dip"
  | "windmill"
  | "stomp";
export const ALL_DANCE_MOVES: DanceMove[] = [
  "bounce",
  "two-step",
  "lean-back",
  "double-bounce",
  "squat",
  "shoulder",
  "hop",
  "wave",
  "cross-step",
  "roll",
  "freeze",
  "charleston",
  "fan",
  "sway",
  "slide",
  "kick",
  "twist",
  "headbang",
  "robot",
  "grapevine",
  "moonwalk",
  "shuffle",
  "pogo",
  "clap",
  "dip",
  "windmill",
  "stomp",
];
const DANCE_MOVES: DanceMove[] = [
  "bounce",
  "bounce",
  "two-step",
  "two-step",
  "lean-back",
  "double-bounce",
  "squat",
  "shoulder",
  "hop",
  "wave",
  "cross-step",
  "roll",
  "freeze",
  "charleston",
  "fan",
  "sway",
  "sway",
  "slide",
  "kick",
  "twist",
  "headbang",
  "robot",
  "grapevine",
  "grapevine",
  "moonwalk",
  "moonwalk",
  "shuffle",
  "shuffle",
  "pogo",
  "clap",
  "dip",
  "windmill",
  "stomp",
];
const MOVE_BEATS: Record<DanceMove, number> = {
  bounce: 2,
  "two-step": 2,
  "lean-back": 1,
  "double-bounce": 2,
  spin: 1,
  squat: 2,
  shoulder: 2,
  hop: 1,
  wave: 2,
  "cross-step": 2,
  roll: 2,
  freeze: 1,
  charleston: 2,
  fan: 2,
  sway: 2,
  slide: 2,
  kick: 2,
  twist: 2,
  headbang: 2,
  robot: 2,
  grapevine: 4,
  moonwalk: 4,
  shuffle: 2,
  pogo: 2,
  clap: 2,
  dip: 2,
  windmill: 2,
  stomp: 2,
};

export type Beat = { index: number; pulse: number };

function easeOutBounce(x: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

export class Player {
  readonly user: LiveUser;
  readonly group = new THREE.Group();
  lastActive = 0;
  diamonds = 0;
  /** Điểm tương tác (chat/tim/quà) — xếp hạng ưu tiên hàng đầu sát sân khấu. */
  score = 0;
  onFloor = false;
  onPodium = false;
  forcedMove: DanceMove | null = null;
  /** Điệu đồng diễn cả sàn — game đặt/xóa theo chu kỳ 32 beat. */
  choreoMove: DanceMove | null = null;

  private sprite: THREE.Sprite;
  private label: THREE.Sprite;
  private bubble: THREE.Sprite | null = null;
  private bubbleUntil = 0;
  private skins: Skin[];
  private skinIndex: number;
  private frame = 0;
  private lastBeat = -1;

  private danceUntil = 0;
  private readonly ampScale = 0.85 + Math.random() * 0.3;
  private readonly phase = Math.random() * Math.PI * 2;
  private tilt = 0;
  private tiltTarget = 0;
  private hopBoost = 0;
  private move: DanceMove = "bounce";
  private moveBeatsLeft = 0;
  /** Nhịp thứ mấy trong điệu hiện tại — cho các điệu có chuỗi bước (grapevine). */
  private moveStep = 0;
  /** Hướng di chuyển cố định suốt một điệu (khác sideDir đảo mỗi nhịp). */
  private travelDir = 1;
  private sideOffset = 0;
  private sideTarget = 0;
  private sideDir = 1;
  // Đi dạo quanh chỗ đứng: đang nhảy trên sàn thì thi thoảng dời vài bước
  private roamOffset = new THREE.Vector3();
  private roamTarget = new THREE.Vector3();
  private halfBeatSwapped = false;
  private danceY = 0;
  private smoothSX = 1;
  private smoothSY = 1;
  private smoothRot = 0;
  private dimTarget = 1;
  private dimCurrent = 1;
  private facing = 1;
  private facingFrom = 1;

  private home: THREE.Vector3;
  private moveFrom: THREE.Vector3 | null = null;
  private moveTo: THREE.Vector3 | null = null;
  private moveT = 1;
  private scaleTarget = 1;
  private scaleCurrent = 1;
  private scaleResetAt = 0;
  private baseScale = 1;
  private zone: "audience" | "floor" | "podium" = "audience";
  private labelForceUntil = 0;

  private jumpT = -1;
  private circleT = -1;
  private dropT = 0;
  private badge: THREE.Mesh | null = null;
  private badgeUntil = 0;

  constructor(user: LiveUser, skins: Skin[], position: THREE.Vector3) {
    this.user = user;
    this.skins = skins;
    this.skinIndex = Math.floor(Math.random() * skins.length);
    this.home = position.clone();

    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.currentSkin.frames[0],
        transparent: true,
      }),
    );
    this.sprite.material.color.setScalar(0.72);
    this.applyAspect();
    this.sprite.position.y = BASE_H / 2;

    const { texture, aspect } = makeLabelTexture(
      user.nickname,
      this.currentSkin.accent,
    );
    this.label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true }),
    );
    const labelH = 0.42;
    this.label.scale.set(labelH * aspect, labelH, 1);
    this.label.position.y = BASE_H + 0.28;

    this.group.add(this.sprite, this.label);
    this.group.position.set(this.home.x, this.home.y + DROP_HEIGHT, this.home.z);
  }

  private get currentSkin(): Skin {
    return this.skins[this.skinIndex % this.skins.length];
  }

  get texture(): THREE.Texture {
    return this.currentSkin.frames[0];
  }

  get isDancing(): boolean {
    return performance.now() < this.danceUntil;
  }

  get skinNumber(): number {
    return this.skinIndex % this.skins.length;
  }

  get skinAspect(): number {
    return this.currentSkin.aspect;
  }

  setHome(target: THREE.Vector3) {
    this.moveFrom = this.home.clone();
    this.moveTo = target.clone();
    this.moveT = 0;
  }

  setZone(zone: "audience" | "floor" | "podium") {
    this.zone = zone;
    this.baseScale = zone === "audience" ? 0.72 : zone === "podium" ? 1.4 : 1;
    // Bục podium đã có bảng tên 🥇 riêng — ẩn nhãn cá nhân tránh trùng đôi
    this.label.visible =
      zone === "floor" || performance.now() < this.labelForceUntil;
  }

  showLabel(ms: number) {
    this.labelForceUntil = performance.now() + ms;
    this.label.visible = true;
  }

  setDimmed(dimmed: boolean) {
    this.dimTarget = dimmed ? 0.22 : 1;
  }

  setSkins(skins: Skin[]) {
    this.skins = skins;
    this.skinIndex = this.skinIndex % skins.length;
    this.applyFrame();
    this.applyAspect();
  }

  private applyAspect() {
    this.sprite.scale.set(BASE_H * this.currentSkin.aspect, BASE_H, 1);
  }

  private applyFrame() {
    const frames = this.currentSkin.frames;
    this.sprite.material.map = frames[this.frame % frames.length];
    this.sprite.material.needsUpdate = true;
  }

  startDancing(ms = DANCE_START_MS) {
    const now = performance.now();
    this.danceUntil = Math.max(this.danceUntil, now + ms);
  }

  keepDancing(extendMs = DANCE_EXTEND_MS, maxAheadMs = DANCE_MAX_AHEAD_MS) {
    if (!this.isDancing || !Number.isFinite(this.danceUntil)) return;
    this.danceUntil = Math.min(
      this.danceUntil + extendMs,
      performance.now() + maxAheadMs,
    );
  }

  jump() {
    if (this.jumpT < 0) this.jumpT = 0;
  }

  swapSkin() {
    this.setSkin(this.skinIndex + 1);
  }

  setSkin(index: number) {
    this.skinIndex = index % this.skins.length;
    const { texture, aspect } = makeLabelTexture(
      this.user.nickname,
      this.currentSkin.accent,
    );
    this.label.material.map?.dispose();
    this.label.material.map = texture;
    this.label.material.needsUpdate = true;
    const labelH = 0.42;
    this.label.scale.set(labelH * aspect, labelH, 1);
    this.frame = 0;
    this.applyFrame();
    this.applyAspect();
  }

  runCircle() {
    if (this.circleT < 0) this.circleT = 0;
  }

  grow() {
    this.scaleTarget = 1.9;
    this.scaleResetAt = performance.now() + 8000;
  }

  shrink() {
    this.scaleTarget = 0.55;
    this.scaleResetAt = performance.now() + 8000;
  }

  celebrate(danceMs = DANCE_START_MS) {
    this.startDancing(danceMs);
    this.jump();
  }

  giveBadge(ms = 120_000) {
    this.badgeUntil = performance.now() + ms;
    if (!this.badge) {
      this.badge = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.78, 32),
        new THREE.MeshBasicMaterial({
          color: 0xffc94d,
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      this.badge.rotation.x = -Math.PI / 2;
      this.badge.position.y = 0.06;
      this.group.add(this.badge);
    }
  }

  say(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.bubble) {
      this.group.remove(this.bubble);
      this.bubble.material.map?.dispose();
      this.bubble.material.dispose();
    }
    const { texture, aspect } = makeBubbleTexture(trimmed);
    this.bubble = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true }),
    );
    this.bubble.material.color.setScalar(0.72);
    const h = 0.42;
    this.bubble.scale.set(h * aspect, h, 1);
    this.bubble.position.y = BASE_H + 0.75;
    this.group.add(this.bubble);
    this.bubbleUntil = performance.now() + BUBBLE_MS;
  }

  update(dt: number, hype: number, beat: Beat, musicOn = true, level = 0) {
    const now = performance.now();
    const t = now / 1000;
    const dancing = musicOn && now < this.danceUntil;

    if (this.moveT < 1 && this.moveFrom && this.moveTo) {
      this.moveT = Math.min(1, this.moveT + dt / 0.9);
      const e =
        this.moveT < 0.5
          ? 2 * this.moveT * this.moveT
          : 1 - Math.pow(-2 * this.moveT + 2, 2) / 2;
      this.home.lerpVectors(this.moveFrom, this.moveTo, e);
    }

    let y = 0;

    let scaleX = 1;
    let scaleY = 1;
    let rot = 0;
    if (dancing) {
      if (beat.index !== this.lastBeat) {
        this.lastBeat = beat.index;
        this.frame = (this.frame + 1) % this.currentSkin.frames.length;
        this.applyFrame();
        this.halfBeatSwapped = false;
        this.moveBeatsLeft -= 1;
        const prevMove = this.move;
        if (this.forcedMove) {
          this.move = this.forcedMove;
        } else if (this.choreoMove) {
          this.move = this.choreoMove;
          this.moveBeatsLeft = MOVE_BEATS[this.move] ?? 2;
        } else if (this.moveBeatsLeft <= 0) {
          let next =
            DANCE_MOVES[Math.floor(Math.random() * DANCE_MOVES.length)];
          if (next === this.move)
            next = DANCE_MOVES[Math.floor(Math.random() * DANCE_MOVES.length)];
          this.move = next;
          this.moveBeatsLeft = MOVE_BEATS[this.move] ?? 2;
        }
        if (this.move !== prevMove) {
          this.moveStep = 0;
          // Đồng diễn: cả sàn đi cùng hướng (suy từ beat), tự do thì ngẫu nhiên
          this.travelDir = this.choreoMove
            ? ((beat.index >> 2) & 1) === 0
              ? 1
              : -1
            : Math.random() < 0.5
              ? 1
              : -1;
          // Moonwalk: mặt quay ngược hướng trượt mới ra chất moonwalk
          if (this.move === "moonwalk") this.facing = -this.travelDir;
        } else {
          this.moveStep++;
        }
        this.sideDir = -this.sideDir;
        if (this.move === "spin") {
          this.facingFrom = this.facing;
          this.facing = -this.facing;
        }
        this.hopBoost =
          this.move === "hop" ? 0.3 : this.move === "pogo" ? 0.45 : 0;
        this.tiltTarget =
          this.move === "lean-back"
            ? -0.3
            : this.move === "freeze"
              ? this.sideDir * 0.26
              : this.move === "two-step"
                ? this.sideDir * 0.14
                : this.move === "sway"
                  ? -this.sideDir * 0.12
                  : this.move === "slide"
                    ? this.sideDir * 0.08
                    : this.move === "kick"
                      ? -0.1
                      : this.move === "dip"
                        ? -0.35
                        : this.move === "shuffle"
                          ? this.sideDir * 0.1
                          : this.move === "stomp"
                            ? this.sideDir * 0.06
                            : 0;
        this.sideTarget =
          this.move === "two-step"
            ? this.sideDir * 0.95
            : this.move === "sway"
              ? this.sideDir * 0.6
              : this.move === "slide"
                ? this.sideDir * 1.25
                : this.move === "stomp"
                  ? this.sideDir * 0.3
                  : 0;
        if (this.move === "grapevine") {
          // Chuỗi bước ngang 4 nhịp: bước - chụm - bước xa - lùi về
          const seq = [0.5, 1.05, 1.6, 0.75];
          this.sideTarget = this.travelDir * seq[this.moveStep % 4];
          this.tiltTarget = this.travelDir * 0.08;
        } else if (this.move === "moonwalk") {
          this.sideTarget =
            this.travelDir * (0.35 + (this.moveStep % 4) * 0.45);
          this.tiltTarget = -0.16;
        }
        // Thi thoảng dời chỗ vài bước quanh slot — sàn có dòng người qua lại
        if (
          this.zone === "floor" &&
          !this.onPodium &&
          beat.index % 4 === 0 &&
          Math.random() < 0.3
        ) {
          const a = Math.random() * Math.PI * 2;
          const r = 0.5 + Math.random() * 1.1;
          this.roamTarget.set(Math.cos(a) * r, 0, Math.sin(a) * r * 0.7);
        }
      }
      if (!this.halfBeatSwapped && beat.pulse > 0.5) {
        this.halfBeatSwapped = true;
        this.frame = (this.frame + 1) % this.currentSkin.frames.length;
        this.applyFrame();
      }

      // Phách 1 của ô nhịp 4 nhún mạnh nhất, phách 3 vừa — tạo groove rõ rệt
      const accent =
        beat.index % 4 === 0 ? 1.25 : beat.index % 2 === 0 ? 1.1 : 1;
      const amp =
        (0.2 + hype * 0.22 + level * 0.22 + this.hopBoost) *
        this.ampScale *
        accent;
      const hopPhase =
        this.move === "double-bounce" ||
        this.move === "charleston" ||
        this.move === "pogo"
          ? Math.min(1, (beat.pulse % 0.5) * 3.4)
          : Math.min(1, beat.pulse * 1.7);
      y = Math.sin(hopPhase * Math.PI) * amp;
      if (this.move === "squat") {
        const s = Math.sin(Math.min(1, beat.pulse * 1.5) * Math.PI);
        y *= 0.4;
        scaleY = 1 - 0.24 * s;
        scaleX = 1 + 0.2 * s;
      } else if (this.move === "wave") {
        y *= 0.55;
        scaleY = 1 + 0.07 * Math.sin(beat.pulse * Math.PI * 4);
        scaleX = 1 - 0.05 * Math.sin(beat.pulse * Math.PI * 4);
      } else if (this.move === "freeze") {
        y = amp * 0.12;
        scaleX = 1.06;
        scaleY = 1.06;
      } else if (this.move === "roll") {
        y = amp * 0.5 * (1 - Math.cos(beat.pulse * Math.PI * 2)) * 0.5;
      } else if (this.move === "sway") {
        y *= 0.4;
      } else if (this.move === "slide") {
        y = amp * 0.08;
        scaleY = 0.96;
      } else if (this.move === "kick") {
        y *= 0.6;
      } else if (this.move === "twist") {
        y *= 0.5;
        scaleX = 1 - 0.22 * Math.abs(Math.sin(beat.pulse * Math.PI * 2));
      } else if (this.move === "headbang") {
        y *= 0.35;
        scaleY = 0.97;
      } else if (this.move === "robot") {
        y = amp * 0.1;
      } else if (this.move === "grapevine") {
        y *= 0.75;
      } else if (this.move === "moonwalk") {
        y = amp * 0.08;
        scaleY = 0.985;
      } else if (this.move === "shuffle") {
        y *= 0.45;
      } else if (this.move === "pogo") {
        // Bật cao liên tục như lò xo — giãn người khi bay, nén khi chạm đất
        scaleY = 1 + 0.09 * Math.sin(hopPhase * Math.PI);
        scaleX = 1 - 0.06 * Math.sin(hopPhase * Math.PI);
      } else if (this.move === "clap") {
        y *= 0.8;
        scaleX = 1 - 0.16 * Math.max(0, Math.sin(beat.pulse * Math.PI * 2));
      } else if (this.move === "dip") {
        y = amp * 0.15;
      } else if (this.move === "windmill") {
        y *= 0.5;
      } else if (this.move === "stomp") {
        // Dậm mạnh phách xuống — chạm đất là nén người rồi nảy tắt dần
        y = amp * Math.max(0, 1 - beat.pulse * 2.2) * 0.9;
        scaleY = 1 - 0.1 * Math.max(0, 1 - beat.pulse * 3);
        scaleX = 1 + 0.07 * Math.max(0, 1 - beat.pulse * 3);
      }
      if (this.move === "cross-step") {
        this.sideTarget =
          Math.sin(beat.pulse * Math.PI * 3) * 0.55 * this.sideDir;
      } else if (this.move === "shuffle") {
        // Bước lết nhanh kiểu shuffle TikTok — đảo chân gấp đôi nhịp thường
        this.sideTarget =
          Math.sin(beat.pulse * Math.PI * 4) * 0.42 * this.sideDir;
      } else if (this.move === "roll") {
        this.sideTarget =
          Math.sin(beat.pulse * Math.PI * 2) * 0.4 * this.sideDir;
      } else if (this.move === "fan") {
        this.sideTarget =
          Math.sin(beat.pulse * Math.PI) * 0.6 * this.sideDir;
      } else if (this.move === "twist") {
        this.sideTarget =
          Math.sin(beat.pulse * Math.PI * 2) * 0.15 * this.sideDir;
      } else if (this.move === "robot") {
        const step = Math.floor(beat.pulse * 4) % 4;
        this.sideTarget = (step === 1 || step === 2 ? 0.3 : 0) * this.sideDir;
      }

      this.tilt += (this.tiltTarget - this.tilt) * Math.min(1, dt * 10);
      if (this.move === "spin") {
        const p = Math.min(1, beat.pulse * 2);
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        let f = this.facingFrom + (this.facing - this.facingFrom) * e;
        if (Math.abs(f) < 0.06) f = f < 0 ? -0.06 : 0.06;
        scaleX *= f;
        rot = this.tilt;
      } else if (this.move === "shoulder") {
        rot = this.tilt + Math.sin(beat.pulse * Math.PI * 4) * 0.18;
      } else if (this.move === "wave") {
        rot = this.tilt + Math.sin(beat.pulse * Math.PI * 2 - 1.2) * 0.15;
      } else if (this.move === "charleston") {
        rot = this.tilt + Math.sin(beat.pulse * Math.PI * 4) * 0.2 * this.sideDir;
      } else if (this.move === "fan") {
        rot = this.tilt + Math.sin(beat.pulse * Math.PI) * 0.38 * this.sideDir;
      } else if (this.move === "sway") {
        rot = this.tilt + Math.sin(beat.pulse * Math.PI) * 0.1 * this.sideDir;
      } else if (this.move === "kick") {
        rot =
          this.tilt +
          Math.max(0, Math.sin(beat.pulse * Math.PI * 2)) * 0.25 * this.sideDir;
      } else if (this.move === "twist") {
        rot = this.tilt + Math.sin(beat.pulse * Math.PI * 2) * 0.1;
      } else if (this.move === "headbang") {
        rot = this.tilt - Math.abs(Math.sin(beat.pulse * Math.PI * 2)) * 0.26;
      } else if (this.move === "robot") {
        const step = Math.floor(beat.pulse * 4) % 4;
        rot = this.tilt + [0, 0.14, 0, -0.14][step] * this.sideDir;
      } else if (this.move === "shuffle") {
        rot = this.tilt + Math.sin(beat.pulse * Math.PI * 4) * 0.1;
      } else if (this.move === "clap") {
        rot = this.tilt + Math.sin(beat.pulse * Math.PI * 2) * 0.08 * this.sideDir;
      } else if (this.move === "dip") {
        // Gập người sâu xuống rồi ngửa lên — như cúi chào điệu nghệ
        rot = this.tilt - Math.sin(beat.pulse * Math.PI) * 0.22;
      } else if (this.move === "windmill") {
        // Vung tay quay vòng lớn — lắc thân biên độ rộng hai bên
        rot = this.tilt + Math.sin(beat.pulse * Math.PI * 2) * 0.34 * this.sideDir;
      } else if (this.move === "stomp") {
        rot = this.tilt + Math.max(0, 1 - beat.pulse * 3) * 0.08 * this.sideDir;
      } else {
        rot = this.tilt + Math.sin(Math.PI * 2 * beat.pulse + this.phase) * 0.06;
      }
      this.sideOffset +=
        (this.sideTarget - this.sideOffset) * Math.min(1, dt * 7);
    } else {
      if (this.frame !== 0) {
        this.frame = 0;
        this.applyFrame();
      }
      this.lastBeat = -1;
      this.moveBeatsLeft = 0;
      y = (Math.sin(t * 1.6 + this.phase) * 0.5 + 0.5) * 0.04;
      this.tilt += (0 - this.tilt) * Math.min(1, dt * 6);
      rot = this.tilt + Math.sin(t * 1.1 + this.phase) * 0.03;
      if (musicOn) {
        // Khán giả không nhảy vẫn gật gù nhẹ theo kick của nhạc
        const nod = Math.max(0, 1 - beat.pulse * 3);
        y += nod * (0.035 + level * 0.05) * this.ampScale;
        rot += nod * 0.02 * (this.phase > Math.PI ? 1 : -1);
      }
      this.sideOffset += (0 - this.sideOffset) * Math.min(1, dt * 6);
    }
    const spinActive = dancing && this.move === "spin";
    const targetSX = scaleX * (spinActive ? 1 : this.facing);
    const smooth = Math.min(1, dt * 18);
    this.danceY += (y - this.danceY) * smooth;
    y = this.danceY;
    this.smoothSX += (targetSX - this.smoothSX) * smooth;
    this.smoothSY += (scaleY - this.smoothSY) * smooth;
    this.smoothRot += (rot - this.smoothRot) * smooth;
    this.sprite.material.rotation = this.smoothRot;
    this.sprite.scale.set(
      BASE_H * this.currentSkin.aspect * this.smoothSX,
      BASE_H * this.smoothSY,
      1,
    );

    this.dimCurrent += (this.dimTarget - this.dimCurrent) * Math.min(1, dt * 6);
    this.sprite.material.opacity = this.dimCurrent;
    this.label.material.opacity = this.dimCurrent;

    if (this.dropT < 1) {
      this.dropT = Math.min(1, this.dropT + dt / DROP_SECONDS);
      y += (1 - easeOutBounce(this.dropT)) * DROP_HEIGHT;
    }

    if (this.jumpT >= 0) {
      this.jumpT += dt / 0.65;
      if (this.jumpT >= 1) {
        this.jumpT = -1;
      } else {
        y += Math.sin(this.jumpT * Math.PI) * 1.6;
      }
    }

    let offsetX = 0;
    let offsetZ = 0;
    if (this.circleT >= 0) {
      this.circleT += dt / 3;
      if (this.circleT >= 1) {
        this.circleT = -1;
      } else {
        const a = this.circleT * Math.PI * 2;
        offsetX = Math.sin(a) * 1.6;
        offsetZ = (1 - Math.cos(a)) * 0.9;
      }
    }

    if (this.scaleResetAt && now > this.scaleResetAt) {
      this.scaleTarget = 1;
      this.scaleResetAt = 0;
    }
    this.scaleCurrent += (this.scaleTarget - this.scaleCurrent) * Math.min(1, dt * 5);
    this.group.scale.setScalar(this.scaleCurrent * this.baseScale);

    if (this.labelForceUntil && now > this.labelForceUntil) {
      this.labelForceUntil = 0;
      this.label.visible = this.zone === "floor";
    }

    if (this.badge) {
      if (now > this.badgeUntil) {
        this.group.remove(this.badge);
        (this.badge.material as THREE.Material).dispose();
        this.badge.geometry.dispose();
        this.badge = null;
      } else {
        this.badge.rotation.z += dt * 1.5;
        (this.badge.material as THREE.MeshBasicMaterial).opacity =
          0.65 + Math.sin(t * 5) * 0.25;
      }
    }

    if (this.bubble) {
      const remain = this.bubbleUntil - now;
      if (remain <= 0) {
        this.group.remove(this.bubble);
        this.bubble.material.map?.dispose();
        this.bubble.material.dispose();
        this.bubble = null;
      } else {
        this.bubble.material.opacity = Math.min(1, remain / 500) * this.dimCurrent;
      }
    }

    // Đi dạo quanh slot: lướt chậm tới điểm mới trong lúc vẫn giữ nhịp nhảy
    if (dancing && this.zone === "floor" && !this.onPodium) {
      this.roamOffset.lerp(this.roamTarget, Math.min(1, dt * 1.6));
    } else {
      this.roamTarget.set(0, 0, 0);
      this.roamOffset.lerp(this.roamTarget, Math.min(1, dt * 2.5));
    }

    const swayX = dancing
      ? Math.sin(t * 2.2 + this.phase) * (0.06 + hype * 0.06)
      : 0;
    this.group.position.set(
      this.home.x + swayX + this.sideOffset + offsetX + this.roamOffset.x,
      this.home.y + y,
      this.home.z + offsetZ + this.roamOffset.z,
    );
  }

  dispose() {
    this.sprite.material.dispose();
    this.label.material.map?.dispose();
    this.label.material.dispose();
    if (this.bubble) {
      this.bubble.material.map?.dispose();
      this.bubble.material.dispose();
    }
    if (this.badge) {
      (this.badge.material as THREE.Material).dispose();
      this.badge.geometry.dispose();
    }
  }
}
