import * as THREE from "three";
import type { LiveUser } from "@/shared/live-events";
import { makeBubbleTexture, makeLabelTexture, type Skin } from "./skins";

const BASE_H = 1.875; // chiều cao chuẩn của nhân vật, bề rộng theo aspect skin
const BUBBLE_MS = 3200;

// Thời gian nhảy mặc định — giá trị thật do GameRules (admin setting) truyền vào
const DANCE_START_MS = 30_000;
const DANCE_EXTEND_MS = 15_000;
const DANCE_MAX_AHEAD_MS = 90_000;

const DROP_HEIGHT = 9;
const DROP_SECONDS = 1.1;

/**
 * Bộ điệu nhảy phong cách hiphop Việt Nam:
 * - bounce: nhún gối cơ bản theo kick
 * - two-step: bước ngang trái/phải luân phiên (toprock)
 * - lean-back: ngả người ra sau giữ 1 beat (swag)
 * - double-bounce: nhún double-time (2 nhịp/beat)
 * - spin: quay 360° trong 1 beat
 * - squat: xuống tấn nảy (bounce thấp)
 * - shoulder: lắc vai (nghiêng nhanh 2 bên)
 * - hop: bật cao
 */
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
  | "fan";
/** Danh sách điệu đang dùng — dùng cho trang test showcase. */
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
];
// bounce/two-step chiếm tỉ trọng cao — nền của hiphop
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
];

/** Nhịp nhạc toàn sàn do game đẩy xuống: index tăng mỗi beat, pulse 0..1 trong beat. */
export type Beat = { index: number; pulse: number };

