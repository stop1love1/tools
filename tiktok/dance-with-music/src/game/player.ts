import * as THREE from "three";
import type { LiveUser } from "@/shared/live-events";
import { CharacterRig, GENRE_GROOVE } from "./rig";
import { makeBubbleTexture, makeLabelTexture, type Skin } from "./skins";

const BASE_H = 1.875;
// Bong bóng chat: to & lâu hơn cho dễ đọc trên màn dọc mobile (TikTok live)
const BUBBLE_MS = 4600;

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
  | "stomp"
  // Nhóm điệu meme — chất TikTok/viral, đối lại bộ điệu sàn cổ điển ở trên
  | "griddy"
  | "gangnam"
  | "sprinkler"
  | "heel-toe"
  | "mushroom-pop";
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
  "griddy",
  "gangnam",
  "sprinkler",
  "heel-toe",
  "mushroom-pop",
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
  "griddy",
  "griddy",
  "gangnam",
  "sprinkler",
  "heel-toe",
  "mushroom-pop",
];
/** Thể loại nhạc ước lượng từ phổ tần — quyết định pool điệu nhảy + chất đèn. */
export type MusicGenre = "ballad" | "pop" | "hiphop" | "rock" | "edm";

/**
 * Pool điệu nhảy theo thể loại: ballad lắc lư mềm, hiphop groove khớp,
 * rock quẩy đầu, EDM bật nhảy liên tục. Lặp phần tử = tăng tỉ lệ ra điệu đó.
 */
export const GENRE_MOVES: Record<MusicGenre, DanceMove[]> = {
  ballad: [
    "sway", "sway", "wave", "wave", "lean-back", "fan", "dip", "roll",
    "freeze", "cross-step", "sway", "wave",
  ],
  pop: [], // gán = DANCE_MOVES bên dưới — giữ độ đa dạng mặc định
  hiphop: [
    "two-step", "two-step", "robot", "robot", "moonwalk", "cross-step",
    "shoulder", "bounce", "slide", "twist", "stomp", "freeze",
    "griddy", "griddy", "griddy", "heel-toe", "heel-toe",
  ],
  rock: [
    "headbang", "headbang", "pogo", "stomp", "stomp", "windmill", "clap",
    "hop", "headbang", "mushroom-pop",
  ],
  edm: [
    "pogo", "pogo", "shuffle", "shuffle", "hop", "double-bounce",
    "charleston", "twist", "clap", "bounce",
    "mushroom-pop", "mushroom-pop", "heel-toe", "gangnam",
  ],
};

/** Tín hiệu nhạc nâng cao game truyền xuống mỗi frame (dùng chung 1 object). */
export type MusicVibe = {
  genre: MusicGenre;
  melodyTrend: number;
  melodyHeight: number;
  /**
   * Cường độ đoạn nhạc 0..1 (từ section): verse ~0.3 lắng, điệp khúc/drop ~0.9
   * bùng. Quyết định biên độ nhún VÀ độ "dữ" của điệu được bốc ra.
   */
  intensity: number;
  /** Năng lượng kick/bass tức thời 0..1 — cú "pop" phách 1&3 bật theo tiếng thật. */
  kick: number;
  /** Năng lượng snare/hi-hat tức thời 0..1 — cú "pop" backbeat 2&4 bật theo tiếng thật. */
  snare: number;
  /** Tin cậy beat 0..1 — chắc thì accent giòn/đầy, mờ thì dịu tránh nhún sai phách. */
  beatConfidence: number;
};

/**
 * Đường cong độ nảy trong một cung nhún, lệch đỉnh theo `peak` (0..1):
 * - peak = 0.5 → hệt `sin(phase·π)` cũ (an toàn, không đổi hành vi mặc định).
 * - peak < 0.5 → attack sắc kiểu lò xo (edm): vọt lên nhanh, hạ chậm.
 * - peak > 0.5 → lên mềm, xuống muộn (ballad).
 * Cung tam giác (đỉnh tại `peak`) được làm mượt bằng nửa sin nên vẫn tròn trịa.
 */
