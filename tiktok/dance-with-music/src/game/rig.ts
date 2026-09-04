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

/** Per-frame puppet control signals, computed by Player and passed down. */
export type RigDrive = {
  move: DanceMove;
  pulse: number; // 0..1 within the beat (ALREADY swing-shifted per genre)
  beatIndex: number;
  intensity: number; // section energy 0..1
  genre: MusicGenre; // drives motion character (soft ballad ↔ hard rock/edm)
  facing: number; // ±1 (moonwalk/spin flip the character)
  camYaw: number; // billboard: rotate the group toward the camera
  opacity: number; // fade from dim/spotlight
  beatConfidence: number; // 0..1; confident → crisp nod, unsure → softened
  dancing: boolean;
};

/**
 * Per-genre rhythmic feel. This varies not just amplitude but the *timing*
 * and *shape* of the motion:
 * - amp: motion amplitude; bob: how deep the per-beat bounce/nod goes.
 * - swing: 0 = locked to the grid (edm); + = laid back behind the beat (hiphop).
 * - timeFeel: "half" spreads one bounce arc over 2 beats (ballad, unhurried);
 *   "straight" bounces once per beat.
 * - peak: where the bounce curve peaks, 0..1. 0.5 = symmetric sine;
 *   <0.5 = sharp spring-like attack (edm); >0.5 = soft rise, late fall (ballad).
 */
export type GrooveFeel = {
  amp: number;
  bob: number;
  swing: number;
  timeFeel: "straight" | "half";
  peak: number;
};
export const GENRE_GROOVE: Record<MusicGenre, GrooveFeel> = {
  // ballad: softest — slow rise, late fall (peak>0.5) for a floating feel
  ballad: { amp: 0.5, bob: 0.4, swing: 0.0, timeFeel: "half", peak: 0.55 },
  // pop: on the beat, slightly early peak — upbeat without feeling jerky
  pop: { amp: 0.78, bob: 0.9, swing: 0.03, timeFeel: "straight", peak: 0.47 },
  // hiphop: pronounced lay-back behind the beat + heavy bob, muddier bounce
  hiphop: { amp: 0.9, bob: 1.25, swing: 0.06, timeFeel: "straight", peak: 0.4 },
  // rock: driving and strong, near the grid; early peak gives the bounce punch
  rock: { amp: 1.05, bob: 1.1, swing: 0.02, timeFeel: "straight", peak: 0.42 },
  // edm: locked to the grid, sharpest attack — four-on-the-floor spring
  edm: { amp: 1.05, bob: 1.35, swing: 0.0, timeFeel: "straight", peak: 0.32 },
};

type Pose = {
  armL: number; // rotation at the shoulder (rad); 0 = hanging down
  armR: number;
  legL: number; // rotation at the hip
  legR: number;
  head: number; // head tilt at the neck
  squash: number; // vertical squash/stretch of the torso (squat/stomp)
  expr: Expression;
};

/**
 * 2D cutout puppet: every body part is a full-frame plane holding only its own
 * pixels. Stacked, they look identical to the one-piece character at rest, but
 * arms/legs/head are separate meshes pivoting at their joints, so they can
 * actually rotate. The whole group billboards around Y to face the camera
 * while staying upright.
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

  // Current angles, eased toward their targets so move changes don't snap
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

    // Draw order, later on top: legs → torso → head → face → arms
    this.legLPivot = this.addPart(tx.legL, RIG_JOINTS.hipL, 1);
    this.legRPivot = this.addPart(tx.legR, RIG_JOINTS.hipR, 1);
    this.addPart(tx.torso, [SKIN_W / 2, SKIN_H / 2], 2); // static torso, pivot at its centre
    this.headPivot = this.addPart(tx.head, RIG_JOINTS.neck, 3);
    // Face shares the head's neck pivot so it tilts with the head
    this.faceMat = this.addMeshTo(this.headPivot, tx.faces.neutral, RIG_JOINTS.neck, 4);
    this.armLPivot = this.addPart(tx.armL, RIG_JOINTS.shoulderL, 5);
    this.armRPivot = this.addPart(tx.armR, RIG_JOINTS.shoulderR, 5);
  }

  /** Joint coordinates on the source canvas → 3D offset from the feet. */
  private jointWorld(j: readonly [number, number]): [number, number] {
    return [
      (j[0] / SKIN_W - 0.5) * this.planeW,
      (1 - j[1] / SKIN_H) * this.planeH,
    ];
  }

  /** Add a full-frame mesh to the given pivot, aligned to its origin. */
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
      // Discard near-transparent fragments, else a faint square shows behind
      // the character
      alphaTest: 0.12,
    });
    mat.color.setScalar(0.72); // match the brightness of the crowd sprites
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(-jx, this.planeH / 2 - jy, 0);
    mesh.renderOrder = renderOrder;
    pivot.add(mesh);
    this.geos.push(geo);
    this.mats.push(mat);
    return mat;
  }

  /** Create a pivot at `joint`, attach a full-frame mesh, parent it to root. */
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

    // Billboard around Y, flip to face direction, squash/stretch the torso
    this.root.rotation.y = d.camYaw;
    this.root.scale.set(d.facing, c.squash, 1);

    for (const m of this.mats) m.opacity = d.opacity;
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    // Textures are cached and shared by buildRigTextures — do NOT dispose here
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
 * Dance move → joint pose. Angles in radians; positive on the LEFT arm swings
 * it out/up, the RIGHT arm mirrors it. Two rules keep the puppet on the beat
 * instead of wobbling constantly:
 * - The base groove swings the arms across ONCE per 2 beats — slow, small,
 *   and scaled by genre (soft for ballad, strong for rock/edm).
 * - Accents land ON the beat: the body bounce and head nod follow `beatHit`,
 *   peaking at the start of a beat and relaxing after.
 */
