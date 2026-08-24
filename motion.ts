// The curves. Pure functions of elapsed milliseconds or of a 0..1 parameter,
// with no clock and no DOM, so `spec/motion.test.ts` can assert the properties
// that decide whether a transition reads as a movement or as a cut.
//
// This file exists because of a bug that was invisible to every check in the
// repo and obvious the moment someone played it: a deformation curve that
// starts at full value teleports whatever it is deforming, on the frame it
// starts. Nothing crashes, nothing goes red, the game just feels broken.

/** How long an impact takes to ring out completely. */
export const RING_MS = 620;

const OMEGA = 21; // rad/s — about a 300ms period
const DECAY = 8.5;

/**
 * A damped bounce for impacts: starts at rest, compresses, springs past its
 * own shape, settles.
 *
 * A sine rather than a cosine, which is the whole trick. A cosine starts at
 * full compression, and since a squeezed block loses height off its *top*,
 * that dropped the block and whatever was standing on it in a single frame —
 * the transition a player reads as the level snapping rather than changing.
 *
 * Damping a cosine with a rise ramp instead was the first fix, and it was
 * worse: the ramp's time constant and the cosine's quarter period were within
 * a factor of two of each other, so the ramp ate the first peak (1.0 down to
 * 0.32) while leaving the rebound alone. The bounce came out weaker than the
 * recoil, which is not how anything soft behaves.
 *
 * Normalised so the peak is exactly 1 and callers own the amplitude.
 */
function raw(ms: number): number {
  const t = ms / 1000;
  return Math.sin(OMEGA * t) * Math.exp(-DECAY * t);
}

/** The curve's own peak, so `ring` can be normalised to it. */
const PEAK = (() => {
  let best = 0;
  for (let ms = 0; ms <= RING_MS; ms += 0.5) best = Math.max(best, raw(ms));
  return best;
})();

export function ring(sinceMs: number): number {
  if (sinceMs < 0 || sinceMs > RING_MS) return 0;
  // Windowed to reach exactly zero at RING_MS. Cutting the curve off where it
  // happens to be leaves a step — small here, 0.004, but it is a step onto
  // every block in the run and it never comes back off. The sixth power keeps
  // the window out of the way until the tail, where there is nothing left to
  // protect.
  return (raw(sinceMs) / PEAK) * (1 - (sinceMs / RING_MS) ** 6);
}

/**
 * Impact amplitudes, split because the two deform about different points.
 *
 * The piece squashes about its feet, so its base does not move however hard it
 * is squeezed — it can take the full drama. A block squashes about its base,
 * which moves its top face, which moves the piece standing on it. So the block
 * gets a quarter of the amplitude: enough to see it give, not enough for the
 * ground to lurch under the player.
 */
export const IMPACT_BLOCK = 0.25;
export const IMPACT_FIGURE = 1.0;
/** The block you pushed off, which nothing is standing on. */
export const IMPACT_KICKED = 0.3;

/** Overshooting ease, for things arriving rather than settling. */
export function easeOutBack(t: number): number {
  const c = 1.70158;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Exponential smoothing over elapsed time rather than over frames.
 *
 * `rate` is roughly how many e-foldings a second. Written as a per-frame
 * constant instead, the camera panned 2.4x faster on a 144Hz screen than on a
 * 60Hz one — a different game depending on the monitor it is marked on.
 */
export function smoothing(dtSeconds: number, rate: number): number {
  return 1 - Math.exp(-dtSeconds * rate);
}
