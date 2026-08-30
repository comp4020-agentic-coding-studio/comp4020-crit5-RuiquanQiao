// Every miss the rule can produce, simulated, and where the piece ends up.
//
//   node scripts/sweep-falls.ts
//
// The rule and the solid do not automatically agree: `resolveLanding` treats a
// landing as a point and the piece has a base with a radius, so a jump scored
// as a miss can still have rim over the block. This walks the whole range of
// offsets on both sides of both edges, for several generated gaps, and reports
// any miss that does not end up below the play plane. `spec/physics.test.ts`
// asserts the same property; this prints the map, which is what tuning needs.

import { chargeToDistance, firstPlatform, gapBetween, nextPlatform, resolveLanding, rng } from "../game.ts";
import { flightSeconds } from "../motion.ts";
import { type Slab, advance, launch } from "../physics.ts";
import { mulMV, qToMat } from "../vec.ts";

export function simulateMiss(seed: number, travelled: number, seconds = 2.2) {
  const random = rng(seed);
  const current = firstPlatform(random);
  const next = nextPlatform(current, random);
  const gap = gapBetween(current, next);
  const landing = resolveLanding(0, travelled, gap);
  if (landing.kind !== "fall") return null;

  let sim = launch({
    x: current.x + (current.axis === "x" ? travelled : 0),
    z: current.z + (current.axis === "z" ? travelled : 0),
    dx: current.axis === "x" ? 1 : 0,
    dz: current.axis === "z" ? 1 : 0,
    range: travelled,
    seconds: flightSeconds(travelled),
  });
  const slabs: Slab[] = [current, next].map((b) => ({ x: b.x, z: b.z, height: b.height }));
  let lowest = Infinity;
  for (let f = 0; f < Math.round(seconds * 60); f++) {
    sim = advance(sim, slabs, 1 / 60);
    lowest = Math.min(lowest, sim.body.p[1]);
  }
  // How upright it finished. 1 is standing, 0 is on its side, -1 is upside down.
  const upright = mulMV(qToMat(sim.body.q), [0, 1, 0])[1];
  return { gap, offset: travelled - gap, reason: landing.reason, y: sim.body.p[1], lowest, upright, contacts: sim.contacts };
}

if (import.meta.filename === process.argv[1]) {
  let worst = -Infinity;
  let stuck = 0;
  for (const seed of [1, 7, 20260831, 424242, 99991]) {
    const row: string[] = [];
    for (let travelled = 32; travelled <= 340; travelled += 4) {
      const out = simulateMiss(seed, travelled);
      if (!out) continue;
      // A miss has to leave. Anything at or above the play plane after two
      // seconds is a piece that came to rest on a block the rule said it missed.
      // The invariant, stated the way a player would read it: a jump the rule
      // scored as a miss must not finish with the piece *on top of* anything.
      // Its centre of mass ends below the plane the blocks' top faces lie in.
      // Standing on a block puts it at +26; lying on one puts it at about +10;
      // scraping down the side of one, which some near misses genuinely do,
      // puts it below zero and keeps it going.
      if (out.y > -5) {
        stuck++;
        console.log(
          `ON TOP seed ${seed} travelled ${travelled} gap ${out.gap.toFixed(0)} offset ${out.offset.toFixed(0)} (${out.reason}) y ${out.y.toFixed(0)} up.y ${out.upright.toFixed(2)}`,
        );
      } else if (out.y > -120) {
        console.log(
          `  caught: seed ${seed} offset ${out.offset.toFixed(0)} (${out.reason}) y ${out.y.toFixed(0)} up.y ${out.upright.toFixed(2)}`,
        );
      }
      worst = Math.max(worst, out.y);
      row.push(out.y.toFixed(0));
    }
    console.log(`seed ${seed}: ${row.length} misses, final y ${row.slice(0, 12).join(" ")} ...`);
  }
  console.log(`\nhighest finish ${worst.toFixed(0)} (must be below 0);  finished on top of a block: ${stuck}`);
}
