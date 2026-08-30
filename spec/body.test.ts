import { describe, expect, it } from "vitest";
import {
  PLATFORM_REACH,
  chargeToDistance,
  firstPlatform,
  gapBetween,
  nextPlatform,
  resolveLanding,
  rng,
} from "../game.ts";
import { GRAVITY, flightSeconds, impactSpeed } from "../motion.ts";
import {
  SUBSTEP,
  type Sim,
  type Slab,
  advance,
  comHeight,
  energy,
  launch,
  penetration,
} from "../physics.ts";
import { length, mulMV, qToMat } from "../vec.ts";

// The fall used to be a parabola with a spin bolted on: constant sideways
// drift, constant rotation, and the block it had just failed to land on ignored
// entirely, so the piece passed straight through it. It read as an animation of
// losing rather than as losing.
//
// It is a solver now, and a solver is exactly the kind of code that is
// plausible on screen and wrong underneath. So these assert what a picture
// cannot show: that energy only ever leaves, that the answer does not depend on
// the monitor it is drawn on, and that the picture never contradicts
// `resolveLanding` — which is still the only thing in this repo that decides
// whether a run continues.

/** A miss down the x axis, landing at `range`, over a block `gap` away. */
function miss(range: number, gap: number, height = 55): { sim: Sim; slabs: Slab[] } {
  return {
    slabs: [
      { x: 0, z: 0, height },
      { x: gap, z: 0, height },
    ],
    sim: launch({ x: range, z: 0, dx: 1, dz: 0, range, seconds: flightSeconds(range) }),
  };
}

function run(range: number, gap: number, seconds: number, step = 1 / 60): Sim {
  const { sim, slabs } = miss(range, gap);
  let state = sim;
  for (let i = 0; i < Math.round(seconds / step); i++) {
    state = advance(state, slabs, step);
  }
  return state;
}

describe("free flight is the same physics the arc is", () => {
  it("accelerates downward at exactly g, with no block anywhere near", () => {
    let sim = launch({ x: 0, z: 0, dx: 1, dz: 0, range: 200, seconds: flightSeconds(200) });
    const heights: number[] = [];
    for (let i = 0; i < 12; i++) {
      heights.push(sim.body.p[1]);
      sim = advance(sim, [], SUBSTEP);
    }
    for (let i = 1; i + 1 < heights.length; i++) {
      const accel = (heights[i + 1]! - 2 * heights[i]! + heights[i - 1]!) / SUBSTEP ** 2;
      expect(accel).toBeCloseTo(-GRAVITY, 0);
    }
  });

  it("keeps turning about the axis it was turning about", () => {
    // Torque-free, and the somersault is about the piece's own sideways axis,
    // which is a principal axis of a shape symmetric across its forward/up
    // plane. So the angular velocity really is constant, and the solver is
    // entitled to leave the gyroscopic term out. If the shape ever stops being
    // symmetric, this is what says so.
    let sim = launch({ x: 0, z: 0, dx: 0, dz: 1, range: 200, seconds: flightSeconds(200) });
    const first = sim.body.w;
    for (let i = 0; i < 60; i++) sim = advance(sim, [], SUBSTEP);
    for (let k = 0; k < 3; k++) expect(sim.body.w[k]!).toBeCloseTo(first[k]!, 6);
  });

  it("leaves the arc at the arc's own last instant", () => {
    // The handover, asserted rather than claimed in a comment. The moment these
    // stop matching, the piece jumps on the frame it starts falling — which is
    // exactly the discontinuity the whole of `motion.ts` exists to avoid.
    const range = 230;
    const seconds = flightSeconds(range);
    const sim = launch({ x: range, z: 0, dx: 1, dz: 0, range, seconds });
    expect(sim.body.v[0]).toBeCloseTo(range / seconds, 9);
    expect(sim.body.v[1]).toBeCloseTo(impactSpeed(range), 9);
    expect(sim.body.p[1]).toBeCloseTo(comHeight(), 9);
    // Upright: a full somersault ends where it began.
    expect(mulMV(qToMat(sim.body.q), [0, 1, 0])[1]).toBeCloseTo(1, 9);
  });
});

describe("the solver does not depend on the machine it runs on", () => {
  it("gives the same trajectory at 30, 60 and 144 frames a second", () => {
    // The lesson `smoothing` had to learn, somewhere it matters far more. As a
    // per-frame step, a rim that clips a block's edge at 144Hz is already past
    // it by the first sample at 30Hz and falls straight through — the same hold
    // on the same seed ending differently depending on the monitor it is marked
    // on. The fixed substep is what stops that; this is what checks it.
    const ends = [1 / 30, 1 / 60, 1 / 144].map((step) => run(200, 250, 1.2, step).body.p);
    for (let k = 0; k < 3; k++) {
      expect(ends[1]![k]!).toBeCloseTo(ends[0]![k]!, 3);
      expect(ends[2]![k]!).toBeCloseTo(ends[0]![k]!, 3);
    }
  });

  it("is deterministic", () => {
    expect(run(200, 250, 1).body.p).toEqual(run(200, 250, 1).body.p);
    expect(run(200, 250, 1).body.q).toEqual(run(200, 250, 1).body.q);
  });

  it("cannot be made to lurch by a stall", () => {
    // A tab that was in the background for a minute must not pay it all back in
    // one frame. The catch-up is capped, so the piece resumes rather than
    // teleporting through whatever it was about to land on.
    const stalled = run(200, 250, 60, 60);
    expect(Number.isFinite(stalled.body.p[1])).toBe(true);
    expect(stalled.carry).toBeLessThan(SUBSTEP);
  });
});

