import * as THREE from "three";
import type { DanceMove, MusicGenre } from "./player";
import {
  buildRigTextures,
  RIG_JOINTS,
  SKIN_H,
  SKIN_W,
  type Expression,
  type RigSpec,
} from "./skins";

/** Tín hiệu điều khiển con rối mỗi frame (Player tính rồi truyền xuống). */
export type RigDrive = {
  move: DanceMove;
  pulse: number; // 0..1 trong ô nhịp (ĐÃ dịch swing theo thể loại)
  beatIndex: number;
  intensity: number; // năng lượng đoạn nhạc 0..1
  genre: MusicGenre; // thể loại → chất động tác (ballad mềm ↔ rock/edm mạnh)
  facing: number; // ±1 (moonwalk/spin lật mặt)
  camYaw: number; // billboard: xoay cả cụm hướng camera
  opacity: number; // độ mờ (theo dim/spotlight)
  beatConfidence: number; // 0..1 tin cậy beat: chắc → gật giòn, mờ → dịu lại
  dancing: boolean;
};

/**
 * Chất nhịp theo thể loại — không chỉ khác biên độ mà khác cả *timing* và
 * *hình dạng* động tác:
 * - amp: biên độ động tác; bob: độ nhún/gật phách.
 * - swing: 0 = dính grid tuyệt đối (edm); + = lay-back trễ phách (hiphop groove).
 * - timeFeel: "half" = ballad trải một cung nhún qua 2 phách (thong thả, không
 *   giật từng phách); "straight" = nhún mỗi phách như cũ.
 * - peak: vị trí đỉnh đường cong nhún 0..1. 0.5 = sin đối xứng (hệt hành vi cũ);
 *   <0.5 = attack sắc kiểu lò xo (edm); >0.5 = lên mềm, xuống muộn (ballad).
 */
export type GrooveFeel = {
  amp: number;
  bob: number;
  swing: number;
  timeFeel: "straight" | "half";
  peak: number;
};
export const GENRE_GROOVE: Record<MusicGenre, GrooveFeel> = {
  // ballad: mềm nhất, cung nhún lên chậm–xuống muộn (peak>0.5) cho cảm giác trôi
  ballad: { amp: 0.5, bob: 0.4, swing: 0.0, timeFeel: "half", peak: 0.55 },
  // pop: bám phách, chớm bật (peak hơi sớm) — vui tươi mà không giật
  pop: { amp: 0.78, bob: 0.9, swing: 0.03, timeFeel: "straight", peak: 0.47 },
  // hiphop: groove lay-back rõ (trễ phách) + nhún nặng (bob cao), bounce đục
  hiphop: { amp: 0.9, bob: 1.25, swing: 0.06, timeFeel: "straight", peak: 0.4 },
  // rock: dồn, mạnh, gần dính grid; đỉnh sớm cho cú nhún có lực
  rock: { amp: 1.05, bob: 1.1, swing: 0.02, timeFeel: "straight", peak: 0.42 },
  // edm: dính grid tuyệt đối, attack SẮC nhất (peak sớm) — bật lò xo four-on-floor
  edm: { amp: 1.05, bob: 1.35, swing: 0.0, timeFeel: "straight", peak: 0.32 },
};

type Pose = {
  armL: number; // góc xoay tại vai (rad); 0 = buông thõng
  armR: number;
  legL: number; // góc tại hông
  legR: number;
  head: number; // nghiêng đầu tại cổ
  squash: number; // co giãn thân đứng (ngồi xổm/dậm)
  expr: Expression;
};

/**
 * Con rối cutout 2D: mỗi bộ phận là một plane full-frame (chỉ chứa phần của nó),
 * xếp chồng nên khi đứng yên trông y hệt nhân vật liền khối; nhưng tay/chân/đầu
 * là mesh riêng có pivot ở khớp nên xoay được → biểu cảm + cử động thật.
 * Cả cụm billboard quanh trục Y để luôn hướng camera mà vẫn đứng thẳng.
 */
export class CharacterRig {
  readonly root = new THREE.Group();
  private planeW: number;
  private planeH: number;
  private geos: THREE.PlaneGeometry[] = [];
  private mats: THREE.MeshBasicMaterial[] = [];
  private faceMat: THREE.MeshBasicMaterial;
  private faces: Record<Expression, THREE.Texture>;

  private armLPivot: THREE.Group;
  private armRPivot: THREE.Group;
  private legLPivot: THREE.Group;
  private legRPivot: THREE.Group;
  private headPivot: THREE.Group;

  // Góc hiện tại (làm mượt về target) — tránh giật khi đổi điệu
  private cur: Pose = {
    armL: 0,
    armR: 0,
    legL: 0,
    legR: 0,
    head: 0,
    squash: 1,
    expr: "neutral",
  };

