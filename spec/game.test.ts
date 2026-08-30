import { describe, expect, it } from "vitest";
import {
  CHARGE_SPEED,
  MAX_CHARGE_MS,
  MAX_DISTANCE,
  MAX_GAP,
  MIN_GAP,
  PERFECT_REACH,
  PLATFORM_REACH,
  blockUnder,
  chargeToDistance,
  firstPlatform,
  gapBetween,
  nextPlatform,
  resolveLanding,
  rng,
  scoreFor,
} from "../game.ts";

// The spec line this file answers: "it can be lost: a wrong move is possible,
// and play ends somewhere". One rule decides that, `resolveLanding`, and it is
// the rule under test here. Everything below it is a supporting check that the
// rule is reachable — a losing rule nobody can trigger, or one nobody can
// survive, is the same bug wearing different clothes.

describe("the losing rule: where you land decides whether the run continues", () => {
  const GAP = 200;
  /** From the centre of the block, which is where a run starts. */
  const centred = (travelled: number) => resolveLanding(0, travelled, GAP);

  // travelled → what should happen, with the reasoning in the name.
  const cases: [string, number, string][] = [
    ["a hold too short to leave the block keeps you on it", 0, "stay"],
    ["still on it at the very edge of the top face", PLATFORM_REACH, "stay"],
    ["cleared your own block but not the gap: you fall", PLATFORM_REACH + 1, "fall"],
    ["short of the far edge by a hair: you fall", GAP - PLATFORM_REACH - 1, "fall"],
    ["exactly the near edge of the target: you land", GAP - PLATFORM_REACH, "land"],
    ["dead centre: you land", GAP, "land"],
    ["exactly the far edge of the target: you land", GAP + PLATFORM_REACH, "land"],
    ["a hair past the far edge: you fall", GAP + PLATFORM_REACH + 1, "fall"],
  ];

  for (const [why, travelled, kind] of cases) {
    it(why, () => {
      expect(centred(travelled).kind).toBe(kind);
    });
  }

  it("names which side you missed on, because the two feel different", () => {
    expect(centred(GAP - PLATFORM_REACH - 1)).toEqual({ kind: "fall", reason: "short" });
    expect(centred(GAP + PLATFORM_REACH + 1)).toEqual({ kind: "fall", reason: "long" });
  });

  it("overshooting is fatal, so holding longer is not always better", () => {
    // The whole reason the game is a precision window and not a power meter.
    expect(resolveLanding(0, MAX_DISTANCE, MIN_GAP).kind).toBe("fall");
  });

  it("scores a landing as perfect only within the centre reach", () => {
    expect(centred(GAP + PERFECT_REACH)).toMatchObject({ kind: "land", perfect: true });
    expect(centred(GAP + PERFECT_REACH + 1)).toMatchObject({
      kind: "land",
      perfect: false,
    });
  });

  it("is decided by the offset alone, wherever the gap is", () => {
    for (const gap of [MIN_GAP, 150, 220, MAX_GAP]) {
      expect(resolveLanding(0, gap, gap)).toMatchObject({ kind: "land", perfect: true });
      expect(resolveLanding(0, gap + PLATFORM_REACH + 0.5, gap).kind).toBe("fall");
    }
  });
});

describe("the jump starts where the piece is standing, not from the centre", () => {
  // A landing leaves the piece where it landed. The run used to slide it back
  // to the middle of the block over the settle, which quietly handed back
  // whatever the player had got wrong and read as the game correcting for them.
  // So the rule takes the standing offset, and the same charge now means
  // different things depending on where you are.
  const GAP = 200;

  it("the same hold lands differently from different parts of the block", () => {
    // Standing 20 units back, a hold that would have been dead centre now falls
    // 20 short; standing 20 forward, it overshoots by 20.
    expect(resolveLanding(-20, GAP, GAP)).toMatchObject({ kind: "land", offset: -20 });
    expect(resolveLanding(20, GAP, GAP)).toMatchObject({ kind: "land", offset: 20 });
    expect(resolveLanding(0, GAP, GAP)).toMatchObject({ kind: "land", offset: 0 });
  });

  it("a jump from the back of the block can fall short where a centred one lands", () => {
    const travelled = GAP - PLATFORM_REACH + 1;
    expect(resolveLanding(0, travelled, GAP).kind).toBe("land");
    expect(resolveLanding(-PLATFORM_REACH, travelled, GAP)).toEqual({
      kind: "fall",
      reason: "short",
    });
  });

  it("staying means still being on the block, not having barely moved", () => {
    // Standing at the back edge, a jump of nearly a whole block width is still
    // a stay — it ends up at the front edge. Standing at the front edge, the
    // same jump leaves the block entirely.
    expect(resolveLanding(-PLATFORM_REACH, PLATFORM_REACH * 2, GAP).kind).toBe("stay");
    expect(resolveLanding(PLATFORM_REACH, 1, GAP).kind).toBe("fall");
  });

  it("leaves a landable hold from anywhere on the block, for every gap", () => {
    // The bound that matters once the piece stops being re-centred: a run must
    // never become unwinnable through no fault of the player. From the very
    // back of the block the target is furthest away, and the reachable window
    // has to still overlap what a full charge can buy.
    for (const gap of [MIN_GAP, 150, 220, MAX_GAP]) {
      for (const from of [-PLATFORM_REACH, -10, 0, 10, PLATFORM_REACH]) {
        // The hold has to put the piece somewhere on the target's top face.
        const shortest = gap - PLATFORM_REACH - from;
        const longest = gap + PLATFORM_REACH - from;
        expect(shortest, `gap ${gap} from ${from}: nothing reaches`).toBeLessThanOrEqual(
          MAX_DISTANCE,
        );
        expect(longest, `gap ${gap} from ${from}: stepping off arrives`).toBeGreaterThan(
          PLATFORM_REACH - from,
        );
        // And the middle of that window really does land.
        const landed = resolveLanding(from, (shortest + longest) / 2, gap);
        expect(landed.kind).toBe("land");
      }
    }
  });

  it("and no position lets you reach the next block without a real jump", () => {
    // The other bound: standing at the very front edge of the block, the near
    // edge of the closest gap the generator can produce is still further than
    // simply stepping off.
    const shortest = MIN_GAP - PLATFORM_REACH - PLATFORM_REACH;
    expect(shortest).toBeGreaterThan(PLATFORM_REACH);
    expect(resolveLanding(PLATFORM_REACH, PLATFORM_REACH, MIN_GAP).kind).toBe("fall");
  });
});