function poseFor(d: RigDrive): Pose {
  const { move, pulse, intensity, beatIndex, genre, beatConfidence } = d;
  const gf = GENRE_GROOVE[genre] ?? GENRE_GROOVE.pop;
  const amp = gf.amp * (0.6 + intensity * 0.5);
  // Slow swing: one full cycle spread over 2 beats, calmer than once per beat
  const swing = Math.sin(((beatIndex % 2) + pulse) * Math.PI);
  // On-beat accent: peaks at pulse=0 then decays. A confident beat snaps
  // crisply; an uncertain one nods gently so a wrong guess isn't emphasised.
  const beatHit = Math.max(0, 1 - pulse * (2 + beatConfidence * 1.6));

  const g: Pose = {
    armL: swing * 0.32 * amp,
    armR: -swing * 0.32 * amp,
    legL: swing * 0.06,
    legR: -swing * 0.06,
    head: -beatHit * 0.08 * gf.bob, // nod down on the beat
    squash: 1 - beatHit * 0.05 * gf.bob, // dip the body on the beat
    expr: intensity > 0.62 ? "happy" : "neutral",
  };

  const UP = 2.1; // arm raised straight up
  switch (move) {
    case "hop":
    case "pogo":
    case "double-bounce":
    case "charleston":
      // Raise both arms on the beat rather than shaking continuously
      g.armL = (UP - 0.35) + beatHit * 0.35;
      g.armR = -g.armL;
      g.expr = intensity > 0.7 ? "wow" : "happy";
      break;
    case "clap":
      g.armL = 1.05 * beatHit; // clap together right on the beat
      g.armR = -1.05 * beatHit;
      g.expr = "happy";
      break;
    case "wave":
    case "fan":
      g.armL = 1.6 + swing * 0.25 * amp; // one arm held high, drifting gently
      g.armR = -0.25;
      break;
    case "kick":
      g.legR = 0.9 * beatHit; // kick on the beat
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
      g.head = -0.45 * beatHit; // snap the head down on the beat, then lift
      g.armL = 0.25;
      g.armR = -0.25;
      break;
    case "windmill":
      g.armL = swing * 2.2 * gf.amp; // full circle driven by the slowed swing
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
    case "griddy": {
      // Arms form goggles in front of the face, legs alternate at double time
      const flick = Math.sin(pulse * Math.PI * 4);
      g.armL = 1.15 + flick * 0.12;
      g.armR = -1.15 + flick * 0.12;
      g.legL = flick * 0.3;
      g.legR = flick * 0.3;
      g.expr = intensity > 0.6 ? "smug" : "cool";
      break;
    }
    case "heel-toe": {
      // Heel-toe: feet alternate very fast, upper body nearly still
      const flick = Math.sin(pulse * Math.PI * 8);
      g.legL = flick * 0.34;
      g.legR = flick * 0.34;
      g.armL = 0.42;
      g.armR = -0.42;
      g.expr = "cool";
      break;
    }
    case "gangnam":
      // Horse ride: arms crossed pulling reins, bouncing on the beat
      g.armL = 1.45 + beatHit * 0.3;
      g.armR = -0.55 - beatHit * 0.25;
      g.legL = 0.3 * beatHit;
      g.legR = -0.22 * beatHit;
      g.expr = intensity > 0.65 ? "wow" : "happy";
      break;
    case "sprinkler":
      // One arm sweeps a slow straight arc, the other rests behind the head
      g.armL = 0.35 + ((pulse + (beatIndex % 4)) / 4) * 2.4 * gf.amp;
      g.armR = -1.85;
      g.head = 0.1;
      g.expr = "derp";
      break;
    case "mushroom-pop":
      // Mushroom pop: compress then burst — arms fly up, cap bounces on beat
      g.squash = 1 + 0.12 * beatHit - Math.max(0, pulse - 0.62) * 0.28;
      g.armL = 0.5 + beatHit * (UP - 0.5);
      g.armR = -g.armL;
      g.head = beatHit * 0.16 - 0.04;
      g.expr = intensity > 0.7 ? "wow" : "derp";
      break;
    default:
      break;
  }
  // At very high intensity, drop an occasional open-mouthed "wow"
  if (intensity > 0.82 && beatIndex % 8 < 2) g.expr = "wow";
  return g;
}
