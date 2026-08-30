import { describe, expect, it } from "vitest";
import { MIN_GAP, PLATFORM_REACH, type Platform } from "../game.ts";
import { COM_LIFT, paintOrder } from "../render.ts";

// Two regressions, both found by playing and neither visible to anything else
// in this repo.
//
// The first: landing on a block, the block painted over the piece's feet for
// about a quarter of a second and then stopped. The order compared the piece's
// landing *point* against each block's *centre*, both as points on the ground,
// so any landing past the centre line read as further away than the block it
// was standing on. The settle slid the piece back to the middle and the fault
// healed itself.
//
// The second: rolling forward off a block after a bad landing, the block
// flickered in front of the piece. The height fed in was the lowest point of
// the whole piece — and a knight leaning over an edge has its muzzle 26 units
// in front of its own axis and hanging in mid-air, so that number crossed zero
// while the piece was still squarely on the block, several times, one frame
// apart.
//
// So the rule is a function, the height it takes is the centre of mass, and the
// rule itself is the standard separating-axis test rather than a depth
// comparison with exceptions bolted on.

const block = (id: number, x: number, z: number): Platform => ({
  id,
  x,
  z,
  height: 50,
  axis: "x",
});

/** A run down the x axis: `from` nearest the camera, `beyond` furthest. */
const from = block(0, 0, 0);
const onto = block(1, MIN_GAP, 0);
const beyond = block(2, MIN_GAP * 2, 0);
const run = [from, onto, beyond];

/** Sorted far to near, so `beyond` is 0, `onto` is 1 and `from` is 2. */
function order(x: number, z: number, y: number) {
  const { order: blocks, pieceAt } = paintOrder(run, x, z, y);
  return { ids: blocks.map((b) => b.id), pieceAt };
}

/** Height of the centre of mass of a piece standing on a block. */
const STANDING = COM_LIFT;

describe("blocks are painted far to near", () => {
  it("sorts by ground depth, whatever order they arrive in", () => {
    expect(order(0, 0, STANDING).ids).toEqual([2, 1, 0]);
    expect(paintOrder([beyond, from, onto], 0, 0, STANDING).order.map((b) => b.id)).toEqual(
      [2, 1, 0],
    );
  });
});

describe("a piece standing on a block is painted after it", () => {
  // The first regression. `onto` is at index 1, so anything less than 2 means
  // the block is painted over the piece standing on it.
  const across: [string, number][] = [
    ["dead centre", 0],
    ["short of centre, still on", -PLATFORM_REACH + 1],
    ["past centre, still on", PLATFORM_REACH - 1],
    ["a hair past centre", 1],
    ["at the very back edge", -PLATFORM_REACH],
    ["at the very far edge", PLATFORM_REACH],
  ];

  for (const [name, offset] of across) {
    it(name, () => {
      const { ids, pieceAt } = order(onto.x + offset, 0, STANDING);
      expect(ids).toEqual([2, 1, 0]);
      expect(pieceAt, `painted at ${pieceAt}, before "onto" at index 1`).toBeGreaterThan(1);
    });
  }

  it("goes down with the block under it and is still painted after it", () => {
    // A charged block loses height off its top and the piece rides it down, so
    // the centre of mass dips. It must not dip through the threshold.
    expect(order(onto.x + 20, 0, STANDING - 12).pieceAt).toBeGreaterThan(1);
  });
});

describe("a piece off the top face is ordered by which side of the block it is on", () => {
  it("dropping past the side of a block, the block paints over it", () => {
    expect(order(onto.x + 10, 0, -30).pieceAt).toBeLessThanOrEqual(1);
  });

  it("falling in the gap, it sits between the two blocks it is between", () => {
    const midway = (from.x + onto.x) / 2;
    // Behind `onto` (index 1) and in front of `from` (index 2).
    expect(order(midway, 0, -40).pieceAt).toBe(2);
  });

  it("nearer than everything, it is painted last of all", () => {
    expect(order(from.x - 200, 0, -60).pieceAt).toBe(3);
  });

  it("further than everything, it is painted first of all", () => {
    expect(order(beyond.x + 200, 0, -60).pieceAt).toBe(0);
  });
});

describe("the order changes once on the way off a block, and only once", () => {
  it("does not flicker as the piece rolls over an edge", () => {
    // The second regression, stated as the thing that was wrong: the answer
    // flipped back and forth frame to frame while the piece was going over.
    // Whatever the answer is at each height, it must change at most once as the
    // piece descends — a monotone signal, not a chattering one.
    let changes = 0;
    let previous = order(onto.x + 20, 0, 40).pieceAt;
    for (let y = 40; y >= -60; y -= 0.5) {
      const now = order(onto.x + 20, 0, y).pieceAt;
      if (now !== previous) changes++;
      previous = now;
    }
    expect(changes, `the painter's order changed ${changes} times`).toBe(1);
  });

  it("changes at the block's top face, not somewhere either side of it", () => {
    expect(order(onto.x + 20, 0, 0.5).pieceAt).toBeGreaterThan(1);
    expect(order(onto.x + 20, 0, -0.5).pieceAt).toBeLessThanOrEqual(1);
  });
});