  constructor(spec: RigSpec, baseH: number, aspect: number) {
    this.planeW = baseH * aspect;
    this.planeH = baseH;
    const tx = buildRigTextures(spec);
    this.faces = tx.faces;

    // Thứ tự vẽ (sau đè trước): chân → thân → đầu → mặt → tay
    this.legLPivot = this.addPart(tx.legL, RIG_JOINTS.hipL, 1);
    this.legRPivot = this.addPart(tx.legR, RIG_JOINTS.hipR, 1);
    this.addPart(tx.torso, [SKIN_W / 2, SKIN_H / 2], 2); // thân tĩnh (pivot tâm)
    this.headPivot = this.addPart(tx.head, RIG_JOINTS.neck, 3);
    // Mặt đi kèm đầu (cùng pivot cổ) để nghiêng theo đầu
    this.faceMat = this.addMeshTo(this.headPivot, tx.faces.neutral, RIG_JOINTS.neck, 4);
    this.armLPivot = this.addPart(tx.armL, RIG_JOINTS.shoulderL, 5);
    this.armRPivot = this.addPart(tx.armR, RIG_JOINTS.shoulderR, 5);
  }

  /** Quy đổi toạ độ khớp trên canvas gốc → offset 3D so với chân (gốc cụm). */
  private jointWorld(j: readonly [number, number]): [number, number] {
    return [
      (j[0] / SKIN_W - 0.5) * this.planeW,
      (1 - j[1] / SKIN_H) * this.planeH,
    ];
  }

  /** Thêm một mesh full-frame vào pivot cho sẵn, canh về đúng vị trí gốc. */
  private addMeshTo(
    pivot: THREE.Group,
    map: THREE.Texture,
    joint: readonly [number, number],
    renderOrder: number,
  ): THREE.MeshBasicMaterial {
    const [jx, jy] = this.jointWorld(joint);
    const geo = new THREE.PlaneGeometry(this.planeW, this.planeH);
    const mat = new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Loại fragment gần trong suốt → không còn ô vuông mờ sau lưng nhân vật
      alphaTest: 0.12,
    });
    mat.color.setScalar(0.72); // đồng bộ độ sáng với sprite khán đài
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(-jx, this.planeH / 2 - jy, 0);
    mesh.renderOrder = renderOrder;
    pivot.add(mesh);
    this.geos.push(geo);
    this.mats.push(mat);
    return mat;
  }

  /** Tạo pivot ở khớp `joint`, gắn mesh full-frame vào rồi treo lên gốc cụm. */
  private addPart(
    map: THREE.Texture,
    joint: readonly [number, number],
    renderOrder: number,
  ): THREE.Group {
    const [jx, jy] = this.jointWorld(joint);
    const pivot = new THREE.Group();
    pivot.position.set(jx, jy, renderOrder * 0.002);
    this.addMeshTo(pivot, map, joint, renderOrder);
    this.root.add(pivot);
    return pivot;
  }

  private setExpr(expr: Expression) {
    if (this.cur.expr === expr) return;
    this.cur.expr = expr;
    this.faceMat.map = this.faces[expr];
    this.faceMat.needsUpdate = true;
  }

  update(dt: number, d: RigDrive) {
    const target = d.dancing ? poseFor(d) : IDLE_POSE;
    const k = Math.min(1, dt * 12);
    const c = this.cur;
    c.armL += (target.armL - c.armL) * k;
    c.armR += (target.armR - c.armR) * k;
    c.legL += (target.legL - c.legL) * k;
    c.legR += (target.legR - c.legR) * k;
    c.head += (target.head - c.head) * k;
    c.squash += (target.squash - c.squash) * k;
    this.setExpr(target.expr);

    this.armLPivot.rotation.z = c.armL;
    this.armRPivot.rotation.z = c.armR;
    this.legLPivot.rotation.z = c.legL;
    this.legRPivot.rotation.z = c.legR;
    this.headPivot.rotation.z = c.head;

    // Billboard quanh Y + lật mặt theo hướng; co giãn thân theo squash
    this.root.rotation.y = d.camYaw;
    this.root.scale.set(d.facing, c.squash, 1);

    for (const m of this.mats) m.opacity = d.opacity;
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    // Texture do buildRigTextures cache & dùng chung — KHÔNG dispose ở đây
  }
}

const IDLE_POSE: Pose = {
  armL: 0,
  armR: 0,
  legL: 0,
  legR: 0,
  head: 0,
  squash: 1,
  expr: "neutral",
};

