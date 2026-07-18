# Pyro Director, Firework Variety & Ground Fog — Design

Date: 2026-07-18
Project: tiktok/dance-with-music
Files touched: `src/game/effects.ts`, `src/game/game.ts`

## Problem

The stage FX (fireworks, flame jets, CO2 smoke) currently fire on hard-coded
beat modulos inline in `game.ts` (the "PYRO DIRECTOR" block ~L2531-L2600 and
the drop handler ~L2628). Symptoms:

- **Fireworks fire mechanically** — one burst shape only, random colors,
  spawned on fixed `beat.index % 16 === 8` while `section > 0.8`. Always the
  same, always firing on the mark, no restraint.
- **Flames/smoke** have patterns but are also modulo-driven, never held back.
- **No low-lying floor mist** — only a global `THREE.Fog` and edge haze
  puffs exist.

## Goals

1. A smarter cue engine that decides **when** pyro fires — reads musical
   energy, holds back during buildups, releases on real moments, and
   deliberately stays quiet sometimes ("not always firing").
2. **Firework variety** across three axes: burst TYPE, TIMING, and
   POSITION/COLOR.
3. Flames & smoke driven by the same smart engine (variety + restraint).
4. A new **ground fog** layer that appears only in quiet/ballad sections —
   thin, faint, drifting just above the floor.

Non-goals: no changes to choreography, camera, or the DiscoFloor/LedWall
systems beyond what the director needs to read.

## Architecture

### PyroDirector (new class in `effects.ts`)

A self-contained "stage-operator brain". game.ts feeds it per-beat musical
state; it returns a list of **cues** which game.ts executes against the
existing `fireworks` / `flames` / `frontSparks` / `smokeJets` instances.

```
type PyroCue =
  | { kind: "firework"; fxType: FireworkType; pos: Vec3; strength: number }
  | { kind: "flame";    strength: number; which?: number[] }
  | { kind: "spark";    strength: number }
  | { kind: "smoke";    strength: number };

class PyroDirector {
  // per-effect energy budget 0..1, depletes on fire, recharges over time
  private budget = { firework: 1, flame: 1, spark: 1, smoke: 1 };
  private lastFireworkType: FireworkType | null;
  private pattern: number;              // current flame pattern (0..N)
  private buildupHold: boolean;         // true while holding fire during a rise

  update(dt): void;                     // recharge budgets each frame
  // called once per NEW beat; returns cues to execute
  cue(ctx: DirectorCtx): PyroCue[];
}

type DirectorCtx = {
  beat: Beat; level: number; section: number; drop: number;
  energyRise: number;   // section delta over recent beats (buildup detector)
  inClimax: boolean; inQuietSection: boolean; beatConfidence: number;
  mood: Mood;
};
```

**Decision logic (`cue`):**

1. **Moment score** `= f(level, section, drop, beatConfidence, energyRise)`.
   Low confidence / ambient → score ~0 → return `[]` (stay silent, as today).
2. **Budget gate** — each effect only fires if `budget[effect] >= cost`.
   Firing subtracts cost; `update()` recharges at a per-effect rate.
   Fireworks recharge slowest → naturally spaced, never spammy.
3. **Buildup hold** — when `energyRise` is high and not yet at the peak,
   set `buildupHold` and suppress fireworks/flames (build tension). On the
   release beat (drop rises, or section crosses climax threshold) spend a
   big chunk of budget on a **volley**.
4. **Variety** — pick firework `fxType` and flame `pattern` by weighted
   random with a "don't repeat last" rule. Position jittered across
   left/right/high/low; color derived from `mood.hue` (± small jitter).
5. **Restraint randomness** — even when eligible, occasionally skip
   (probability scaled down with score) so runs never feel metronomic.

game.ts keeps its **hard** triggers (drop hit, chorus-entry stinger) as
direct calls for guaranteed punch, but routes the *recurring* chorus/verse
pyro through the director instead of the modulo conditions.

### Firework variety (`Fireworks` class in `effects.ts`)

Add `type FireworkType = "burst" | "willow" | "ring" | "crackle" | "comet"`
and extend `spawn(origin, count, opts?)` with `{ type, hue }`.