describe("a collision only ever takes energy out", () => {
  it("never leaves the piece with more than it arrived with", () => {
    for (const [range, gap] of [
      [200, 250],
      [244, 289],
      [300, 260],
      [120, 96],
    ] as const) {
      const { sim, slabs } = miss(range, gap);
      let state = sim;
      const before = energy(state.body);
      let worst = -Infinity;
      for (let i = 0; i < 90; i++) {
        state = advance(state, slabs, 1 / 60);
        worst = Math.max(worst, energy(state.body));
      }
      // A little slack for the positional correction, which pushes a
      // penetrating point back out and adds a small amount of height with it.
      expect(worst, `range ${range} gap ${gap} gained energy`).toBeLessThan(before * 1.02);
    }
  });

  it("does not let a contact point sink far into a block", () => {
    // Penetration, not height. A piece tipping over an edge is legitimately
    // well below the top face — over the gap, with nothing under it. The first
    // version of this measured height and reported seventeen units of sinking
    // for a piece that was in mid-air.
    for (const [range, gap] of [
      [244, 289],
      [200, 250],
      [285, 250],
    ] as const) {
      const { sim, slabs } = miss(range, gap);
      let state = sim;
      let deepest = 0;
      for (let i = 0; i < 60; i++) {
        state = advance(state, slabs, 1 / 60);
        deepest = Math.max(deepest, penetration(state.body, slabs));
      }
      // At 240 substeps a second and 640 units a second of downward speed, a
      // point travels 2.7 units between samples, so a couple of units of
      // overlap is the discretisation and anything much more is the solver
      // failing to push back.
      expect(deepest, `range ${range} sank ${deepest.toFixed(1)} units in`).toBeLessThan(6);
    }
  });
});

describe("the picture never contradicts the rule", () => {
  // The invariant that matters, and the one that took three goes to state.
  //
  // `resolveLanding` treats a landing as a *point*: within `PLATFORM_REACH` of
  // the centre you are on, past it you are off. The piece is a solid with a
  // base that has a radius, so a jump the rule scores as a miss can still have
  // rim over the block — and at the drawn radius of 22 units it did. A miss put
  // its toe on the edge, skated forward on its own momentum, and came to rest
  // standing on the block it had just failed to reach. The game said you lost
  // and the picture said you had not.
  const SEEDS = [1, 7, 20260831, 424242, 99991];

  it("puts every missed jump below the blocks, on every seed", () => {
    let checked = 0;
    let worst = -Infinity;
    let worstCase = "";

    for (const seed of SEEDS) {
      const random = rng(seed);
      const current = firstPlatform(random);
      const next = nextPlatform(current, random);
      const gap = gapBetween(current, next);
      const slabs: Slab[] = [current, next].map((b) => ({
        x: b.x,
        z: b.z,
        height: b.height,
      }));
      const dx = current.axis === "x" ? 1 : 0;
      const dz = current.axis === "z" ? 1 : 0;

      for (let held = 100; held <= 1250; held += 25) {
        const range = chargeToDistance(held);
        if (resolveLanding(range, gap).kind !== "fall") continue;
        checked++;
        let sim = launch({
          x: current.x + dx * range,
          z: current.z + dz * range,
          dx,
          dz,
          range,
          seconds: flightSeconds(range),
        });
        // Two and a fifth seconds — comfortably past the 1300ms at which the
        // game gives up on a fall and shows the score.
        for (let i = 0; i < 132; i++) sim = advance(sim, slabs, 1 / 60);
        if (sim.body.p[1] > worst) {
          worst = sim.body.p[1];
          worstCase = `seed ${seed}, held ${held}ms, offset ${(range - gap).toFixed(0)}`;
        }
      }
    }

    expect(checked).toBeGreaterThan(150);
    // Standing on a block puts the centre of mass at +26 and lying on one puts
    // it at about +10. Below zero it is not on top of anything.
    expect(worst, `worst: ${worstCase} finished at y ${worst.toFixed(0)}`).toBeLessThan(0);
  });

  it("catches the edge when the landing was close, and not when it was wild", () => {
    // The other half of the same trade. The contact radius has to be small
    // enough not to overturn the rule and large enough that a near miss still
    // visibly clips something — that clip is the whole drama of losing by a
    // hair, and it is also what the scuff sound is now triggered by.
    const gap = 250;
    const near = miss(gap + PLATFORM_REACH + 4, gap);
    const wild = miss(gap + PLATFORM_REACH + 60, gap);
    let a = near.sim;
    let b = wild.sim;
    for (let i = 0; i < 24; i++) {
      a = advance(a, near.slabs, 1 / 60);
      b = advance(b, wild.slabs, 1 / 60);
    }
    expect(a.contacts, "a landing four units past the edge touched nothing").toBeGreaterThan(0);
    expect(b.contacts, "a landing sixty units past the edge hit something").toBe(0);
  });

  it("finishes on its side or on its way down, never still standing", () => {
    const { sim, slabs } = miss(244, 289);
    let state = sim;
    for (let i = 0; i < 132; i++) state = advance(state, slabs, 1 / 60);
    const upright = mulMV(qToMat(state.body.q), [0, 1, 0])[1];
    const still = length(state.body.v) < 30;
    expect(still && upright! > 0.8 && state.body.p[1] > 0).toBe(false);
  });
});