describe("every gap the generator can produce is winnable and losable", () => {
  // If a platform could spawn closer than the block you are standing on is
  // wide, a tap would clear it and the losing rule would never fire; if one
  // could spawn beyond full charge, no hold would clear it. Both are silent —
  // the game would just feel wrong — so they are asserted rather than eyeballed.
  it("never spawns a gap a full-charge hold cannot reach", () => {
    expect(MAX_GAP + PLATFORM_REACH).toBeLessThanOrEqual(MAX_DISTANCE);
  });

  it("never spawns a gap so close that leaving the block clears it", () => {
    expect(MIN_GAP - PLATFORM_REACH).toBeGreaterThan(PLATFORM_REACH);
  });

  it("holds those bounds across a long generated run", () => {
    const random = rng(20260831);
    let platform = firstPlatform(random);
    for (let i = 0; i < 500; i++) {
      const next = nextPlatform(platform, random);
      const gap = gapBetween(platform, next);
      expect(gap).toBeGreaterThanOrEqual(MIN_GAP);
      expect(gap).toBeLessThanOrEqual(MAX_GAP);
      platform = next;
    }
  });

  it("replays a run exactly from the same seed", () => {
    const run = (seed: number) => {
      const random = rng(seed);
      let platform = firstPlatform(random);
      const gaps: number[] = [];
      for (let i = 0; i < 20; i++) {
        const next = nextPlatform(platform, random);
        gaps.push(gapBetween(platform, next));
        platform = next;
      }
      return gaps;
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });
});

describe("holding longer goes further, up to the point where it stops", () => {
  it("goes nowhere on no hold", () => {
    expect(chargeToDistance(0)).toBe(0);
    expect(chargeToDistance(-10)).toBe(0);
  });

  it("is monotonic while the charge is filling", () => {
    let previous = -1;
    for (let ms = 0; ms <= MAX_CHARGE_MS; ms += 25) {
      const distance = chargeToDistance(ms);
      expect(distance).toBeGreaterThan(previous);
      previous = distance;
    }
  });

  it("stops growing at full charge, so a stuck finger cannot cheat", () => {
    expect(chargeToDistance(MAX_CHARGE_MS)).toBeCloseTo(MAX_DISTANCE);
    expect(chargeToDistance(MAX_CHARGE_MS * 10)).toBeCloseTo(MAX_DISTANCE);
  });

  it("converts at the advertised rate", () => {
    expect(chargeToDistance(500)).toBeCloseTo(500 * CHARGE_SPEED);
  });
});

describe("scoring rewards aim, not survival", () => {
  it("pays one for clearing the gap", () => {
    expect(scoreFor(false, 0)).toBe(1);
    expect(scoreFor(false, 5)).toBe(1);
  });

  it("pays more for each consecutive centre hit", () => {
    expect([0, 1, 2, 3, 4].map((streak) => scoreFor(true, streak))).toEqual([
      2, 4, 6, 8, 10,
    ]);
  });

  it("makes a streak worth more than the landings it replaces", () => {
    const perfectRun = [0, 1, 2].reduce((sum, s) => sum + scoreFor(true, s), 0);
    const plainRun = 3 * scoreFor(false, 0);
    expect(perfectRun).toBeGreaterThan(plainRun);
  });
});

describe("the shadow has something to fall on, or it has nothing", () => {
  // Not decoration. The shadow leaving the near block, crossing nothing, and
  // arriving on the far one is the only thing that tells a player how a jump
  // is going while it is in the air — and it does it without a word.
  const random = rng(4020);
  const a = firstPlatform(random);
  const b = nextPlatform(a, random);
  const blocks = [a, b];

  it("finds the block you are standing on", () => {
    expect(blockUnder(blocks, a.x, a.z)).toBe(a);
    expect(blockUnder(blocks, b.x, b.z)).toBe(b);
  });

  it("holds right out to the edge of a top face and no further", () => {
    const axis = a.axis;
    const at = (d: number) =>
      blockUnder(blocks, axis === "x" ? a.x + d : a.x, axis === "z" ? a.z + d : a.z);
    expect(at(PLATFORM_REACH)).toBe(a);
    expect(at(PLATFORM_REACH + 0.01)).toBeUndefined();
  });

  it("finds nothing over the gap", () => {
    const gap = gapBetween(a, b);
    const axis = a.axis;
    for (const frac of [0.35, 0.5, 0.65]) {
      const d = gap * frac;
      const found = blockUnder(
        blocks,
        axis === "x" ? a.x + d : a.x,
        axis === "z" ? a.z + d : a.z,
      );
      expect(found, `something was under the piece ${frac} of the way across`).toBeUndefined();
    }
  });
});
