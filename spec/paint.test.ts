import { describe, expect, it } from "vitest";
import { MIN_GAP, PLATFORM_REACH, type Platform } from "../game.ts";
import { paintOrder } from "../render.ts";

// A regression, and the first bug in this repo that was found by playing rather
// than by looking or by measuring.
//
// Landing on a block, the block would paint over the piece's feet for about a
// quarter of a second and then stop. Every check was green, because nothing
// checked the painter's order at all: it compared the piece's *landing point*
// against each block's *centre*, so any landing past the centre line — half of
// them — read as the piece being further away than the block it was standing
// on. The settle slid the piece back to the middle and the fault healed itself,
// which is exactly the shape of thing you see once and then doubt.
//
// So the rule is a function now, and this is the rule: something standing on a
// box is painted after the box, wherever on the box it is standing.

const block = (id: number, x: number, z: number): Platform => ({
  id,
  x,
  z,
  height: 50,
  axis: "x",
});

/** A run down the x axis: three blocks, near to far. */
const from = block(0, 0, 0);
const onto = block(1, MIN_GAP, 0);
const beyond = block(2, MIN_GAP * 2, 0);
const run = [from, onto, beyond];

function order(x: number, z: number, feet: number) {
  const { order: blocks, pieceAt } = paintOrder(run, x, z, feet);
  return { ids: blocks.map((b) => b.id), pieceAt };
}

describe("blocks are painted far to near", () => {
  it("sorts by ground depth, whatever order they arrive in", () => {
    expect(order(0, 0, 0).ids).toEqual([2, 1, 0]);
    expect(paintOrder([beyond, from, onto], 0, 0, 0).order.map((b) => b.id)).toEqual([
      2, 1, 0,
    ]);
  });
});

describe("a piece standing on a block is painted after it", () => {
  // The whole point. Every one of these is the piece standing on `onto`, and
  // `onto` is at index 1, so the piece must come at index 2 or later in all of
  // them — anywhere earlier and the block paints over it.
  const cases: [string, number][] = [
    ["dead centre", 0],
    ["short of centre, still on", -PLATFORM_REACH + 1],
    ["past centre, still on", PLATFORM_REACH - 1],
    ["a hair past centre", 1],
    ["at the very far edge", PLATFORM_REACH],
  ];

  for (const [name, offset] of cases) {
    it(`${name}`, () => {
      const { ids, pieceAt } = order(onto.x + offset, 0, 0);
      expect(ids).toEqual([2, 1, 0]);
      expect(
        pieceAt,
        `the piece is painted at ${pieceAt}, before "onto" at index 1`,
      ).toBeGreaterThan(1);
    });
  }

  it("is still painted after it while squashed into it", () => {
    // The impact bounce presses the piece down with the top face; the feet stay
    // on the plane rather than going through it.
    expect(order(onto.x + 20, 0, 0).pieceAt).toBeGreaterThan(1);
  });

  it("is painted before the block it jumped from, which is nearer the camera", () => {
    // `from` is at index 2. Standing on `onto`, the piece belongs between them.
    expect(order(onto.x, 0, 0).pieceAt).toBe(2);
  });
});

describe("a piece that is not on a block falls back to ground depth", () => {
  it("over the gap, it sits between the two blocks it is between", () => {
    const midway = (from.x + onto.x) / 2;
    const { pieceAt } = order(midway, 0, 40);
    // Behind `onto` (index 1) and in front of `from` (index 2).
    expect(pieceAt).toBe(2);
  });

  it("beyond everything, it is painted first of all", () => {
    expect(order(beyond.x + 200, 0, 60).pieceAt).toBe(0);
  });

  it("in front of everything, it is painted last of all", () => {
    expect(order(from.x - 200, 0, 60).pieceAt).toBe(3);
  });
});

describe("a piece below the tops is not standing on anything", () => {
  it("dropping past the side of a block, the block paints over it", () => {
    // Without the height check, a knocked-off piece whose ground position is
    // still inside a footprint would be drawn in front of the block it is
    // falling behind.
    const high = order(onto.x + 10, 0, 0).pieceAt;
    const low = order(onto.x + 10, 0, -30).pieceAt;
    expect(high).toBeGreaterThan(1);
    expect(low).toBeLessThanOrEqual(1);
  });
});
