// The rules of the game, with no canvas, no DOM and no clock in sight.
//
// Everything here is a pure function of its arguments, which is the only
// reason `spec/game.test.ts` can state the losing rule as a table of cases
// instead of driving synthetic pointer events at a rendered page. The renderer
// and the input loop live next door in `render.ts` and `main.ts`; they are
// allowed to know about pixels, and this file is not.

/** World units. A platform's top face is a square this wide. */
export const PLATFORM_SIZE = 58;
/** Half the top face, i.e. how far off-centre you can land and survive. */
export const PLATFORM_REACH = PLATFORM_SIZE / 2;
/** Land within this of dead centre and the jump scores as perfect. */
export const PERFECT_REACH = 6;

/** Hold longer than this and the charge stops growing. */
export const MAX_CHARGE_MS = 1250;
/** Distance travelled at full charge. */
export const MAX_DISTANCE = 340;
/** Distance travelled per millisecond held. */
export const CHARGE_SPEED = MAX_DISTANCE / MAX_CHARGE_MS;

/** Closest the next platform is ever placed — always clearable. */
export const MIN_GAP = 96;
/** Furthest the next platform is ever placed — always reachable at full charge. */
export const MAX_GAP = 300;

/** Drawn height of a block. Varies for looks; nothing reads it as a rule. */
export const MIN_HEIGHT = 42;
export const MAX_HEIGHT = 68;

/** The two isometric directions the run can turn. */
export type Axis = "x" | "z";

export interface Platform {
  readonly id: number;
  /** Ground-plane position of the centre of the top face. */
  readonly x: number;
  readonly z: number;
  /** Drawn height of the block, which varies for looks only. */
  readonly height: number;
  /** Which way you leave this platform to reach the next one. */
  readonly axis: Axis;
}

/**
 * What a jump did. `stay` is the tap that never really left: in the original
 * a feeble hold drops you back on the block you were already standing on, and
 * that is not a loss, so the rule has three outcomes rather than two.
 */
export type Landing =
  | { readonly kind: "stay" }
  | { readonly kind: "land"; readonly perfect: boolean; readonly offset: number }
  | { readonly kind: "fall"; readonly reason: "short" | "long" };

/**
 * The losing rule, and the only place in the codebase that decides it.
 *
 * `travelled` and `gap` are both measured along the jump axis from the centre
 * of the platform being left, so the arithmetic is one-dimensional even though
 * the picture is not.
 */
export function resolveLanding(travelled: number, gap: number): Landing {
  if (travelled <= PLATFORM_REACH) return { kind: "stay" };

  const offset = travelled - gap;
  if (offset < -PLATFORM_REACH) return { kind: "fall", reason: "short" };
  if (offset > PLATFORM_REACH) return { kind: "fall", reason: "long" };

  return { kind: "land", perfect: Math.abs(offset) <= PERFECT_REACH, offset };
}

/** Hold time to distance: linear, and flat once the charge is full. */
export function chargeToDistance(heldMs: number): number {
  if (heldMs <= 0) return 0;
  return Math.min(heldMs, MAX_CHARGE_MS) * CHARGE_SPEED;
}

/**
 * Points for a landing. A plain landing is worth one; centre hits pay 2, 4, 6,
 * 8 … as long as you keep hitting them, which is the whole reason to aim
 * rather than merely clear the gap.
 *
 * `streak` is how many perfect landings came immediately before this one.
 */
export function scoreFor(perfect: boolean, streak: number): number {
  return perfect ? 2 * (streak + 1) : 1;
}

/** Deterministic PRNG (mulberry32) so a seed replays a run exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where the run starts: one block under your feet, one to aim at. */
export function firstPlatform(random: () => number): Platform {
  return {
    id: 0,
    x: 0,
    z: 0,
    height: MIN_HEIGHT + Math.floor(random() * (MAX_HEIGHT - MIN_HEIGHT)),
    axis: random() < 0.5 ? "x" : "z",
  };
}

/**
 * The next block, placed along `from.axis` at a gap that full charge can
 * always clear and the shortest real hold can always reach.
 */
export function nextPlatform(from: Platform, random: () => number): Platform {
  const gap = MIN_GAP + random() * (MAX_GAP - MIN_GAP);
  return {
    id: from.id + 1,
    x: from.axis === "x" ? from.x + gap : from.x,
    z: from.axis === "z" ? from.z + gap : from.z,
    height: MIN_HEIGHT + Math.floor(random() * (MAX_HEIGHT - MIN_HEIGHT)),
    axis: random() < 0.5 ? "x" : "z",
  };
}

/** Centre-to-centre distance between two platforms, along their shared axis. */
export function gapBetween(from: Platform, to: Platform): number {
  return Math.hypot(to.x - from.x, to.z - from.z);
}