/**
 * Ánh xạ điệu nhảy → tư thế khớp. Góc radian; tay TRÁI dương = vung ra/lên,
 * tay PHẢI dấu ngược (đối xứng). Nguyên tắc để ĐỠ LẮC và BÁM NHỊP:
 * - Groove nền chỉ đưa tay qua-lại MỘT lần mỗi 2 phách (chậm, không giật),
 *   biên độ nhỏ và scale theo thể loại (ballad mềm, rock/edm mạnh).
 * - Điểm nhấn rơi ĐÚNG PHÁCH: nhún người + gật đầu theo `beatHit` (đỉnh ở đầu
 *   phách rồi giãn) — cảm giác "ăn" nhịp thay vì lắc lư liên tục.
 */
function poseFor(d: RigDrive): Pose {
  const { move, pulse, intensity, beatIndex, genre, beatConfidence } = d;
  const gf = GENRE_GROOVE[genre] ?? GENRE_GROOVE.pop;
  const amp = gf.amp * (0.6 + intensity * 0.5);
  // Swing chậm: một chu kỳ qua-lại trải đều 2 phách (đỡ loạn hơn mỗi-phách)
  const swing = Math.sin(((beatIndex % 2) + pulse) * Math.PI);
  // Nhấn đúng phách: đỉnh ở đầu phách (pulse=0) rồi tắt dần. Nhịp CHẮC thì gằm
  // giòn (tắt nhanh, ăn phách rõ); nhịp MỜ thì gật dịu tránh nhấn sai chỗ.
  const beatHit = Math.max(0, 1 - pulse * (2 + beatConfidence * 1.6));

  const g: Pose = {
    armL: swing * 0.32 * amp,
    armR: -swing * 0.32 * amp,
    legL: swing * 0.06,
    legR: -swing * 0.06,
    head: -beatHit * 0.08 * gf.bob, // gật đầu xuống trên phách
    squash: 1 - beatHit * 0.05 * gf.bob, // nhún người trên phách
    expr: intensity > 0.62 ? "happy" : "neutral",
  };

  const UP = 2.1; // tay giơ thẳng lên
  switch (move) {
    case "hop":
    case "pogo":
    case "double-bounce":
    case "charleston":
      // Giơ hai tay theo phách (bám nhịp), không rung liên tục
      g.armL = (UP - 0.35) + beatHit * 0.35;
      g.armR = -g.armL;
      g.expr = intensity > 0.7 ? "wow" : "happy";
      break;
    case "clap":
      g.armL = 1.05 * beatHit; // vỗ vào giữa đúng phách
      g.armR = -1.05 * beatHit;
      g.expr = "happy";
      break;
    case "wave":
    case "fan":
      g.armL = 1.6 + swing * 0.25 * amp; // một tay giơ cao lượn nhẹ
      g.armR = -0.25;
      break;
    case "kick":
      g.legR = 0.9 * beatHit; // đá theo phách
      g.armL = 0.6;
      g.armR = -0.6;
      break;
    case "squat":
    case "dip":
      g.squash = 1 - 0.2 * beatHit;
      g.armL = 0.8;
      g.armR = -0.8;
      break;
    case "stomp":
      g.squash = 1 - 0.14 * beatHit;
      g.legL = beatIndex % 2 === 0 ? 0.45 * beatHit : 0.05;
      g.legR = beatIndex % 2 === 1 ? -0.45 * beatHit : -0.05;
      break;
    case "headbang":
      g.head = -0.45 * beatHit; // gằm mạnh đúng phách rồi ngẩng
      g.armL = 0.25;
      g.armR = -0.25;
      break;
    case "windmill":
      g.armL = swing * 2.2 * gf.amp; // quay tròn theo swing (đã chậm lại)
      g.armR = -swing * 2.2 * gf.amp;
      g.expr = "wow";
      break;
    case "twist":
      g.legL = swing * 0.22;
      g.legR = swing * 0.22;
      g.head = -swing * 0.1;
      break;
    case "moonwalk":
    case "slide":
    case "robot":
      g.armL = 0.5;
      g.armR = -0.5;
      g.expr = "cool";
      break;
    case "shoulder":
    case "shuffle":
    case "cross-step":
    case "grapevine":
      g.armL = 0.35 + swing * 0.3 * amp;
      g.armR = -0.35 - swing * 0.3 * amp;
      break;
    case "freeze":
      g.armL = 1.2;
      g.armR = -0.35;
      g.head = 0.12;
      g.expr = "cool";
      break;
    default:
      break;
  }
  // Cao trào rất mạnh: thi thoảng há hốc "wow" cho sống động
  if (intensity > 0.82 && beatIndex % 8 < 2) g.expr = "wow";
  return g;
}
