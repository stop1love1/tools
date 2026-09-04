import * as THREE from "three";

export type Skin = {
  /**
   * Vòng khung hình. Khung 0 luôn là tư thế đứng yên. Với skin ảnh meme đơn,
   * mảng ban đầu chỉ có 1 khung và được `expand()` nở ra thành vòng nhảy.
   */
  frames: THREE.Texture[];
  accent: string;
  aspect: number;
  /** Chỉ skin mặc định (vẽ sẵn) mới có — dữ liệu để dựng con rối cutout. */
  rig?: RigSpec;
  /**
   * Skin ảnh meme đơn: dựng vòng nhảy warp NGAY LẦN ĐẦU thật sự cần (khi chủ
   * nhân bước lên sàn). Gọi nhiều lần vô hại. Nếu bake sẵn cho cả thư mục
   * `public/characters/` thì tốn hàng trăm MB canvas cho những skin không ai dùng.
   */
  expand?: () => void;
};

/** Kích thước canvas gốc của nhân vật — rig dùng để quy đổi khớp sang toạ độ 3D. */
export const SKIN_W = 256;
export const SKIN_H = 320;

/**
 * Phụ kiện — chỉ giữ những thứ hợp với 蘑菇头 (mũ lưỡi trai, tai nghe DJ), đều
 * tô xám. Vương miện/nơ/kính từng có ở đây là suy diễn sai nhân vật, đã bỏ.
 */
export type Accessory = "none" | "cap" | "headphones";
export type Expression =
  | "neutral"
  | "happy"
  | "wow"
  | "cool"
  | "derp"
  | "smug";
/**
 * Dáng tóc bát. Nhân vật gốc là kiểu tóc NẤM (bát úp) chứ không phải cây nấm —
 * các biến thể chỉ đổi bề rộng vòm, độ dài vạt tóc hai bên và đường mái.
 * Rig vẽ đầu ở lớp riêng (dưới lớp mặt) nên mọi biến thể phải nằm TRÊN tầm mắt.
 */
export type HeadShape = "bowl" | "dome" | "wide" | "long" | "parted";

/** Thông tin đủ để cắt/vẽ lại nhân vật thành các mảnh rời (đầu, thân, tay, chân). */
export type RigSpec = {
  shirt: string;
  accessory: Accessory;
  accent: string;
  head: HeadShape;
};

// 蘑菇头 là nhân vật ĐƠN SẮC: tóc đen tuyền, mặt trắng, áo quần xám, viền đen
// dày. Không tô màu lên người — màu chỉ dành cho nhãn tên & huy hiệu.
const FACE_COLOR = "#fbfbfb";
const HAIR_COLOR = "#141414";
const INK = "#141414";

/**
 * Sắc xám áo. Phân biệt nhân vật trên sàn đông dựa vào dáng tóc + mặt + sắc áo,
 * không dùng màu. `accent` chỉ đi vào nhãn tên/huy hiệu chứ không lên người.
 */
const OUTFITS = [
  { shirt: "#b4b4b7", accent: "#fe2c55" },
  { shirt: "#8e8e92", accent: "#25f4ee" },
  { shirt: "#d2d2d4", accent: "#ffc94d" },
  { shirt: "#6c6c70", accent: "#7cc0ff" },
  { shirt: "#a0a0a3", accent: "#b18cff" },
  { shirt: "#5a5a5e", accent: "#5dffb0" },
];

const W = 256;
const H = 320;

