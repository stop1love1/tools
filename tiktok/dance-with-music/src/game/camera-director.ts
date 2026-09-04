/**
 * Editing decisions for the automatic camera director, kept free of THREE and
 * of scene state so the rules can be read on their own. game.ts owns the shot
 * geometry and applies whatever this module decides.
 */

export type ShotKind =
  | "wide"
  | "medium"
  | "crowd"
  | "top"
  | "side"
  | "close"
  | "dj"
  | "low";

export type CamShot = {
  pos: [number, number, number];
  look: [number, number, number];
  drift: number;
  kind: ShotKind;
};

/**
 * Lens per frame size: close shots go long (narrow FOV) to compress the
 * background, wide shots go short for scale.
 */
export const FOV_BY_KIND: Record<ShotKind, number> = {
  close: 52,
  dj: 50,
  side: 52,
  medium: 56,
  top: 56,
  low: 58,
  crowd: 60,
  wide: 62,
};

/**
 * Editing grammar: which frame sizes read well after each other. A camera
 * operator doesn't cut close→close or hold one size all night, so the next
 * kind is drawn from this table instead of uniformly at random.
 */
const KIND_FOLLOWS: Record<ShotKind, ShotKind[]> = {
  wide: ["medium", "close", "side", "dj", "low"],
  medium: ["close", "wide", "top", "side", "low"],
  close: ["wide", "side", "crowd", "top", "medium"],
  side: ["close", "wide", "medium", "top"],
  top: ["medium", "close", "crowd", "low"],
  crowd: ["wide", "medium", "dj", "close"],
  dj: ["crowd", "wide", "close", "side"],
  low: ["wide", "medium", "top", "side"],
};

/**
 * Relative pick weight. The dramatic angles stay rare so they keep their
 * impact; the readable ones carry most of the runtime.
 */
const KIND_WEIGHT: Record<ShotKind, number> = {
  wide: 1,
  medium: 1,
  close: 0.9,
  side: 0.8,
  top: 0.7,
  crowd: 0.7,
  dj: 0.45,
  low: 0.4,
};

/** A close-up outstays its welcome long before an establishing wide does. */
const KIND_TAKE_SCALE: Record<ShotKind, number> = {
  close: 0.6,
  low: 0.7,
  dj: 0.8,
  side: 0.85,
  medium: 1,
  crowd: 1.1,
  top: 1.15,
  wide: 1.25,
};

/** How many recent shots to keep out of the running, to avoid ping-ponging. */
export const RECENT_SHOTS = 4;

/**
 * Below this beat confidence the detector is guessing at the grid. A cut that
 * lands off the music reads far worse than a late one, so the director stops
 * cutting on `beat.index` and falls back to elapsed time.
 */
export const BEAT_CUT_MIN_CONFIDENCE = 0.45;

function weightedPick(
  shots: readonly CamShot[],
  score: (s: CamShot, i: number) => number,
  rand: () => number,
): number {
  const w = new Array<number>(shots.length);
  let total = 0;
  let lastNonZero = -1;
  for (let i = 0; i < shots.length; i++) {
    const v = Math.max(0, score(shots[i], i));
    w[i] = v;
    if (v > 0) lastNonZero = i;
    total += v;
  }
  if (total <= 0) return -1;
  let r = rand() * total;
  for (let i = 0; i < shots.length; i++) {
    r -= w[i];
    if (r <= 0 && w[i] > 0) return i;
  }
  return lastNonZero;
}

/**
 * Choose the next shot index. Tries the full grammar first, then relaxes one
 * constraint at a time, so a narrow `kinds` filter degrades into a worse-but-
 * valid choice rather than no choice at all.
 */
export function pickNextShot(
  shots: readonly CamShot[],
  opts: {
    curKind?: ShotKind;
    /** Recently used indices, most recent first. */
    recent?: readonly number[];
    /** Frame sizes allowed for this section of the song. */
    kinds?: readonly ShotKind[];
    rand?: () => number;
  },
): number {
  if (!shots.length) return -1;
  const rand = opts.rand ?? Math.random;
  const recent = opts.recent ?? [];
  const allowed = opts.kinds;
  const follows = opts.curKind ? KIND_FOLLOWS[opts.curKind] : null;
  const permitted = (s: CamShot) => !allowed || allowed.includes(s.kind);

  const full = weightedPick(
    shots,
    (s, i) => {
      if (!permitted(s) || recent.includes(i) || s.kind === opts.curKind) {
        return 0;
      }
      // Prefer the grammar, but only discount what falls outside it: a hard
      // ban loops the same few sizes once `kinds` is narrow.
      return KIND_WEIGHT[s.kind] * (!follows || follows.includes(s.kind) ? 1 : 0.25);
    },
    rand,
  );
  if (full >= 0) return full;

  const sameKindOk = weightedPick(
    shots,
    (s, i) => (permitted(s) && !recent.includes(i) ? KIND_WEIGHT[s.kind] : 0),
    rand,
  );
  if (sameKindOk >= 0) return sameKindOk;

  const anyButCurrent = weightedPick(
    shots,
    (_s, i) => (i === recent[0] ? 0 : 1),
    rand,
  );
  return anyButCurrent >= 0 ? anyButCurrent : 0;
}

/**
 * Take length in beats: short and punchy in a chorus, long and patient in a
 * quiet section, then scaled by how long the frame size can hold interest.
 */
export function takeLengthBeats(
  kind: ShotKind,
  section: number,
  jitter: number,
): number {
  const base = section > 0.7 ? 8 : section < 0.4 ? 18 : 14;
  return Math.max(4, Math.round(base * KIND_TAKE_SCALE[kind]) + jitter);
}

/**
 * Whether the director should cut now. On a trusted grid it waits for the take
 * to run out AND for a bar boundary; otherwise it cuts purely on elapsed time.
 */
export function shouldCut(opts: {
  takeBeats: number;
  takeLen: number;
  takeSeconds: number;
  beatSeconds: number;
  beatIndex: number;
  cutGrid: number;
  beatConfidence: number;
}): boolean {
  if (opts.beatConfidence >= BEAT_CUT_MIN_CONFIDENCE) {
    return opts.takeBeats >= opts.takeLen && opts.beatIndex % opts.cutGrid === 0;
  }
  return opts.takeSeconds >= opts.takeLen * opts.beatSeconds;
}
