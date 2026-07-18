import * as THREE from "three";

export type Skin = {
  frames: THREE.Texture[];
  accent: string;
  aspect: number;
};

const FACE_COLOR = "#f3efe6";
const HAIR_COLOR = "#0a0a0c";
const INK = "#141414";

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

type Accessory = "none" | "cap" | "headphones" | "bow" | "party";

function drawAccessory(
  ctx: CanvasRenderingContext2D,
  accessory: Accessory,
  accent: string,
) {
  const cx = 128;
  const headTop = 26;
  ctx.lineCap = "round";
  if (accessory === "cap") {
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

/**
 * Vẽ nhân vật với "độ giơ" của từng tay 0..1 (0 = buông thõng, 1 = giơ cao).
 * Nội suy liên tục giữa hai cực nên sinh được nhiều pose cho một vòng nhảy
 * uyển chuyển, mà vẫn giữ nguyên phong cách meme sẵn có.
 */
function drawCharacter(
  ctx: CanvasRenderingContext2D,
  shirt: string,
  face: number,
  lRaise: number,
  rRaise: number,
  accessory: Accessory = "none",
  accent = "#fe2c55",
) {
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const cx = 128;
  const headCy = 116;
  const headR = 96;
  const avg = (lRaise + rRaise) / 2;

  const bodyTop = headCy + headR - 30;
  ctx.fillStyle = shirt;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(cx - 42, bodyTop, 84, 66, 16);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = HAIR_COLOR;
  ctx.lineWidth = 14;
  const legY = bodyTop + 62;
  const spread = 16 + avg * 8;
  // Dồn trọng tâm nhẹ theo bên tay giơ cao hơn — như đang bước theo nhịp
  const step = (rRaise - lRaise) * 4;
  ctx.beginPath();
  ctx.moveTo(cx - spread, legY);
  ctx.lineTo(cx - spread - 3 + step, legY + 28);
  ctx.moveTo(cx + spread, legY);
  ctx.lineTo(cx + spread + 3 + step, legY + 28);
  ctx.stroke();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(cx - spread - 7 + step, legY + 32, 15, 8, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + spread + 7 + step, legY + 32, 15, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  // Cánh tay: nội suy đầu tay giữa buông thõng (raise 0) và giơ cao (raise 1)
  const shoulderY = bodyTop + 15;
  const laX = cx - (64 + lRaise * 14);
  const laY = bodyTop + (50 - lRaise * 84);
  const raX = cx + (64 + rRaise * 14);
  const raY = bodyTop + (50 - rRaise * 84);
  ctx.strokeStyle = shirt === "#f5f4f0" || shirt === "#e8e4da" ? "#d9d4c7" : shirt;
  ctx.lineWidth = 13;
  ctx.beginPath();
  ctx.moveTo(cx - 38, shoulderY);
  ctx.lineTo(laX, laY);
  ctx.moveTo(cx + 38, shoulderY);
  ctx.lineTo(raX, raY);
  ctx.stroke();
  ctx.fillStyle = FACE_COLOR;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  const lhX = cx - (66 + lRaise * 14);
  const lhY = bodyTop + (54 - lRaise * 92);
  const rhX = cx + (66 + rRaise * 14);
  const rhY = bodyTop + (54 - rRaise * 92);
  ctx.beginPath();
  ctx.arc(lhX, lhY, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(rhX, rhY, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = HAIR_COLOR;
  ctx.beginPath();
  ctx.arc(cx, headCy, headR, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = FACE_COLOR;
  ctx.beginPath();
  ctx.arc(cx, headCy + 18, headR - 12, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = HAIR_COLOR;
  ctx.beginPath();
  ctx.ellipse(cx, headCy - 34, headR - 2, 52, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx - headR - 2, headCy - 14, 26, 74, 12);
  ctx.roundRect(cx + headR - 24, headCy - 14, 26, 74, 12);
  ctx.fill();

  const eyeY = headCy + 30;
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;

  if (face === 0) {
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

  // Càng quẩy (tay giơ càng cao) má càng ửng hồng
  if (avg > 0.45) {
    ctx.fillStyle = `rgba(255,110,110,${((avg - 0.45) * 0.6).toFixed(3)})`;
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

// Vòng nhảy: mỗi khung là [độ giơ tay trái, phải]. Khung 0 = đứng yên (buông
// thõng) — dùng khi không nhảy; các khung sau vung tay so le rồi về, tạo một
// vòng groove liên tục uyển chuyển khi phát nối tiếp.
const DANCE_CYCLE: [number, number][] = [
  [0.0, 0.0], // idle — đứng yên
  [0.7, 0.15], // vung tay trái lên
  [1.0, 0.5], // trái cao, phải nhấc
  [0.5, 1.0], // đổi bên: phải cao
  [0.15, 0.7], // phải vung, trái hạ
  [0.35, 0.35], // chụm về gần idle rồi lặp
];

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
      frames: DANCE_CYCLE.map(([l, r]) =>
        makeTexture((ctx) =>
          drawCharacter(ctx, outfit.shirt, face, l, r, accessory, outfit.accent),
        ),
      ),
    });
  }
  return skins;
}

const ACCENTS = ["#fe2c55", "#25f4ee", "#ffc94d", "#7cc0ff", "#b18cff", "#5dffb0"];

function stripWhiteBackground(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height);
  const px = data.data;

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
      }
    }
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

export function makeLabelTexture(
  text: string,
  accent: string,
  faceColor = "#ffffff",
): { texture: THREE.Texture; aspect: number } {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  // Chữ 3D không khung: mặt trên trắng, khối đùn màu accent phía dưới
  const font = "600 44px system-ui, sans-serif";
  ctx.font = font;
  const label = text.length > 16 ? `${text.slice(0, 15)}…` : text;
  const textW = ctx.measureText(label).width;
  const padX = 14;
  const depth = 6;
  canvas.width = Math.ceil(textW + padX * 2);
  canvas.height = 72;

  const c = canvas.getContext("2d")!;
  c.font = font;
  c.textAlign = "center";
  c.textBaseline = "middle";
  const cx = canvas.width / 2;
  const cy = canvas.height / 2 - depth / 2;
  // Lớp sâu nhất kèm bóng mờ để tách chữ khỏi nền sân khấu
  c.shadowColor = "rgba(0,0,0,0.7)";
  c.shadowBlur = 8;
  c.shadowOffsetY = 3;
  c.fillStyle = "rgba(0,0,0,0.65)";
  c.fillText(label, cx, cy + depth);
  c.shadowColor = "transparent";
  c.shadowBlur = 0;
  c.shadowOffsetY = 0;
  // Khối đùn 3D màu accent
  c.fillStyle = accent;
  for (let i = depth - 1; i >= 1; i--) {
    c.fillText(label, cx, cy + i);
  }
  // Mặt chữ trên cùng — trắng mặc định, donor đổi màu theo tier
  c.fillStyle = faceColor;
  c.fillText(label, cx, cy);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: canvas.width / canvas.height };
}

export function makeBubbleTexture(text: string): {
  texture: THREE.Texture;
  aspect: number;
} {
  // Vẽ ở độ phân giải gấp đôi (DPR) cho chữ sắc nét, font to hơn để dễ đọc
  const DPR = 2;
  const measure = document.createElement("canvas").getContext("2d")!;
  const fontSize = 34;
  const font = `700 ${fontSize}px system-ui, sans-serif`;
  measure.font = font;
  const label = text.length > 28 ? `${text.slice(0, 27)}…` : text;
  const textW = measure.measureText(label).width;
  const padX = 30;
  const padY = 20;
  const bodyH = fontSize + padY * 2;
  const tailH = 16;
  const cssW = Math.ceil(textW + padX * 2);
  const cssH = bodyH + tailH;

  const canvas = document.createElement("canvas");
  canvas.width = cssW * DPR;
  canvas.height = cssH * DPR;
  const c = canvas.getContext("2d")!;
  c.scale(DPR, DPR);
  c.font = font;

  // Bóng đổ để bong bóng nổi bật trên sân khấu nhiều màu
  c.save();
  c.shadowColor = "rgba(0,0,0,0.55)";
  c.shadowBlur = 8;
  c.shadowOffsetY = 3;
  c.fillStyle = "rgba(255,255,255,0.98)";
  c.strokeStyle = "rgba(0,0,0,0.9)";
  c.lineWidth = 3.5;
  const radius = 18;
  c.beginPath();
  c.roundRect(3, 3, cssW - 6, bodyH - 6, radius);
  c.fill();
  c.restore();
  c.stroke();
  // Đuôi bong bóng chỉ xuống đầu nhân vật
  c.beginPath();
  c.moveTo(cssW / 2 - 11, bodyH - 6);
  c.lineTo(cssW / 2, bodyH + tailH - 6);
  c.lineTo(cssW / 2 + 11, bodyH - 6);
  c.closePath();
  c.fillStyle = "rgba(255,255,255,0.98)";
  c.fill();
  c.stroke();

  c.fillStyle = "#0d0f16";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(label, cssW / 2, bodyH / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, aspect: cssW / cssH };
}
