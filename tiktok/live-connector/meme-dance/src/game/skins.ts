import * as THREE from "three";

/**
 * Nhân vật "đầu nấm" theo phong cách meme sticker: mặt trắng bệch, tóc bát úp
 * đen kịt, biểu cảm deadpan/nhếch mép/cười XD/kính đen.
 * Mỗi skin có 2 frame (tay xuống / tay lên) đảo theo nhịp.
 * Bỏ PNG vào /public/characters để thay bằng ảnh meme thật (1 file = 1 skin).
 */

export type Skin = {
  frames: THREE.Texture[];
  accent: string;
  /** width/height của sprite — dùng để scale đúng tỉ lệ ảnh. */
  aspect: number;
};

const FACE_COLOR = "#f3efe6";
const HAIR_COLOR = "#0a0a0c";
const INK = "#141414";

// Trang phục meme: đồ đen, áo trắng, hoodie đỏ, sơ mi xanh đậm...
const OUTFITS = [
  { shirt: "#17171a", accent: "#fe2c55" },
  { shirt: "#f5f4f0", accent: "#25f4ee" },
  { shirt: "#c0272d", accent: "#ffc94d" },
  { shirt: "#1e2a44", accent: "#7cc0ff" },
  { shirt: "#2b2b2e", accent: "#b18cff" },
  { shirt: "#e8e4da", accent: "#ff8bb3" },
  { shirt: "#5a1f1f", accent: "#ffd166" },
  { shirt: "#10221c", accent: "#5dffb0" },
];

const W = 256;
const H = 320;

type Pose = "idle" | "arms-up";
type Accessory = "none" | "cap" | "headphones" | "bow" | "party";

