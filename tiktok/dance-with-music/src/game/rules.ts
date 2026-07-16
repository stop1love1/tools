
export type GiftAction =
  | "jump"
  | "circle"
  | "swap"
  | "grow"
  | "shrink"
  | "fireworks"
  | "focus"
  | "badge"
  | "dj";

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
  dj: { emoji: "🎧", label: "Order nhạc — lên bàn DJ đến hết bài" },
};

export type TikTokGift = {
  name: string;
  emoji: string;
  diamonds: number;
  /** Ảnh quà chính chủ từ CDN TikTok — thiếu thì fallback emoji. */
  image?: string;
};

const CDN = "https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va";

export const TIKTOK_GIFTS: TikTokGift[] = [
  { name: "Rose (Hoa hồng)", emoji: "🌹", diamonds: 1, image: `${CDN}/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.png` },
  { name: "TikTok", emoji: "🎵", diamonds: 1, image: `${CDN}/802a21ae29f9fae5abe3693de9f874bd~tplv-obj.png` },
  { name: "Finger Heart (Thả tim)", emoji: "🤟", diamonds: 5, image: `${CDN}/a4c4dc437fd3a6632aba149769491f49.png~tplv-obj.png` },
  { name: "Rosa (Hoa hồng trắng)", emoji: "🌸", diamonds: 10, image: `${CDN}/eb77ead5c3abb6da6034d3cf6cfeb438~tplv-obj.webp` },
  { name: "Friendship Necklace (Vòng cổ)", emoji: "📿", diamonds: 10, image: `${CDN}/resource/e033c3f28632e233bebac1668ff66a2f.png~tplv-obj.webp` },
  { name: "Perfume (Nước hoa)", emoji: "🧴", diamonds: 20, image: `${CDN}/20b8f61246c7b6032777bb81bf4ee055~tplv-obj.png` },
  { name: "Doughnut (Bánh donut)", emoji: "🍩", diamonds: 30, image: `${CDN}/4e7ad6bdf0a1d860c538f38026d4e812~tplv-obj.png` },
  { name: "Paper Crane (Hạc giấy)", emoji: "🕊️", diamonds: 99, image: `${CDN}/0f158a08f7886189cdabf496e8a07c21~tplv-obj.png` },
  { name: "Little Crown (Vương miện nhỏ)", emoji: "👑", diamonds: 99, image: `${CDN}/cf3db11b94a975417043b53401d0afe1~tplv-obj.png` },
  { name: "Hand Hearts (Tim tay)", emoji: "🫶", diamonds: 100, image: `${CDN}/6cd022271dc4669d182cad856384870f~tplv-obj.png` },
  { name: "Confetti (Pháo giấy)", emoji: "🎊", diamonds: 100, image: `${CDN}/cb4e11b3834e149f08e1cdcc93870b26~tplv-obj.png` },
  { name: "Sunglasses (Kính đen)", emoji: "🕶️", diamonds: 199, image: `${CDN}/08af67ab13a8053269bf539fd27f3873.png~tplv-obj.png` },
  { name: "Boxing Gloves (Găng boxing)", emoji: "🥊", diamonds: 299, image: `${CDN}/9f8bd92363c400c284179f6719b6ba9c~tplv-obj.png` },
  { name: "Corgi (Cún corgi)", emoji: "🐕", diamonds: 299 },
  { name: "Money Gun (Súng bắn tiền)", emoji: "💸", diamonds: 500 },
  { name: "Swan (Thiên nga)", emoji: "🦢", diamonds: 699, image: `${CDN}/97a26919dbf6afe262c97e22a83f4bf1~tplv-obj.png` },
  { name: "Train (Tàu hỏa)", emoji: "🚂", diamonds: 899, image: `${CDN}/4227ed71f2c494b554f9cbe2147d4899~tplv-obj.png` },
  { name: "Galaxy (Dải ngân hà)", emoji: "🌌", diamonds: 1000 },
  { name: "Whale Diving (Cá voi)", emoji: "🐋", diamonds: 2150 },
  { name: "Motorcycle (Xe máy)", emoji: "🏍️", diamonds: 2988, image: `${CDN}/7e5d2b6404d04e798d907ddf107a39fa~tplv-obj.png` },
  { name: "Sports Car (Siêu xe)", emoji: "🏎️", diamonds: 7000, image: `${CDN}/e7ce188da898772f18aaffe49a7bd7db~tplv-obj.png` },
  { name: "Interstellar (Liên sao)", emoji: "✨", diamonds: 10000, image: `${CDN}/8520d47b59c202a4534c1560a355ae06~tplv-obj.png` },
  { name: "Rocket (Tên lửa)", emoji: "🚀", diamonds: 20000, image: `${CDN}/5cf0180749e79c5df2f3b242963e27ad~tplv-obj.png` },
  { name: "Lion (Sư tử)", emoji: "🦁", diamonds: 26999, image: `${CDN}/4fb89af2082a290b37d704e20f4fe729~tplv-obj.png` },
  { name: "TikTok Universe (Vũ trụ)", emoji: "🪐", diamonds: 34999, image: `${CDN}/ff7d237a26868b9588e0d3fc416cb26b~tplv-obj.png` },
];

export type GiftActionRule = { min: number; action: GiftAction; gift?: string };

export type GiftTiers = {
  jump: number;
  circle: number;
  swap: number;
  grow: number;
  focus: number;
  badge: number;
};

export type ZoneMode = "auto" | "all-floor" | "all-audience";

export type CameraMode = "sway" | "orbit";

export type GameRules = {
  cameraMode: CameraMode;
  zoneMode: ZoneMode;
  requireStartCommand: boolean;
  startCommand: string;
  stayOnFloor: boolean;
  danceStartSec: number;
  danceExtendSec: number;
  danceMaxSec: number;
  autoBpm: number;
  beatSensitivity: number;
  commandsEnabled: boolean;
  /** Số lượt order nhạc (lên bàn DJ) tối đa cho mỗi bài. */
  djOrderPerSong: number;
  giftActions: GiftActionRule[];
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
  djOrderPerSong: 1,
  giftActions: [
    { min: 1, action: "jump", gift: "Rose (Hoa hồng)" },
    { min: 5, action: "circle", gift: "Finger Heart (Thả tim)" },
    { min: 10, action: "swap", gift: "Rosa (Hoa hồng trắng)" },
    { min: 20, action: "grow", gift: "Perfume (Nước hoa)" },
    { min: 30, action: "shrink", gift: "Doughnut (Bánh donut)" },
    { min: 99, action: "fireworks", gift: "Paper Crane (Hạc giấy)" },
    { min: 100, action: "focus", gift: "Hand Hearts (Tim tay)" },
    { min: 199, action: "dj", gift: "Sunglasses (Kính đen)" },
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

export type LegendItem = { emoji: string; label: string; image?: string };

/** Bảng lệnh trên màn hình: chỉ liệt kê các mốc quà donate (gọn cho overlay). */
export function buildLegend(r: GameRules): LegendItem[] {
  const custom = (r.legendOverride ?? "").trim();
  if (custom) {
    return custom
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((label) => ({ emoji: "", label }));
  }
  const legend: LegendItem[] = [];
  [...r.giftActions]
    .sort((a, b) => a.min - b.min)
    .forEach((rule) => {
      const meta = GIFT_ACTION_META[rule.action];
      if (!meta) return;
      const gift = TIKTOK_GIFTS.find((g) => g.name === rule.gift);
      legend.push({
        emoji: gift?.emoji ?? meta.emoji,
        label: meta.label.split(" — ")[0],
        image: gift?.image,
      });
    });
  return legend;
}