/** Phụ kiện đều tô xám — nhân vật gốc đơn sắc nên không nhận màu accent. */
function drawAccessory(ctx: CanvasRenderingContext2D, accessory: Accessory) {
  const cx = 128;
  const headTop = 22;
  ctx.lineCap = "round";
  if (accessory === "cap") {
    // Mũ lưỡi trai xám úp lên vòm tóc
    ctx.fillStyle = "#9a9a9e";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(cx, headTop + 26, 74, 36, 0, Math.PI, 0);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(cx + 44, headTop + 12, 58, 17, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#6e6e72";
    ctx.beginPath();
    ctx.roundRect(cx - 74, headTop + 18, 148, 9, 4);
    ctx.fill();
  } else if (accessory === "headphones") {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.arc(cx, 122, 108, Math.PI * 1.14, Math.PI * 1.86);
    ctx.stroke();
    ctx.fillStyle = "#8e8e92";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.roundRect(cx - 122, 98, 28, 48, 11);
    ctx.roundRect(cx + 94, 98, 28, 48, 11);
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * Vẽ khối đầu 蘑菇头: vòm tóc đen TRÙM QUÁ KHỔ khuôn mặt, hai vạt tóc buông
 * xuống tận quai hàm, mặt trắng hình trứng bè phía dưới thò ra dưới mái.
 * Không có mắt/miệng ở đây — lớp mặt vẽ riêng để rig nghiêng đầu được.
 *
 * Tỉ lệ lấy theo bộ ảnh gốc trong `public/characters/` (mogu-*, meme3-*):
 * vòm tóc rộng hơn mặt rõ rệt, mái phủ kín trán, cằm mặt bè hơn thái dương.
 */
function paintHead(ctx: CanvasRenderingContext2D, head: HeadShape) {
  const cx = 128;
  const headCy = 116;

  // Vòm tóc: bán trục ngang/dọc + độ dài vạt tóc hai bên theo từng dáng
  const capRx =
    head === "wide" ? 106 : head === "dome" ? 88 : head === "long" ? 94 : 98;
  const capRy = head === "dome" ? 84 : head === "wide" ? 62 : 72;
  const capCy = headCy - 22;
  // Vạt tóc buông tới đâu (y tuyệt đối) — bản gốc buông tới quai hàm
  const sideBottom =
    head === "long" ? 214 : head === "wide" ? 178 : head === "dome" ? 188 : 196;

  // 1) Mặt trắng: hình trứng BÈ PHÍA DƯỚI, vẽ trước để tóc đè lên trán
  ctx.fillStyle = FACE_COLOR;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(cx - 74, headCy + 4);
  // má trái xuống cằm
  ctx.bezierCurveTo(cx - 78, headCy + 68, cx - 46, headCy + 96, cx, headCy + 96);
  // cằm sang má phải
  ctx.bezierCurveTo(cx + 46, headCy + 96, cx + 78, headCy + 68, cx + 74, headCy + 4);
  // vòng lên đỉnh trán (sẽ bị tóc phủ)
  ctx.bezierCurveTo(cx + 70, headCy - 54, cx - 70, headCy - 54, cx - 74, headCy + 4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // 2) Vạt tóc hai bên: buông dọc theo má, đuôi vạt vát nhọn nhẹ
  ctx.fillStyle = HAIR_COLOR;
  for (const s of [-1, 1]) {
    const outer = cx + s * capRx;
    const inner = cx + s * (capRx - 34);
    ctx.beginPath();
    ctx.moveTo(outer, capCy);
    ctx.lineTo(outer, sideBottom - 16);
    // đuôi vạt vát chéo vào trong
    ctx.quadraticCurveTo(outer, sideBottom, cx + s * (capRx - 14), sideBottom);
    ctx.lineTo(inner, sideBottom - 22);
    ctx.lineTo(inner, capCy);
    ctx.closePath();
    ctx.fill();
  }

  // 3) Vòm tóc trùm lên trên, phủ kín trán tới ngang chân mày
  if (head === "parted") {
    // Rẽ ngôi: hai mảng vòm chừa khe hẹp ở giữa đỉnh
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(
        cx + s * 26,
        capCy,
        capRx - 24,
        capRy,
        s * 0.14,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(cx, capCy - 6, capRx - 10, capRy - 26, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.ellipse(cx, capCy, capRx, capRy, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Mái cắt ngang trán: đáy vòm là một cung phẳng chứ không tròn vo
  ctx.beginPath();
  ctx.moveTo(cx - capRx, capCy);
  ctx.quadraticCurveTo(cx, capCy + capRy * 0.62, cx + capRx, capCy);
  ctx.lineTo(cx + capRx, capCy - 10);
  ctx.lineTo(cx - capRx, capCy - 10);
  ctx.closePath();
  ctx.fill();

  if (head === "wide") {
    // Vòm bè: chỏm tóc dựng lệch một bên như bản gốc
    ctx.beginPath();
    ctx.moveTo(cx + 44, capCy - capRy + 8);
    ctx.quadraticCurveTo(cx + 96, capCy - capRy - 26, cx + 82, capCy - capRy + 30);
    ctx.closePath();
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
  expr: Expression,
  lRaise: number,
  rRaise: number,
  accessory: Accessory = "none",
  head: HeadShape = "bowl",
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

  // Đầu và mặt dùng chung đường vẽ với con rối cutout — đổi một chỗ là cả hai
  // biểu diễn (sprite phẳng / rig) khớp nhau
  paintHead(ctx, head);
  drawFace(ctx, expr);

  const eyeY = headCy + 30;

  // Càng quẩy (tay giơ càng cao) má càng ửng hồng
  if (avg > 0.45) {
    ctx.fillStyle = `rgba(255,110,110,${((avg - 0.45) * 0.6).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(cx - 56, eyeY + 16, 12, 7, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 56, eyeY + 16, 12, 7, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawAccessory(ctx, accessory);
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

const ACCESSORIES: Accessory[] = ["none", "cap", "headphones"];
const HEAD_SHAPES: HeadShape[] = ["bowl", "dome", "wide", "long", "parted"];
const EXPRESSIONS: Expression[] = [
  "neutral",
  "happy",
  "wow",
  "cool",
  "derp",
  "smug",
];

/**
 * Bộ nhân vật vẽ bằng canvas — chỉ là PHƯƠNG ÁN DỰ PHÒNG khi
 * `public/characters/` không có ảnh nào. Ảnh 蘑菇头 thật luôn được ưu tiên vì
 * nét vẽ tay không bao giờ ra đúng cái mặt người thật của meme gốc.
 *
 * 3 trục có chu kỳ 6/3/5 và biểu cảm chu kỳ 6 → 15 nhân vật đầu không trùng.
 */
export function generateSkins(count = 15): Skin[] {
  const skins: Skin[] = [];
  for (let i = 0; i < count; i++) {
    const outfit = OUTFITS[i % OUTFITS.length];
    const expr = EXPRESSIONS[(i * 5) % EXPRESSIONS.length];
    const accessory = ACCESSORIES[i % ACCESSORIES.length];
    const head = HEAD_SHAPES[i % HEAD_SHAPES.length];
    skins.push({
      accent: outfit.accent,
      aspect: W / H,
      frames: DANCE_CYCLE.map(([l, r]) =>
        makeTexture((ctx) =>
          drawCharacter(ctx, outfit.shirt, expr, l, r, accessory, head),
        ),
      ),
      rig: { shirt: outfit.shirt, accessory, accent: outfit.accent, head },
    });
  }
  return skins;
}

// ===================== CON RỐI CUTOUT (rig) =====================
// Mỗi bộ phận vẽ trên canvas full 256×320, chỉ chứa phần của nó (còn lại trong
// suốt). Xếp chồng các plane cùng cỡ ở cùng vị trí => giống hệt nhân vật liền
// khối; nhưng mỗi mảnh là mesh riêng nên xoay được quanh khớp (vai/hông/cổ).
const CX = 128;
const BODY_TOP = 116 + 96 - 30; // = 182, khớp với drawCharacter

/** Toạ độ khớp (canvas gốc) — rig quy đổi sang pivot 3D. */
export const RIG_JOINTS = {
  neck: [CX, BODY_TOP] as [number, number],
  shoulderL: [CX - 38, BODY_TOP + 15] as [number, number],
  shoulderR: [CX + 38, BODY_TOP + 15] as [number, number],
  hipL: [CX - 16, BODY_TOP + 62] as [number, number],
  hipR: [CX + 16, BODY_TOP + 62] as [number, number],
};

export type RigTextures = {
  torso: THREE.Texture;
  head: THREE.Texture;
  faces: Record<Expression, THREE.Texture>;
  armL: THREE.Texture;
  armR: THREE.Texture;
  legL: THREE.Texture;
  legR: THREE.Texture;
};

function drawTorso(ctx: CanvasRenderingContext2D, shirt: string) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.fillStyle = shirt;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(CX - 42, BODY_TOP, 84, 66, 16);
  ctx.fill();
  ctx.stroke();
}

function drawLeg(ctx: CanvasRenderingContext2D, side: number) {
  const hx = CX + side * 16;
  const legY = BODY_TOP + 62;
  ctx.lineCap = "round";
  ctx.strokeStyle = HAIR_COLOR;
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(hx, legY);
  ctx.lineTo(hx + side * 3, legY + 28);
  ctx.stroke();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(hx + side * 7, legY + 32, 15, 8, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawArm(ctx: CanvasRenderingContext2D, shirt: string, side: number) {
  ctx.lineCap = "round";
  ctx.strokeStyle =
    shirt === "#f5f4f0" || shirt === "#e8e4da" ? "#d9d4c7" : shirt;
  ctx.lineWidth = 13;
  ctx.beginPath();
  ctx.moveTo(CX + side * 38, BODY_TOP + 15);
  ctx.lineTo(CX + side * 64, BODY_TOP + 50);
  ctx.stroke();
  ctx.fillStyle = FACE_COLOR;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(CX + side * 66, BODY_TOP + 54, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawHead(
  ctx: CanvasRenderingContext2D,
  accessory: Accessory,
  accent: string,
  head: HeadShape,
) {
  paintHead(ctx, head);
  drawAccessory(ctx, accessory);
}

function drawFace(ctx: CanvasRenderingContext2D, expr: Expression) {
  const eyeY = 116 + 30;
  ctx.lineCap = "round";
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  if (expr === "neutral") {
    ctx.beginPath();
    ctx.arc(CX - 32, eyeY, 6, 0, Math.PI * 2);
    ctx.arc(CX + 32, eyeY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(CX - 24, eyeY + 38);
    ctx.quadraticCurveTo(CX, eyeY + 46, CX + 24, eyeY + 38);
    ctx.stroke();
  } else if (expr === "happy") {
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(CX - 44, eyeY + 2);
    ctx.quadraticCurveTo(CX - 31, eyeY - 15, CX - 18, eyeY + 2);
    ctx.moveTo(CX + 18, eyeY + 2);
    ctx.quadraticCurveTo(CX + 31, eyeY - 15, CX + 44, eyeY + 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(CX - 28, eyeY + 30);
    ctx.quadraticCurveTo(CX, eyeY + 60, CX + 28, eyeY + 30);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,110,110,0.4)";
    ctx.beginPath();
    ctx.ellipse(CX - 56, eyeY + 18, 12, 7, 0, 0, Math.PI * 2);
    ctx.ellipse(CX + 56, eyeY + 18, 12, 7, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (expr === "wow") {
    ctx.beginPath();
    ctx.arc(CX - 30, eyeY - 2, 7, 0, Math.PI * 2);
    ctx.arc(CX + 30, eyeY - 2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(CX, eyeY + 40, 15, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ff9d9d";
    ctx.beginPath();
    ctx.ellipse(CX, eyeY + 48, 8, 9, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (expr === "derp") {
    // Mắt lệch cỡ + lưỡi thè — mặt ngáo kinh điển của meme
    ctx.beginPath();
    ctx.arc(CX - 33, eyeY - 4, 12, 0, Math.PI * 2);
    ctx.arc(CX + 31, eyeY + 3, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(CX - 29, eyeY - 8, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(CX - 26, eyeY + 34);
    ctx.quadraticCurveTo(CX + 2, eyeY + 46, CX + 26, eyeY + 32);
    ctx.stroke();
    ctx.fillStyle = "#ff8fa3";
    ctx.beginPath();
    ctx.ellipse(CX + 8, eyeY + 48, 13, 10, 0.2, 0, Math.PI * 2);
    ctx.fill();
  } else if (expr === "smug") {
    // Mắt lim dim + cười khẩy một bên
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(CX - 46, eyeY - 6);
    ctx.quadraticCurveTo(CX - 32, eyeY + 8, CX - 16, eyeY - 4);
    ctx.moveTo(CX + 16, eyeY - 4);
    ctx.quadraticCurveTo(CX + 32, eyeY + 8, CX + 46, eyeY - 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(CX - 20, eyeY + 38);
    ctx.quadraticCurveTo(CX + 8, eyeY + 40, CX + 30, eyeY + 24);
    ctx.stroke();
  } else {
    // cool — kính đen + cười khẩy
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.roundRect(CX - 52, eyeY - 14, 42, 24, 8);
    ctx.roundRect(CX + 10, eyeY - 14, 42, 24, 8);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(CX - 10, eyeY - 6);
    ctx.lineTo(CX + 10, eyeY - 6);
    ctx.stroke();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(CX - 16, eyeY + 36);
    ctx.quadraticCurveTo(CX, eyeY + 44, CX + 20, eyeY + 34);
    ctx.stroke();
  }
}

const rigCache = new Map<string, RigTextures>();

/** Dựng (và cache theo outfit) bộ texture các mảnh rời cho con rối cutout. */
export function buildRigTextures(spec: RigSpec): RigTextures {
  const key = `${spec.shirt}|${spec.accessory}|${spec.accent}|${spec.head}`;
  const cached = rigCache.get(key);
  if (cached) return cached;
  const faces = {} as Record<Expression, THREE.Texture>;
  for (const e of EXPRESSIONS) faces[e] = makeTexture((ctx) => drawFace(ctx, e));
  const tex: RigTextures = {
    torso: makeTexture((ctx) => drawTorso(ctx, spec.shirt)),
    head: makeTexture((ctx) =>
      drawHead(ctx, spec.accessory, spec.accent, spec.head),
    ),
    faces,
    armL: makeTexture((ctx) => drawArm(ctx, spec.shirt, -1)),
    armR: makeTexture((ctx) => drawArm(ctx, spec.shirt, 1)),
    legL: makeTexture((ctx) => drawLeg(ctx, -1)),
    legR: makeTexture((ctx) => drawLeg(ctx, 1)),
  };
  // Các mảnh chỉ chiếm một phần khung 256×320, phần còn lại trong suốt. Mipmap
  // sẽ gộp phần đã vẽ ra toàn khung khi nhân vật ở xa → hiện ô vuông mờ phía
  // sau. Tắt mipmap (lọc tuyến tính) để vùng trong suốt luôn trong suốt.
  for (const t of [
    tex.torso,
    tex.head,
    tex.armL,
    tex.armR,
    tex.legL,
    tex.legR,
    ...Object.values(tex.faces),
  ]) {
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
  }
  rigCache.set(key, tex);
  return tex;
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

/**
 * Một tư thế trong vòng nhảy dựng từ ảnh tĩnh:
 * - `lean` nghiêng thân (đỉnh đầu lệch nhiều nhất, chân đứng yên),
 * - `squash` nén/giãn dọc,
 * - `bob` nhấp nhô phần trên.
 * Khớp nhịp điệu với `DANCE_CYCLE` của skin vẽ sẵn để cả sàn cùng một groove.
 */
type WarpPose = { lean: number; squash: number; bob: number };
const MEME_CYCLE: WarpPose[] = [
  { lean: 0, squash: 1, bob: 0 }, // idle — khung 0, dùng khi đứng yên
  { lean: 0.55, squash: 0.94, bob: 0.012 },
  { lean: 0.9, squash: 1.05, bob: 0.03 },
  { lean: 0.1, squash: 0.92, bob: -0.008 },
  { lean: -0.9, squash: 1.05, bob: 0.03 },
  { lean: -0.55, squash: 0.94, bob: 0.012 },
];

/**
 * Giữ lại DUY NHẤT nhân vật trong ảnh: gắn nhãn các mảng pixel liền khối rồi
 * bỏ hết những mảng không dính vào mảng lớn nhất, cuối cùng cắt sát khung.
 *
 * Ảnh 蘑菇头 tải từ các bộ sticker gần như luôn kèm CHỮ TRUNG in sẵn ở mép và
 * đôi khi có nhân vật phụ. Trên sàn nhảy, sprite được neo ở CHÂN nên dải chữ
 * phía dưới sẽ nằm đúng mặt sàn còn nhân vật thì lửng lơ trên không. Chữ và
 * nhân vật phụ không dính vào thân nhân vật chính nên tách được sạch bằng
 * connected-component, không cần đoán vị trí dải chữ.
 *
 * Trả về `null` khi không tách được gì đáng tin (ảnh quá nhỏ, mảng chính quá
 * bé hoặc tỉ lệ méo mó) — khi đó bên gọi cứ dùng nguyên ảnh gốc.
 */
function isolateSubject(source: HTMLCanvasElement): HTMLCanvasElement | null {
  const { width, height } = source;
  if (width < 24 || height < 24) return null;
  const ctx = source.getContext("2d")!;
  const img = ctx.getImageData(0, 0, width, height);
  const px = img.data;
  const n = width * height;

  // Nhãn 0 = nền trong suốt/chưa xét, >0 = số hiệu mảng
  const label = new Int32Array(n);
  const stack: number[] = [];
  let next = 0;
  const areas: number[] = [0];
  // bbox theo từng mảng: [minX, minY, maxX, maxY]
  const boxes: number[][] = [[0, 0, 0, 0]];

  for (let start = 0; start < n; start++) {
    if (label[start] !== 0 || px[start * 4 + 3] <= 24) continue;
    next++;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    label[start] = next;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      area++;
      const x = p % width;
      const y = (p / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // 8 hướng: nét vẽ mảnh hay dính nhau theo đường chéo, dùng 4 hướng thì
      // một nhân vật dễ bị vỡ thành nhiều mảng rời
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (label[q] !== 0 || px[q * 4 + 3] <= 24) continue;
          label[q] = next;
          stack.push(q);
        }
      }
    }
    areas.push(area);
    boxes.push([minX, minY, maxX, maxY]);
  }
  if (next === 0) return null;

  let main = 1;
  for (let i = 2; i <= next; i++) if (areas[i] > areas[main]) main = i;
  if (areas[main] < n * 0.01) return null;

  // Chỉ giữ mảng LỚN NHẤT. Từng thử "giữ thêm mảng có bbox giao với mảng chính"
  // để cứu tay/vật cầm bị nét đứt, nhưng bbox nhân vật thường trải gần hết khung
  // (tay vươn ngang) nên dải chữ nằm trên/dưới vẫn giao và không bị loại — thử
  // trên meme5-03 thì chữ 安排 vẫn còn nguyên. Nét vẽ 蘑菇头 viền đen liền khối
  // nên nhân vật gần như luôn là một mảng duy nhất, bỏ hết phần còn lại là đúng.
  for (let p = 0; p < n; p++) {
    if (px[p * 4 + 3] > 24 && label[p] !== main) px[p * 4 + 3] = 0;
  }

  // Cắt sát theo MẬT ĐỘ chứ không theo bbox: ảnh sticker hay có đường kẻ viền
  // mảnh dính vào nhân vật, bbox thô sẽ kéo khung ra hết cỡ và chừa mảng trống
  // to đùng phía trên (nhân vật hoá bé tí so với người bên cạnh).
  const rows = new Int32Array(height);
  const cols = new Int32Array(width);
  for (let p = 0; p < n; p++) {
    if (px[p * 4 + 3] <= 24) continue;
    rows[(p / width) | 0]++;
    cols[p % width]++;
  }
  let rMax = 0;
  let cMax = 0;
  for (let y = 0; y < height; y++) if (rows[y] > rMax) rMax = rows[y];
  for (let x = 0; x < width; x++) if (cols[x] > cMax) cMax = cols[x];
  const rowMin = Math.max(2, Math.round(rMax * 0.04));
  const colMin = Math.max(2, Math.round(cMax * 0.04));
  let x0 = 0;
  let y0 = 0;
  let x1 = width - 1;
  let y1 = height - 1;
  while (y0 < y1 && rows[y0] < rowMin) y0++;
  while (y1 > y0 && rows[y1] < rowMin) y1--;
  while (x0 < x1 && cols[x0] < colMin) x0++;
  while (x1 > x0 && cols[x1] < colMin) x1--;

  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  if (cw < 16 || ch < 16) return null;
  const ratio = cw / ch;
  if (ratio < 0.2 || ratio > 5) return null;

  ctx.putImageData(img, 0, 0);
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d")!.drawImage(source, x0, y0, cw, ch, 0, 0, cw, ch);
  return out;
}

/** Chiều cao tối đa khi bake vòng nhảy — ảnh meme gốc có thể 1000px+, giữ
 * nguyên cỡ đó nhân 6 khung là hàng trăm MB canvas cho một sàn đông người. */
const WARP_MAX_H = 384;
/** Số dải ngang khi warp. Nhiều dải = đường cong mượt, không thấy răng cưa bậc. */
const WARP_STRIPS = 30;
/** Đỉnh đầu lệch ngang tối đa, tính theo bề rộng ảnh, ở `lean` = 1. */
const WARP_SHEAR = 0.085;

/**
 * Uốn ảnh tĩnh thành một tư thế: vẽ lại theo từng dải ngang, dải càng gần đỉnh
 * đầu càng lệch/nhún nhiều. Vì biến dạng biến thiên liên tục theo chiều cao nên
 * không có đường nối lộ liễu như cách cắt rời đầu/thân.
 *
 * Ảnh gốc được đặt vào giữa khung đích rộng `w` (đã chừa lề hai bên) — nghiêng
 * hết cỡ thì đỉnh đầu vẫn nằm trong khung thay vì bị mép canvas cắt cụt.
 */
function warpPose(
  src: HTMLCanvasElement,
  pose: WarpPose,
  w: number,
  h: number,
  innerW: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const sh = src.height / WARP_STRIPS;
  for (let i = 0; i < WARP_STRIPS; i++) {
    const y0 = (i / WARP_STRIPS) * h;
    const stripH = h / WARP_STRIPS;
    // u = 0 ở chân, 1 ở đỉnh đầu; bình phương để chân gần như bất động
    const u = 1 - (y0 + stripH / 2) / h;
    const uu = u * u;
    const dx = pose.lean * uu * innerW * WARP_SHEAR;
    const dy = pose.bob * h * uu;
    // Nén dọc dồn hết về phía trên: chân chạm đất, thân co lại
    const sy = 1 + (pose.squash - 1) * u;
    const sx = 1 + (1 - pose.squash) * 0.55 * u;
    const dw = innerW * sx;
    ctx.drawImage(
      src,
      0,
      i * sh,
      src.width,
      sh,
      (w - dw) / 2 + dx,
      h - (h - y0) * sy + dy,
      dw,
      // +1px chồng mép để hai dải liền nhau không hở sọc trong suốt
      stripH * sy + 1,
    );
  }
  return canvas;
}

function toTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16;
  return texture;
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
 * Tải trước toàn bộ ảnh, chạy song song có giới hạn.
 *
 * Trước đây mỗi ảnh được `await` lần lượt ngay trong vòng dựng skin, nên
 * `public/characters/` cả trăm file là cả trăm lượt đi-về nối đuôi nhau — sàn
 * trống hàng chục giây sau khi vào trang. Phần xử lý pixel chỉ tốn ~0.5s cho
 * cả bộ, nút thắt nằm hết ở khâu chờ mạng.
 */
async function preloadImages(
  urls: string[],
  limit = 8,
): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try {
        out.set(url, await loadImage(url));
      } catch {
        // Ảnh hỏng/404 thì bỏ qua, bên dựng skin tự thiếu khung đó
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, urls.length) }, worker),
  );
  return out;
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

  const images = await preloadImages(urls);

  const skins: Skin[] = [];
  let index = 0;
  for (const key of [...groups.keys()].sort()) {
    const entries = groups.get(key)!.sort((a, b) => a.order - b.order);
    const frames: THREE.Texture[] = [];
    let aspect = 0.8;
    let firstCanvas: HTMLCanvasElement | null = null;
    // Bộ nhiều khung (`ten_0.png, ten_1.png…`) là sprite sheet đã canh sẵn: cắt
    // sát khung theo TỪNG khung thì mỗi khung ra một khung cắt khác nhau và
    // nhân vật giật lung tung khi phát. Chỉ dọn ảnh đơn.
    const clean = entries.length === 1;
    for (const { url } of entries) {
      const img = images.get(url);
      if (!img) continue;
      try {
        // Nền trắng → trong suốt, rồi bỏ chữ/nhân vật phụ và cắt sát nhân vật.
        // Tách được thì dùng bản sạch, không thì giữ nguyên ảnh gốc.
        const stripped = stripWhiteBackground(img);
        const canvas = clean ? (isolateSubject(stripped) ?? stripped) : stripped;
        if (!firstCanvas) firstCanvas = canvas;
        aspect = canvas.width / canvas.height;
        frames.push(toTexture(canvas));
      } catch {
      }
    }
    if (!frames.length) continue;
    const skin: Skin = {
      frames,
      aspect,
      accent: ACCENTS[index % ACCENTS.length],
    };
    // Ảnh đơn (không phải bộ `ten_0.png, ten_1.png…`) tự nó không có động tác:
    // sinh vòng nhảy bằng cách uốn chính nó. Bake lười — chỉ khi ai đó thật sự
    // mang skin này lên sàn, vì thư mục characters có thể cả trăm file.
    if (frames.length === 1 && firstCanvas) {
      const base = firstCanvas;
      let expanded = false;
      skin.expand = () => {
        if (expanded) return;
        expanded = true;
        const h = Math.min(WARP_MAX_H, base.height);
        const innerW = Math.max(1, Math.round(h * (base.width / base.height)));
        // Lề hai bên vừa đủ cho cú nghiêng mạnh nhất trong vòng nhảy
        const maxLean = Math.max(...MEME_CYCLE.map((p) => Math.abs(p.lean)));
        const w = innerW + 2 * Math.ceil(innerW * WARP_SHEAR * maxLean);
        // Khung idle phải bake lại trong CÙNG khung có lề, không thì lúc vào
        // nhảy tỉ lệ ảnh đổi đột ngột → nhân vật giật cỡ một cái
        frames[0] = toTexture(warpPose(base, MEME_CYCLE[0], w, h, innerW));
        for (let i = 1; i < MEME_CYCLE.length; i++) {
          frames.push(toTexture(warpPose(base, MEME_CYCLE[i], w, h, innerW)));
        }
        skin.aspect = w / h;
      };
    }
    skins.push(skin);
    index++;
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
