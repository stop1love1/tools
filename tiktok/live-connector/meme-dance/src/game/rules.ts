/** Luật chơi do admin cấu hình trong Settings — lưu localStorage. */

/** Các hành động có thể gán cho quà. */
export type GiftAction =
  | "jump"
  | "circle"
  | "swap"
  | "grow"
  | "shrink"
  | "fireworks"
  | "focus"
  | "badge";

export const GIFT_ACTION_META: Record<
  GiftAction,
  { emoji: string; label: string }
> = {
  jump: { emoji: "🦘", label: "Nhảy 1 cái" },
  circle: { emoji: "🌀", label: "Đi vòng" },
  swap: { emoji: "🎭", label: "Đổi nhân vật" },
  grow: { emoji: "🔍", label: "To lên" },
  shrink: { emoji: "🐜", label: "Nhỏ lại" },
  fireworks: { emoji: "🎆", label: "Pháo hoa" },
  focus: { emoji: "🎥", label: "Camera cận cảnh" },
  badge: { emoji: "👑", label: "Huy hiệu + cánh" },
};

/** Danh mục quà TikTok phổ biến (giá 💎 chuẩn của TikTok). */
export type TikTokGift = { name: string; emoji: string; diamonds: number };

export const TIKTOK_GIFTS: TikTokGift[] = [
  { name: "Rose (Hoa hồng)", emoji: "🌹", diamonds: 1 },
  { name: "TikTok", emoji: "🎵", diamonds: 1 },
  { name: "Finger Heart (Thả tim)", emoji: "🤟", diamonds: 5 },
  { name: "Rosa (Hoa hồng trắng)", emoji: "🌸", diamonds: 10 },
  { name: "Friendship Necklace (Vòng cổ)", emoji: "📿", diamonds: 10 },
  { name: "Perfume (Nước hoa)", emoji: "🧴", diamonds: 20 },
  { name: "Doughnut (Bánh donut)", emoji: "🍩", diamonds: 30 },
  { name: "Paper Crane (Hạc giấy)", emoji: "🕊️", diamonds: 99 },
  { name: "Little Crown (Vương miện nhỏ)", emoji: "👑", diamonds: 99 },
  { name: "Hand Hearts (Tim tay)", emoji: "🫶", diamonds: 100 },
  { name: "Confetti (Pháo giấy)", emoji: "🎊", diamonds: 100 },
  { name: "Sunglasses (Kính đen)", emoji: "🕶️", diamonds: 199 },
  { name: "Boxing Gloves (Găng boxing)", emoji: "🥊", diamonds: 299 },
  { name: "Corgi (Cún corgi)", emoji: "🐕", diamonds: 299 },
  { name: "Money Gun (Súng bắn tiền)", emoji: "💸", diamonds: 500 },
  { name: "Swan (Thiên nga)", emoji: "🦢", diamonds: 699 },
  { name: "Train (Tàu hỏa)", emoji: "🚂", diamonds: 899 },
  { name: "Galaxy (Dải ngân hà)", emoji: "🌌", diamonds: 1000 },
  { name: "Whale Diving (Cá voi)", emoji: "🐋", diamonds: 2150 },
  { name: "Motorcycle (Xe máy)", emoji: "🏍️", diamonds: 2988 },
  { name: "Sports Car (Siêu xe)", emoji: "🏎️", diamonds: 7000 },
  { name: "Interstellar (Liên sao)", emoji: "✨", diamonds: 10000 },
  { name: "Rocket (Tên lửa)", emoji: "🚀", diamonds: 20000 },
  { name: "Lion (Sư tử)", emoji: "🦁", diamonds: 26999 },
  { name: "TikTok Universe (Vũ trụ)", emoji: "🪐", diamonds: 34999 },
];

/**
 * 1 dòng cấu hình: quà từ `min` 💎 trở lên → hành động (dòng min cao nhất thắng).
 * `gift` = tên quà TikTok đã chọn (chỉ để hiển thị; mốc vẫn tính theo 💎).
 */
export type GiftActionRule = { min: number; action: GiftAction; gift?: string };

/** @deprecated giữ để migrate config cũ */
export type GiftTiers = {
  jump: number;
  circle: number;
  swap: number;
  grow: number;
  focus: number;
  badge: number;
};

/**
 * Bố trí khu vực: auto = khán đài, chat lệnh mới lên sàn;
 * all-floor = tất cả lên sàn nhảy luôn; all-audience = tất cả ở khán đài.
 */
export type ZoneMode = "auto" | "all-floor" | "all-audience";

/** Camera: sway = đứng yên lắc nhẹ; orbit = xoay vòng quanh sàn. */
export type CameraMode = "sway" | "orbit";