// Rơi xuống có độ nảy khi chạm đất
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
  /** Đang đứng trên sàn nhảy (true) hay dưới khán đài (false). */
  onFloor = false;
  /** Top donate — đứng trên bục cạnh DJ, không bị luân chuyển sàn/khán đài. */
  onPodium = false;
  /** Trang test: ép nhảy đúng 1 điệu thay vì bốc ngẫu nhiên mỗi beat. */
  forcedMove: DanceMove | null = null;

  private sprite: THREE.Sprite;
  private label: THREE.Sprite;
  private bubble: THREE.Sprite | null = null;
  private bubbleUntil = 0;
  private skins: Skin[];
  private skinIndex: number;
  private frame = 0;
  private lastBeat = -1;

  // Nhảy: chỉ khi còn "năng lượng" (chat 1 để bật, comment để gia hạn)
  private danceUntil = 0;
  private readonly ampScale = 0.85 + Math.random() * 0.3; // mỗi người bốc một kiểu
  private readonly phase = Math.random() * Math.PI * 2;
  private tilt = 0;
  private tiltTarget = 0;
  private hopBoost = 0;
  // Điệu nhảy hiện tại (đổi mỗi beat) — bộ điệu phong cách hiphop VN
  private move: DanceMove = "bounce";
  private sideOffset = 0;
  private sideTarget = 0;
  private sideDir = 1; // hướng two-step luân phiên
  private halfBeatSwapped = false;
  // Hướng mặt (1 = gốc, -1 = lật gương) — điệu spin quay người 180°
  private facing = 1;
  private facingFrom = 1;

  private home: THREE.Vector3;
  private moveFrom: THREE.Vector3 | null = null;
  private moveTo: THREE.Vector3 | null = null;
  private moveT = 1;
  private scaleTarget = 1;
  private scaleCurrent = 1;
  private scaleResetAt = 0;
  /** Khán đài: nhân vật nhỏ lại + ẩn tên để không che khung hình. */
  private baseScale = 1;
  private zone: "audience" | "floor" | "podium" = "audience";
  private labelForceUntil = 0;

  private jumpT = -1;
  private circleT = -1;
  private dropT = 0; // 0..1, <1 = đang rơi từ trời xuống
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
    // Ghìm độ sáng dưới ngưỡng bloom để mặt trắng của meme không bị cháy sáng
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
    const labelH = 0.34;
    this.label.scale.set(labelH * aspect, labelH, 1);
    this.label.position.y = BASE_H + 0.28;

    this.group.add(this.sprite, this.label);
    // Xuất phát lơ lửng trên trời, update() sẽ thả rơi xuống
    this.group.position.set(this.home.x, this.home.y + DROP_HEIGHT, this.home.z);
  }

  private get currentSkin(): Skin {
    return this.skins[this.skinIndex % this.skins.length];
  }

  /** First frame of the current skin — used for the podium clone. */
  get texture(): THREE.Texture {
    return this.currentSkin.frames[0];
  }

  get isDancing(): boolean {
    return performance.now() < this.danceUntil;
  }

  /** Chuyển chỗ đứng (lên sàn / về khán đài) với bước di chuyển mượt. */
  setHome(target: THREE.Vector3) {
    this.moveFrom = this.home.clone();
    this.moveTo = target.clone();
    this.moveT = 0;
  }

  /**
   * Kích thước + nhãn theo khu vực: khán đài nhỏ và ẩn tên (đỡ che hình),
   * sàn nhảy chuẩn, bục DJ to nổi bật.
   */
  setZone(zone: "audience" | "floor" | "podium") {
    this.zone = zone;
    this.baseScale = zone === "audience" ? 0.72 : zone === "podium" ? 1.4 : 1;
    this.label.visible =
      zone !== "audience" || performance.now() < this.labelForceUntil;
  }

  /** Tạm hiện tên (vd: đang được camera zoom cận cảnh) rồi trả về theo khu. */
  showLabel(ms: number) {
    this.labelForceUntil = performance.now() + ms;
    this.label.visible = true;
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

  // --- Commands -----------------------------------------------------------

  /** Chat lệnh lên sàn: bật chế độ nhảy. */
  startDancing(ms = DANCE_START_MS) {
    const now = performance.now();
    this.danceUntil = Math.max(this.danceUntil, now + ms);
  }

  /** Comment thường: nếu đang nhảy thì gia hạn (bỏ qua khi nhảy vĩnh viễn). */
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

  /** Gán skin theo chỉ số (trang test dùng để duyệt tuần tự). */
  setSkin(index: number) {
    this.skinIndex = index % this.skins.length;
    const { texture, aspect } = makeLabelTexture(
      this.user.nickname,
      this.currentSkin.accent,
    );
    this.label.material.map?.dispose();
    this.label.material.map = texture;
    this.label.material.needsUpdate = true;
    const labelH = 0.34;
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

  /** Huy hiệu vàng dưới chân cho đại gia donate (mặc định 2 phút). */
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

  /** Hiện bong bóng chat trên đầu vài giây. */
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

  // --- Per-frame update ----------------------------------------------------

  update(dt: number, hype: number, beat: Beat, musicOn = true) {
    const now = performance.now();
    const t = now / 1000;
    // Không có nhạc → TẤT CẢ tạm dừng nhảy, chỉ chuyển động nhỏ.
    // Ngoại lệ duy nhất: nhân vật test của trang preview (soi điệu).
    const dancing =
      now < this.danceUntil && (musicOn || this.forcedMove !== null);

    // Đi bộ sang chỗ mới (lên sàn / về khán đài)
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
    if (dancing) {
      // Vào beat mới: đổi frame + bốc điệu hiphop mới
      if (beat.index !== this.lastBeat) {
        this.lastBeat = beat.index;
        this.frame = (this.frame + 1) % this.currentSkin.frames.length;
        this.applyFrame();
        this.halfBeatSwapped = false;
        this.move =
          this.forcedMove ??
          DANCE_MOVES[Math.floor(Math.random() * DANCE_MOVES.length)];
        this.sideDir = -this.sideDir;
        if (this.move === "spin") {
          // Quay người: lật hướng mặt trong nửa beat đầu
          this.facingFrom = this.facing;
          this.facing = -this.facing;
        }
        this.hopBoost = this.move === "hop" ? 0.3 : 0;
        this.tiltTarget =
          this.move === "lean-back"
            ? -0.3
            : this.move === "freeze"
              ? this.sideDir * 0.26
              : this.move === "two-step"
                ? this.sideDir * 0.14
                : 0;
        this.sideTarget =
          this.move === "two-step" ? this.sideDir * 0.7 : 0;
      }
      // Tay chân cử động RÕ: đổi frame mỗi NỬA beat cho mọi điệu
      if (!this.halfBeatSwapped && beat.pulse > 0.5) {
        this.halfBeatSwapped = true;
        this.frame = (this.frame + 1) % this.currentSkin.frames.length;
        this.applyFrame();
      }

      // Bật NGAY đầu phách rồi tiếp đất chờ phách sau — nhún theo kick
      const amp = (0.24 + hype * 0.26 + this.hopBoost) * this.ampScale;
      const hopPhase =
        this.move === "double-bounce" || this.move === "charleston"
          ? Math.min(1, (beat.pulse % 0.5) * 3.4)
          : Math.min(1, beat.pulse * 1.7);
      y = Math.sin(hopPhase * Math.PI) * amp;
      if (this.move === "squat") {
        // Xuống tấn: nhún thấp, người bè ra theo nhịp
        const s = Math.sin(Math.min(1, beat.pulse * 1.5) * Math.PI);
        y *= 0.4;
        scaleY = 1 - 0.24 * s;
        scaleX = 1 + 0.2 * s;
      } else if (this.move === "wave") {
        // Body wave: gợn sóng dọc thân, nhún nhẹ
        y *= 0.55;
        scaleY = 1 + 0.07 * Math.sin(beat.pulse * Math.PI * 4);
        scaleX = 1 - 0.05 * Math.sin(beat.pulse * Math.PI * 4);
      } else if (this.move === "freeze") {
        // Freeze: khựng pose 1 beat, phồng nhẹ
        y = amp * 0.12;
        scaleX = 1.06;
        scaleY = 1.06;
      } else if (this.move === "roll") {
        // Lăn người: quỹ đạo tròn nhỏ
        y = amp * 0.5 * (1 - Math.cos(beat.pulse * Math.PI * 2)) * 0.5;
      }
      // Bước chéo nhanh trái-phải trong 1 beat
      if (this.move === "cross-step") {
        this.sideTarget =
          Math.sin(beat.pulse * Math.PI * 3) * 0.4 * this.sideDir;
      } else if (this.move === "roll") {
        this.sideTarget =
          Math.sin(beat.pulse * Math.PI * 2) * 0.3 * this.sideDir;
      } else if (this.move === "fan") {
        // Múa quạt: lướt người theo vòng cung quét của tay quạt
        this.sideTarget =
          Math.sin(beat.pulse * Math.PI) * 0.5 * this.sideDir;
      }

      // Xoay/nghiêng theo điệu
      this.tilt += (this.tiltTarget - this.tilt) * Math.min(1, dt * 10);
      if (this.move === "spin") {
        // Quay người 180°: xoay từ hướng cũ sang hướng mới trong nửa beat,
        // sau đó đứng theo hướng mới — giống xoay người thật
        const p = Math.min(1, beat.pulse * 2);
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        let f = this.facingFrom + (this.facing - this.facingFrom) * e;
        if (Math.abs(f) < 0.06) f = f < 0 ? -0.06 : 0.06;
        scaleX *= f;
        this.sprite.material.rotation = this.tilt;
      } else if (this.move === "shoulder") {
        this.sprite.material.rotation =
          this.tilt + Math.sin(beat.pulse * Math.PI * 4) * 0.18;
      } else if (this.move === "wave") {
        this.sprite.material.rotation =
          this.tilt + Math.sin(beat.pulse * Math.PI * 2 - 1.2) * 0.15;
      } else if (this.move === "charleston") {
        this.sprite.material.rotation =
          this.tilt + Math.sin(beat.pulse * Math.PI * 4) * 0.2 * this.sideDir;
      } else if (this.move === "fan") {
        // Múa quạt: vung một vòng cung rộng qua đầu, đổi bên mỗi nhịp
        this.sprite.material.rotation =
          this.tilt + Math.sin(beat.pulse * Math.PI) * 0.38 * this.sideDir;
      } else {
        this.sprite.material.rotation =
          this.tilt + Math.sin(Math.PI * 2 * beat.pulse + this.phase) * 0.06;
      }
      // Bước ngang two-step mượt
      this.sideOffset +=
        (this.sideTarget - this.sideOffset) * Math.min(1, dt * 7);
    } else {
      // Đứng thở nhẹ chờ lệnh "1"
      if (this.frame !== 0) {
        this.frame = 0;
        this.applyFrame();
      }
      this.lastBeat = -1;
      // Chuyển động nhỏ chờ nhạc: thở nhẹ + lắc lư rất khẽ
      y = (Math.sin(t * 1.6 + this.phase) * 0.5 + 0.5) * 0.04;
      this.tilt += (0 - this.tilt) * Math.min(1, dt * 6);
      this.sprite.material.rotation =
        this.tilt + Math.sin(t * 1.1 + this.phase) * 0.03;
      this.sideOffset += (0 - this.sideOffset) * Math.min(1, dt * 6);
    }
    // Áp squash/stretch + hướng mặt lên sprite (spin tự nội suy hướng riêng)
    const spinActive = dancing && this.move === "spin";
    this.sprite.scale.set(
      BASE_H * this.currentSkin.aspect * scaleX * (spinActive ? 1 : this.facing),
      BASE_H * scaleY,
      1,
    );

    // Rơi từ trời xuống khi mới vào
    if (this.dropT < 1) {
      this.dropT = Math.min(1, this.dropT + dt / DROP_SECONDS);
      y += (1 - easeOutBounce(this.dropT)) * DROP_HEIGHT;
    }

    // Jump arc
    if (this.jumpT >= 0) {
      this.jumpT += dt / 0.65;
      if (this.jumpT >= 1) {
        this.jumpT = -1;
      } else {
        y += Math.sin(this.jumpT * Math.PI) * 1.6;
      }
    }

    // Run one lap around home position
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

    // Scale tween + timed reset
    if (this.scaleResetAt && now > this.scaleResetAt) {
      this.scaleTarget = 1;
      this.scaleResetAt = 0;
    }
    this.scaleCurrent += (this.scaleTarget - this.scaleCurrent) * Math.min(1, dt * 5);
    this.group.scale.setScalar(this.scaleCurrent * this.baseScale);

    // Hết thời gian hiện tên tạm → trả về quy tắc theo khu vực
    if (this.labelForceUntil && now > this.labelForceUntil) {
      this.labelForceUntil = 0;
      this.label.visible = this.zone !== "audience";
    }

    // Huy hiệu vàng xoay + nhấp nháy, hết hạn thì gỡ
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

    // Bong bóng chat mờ dần rồi biến mất
    if (this.bubble) {
      const remain = this.bubbleUntil - now;
      if (remain <= 0) {
        this.group.remove(this.bubble);
        this.bubble.material.map?.dispose();
        this.bubble.material.dispose();
        this.bubble = null;
      } else {
        this.bubble.material.opacity = Math.min(1, remain / 500);
      }
    }

    const swayX = dancing
      ? Math.sin(t * 2.2 + this.phase) * (0.05 + hype * 0.05)
      : 0;
    this.group.position.set(
      this.home.x + swayX + this.sideOffset + offsetX,
      this.home.y + y,
      this.home.z + offsetZ,
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