export function grooveCurve(phase: number, peak: number): number {
  const p = phase <= 0 ? 0 : phase >= 1 ? 1 : phase;
  const pk = peak <= 0.02 ? 0.02 : peak >= 0.98 ? 0.98 : peak;
  const x = p < pk ? p / pk : 1 - (p - pk) / (1 - pk);
  return Math.sin(Math.max(0, x) * (Math.PI / 2));
}

/** Các điệu cố ý giữ người phẳng — không cộng "pop" theo kick/snare. */
const FLAT_MOVES: ReadonlySet<DanceMove> = new Set<DanceMove>([
  "freeze",
  "robot",
  "slide",
  "moonwalk",
  "dip",
]);

/**
 * "Độ dữ" của mỗi điệu 0 (êm, lắc lư) .. 1 (bốc, bật nhảy). Dùng để bốc điệu
 * khớp năng lượng đoạn nhạc — verse ra điệu dịu, điệp khúc ra điệu quẩy.
 */
const MOVE_ENERGY: Record<DanceMove, number> = {
  sway: 0.12,
  wave: 0.18,
  dip: 0.2,
  "lean-back": 0.24,
  fan: 0.28,
  freeze: 0.3,
  roll: 0.34,
  slide: 0.36,
  "two-step": 0.4,
  robot: 0.4,
  "cross-step": 0.42,
  moonwalk: 0.44,
  shoulder: 0.46,
  bounce: 0.5,
  grapevine: 0.5,
  squat: 0.5,
  twist: 0.52,
  charleston: 0.55,
  clap: 0.55,
  spin: 0.58,
  kick: 0.6,
  "double-bounce": 0.66,
  hop: 0.72,
  shuffle: 0.72,
  stomp: 0.76,
  headbang: 0.82,
  windmill: 0.84,
  pogo: 0.92,
  sprinkler: 0.48,
  "heel-toe": 0.58,
  griddy: 0.62,
  gangnam: 0.7,
  "mushroom-pop": 0.8,
};

/**
 * Bốc một điệu trong pool sao cho "độ dữ" khớp năng lượng đoạn nhạc `target`.
 * Lấy vài ứng viên rồi chọn cái gần target nhất (có nhiễu để vẫn đa dạng).
 */
export function pickEnergyMove(pool: DanceMove[], target: number): DanceMove {
  let best = pool[0];
  let bestScore = Infinity;
  for (let k = 0; k < 3; k++) {
    const c = pool[Math.floor(Math.random() * pool.length)];
    const d = Math.abs((MOVE_ENERGY[c] ?? 0.5) - target) + Math.random() * 0.35;
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return best;
}

/**
 * Độ nghiêng thân giữ suốt một nhịp của điệu. `side` = nhân theo `sideDir`
 * (đảo dấu mỗi nhịp → lắc qua lại); không có `side` là nghiêng cố định một phía.
 * Điệu không có mặt trong bảng thì đứng thẳng.
 */
const MOVE_TILT: Partial<Record<DanceMove, { v: number; side?: boolean }>> = {
  "lean-back": { v: -0.3 },
  freeze: { v: 0.26, side: true },
  "two-step": { v: 0.14, side: true },
  sway: { v: -0.12, side: true },
  slide: { v: 0.08, side: true },
  kick: { v: -0.1 },
  dip: { v: -0.35 },
  shuffle: { v: 0.1, side: true },
  stomp: { v: 0.06, side: true },
  griddy: { v: 0.09, side: true },
  "heel-toe": { v: 0.07, side: true },
  sprinkler: { v: 0.16, side: true },
};

/** Biên độ dịch ngang giữ suốt một nhịp (nhân `sideDir`, đảo mỗi nhịp). */
const MOVE_SIDE: Partial<Record<DanceMove, number>> = {
  "two-step": 0.95,
  sway: 0.6,
  slide: 1.25,
  stomp: 0.3,
  griddy: 0.5,
  "heel-toe": 0.34,
};

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
  griddy: 2,
  gangnam: 4,
  sprinkler: 4,
  "heel-toe": 2,
  "mushroom-pop": 2,
};