export type GameRules = {
  /** Chế độ camera. */
  cameraMode: CameraMode;
  /** Bố trí user trên sàn / khán đài. */
  zoneMode: ZoneMode;
  /** Bắt buộc chat lệnh mới được lên sàn nhảy (tắt = ai comment cũng nhảy). */
  requireStartCommand: boolean;
  /** Lệnh lên sàn, mặc định "1". */
  startCommand: string;
  /** Đã chat lệnh lên sàn thì ở lại sàn luôn (không hết giờ) đến khi rời live. */
  stayOnFloor: boolean;
  /** Giây được nhảy khi bắt đầu. */
  danceStartSec: number;
  /** Giây gia hạn mỗi comment. */
  danceExtendSec: number;
  /** Trần tích lũy (giây). */
  danceMaxSec: number;
  /** BPM khi không phát nhạc. */
  autoBpm: number;
  /** Độ nhạy bắt beat nhạc (1.1 nhạy — 2.0 chỉ beat mạnh). */
  beatSensitivity: number;
  /** Cho phép lệnh chat (nhảy / đổi nv / đi vòng / to lên / nhỏ lại). */
  commandsEnabled: boolean;
  /** Bảng quà → hành động do admin tự soạn. */
  giftActions: GiftActionRule[];
  /**
   * Bảng lệnh tùy chỉnh: mỗi dòng 1 mục hiển thị nguyên văn.
   * Để trống → tự sinh theo luật ở trên.
   */
  legendOverride: string;
};

export const DEFAULT_RULES: GameRules = {
  cameraMode: "sway",
  zoneMode: "auto",
  requireStartCommand: true,
  startCommand: "1",
  stayOnFloor: true,
  danceStartSec: 30,
  danceExtendSec: 15,
  danceMaxSec: 90,
  autoBpm: 128,
  beatSensitivity: 1.35,
  commandsEnabled: true,
  // Mặc định theo bộ chuẩn stream vũ trường: mỗi hành động đúng 1 quà
  giftActions: [
    { min: 1, action: "jump", gift: "Rose (Hoa hồng)" },
    { min: 5, action: "circle", gift: "Finger Heart (Thả tim)" },
    { min: 10, action: "swap", gift: "Rosa (Hoa hồng trắng)" },
    { min: 20, action: "grow", gift: "Perfume (Nước hoa)" },
    { min: 30, action: "shrink", gift: "Doughnut (Bánh donut)" },
    { min: 99, action: "fireworks", gift: "Paper Crane (Hạc giấy)" },
    { min: 100, action: "focus", gift: "Hand Hearts (Tim tay)" },
    { min: 500, action: "badge", gift: "Money Gun (Súng bắn tiền)" },
  ],
  legendOverride: "",
};

const STORAGE_KEY = "md:rules";

export function loadRules(): GameRules {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RULES;
    const parsed = JSON.parse(raw);
    // Migrate config cũ (giftTiers cố định) sang danh sách giftActions
    let giftActions: GiftActionRule[] = Array.isArray(parsed.giftActions)
      ? parsed.giftActions
      : [];
    if (!giftActions.length && parsed.giftTiers) {
      giftActions = (
        Object.entries(parsed.giftTiers) as Array<[GiftAction, number]>
      ).map(([action, min]) => ({ min, action }));
    }
    if (!giftActions.length) giftActions = DEFAULT_RULES.giftActions;
    return { ...DEFAULT_RULES, ...parsed, giftActions };
  } catch {
    return DEFAULT_RULES;
  }
}

export function saveRules(rules: GameRules) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
}

/** Bảng lệnh hiển thị cho người xem — admin tự soạn, hoặc sinh từ luật. */
export function buildLegend(r: GameRules): Array<{ emoji: string; label: string }> {
  const custom = (r.legendOverride ?? "").trim();
  if (custom) {
    return custom
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((label) => ({ emoji: "", label }));
  }
  const legend: Array<{ emoji: string; label: string }> = [];
  if (r.zoneMode === "all-floor") {
    legend.push({ emoji: "🕺", label: "Comment là lên sàn quẩy luôn!" });
  } else if (r.zoneMode === "all-audience") {
    legend.push({ emoji: "💬", label: "Bình luận để vào khán đài cổ vũ" });
  } else {
    legend.push({ emoji: "💬", label: "Bình luận để vào khán đài" });
  }
  if (r.zoneMode === "auto") {
    if (r.requireStartCommand) {
      legend.push({
        emoji: "🕺",
        label: `Chat “${r.startCommand}” — lên sàn nhảy theo nhạc`,
      });
      if (!r.stayOnFloor) {
        legend.push({ emoji: "🔁", label: "Comment tiếp để nhảy không nghỉ" });
      }
    } else {
      legend.push({ emoji: "🕺", label: "Comment là nhảy luôn!" });
    }
  }
  if (r.commandsEnabled) {
    legend.push({
      emoji: "🎭",
      label: "“nhảy” · “đổi nv” · “đi vòng” · “to lên” · “nhỏ lại”",
    });
  }
  // Bảng quà → hành động: sinh theo danh sách admin soạn (sắp theo mốc tăng dần)
  [...r.giftActions]
    .sort((a, b) => a.min - b.min)
    .forEach((rule) => {
      const meta = GIFT_ACTION_META[rule.action];
      if (!meta) return;
      const gift = TIKTOK_GIFTS.find((g) => g.name === rule.gift);
      const giftLabel = gift
        ? `${gift.name.split(" (")[0]}`
        : `Quà ${rule.min}💎+`;
      legend.push({
        emoji: gift?.emoji ?? meta.emoji,
        label: `${giftLabel} — ${meta.label.toLowerCase()}`,
      });
    });
  legend.push({ emoji: "❤️", label: "Thả tim — cả sàn quẩy disco" });
  return legend;
}
