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
} from "../game";

// The spec line this file answers: "it can be lost: a wrong move is possible,
// and play ends somewhere". One rule decides that, `resolveLanding`, and it is
// the rule under test here. Everything below it is a supporting check that the
// rule is reachable — a losing rule nobody can trigger, or one nobody can
// survive, is the same bug wearing different clothes.

describe("the losing rule: where you land decides whether the run continues", () => {
  const GAP = 200;

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
      expect(resolveLanding(travelled, GAP).kind).toBe(kind);
    });
  }

  it("names which side you missed on, because the two feel different", () => {
    expect(resolveLanding(GAP - PLATFORM_REACH - 1, GAP)).toEqual({
      kind: "fall",
      reason: "short",
    });
    expect(resolveLanding(GAP + PLATFORM_REACH + 1, GAP)).toEqual({
      kind: "fall",
      reason: "long",
    });
  });

  it("overshooting is fatal, so holding longer is not always better", () => {
    // The whole reason the game is a precision window and not a power meter.
    expect(resolveLanding(MAX_DISTANCE, MIN_GAP).kind).toBe("fall");
  });

  it("scores a landing as perfect only within the centre reach", () => {
    const inside = resolveLanding(GAP + PERFECT_REACH, GAP);
    const outside = resolveLanding(GAP + PERFECT_REACH + 1, GAP);
    expect(inside).toMatchObject({ kind: "land", perfect: true });
    expect(outside).toMatchObject({ kind: "land", perfect: false });
  });

  it("is decided by the offset alone, wherever the gap is", () => {
    for (const gap of [MIN_GAP, 150, 220, MAX_GAP]) {
      expect(resolveLanding(gap, gap)).toMatchObject({ kind: "land", perfect: true });
      expect(resolveLanding(gap + PLATFORM_REACH + 0.5, gap).kind).toBe("fall");
    }
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