GENRE_MOVES.pop = DANCE_MOVES;

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
  /**
   * Đã được phép lên sàn — ở chế độ "auto" chỉ khi đã chat lệnh lên sàn cờ
   * này mới bật; quà/follow không tự đưa người chưa chat lên sàn.
   */
  floorEligible = false;
  forcedMove: DanceMove | null = null;
  /** Điệu đồng diễn cả sàn — game đặt/xóa theo chu kỳ 32 beat. */
  choreoMove: DanceMove | null = null;
  /**
   * Nhịp bắt đầu áp điệu đồng diễn cho RIÊNG người này. Đội hình sóng/canon
   * đặt lệch theo vị trí để tạo hiệu ứng lan; trước mốc này vẫn nhảy tự do.
   */
  choreoFromBeat = 0;

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
  /** Pha đổi điệu riêng — mỗi người đổi ở một phách khác trong ô nhịp. */
  private readonly phraseOffset = Math.floor(Math.random() * 4);
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
  /** Con rối cutout (tay/chân/đầu cử động + biểu cảm) — chỉ bật cho người
   * tương tác nhiều & skin mặc định; null = dùng sprite phẳng như cũ. */
  private rig: CharacterRig | null = null;

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
    // Neo sprite tại CHÂN (center.y = 0): billboard chỉ vươn lên trên nên khi
    // camera trên cao nhìn xuống, thân dưới không còn ngả tới trước và cắm
    // xuyên bục podium/bàn DJ như khi neo giữa thân
    this.sprite.center.set(0.5, 0);
    this.sprite.position.y = 0;

    const { face: nf, accent: na } = this.nameTag();
    const { texture, aspect } = makeLabelTexture(user.nickname, na, nf);
    this.label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true }),
    );
    const labelH = 0.5;
    this.label.scale.set(labelH * aspect, labelH, 1);
    this.label.position.y = BASE_H + 0.3;

    this.group.add(this.sprite, this.label);
    this.group.position.set(this.home.x, this.home.y + DROP_HEIGHT, this.home.z);
  }

  private get currentSkin(): Skin {
    return this.skins[this.skinIndex % this.skins.length];
  }

  get texture(): THREE.Texture {
    return this.currentSkin.frames[0];
  }

  /** Toàn bộ frame của skin hiện tại — cho DJ takeover cũng nhảy theo beat. */
  get skinFrames(): THREE.Texture[] {
    return this.currentSkin.frames;
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
    this.syncLabelVisible();
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
    // Skin đổi (vd nạp ảnh custom): dựng lại rig theo outfit mới, hoặc tự tắt
    // nếu skin mới không có dữ liệu rig
    if (this.rig) {
      this.setRig(false);
      this.setRig(true);
    }
  }

  /**
   * Bật/tắt con rối cutout (tay/chân/đầu cử động + biểu cảm). Chỉ dựng được cho
   * skin mặc định (có `rig` spec) — skin ảnh custom bỏ qua. Bật thì ẩn sprite
   * phẳng, tắt thì hiện lại.
   */
  setRig(on: boolean) {
    if (on) {
      if (this.rig) return;
      const spec = this.currentSkin.rig;
      if (!spec) return;
      this.rig = new CharacterRig(spec, BASE_H, this.currentSkin.aspect);
      this.group.add(this.rig.root);
      this.sprite.visible = false;
    } else {
      if (!this.rig) return;
      this.group.remove(this.rig.root);
      this.rig.dispose();
      this.rig = null;
      this.sprite.visible = true;
    }
  }

  get hasRig(): boolean {
    return this.rig !== null;
  }

  /** Skin hiện tại có cắt được rig không (mặc định = có, ảnh custom = không). */
  get canRig(): boolean {
    return !!this.currentSkin.rig;
  }

  private applyAspect() {
    this.sprite.scale.set(BASE_H * this.currentSkin.aspect, BASE_H, 1);
  }

  /**
   * Gán texture của khung hiện tại. Tự bỏ qua khi đã đúng nên gọi mỗi frame vẫn
   * rẻ — cần vậy vì skin ảnh meme `expand()` có thể THAY khung 0 giữa chừng
   * (bake lại trong khung có lề), người đang cầm texture cũ phải tự bắt kịp.
   */
  private applyFrame() {
    const frames = this.currentSkin.frames;
    const map = frames[this.frame % frames.length];
    if (this.sprite.material.map === map) return;
    this.sprite.material.map = map;
    this.sprite.material.needsUpdate = true;
  }

  startDancing(ms = DANCE_START_MS) {
    const now = performance.now();
    this.danceUntil = Math.max(this.danceUntil, now + ms);
    // Skin ảnh meme đơn: dựng vòng nhảy ngay trước khi cần dùng tới (idempotent)
    this.currentSkin.expand?.();
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
    this.applyNameTag();
    this.frame = 0;
    this.applyFrame();
    this.applyAspect();
    if (this.rig) {
      this.setRig(false);
      this.setRig(true);
    }
  }

  /** Màu tên theo mốc donate: 0💎 trắng → cao dần xanh/vàng/hồng/tím VIP. */
  private nameTag(): { face: string; accent: string } {
    const d = this.diamonds;
    if (d >= 2000) return { face: "#d8b4fe", accent: "#5b21a8" };
    if (d >= 500) return { face: "#ff5c7a", accent: "#8f1330" };
    if (d >= 100) return { face: "#ffd25e", accent: "#8a6414" };
    if (d >= 20) return { face: "#5ef0e6", accent: "#0e6b66" };
    return { face: "#ffffff", accent: "#151a28" };
  }

  private applyNameTag() {
    const { face, accent } = this.nameTag();
    const { texture, aspect } = makeLabelTexture(
      this.user.nickname,
      accent,
      face,
    );
    this.label.material.map?.dispose();
    this.label.material.map = texture;
    this.label.material.needsUpdate = true;
    const labelH = 0.5;
    this.label.scale.set(labelH * aspect, labelH, 1);
  }

  /** Gọi khi số 💎 đổi — cập nhật màu tên theo mốc donate + hiện tên donor. */
  refreshNameTag() {
    this.applyNameTag();
    this.syncLabelVisible();
  }

  /** Hiện tên khi: đang trên sàn, HOẶC là donor (💎>0, trừ bục có bảng riêng). */
  private syncLabelVisible() {
    this.label.visible =
      this.zone === "floor" ||
      (this.zone !== "podium" && this.diamonds > 0) ||
      performance.now() < this.labelForceUntil;
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
    // Bong bóng chat phải sáng rõ dễ đọc — chỉ hạ nhẹ để không lóa bloom
    this.bubble.material.color.setScalar(0.9);
    // To hơn hẳn cho dễ đọc trên màn dọc; nâng cao hơn để không đè lên tên
    const h = 0.82;
    this.bubble.scale.set(h * aspect, h, 1);
    this.bubble.position.y = BASE_H + 1.08;
    this.group.add(this.bubble);
    this.bubbleUntil = performance.now() + BUBBLE_MS;
  }

  update(
    dt: number,
    hype: number,
    beat: Beat,
    musicOn = true,
    level = 0,
    moodEnergy = 0.5,
    vibe?: MusicVibe,
    camPos?: THREE.Vector3,
  ) {
    const now = performance.now();
    const t = now / 1000;
    // Ở khán đài (ngoài sàn nhảy) thì KHÔNG nhảy — chỉ đứng gật gù theo
    // nhạc; muốn quẩy phải được đưa lên sàn (chat lệnh / zone mode)
    const dancing =
      musicOn && now < this.danceUntil && this.zone !== "audience";

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
    // Chất nhịp theo thể loại: swing/lay-back, half-time, hình cung nhún.
    const groove = GENRE_GROOVE[vibe?.genre ?? "pop"] ?? GENRE_GROOVE.pop;
    // Lay-back: dịch pha trễ chút → đỉnh nhún rơi SAU phách (hiphop groove);
    // edm swing=0 dính grid tuyệt đối. Pha lùi qua biên thì index lùi theo để
    // mốc phách và pha luôn đọc trên cùng một lưới đã dịch.
    let gpulse = beat.pulse - groove.swing;
    let gindex = beat.index;
    if (gpulse < 0) {
      gpulse += 1;
      gindex = Math.max(0, gindex - 1);
    }
    if (dancing) {
      if (beat.index !== this.lastBeat) {
        this.lastBeat = beat.index;
        this.moveBeatsLeft -= 1;
        const prevMove = this.move;
        if (this.forcedMove) {
          this.move = this.forcedMove;
        } else if (this.choreoMove && beat.index >= this.choreoFromBeat) {
          // Đồng diễn: chỉ vào điệu khi tới nhịp kích hoạt của RIÊNG mình —
          // đội hình sóng/canon lệch nhau vài nhịp tạo hiệu ứng lan khắp sàn
          this.move = this.choreoMove;
          this.moveBeatsLeft = MOVE_BEATS[this.move] ?? 2;
        } else if (
          this.moveBeatsLeft <= 0 &&
          (((beat.index + this.phraseOffset) % 4) + 4) % 4 === 0
        ) {
          // Chỉ đổi điệu ở ranh giới ô nhịp (lệch pha riêng từng người) —
          // người thật đổi động tác theo câu nhạc chứ không giữa chừng.
          // Chọn điệu trong pool của thể loại đang phát, ưu tiên điệu khớp
          // năng lượng đoạn nhạc: verse ra điệu dịu, điệp khúc ra điệu quẩy.
          const pool = vibe ? GENRE_MOVES[vibe.genre] : DANCE_MOVES;
          const target = vibe?.intensity ?? 0.5;
          let next = pickEnergyMove(pool, target);
          if (next === this.move) next = pickEnergyMove(pool, target);
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
          this.move === "hop"
            ? 0.3
            : this.move === "pogo"
              ? 0.45
              : this.move === "gangnam"
                ? 0.28
                : this.move === "mushroom-pop"
                  ? 0.34
                  : 0;
        const tilt = MOVE_TILT[this.move];
        this.tiltTarget = tilt
          ? tilt.v * (tilt.side ? this.sideDir : 1)
          : 0;
        this.sideTarget = (MOVE_SIDE[this.move] ?? 0) * this.sideDir;
        if (this.move === "grapevine") {
          // Chuỗi bước ngang 4 nhịp: bước - chụm - bước xa - lùi về
          const seq = [0.5, 1.05, 1.6, 0.75];
          this.sideTarget = this.travelDir * seq[this.moveStep % 4];
          this.tiltTarget = this.travelDir * 0.08;
        } else if (this.move === "moonwalk") {
          this.sideTarget =
            this.travelDir * (0.35 + (this.moveStep % 4) * 0.45);
          this.tiltTarget = -0.16;
        } else if (this.move === "gangnam") {
          // Phi ngựa: hai nhịp nhảy tiến ngang, hai nhịp giậm tại chỗ rồi lặp
          const seq = [0.45, 1.0, 0.6, 0.15];
          this.sideTarget = this.travelDir * seq[this.moveStep % 4];
          this.tiltTarget = this.travelDir * 0.1;
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
      // Phát khung LIÊN TỤC theo pha nhạc thay vì snap 2 khung/nhịp: bước đều
      // qua mọi khung của skin → vòng nhảy nhiều pose (mặc định) và GIF/sprite
      // nạp ngoài đều chạy uyển chuyển; đoạn cao trào (intensity) nhảy nhanh hơn.
      // (Bỏ qua khi đang dùng rig — rig có mesh tay/chân riêng, không đổi frame.)
      if (!this.rig) {
        const nf = this.currentSkin.frames.length;
        const fpb = 2.5 + (vibe?.intensity ?? 0.5) * 1.5;
        this.frame =
          (((Math.floor((beat.index + beat.pulse) * fpb) % nf) + nf) % nf) | 0;
        this.applyFrame();
      }

      const conf = vibe?.beatConfidence ?? 0.5;
      // Ballad (timeFeel "half"): trải MỘT cung nhún qua 2 phách — thong thả,
      // không giật từng phách. Các điệu bật đôi giữ 2 nhún/phách như cũ.
      const doubleHop =
        this.move === "double-bounce" ||
        this.move === "charleston" ||
        this.move === "pogo";
      const halfTime = groove.timeFeel === "half" && !doubleHop;
      // Phách 1 của ô nhịp 4 nhún mạnh nhất, phách 3 vừa — tạo groove rõ rệt
      const accentIndex = halfTime ? gindex - (gindex % 2) : gindex;
      const accent =
        accentIndex % 4 === 0 ? 1.25 : accentIndex % 2 === 0 ? 1.1 : 1;
      // Nhạc buồn/êm nhún dịu lại, nhạc dữ dội quẩy hết biên độ;
      // giai điệu đang lên (nốt thăng) thì bật cao thêm chút cho tới khúc.
      // Nhịp không chắc (beatConfidence thấp) dịu biên độ lại — tránh nhún dứt
      // khoát trên phách có thể sai.
      const amp =
        (0.2 + hype * 0.22 + level * 0.22 + this.hopBoost) *
        this.ampScale *
        accent *
        (0.72 + moodEnergy * 0.5) *
        // Tương phản verse↔điệp khúc: đoạn trầm nhún dịu, đoạn bùng quẩy hết cỡ
        (0.62 + (vibe?.intensity ?? 0.5) * 0.72) *
        (1 + (vibe?.melodyTrend ?? 0) * 0.18) *
        (0.78 + conf * 0.22);
      const hopPhase = doubleHop
        ? Math.min(1, (gpulse % 0.5) * 3.4)
        : halfTime
          ? Math.min(1, (((gindex % 2) + gpulse) / 2) * 1.4)
          : Math.min(1, gpulse * 1.7);
      // Hình cung nhún lệch đỉnh theo thể loại: edm attack sắc, ballad mềm muộn.
      y = grooveCurve(hopPhase, groove.peak) * amp;
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
      } else if (this.move === "griddy") {
        // Gót chân đảo gấp đôi nhịp, thân giữ thấp — sức nằm ở chân chứ không bật
        y *= 0.5;
        scaleY = 1 - 0.05 * Math.abs(Math.sin(beat.pulse * Math.PI * 2));
      } else if (this.move === "heel-toe") {
        // Gót–mũi đổi chân rất nhanh: 4 lần mỗi phách, người gần như đứng yên
        y *= 0.4;
        scaleY = 1 - 0.04 * Math.abs(Math.sin(beat.pulse * Math.PI * 4));
      } else if (this.move === "gangnam") {
        // Phi ngựa: bật nảy đều, người hơi giãn khi bay
        scaleY = 1 + 0.07 * Math.sin(hopPhase * Math.PI);
        scaleX = 1 - 0.05 * Math.sin(hopPhase * Math.PI);
      } else if (this.move === "sprinkler") {
        // Tay quét vòng, thân chỉ đưa nhẹ theo
        y *= 0.55;
      } else if (this.move === "mushroom-pop") {
        // Nấm bung: nén sát đất cuối nhịp rồi BUNG to đúng phách
        const punch = Math.max(0, 1 - beat.pulse * 3.2);
        const squat = Math.max(0, beat.pulse - 0.62) * 2.6;
        y = amp * (0.25 + punch * 0.85) - amp * squat * 0.35;
        scaleY = 1 + 0.16 * punch - 0.13 * squat;
        scaleX = 1 - 0.11 * punch + 0.1 * squat;
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
      } else if (this.move === "griddy") {
        // Đảo chân qua lại gấp đôi nhịp quanh vị trí bước đã chốt đầu nhịp
        this.sideTarget =
          (MOVE_SIDE.griddy! + Math.sin(beat.pulse * Math.PI * 4) * 0.3) *
          this.sideDir;
      } else if (this.move === "heel-toe") {
        this.sideTarget =
          (MOVE_SIDE["heel-toe"]! +
            Math.sin(beat.pulse * Math.PI * 8) * 0.16) *
          this.sideDir;
      } else if (this.move === "sprinkler") {
        this.sideTarget =
          Math.sin(beat.pulse * Math.PI * 0.5) * 0.45 * this.sideDir;
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
      } else if (this.move === "griddy") {
        rot = this.tilt + Math.sin(beat.pulse * Math.PI * 4) * 0.09;
      } else if (this.move === "heel-toe") {
        rot = this.tilt + Math.sin(beat.pulse * Math.PI * 8) * 0.05;
      } else if (this.move === "gangnam") {
        // Lắc theo cú nhảy ngựa, nghiêng về hướng đang tiến
        rot = this.tilt + Math.sin(beat.pulse * Math.PI * 2) * 0.12 * this.travelDir;
      } else if (this.move === "sprinkler") {
        // Thân xoay giật theo tay quét: quét ra chậm, giật về nhanh
        rot = this.tilt + (beat.pulse < 0.75 ? beat.pulse * 0.4 : (1 - beat.pulse) * 1.2) * this.sideDir;
      } else if (this.move === "mushroom-pop") {
        rot = this.tilt + Math.max(0, 1 - beat.pulse * 3.2) * 0.1 * this.sideDir;
      } else {
        rot = this.tilt + Math.sin(Math.PI * 2 * beat.pulse + this.phase) * 0.06;
      }
      // Nốt thăng: người vươn nhẹ lên; nốt trầm: chùng người xuống — như
      // đang "hát theo" giai điệu chứ không chỉ dậm theo kick
      if (vibe) {
        const mt = vibe.melodyTrend;
        scaleY *= 1 + Math.max(0, mt) * 0.05 - Math.max(0, -mt) * 0.03;
        rot += mt * 0.03 * this.sideDir;
        // Cú "pop" bật theo TIẾNG THẬT: đầu phách nảy thêm theo kick (phách 1&3)
        // hay snare/hi-hat (backbeat 2&4) đang thực sự kêu to cỡ nào — không chỉ
        // dậm theo lưới nhịp. Nhịp chắc thì pop sắc & mạnh, mờ thì nhẹ. Cộng
        // thêm (không nhân vào cung nhún) để không xẹp giữa nhịp.
        const sound = beat.index % 2 === 1 ? vibe.snare : vibe.kick;
        const pop = Math.max(0, 1 - beat.pulse * (2.4 + conf * 2.2));
        if (!FLAT_MOVES.has(this.move)) {
          y += pop * sound * (0.18 + conf * 0.16) * groove.bob * this.ampScale;
        }
      }
      this.sideOffset +=
        (this.sideTarget - this.sideOffset) * Math.min(1, dt * 7);
    } else {
      this.frame = 0;
      this.applyFrame();
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
    this.dimCurrent += (this.dimTarget - this.dimCurrent) * Math.min(1, dt * 6);
    if (this.rig) {
      // Con rối cutout: tay/chân/đầu là mesh riêng — điều khiển theo điệu; sprite
      // phẳng đã ẩn. Vị trí/độ nảy của cả nhóm vẫn do phần dưới xử lý như cũ.
      this.rig.update(dt, {
        move: this.move,
        pulse: gpulse,
        beatIndex: gindex,
        intensity: vibe?.intensity ?? 0.5,
        genre: vibe?.genre ?? "pop",
        facing: dancing ? this.facing : 1,
        camYaw: camPos
          ? Math.atan2(
              camPos.x - this.group.position.x,
              camPos.z - this.group.position.z,
            )
          : 0,
        opacity: this.dimCurrent,
        beatConfidence: vibe?.beatConfidence ?? 0.5,
        dancing,
      });
    } else {
      this.smoothSX += (targetSX - this.smoothSX) * smooth;
      this.smoothSY += (scaleY - this.smoothSY) * smooth;
      this.smoothRot += (rot - this.smoothRot) * smooth;
      this.sprite.material.rotation = this.smoothRot;
      this.sprite.scale.set(
        BASE_H * this.currentSkin.aspect * this.smoothSX,
        BASE_H * this.smoothSY,
        1,
      );
      this.sprite.material.opacity = this.dimCurrent;
    }
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
      this.syncLabelVisible();
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
    this.rig?.dispose();
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