function drawAccessory(
  ctx: CanvasRenderingContext2D,
  accessory: Accessory,
  accent: string,
) {
  const cx = 128;
  const headTop = 26; // đỉnh tóc
  ctx.lineCap = "round";
  if (accessory === "cap") {
    // Mũ lưỡi trai đội ngược — chất hiphop
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.ellipse(cx, headTop + 22, 62, 30, 0, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(cx + 34, headTop + 8, 52, 16, 8);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.roundRect(cx - 62, headTop + 16, 124, 8, 4);
    ctx.fill();
  } else if (accessory === "headphones") {
    ctx.strokeStyle = "#15151a";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, 118, 100, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(cx - 112, 96, 26, 44, 10);
    ctx.roundRect(cx + 86, 96, 26, 44, 10);
    ctx.fill();
  } else if (accessory === "bow") {
    ctx.fillStyle = accent;
    const bx = cx + 58;
    const by = headTop + 26;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - 26, by - 16);
    ctx.lineTo(bx - 26, by + 16);
    ctx.closePath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + 26, by - 16);
    ctx.lineTo(bx + 26, by + 16);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx, by, 7, 0, Math.PI * 2);
    ctx.fill();
  } else if (accessory === "party") {
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(cx, headTop - 26);
    ctx.lineTo(cx - 24, headTop + 22);
    ctx.lineTo(cx + 24, headTop + 22);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(cx, headTop - 28, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCharacter(
  ctx: CanvasRenderingContext2D,
  shirt: string,
  face: number,
  pose: Pose,
  accessory: Accessory = "none",
  accent = "#fe2c55",
) {
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const cx = 128;
  const headCy = 116;
  const headR = 96;

  // ---- Thân nhỏ xíu kiểu sticker
  const bodyTop = headCy + headR - 30;
  ctx.fillStyle = shirt;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(cx - 42, bodyTop, 84, 66, 16);
  ctx.fill();
  ctx.stroke();

  // Chân + giày
  ctx.strokeStyle = HAIR_COLOR;
  ctx.lineWidth = 14;
  const legY = bodyTop + 62;
  const spread = pose === "arms-up" ? 24 : 16;
  ctx.beginPath();
  ctx.moveTo(cx - spread, legY);
  ctx.lineTo(cx - spread - 3, legY + 28);
  ctx.moveTo(cx + spread, legY);
  ctx.lineTo(cx + spread + 3, legY + 28);
  ctx.stroke();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(cx - spread - 7, legY + 32, 15, 8, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + spread + 7, legY + 32, 15, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  // Tay: frame nhảy giơ cao hẳn cho máu lửa
  ctx.strokeStyle = shirt === "#f5f4f0" || shirt === "#e8e4da" ? "#d9d4c7" : shirt;
  ctx.lineWidth = 13;
  ctx.beginPath();
  if (pose === "arms-up") {
    ctx.moveTo(cx - 38, bodyTop + 16);
    ctx.lineTo(cx - 78, bodyTop - 34);
    ctx.moveTo(cx + 38, bodyTop + 16);
    ctx.lineTo(cx + 78, bodyTop - 34);
  } else {
    ctx.moveTo(cx - 38, bodyTop + 14);
    ctx.lineTo(cx - 64, bodyTop + 50);
    ctx.moveTo(cx + 38, bodyTop + 14);
    ctx.lineTo(cx + 64, bodyTop + 50);
  }
  ctx.stroke();
  ctx.fillStyle = FACE_COLOR;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  const handY = pose === "arms-up" ? bodyTop - 38 : bodyTop + 54;
  const handX = pose === "arms-up" ? 80 : 66;
  ctx.beginPath();
  ctx.arc(cx - handX, handY, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + handX, handY, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // ---- Đầu: tóc đen tròn, mặt trắng lộ nửa dưới => bát úp
  ctx.fillStyle = HAIR_COLOR;
  ctx.beginPath();
  ctx.arc(cx, headCy, headR, 0, Math.PI * 2);
  ctx.fill();

  // Mặt trắng
  ctx.fillStyle = FACE_COLOR;
  ctx.beginPath();
  ctx.arc(cx, headCy + 18, headR - 12, 0, Math.PI * 2);
  ctx.fill();

  // Mái bát úp che nửa trán (đặc trưng meme)
  ctx.fillStyle = HAIR_COLOR;
  ctx.beginPath();
  ctx.ellipse(cx, headCy - 34, headR - 2, 52, 0, 0, Math.PI * 2);
  ctx.fill();
  // Hai bên tóc ôm má
  ctx.beginPath();
  ctx.roundRect(cx - headR - 2, headCy - 14, 26, 74, 12);
  ctx.roundRect(cx + headR - 24, headCy - 14, 26, 74, 12);
  ctx.fill();

  // ---- Biểu cảm meme
  const eyeY = headCy + 30;
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;

  if (face === 0) {
    // Deadpan: mắt chấm nhỏ + mồm ngang dài (mặt vô cảm huyền thoại)
    ctx.beginPath();
    ctx.arc(cx - 32, eyeY, 6, 0, Math.PI * 2);
    ctx.arc(cx + 32, eyeY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(cx - 26, eyeY + 38);
    ctx.lineTo(cx + 26, eyeY + 38);
    ctx.stroke();
  } else if (face === 1) {
    // Nhếch mép: mắt lườm + cười đểu 1 bên
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(cx - 44, eyeY - 4);
    ctx.lineTo(cx - 18, eyeY + 2);
    ctx.moveTo(cx + 18, eyeY + 2);
    ctx.lineTo(cx + 44, eyeY - 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 8, eyeY + 36);
    ctx.quadraticCurveTo(cx + 22, eyeY + 44, cx + 34, eyeY + 26);
    ctx.stroke();
  } else if (face === 2) {
    // Cười XD: mắt ><, mồm đen há to
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(cx - 44, eyeY - 10);
    ctx.lineTo(cx - 22, eyeY);
    ctx.lineTo(cx - 44, eyeY + 10);
    ctx.moveTo(cx + 44, eyeY - 10);
    ctx.lineTo(cx + 22, eyeY);
    ctx.lineTo(cx + 44, eyeY + 10);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, eyeY + 36, 22, 16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ff9d9d";
    ctx.beginPath();
    ctx.ellipse(cx, eyeY + 42, 12, 7, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Kính đen swag + cười mím
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.roundRect(cx - 52, eyeY - 14, 42, 24, 8);
    ctx.roundRect(cx + 10, eyeY - 14, 42, 24, 8);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx - 10, eyeY - 6);
    ctx.lineTo(cx + 10, eyeY - 6);
    ctx.stroke();
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(cx - 16, eyeY + 36);
    ctx.quadraticCurveTo(cx, eyeY + 44, cx + 20, eyeY + 34);
    ctx.stroke();
  }

  // Má hồng nhẹ cho frame nhảy
  if (pose === "arms-up") {
    ctx.fillStyle = "rgba(255,110,110,0.35)";
    ctx.beginPath();
    ctx.ellipse(cx - 56, eyeY + 16, 12, 7, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 56, eyeY + 16, 12, 7, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawAccessory(ctx, accessory, accent);
}

function makeTexture(draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16;
  return texture;
}

export function generateSkins(): Skin[] {
  const skins: Skin[] = [];
  const accessories: Accessory[] = ["none", "cap", "headphones", "bow", "party"];
  for (let i = 0; i < 16; i++) {
    const outfit = OUTFITS[i % OUTFITS.length];
    const face = i % 4;
    const accessory = accessories[i % accessories.length];
    skins.push({
      accent: outfit.accent,
      aspect: W / H,
      frames: [
        makeTexture((ctx) =>
          drawCharacter(ctx, outfit.shirt, face, "idle", accessory, outfit.accent),
        ),
        makeTexture((ctx) =>
          drawCharacter(ctx, outfit.shirt, face, "arms-up", accessory, outfit.accent),
        ),
      ],
    });
  }
  return skins;
}

const ACCENTS = ["#fe2c55", "#25f4ee", "#ffc94d", "#7cc0ff", "#b18cff", "#5dffb0"];

/**
 * Xóa nền sáng bằng flood-fill từ 4 mép: chỉ xóa vùng near-white ĐỤC dính với
 * mép ảnh, nên ảnh đã trong suốt sẵn hay mặt trắng của nhân vật không bị ảnh
 * hưởng. Chạy cho mọi ảnh (một số PNG có alpha nhưng vẫn kèm nền trắng).
 */
function stripWhiteBackground(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height);
  const px = data.data;

  // Đục + gần trắng (nới ngưỡng nhẹ để ăn cả nền xám sáng/viền nén JPG)
  const isBackground = (i: number) =>
    px[i + 3] > 40 && px[i] > 228 && px[i + 1] > 228 && px[i + 2] > 228;

  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  for (let x = 0; x < width; x++) queue.push(x, x + (height - 1) * width);
  for (let y = 0; y < height; y++) queue.push(y * width, y * width + width - 1);
  while (queue.length) {
    const p = queue.pop()!;
    if (visited[p]) continue;
    visited[p] = 1;
    if (!isBackground(p * 4)) continue;
    px[p * 4 + 3] = 0;
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) queue.push(p - 1);
    if (x < width - 1) queue.push(p + 1);
    if (y > 0) queue.push(p - width);
    if (y < height - 1) queue.push(p + width);
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/** Lật gương ngang — tạo frame thứ 2 cho skin tĩnh để nhân vật lắc qua lại. */
function mirrorCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(source.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(source, 0, 0);
  return canvas;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Nạp skin PNG/WebP tùy chỉnh. File đặt tên `ten_0.png, ten_1.png…` được gộp
 * thành 1 skin nhiều frame (animation); file lẻ = skin 1 frame.
 */
export async function loadCustomSkins(urls: string[]): Promise<Skin[]> {
  const groups = new Map<string, { order: number; url: string }[]>();
  for (const url of urls) {
    const base = url.split("/").pop() ?? url;
    const m = base.match(/^(.+?)_(\d+)\.(png|webp)$/i);
    const key = m ? m[1] : base;
    const order = m ? parseInt(m[2], 10) : 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ order, url });
  }

  const skins: Skin[] = [];
  let index = 0;
  for (const key of [...groups.keys()].sort()) {
    const entries = groups.get(key)!.sort((a, b) => a.order - b.order);
    const frames: THREE.Texture[] = [];
    let aspect = 0.8;
    let firstCanvas: HTMLCanvasElement | null = null;
    for (const { url } of entries) {
      try {
        const img = await loadImage(url);
        const canvas = stripWhiteBackground(img);
        if (!firstCanvas) firstCanvas = canvas;
        aspect = canvas.width / canvas.height;
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 16;
        frames.push(texture);
      } catch {
        // bỏ frame lỗi
      }
    }
    // Skin tĩnh 1 frame → thêm frame lật gương để tay chân vẫn "cử động"
    if (frames.length === 1 && firstCanvas) {
      const mirrored = new THREE.CanvasTexture(mirrorCanvas(firstCanvas));
      mirrored.colorSpace = THREE.SRGBColorSpace;
      mirrored.anisotropy = 16;
      frames.push(mirrored);
    }
    if (frames.length) {
      skins.push({
        frames,
        aspect,
        accent: ACCENTS[index % ACCENTS.length],
      });
      index++;
    }
  }
  return skins;
}

/** Bảng tên bo tròn trên đầu nhân vật. */
export function makeLabelTexture(
  text: string,
  accent: string,
): { texture: THREE.Texture; aspect: number } {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "600 26px system-ui, sans-serif";
  ctx.font = font;
  const label = text.length > 16 ? `${text.slice(0, 15)}…` : text;
  const textW = ctx.measureText(label).width;
  const padX = 18;
  canvas.width = Math.ceil(textW + padX * 2);
  canvas.height = 48;

  const c = canvas.getContext("2d")!;
  c.font = font;
  c.fillStyle = "rgba(8,9,13,0.72)";
  c.beginPath();
  c.roundRect(0, 0, canvas.width, canvas.height, 24);
  c.fill();
  c.strokeStyle = accent;
  c.lineWidth = 3;
  c.stroke();
  c.fillStyle = "#ffffff";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(label, canvas.width / 2, canvas.height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: canvas.width / canvas.height };
}

/** Bong bóng chat trắng chữ đen kiểu sticker. */
export function makeBubbleTexture(text: string): {
  texture: THREE.Texture;
  aspect: number;
} {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "600 24px system-ui, sans-serif";
  ctx.font = font;
  const label = text.length > 24 ? `${text.slice(0, 23)}…` : text;
  const textW = ctx.measureText(label).width;
  canvas.width = Math.ceil(textW + 36);
  canvas.height = 54;

  const c = canvas.getContext("2d")!;
  c.font = font;
  c.fillStyle = "rgba(255,255,255,0.96)";
  c.strokeStyle = "rgba(0,0,0,0.85)";
  c.lineWidth = 3;
  c.beginPath();
  c.roundRect(2, 2, canvas.width - 4, canvas.height - 10, 14);
  c.fill();
  c.stroke();
  // đuôi bong bóng
  c.beginPath();
  c.moveTo(canvas.width / 2 - 7, canvas.height - 9);
  c.lineTo(canvas.width / 2, canvas.height);
  c.lineTo(canvas.width / 2 + 7, canvas.height - 9);
  c.closePath();
  c.fill();
  c.fillStyle = "#111";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(label, canvas.width / 2, canvas.height / 2 - 3);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: canvas.width / canvas.height };
}