Per-burst behavior differences:

- **burst** — current spherical spray (default, unchanged look).
- **willow** — heavier gravity, lower initial speed, longer `BURST_LIFE`,
  warm-gold hue, droops down slowly.
- **ring** — velocities constrained to a tilted plane → expanding ring.
- **crackle** — near end of life, a fraction of particles re-accelerate in
  random directions with a brief brightness pop (secondary sparkle).
- **comet** — a two-stage shell: a fast rising streak, then a small burst
  spawned at its apex.

Implementation: the per-particle init and the `update()` integrator gain a
small `type`-keyed branch (gravity, life, hue mapping, optional secondary).
Color: use `opts.hue` (from `mood.hue`) with small per-burst jitter instead
of `Math.random()` hue; keep a random fallback when no hue given.

Multi-shell volleys are produced by the director emitting several
`firework` cues with staggered positions in one beat (game.ts spawns them;
optional tiny stagger via existing per-frame spawn is acceptable — no timers
needed).

### Flames & smoke

No structural change to `FlameJets` / `SmokeJets`. The director supplies
`strength` and `which[]`; add 1-2 new flame patterns in the director's
pattern table:

- existing: chase-around, pair-outward, all-on-downbeat
- new: **random single pop**, **wave both directions**, **double-tap**
  (fire same nozzles twice within the beat window — second call next frame).

Smoke `blast` strength and haze `puff` rate come from the director's smoke
budget + score rather than fixed modulos.

### GroundFog (new class in `effects.ts`)

Layered translucent planes hugging the floor, visible only in quiet
sections.

```
class GroundFog {
  readonly group: THREE.Group;   // 2-3 stacked PlaneGeometry, y ≈ 0.12-0.3
  update(dt, quiet: number, energy: number, mood?: Mood): void;
}
```

- Large flat planes (cover the dance floor footprint), soft radial/noise
  alpha texture (reuse `makeGlowTexture()` tiled, or a dedicated soft-noise
  canvas), `AdditiveBlending` off / normal blend at low opacity so it reads
  as pale mist, `depthWrite: false`.
- Animate UV offset (or plane rotation) slowly for drift.
- **Opacity target** = `quiet * (1 - energy) * cap` where
  `quiet = inQuietSection ? 1 : 0` smoothed over time, so it fades in during
  ballad/breakdown and melts away in the climax. Never opaque enough to hide
  dancers' feet.
- Color: near-white, faintly tinted toward `mood.hue`.

game.ts constructs it, adds `group` to the scene, and calls `update` each
frame with `music.inQuietSection` + `mood.energy`.

## Data flow

```
game.update()
  each frame:  pyroDirector.update(dt); groundFog.update(dt, quiet, energy, mood)
  each NEW beat: cues = pyroDirector.cue(ctx)
                 for cue in cues: apply to fireworks/flames/frontSparks/smokeJets
  hard triggers (drop, chorus entry): direct fire() calls as today
```

## Error handling / safety

- Director returns `[]` on low-confidence/ambient audio → no misfires (keeps
  the existing "operator caution" behavior).
- Budgets clamp to [0,1]; costs guarantee a max fire rate → no particle-pool
  exhaustion beyond current `FLAME_MAX` / `SMOKE_MAX` / firework limits.
- GroundFog opacity clamps to a safe cap; planes use `frustumCulled = false`
  only if they extend past the floor (they don't — leave culling on).

## Testing / verification

Manual in-browser (this is a real-time visual system):

1. Ambient/preview (no strong beat) → fireworks stay silent, ground fog
   fades in.
2. Verse → occasional varied flames, no firework spam.
3. Buildup → pyro noticeably holds back.
4. Drop / chorus entry → volley of mixed firework types across positions,
   full flames + smoke.
5. Ballad section → ground mist clearly visible; climax → mist gone.
6. Confirm no console errors, no frame drop, particle pools not exhausted.

## Rollout

Incremental, each landable on its own:

1. `Fireworks` type variety (visible immediately via existing spawn sites).
2. `GroundFog` class + wire into scene.
3. `PyroDirector` class; route recurring pyro through it, keep hard
   triggers. Tune budgets/scores last.
