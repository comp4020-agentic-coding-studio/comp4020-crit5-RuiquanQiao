import { describe, expect, it } from "vitest";
import { FIGURE_HEIGHT } from "../mesh.ts";
import { UPRIGHT, isoVector, tumbleUp } from "../iso.ts";
import { COM_LIFT, orientationFor, renderPiece } from "../piece.ts";
import { fitScale } from "../render.ts";
import { type Vertex, clear, downsample, surface, triangle } from "../raster.ts";
import { QID, mulMV, qToMat } from "../vec.ts";

// The piece is rendered by a rasteriser that writes into a plain array, and the
// whole reason it is written that way is so that these can exist. Every one of
// them runs in Node, with no canvas, on exactly the pixels the browser gets.

/** Coverage and extent of a rendered piece, in device pixels. */
function measure(image: { w: number; h: number; rgba: Uint8ClampedArray }) {
  let covered = 0;
  let partial = 0;
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (let y = 0; y < image.h; y++) {
    for (let x = 0; x < image.w; x++) {
      const a = image.rgba[(y * image.w + x) * 4 + 3]!;
      if (a === 0) continue;
      covered++;
      if (a < 250) partial++;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  return { covered, partial, height: bottom - top + 1, width: right - left + 1 };
}

describe("the quaternion pose reproduces the closed-form projection", () => {
  // `tumbleUp` states, in two dimensions and in one line, where the piece's own
  // vertical axis points after somersaulting through `theta`. The mesh gets
  // there by a completely different route: a body-frame pitch, then a yaw, then
  // a quaternion, then a matrix, then the isometric projection. Agreement to
  // twelve places between a hand-derived scalar and a matrix pipeline is worth
  // more than either on its own — and it is the only check that the *order* of
  // the two rotations is right, which is the difference between a somersault
  // and a cartwheel.
  for (const [dx, dz, name] of [
    [1, 0, "axis x"],
    [0, 1, "axis z"],
  ] as const) {
    it(`agrees down ${name}, all the way round`, () => {
      for (let i = 0; i <= 16; i++) {
        const theta = (i / 16) * Math.PI * 2;
        const world = mulMV(qToMat(orientationFor(dx, dz, theta)), [0, 1, 0]);
        const projected = isoVector(world[0], world[1], world[2]);
        const closed = tumbleUp(dx, dz, theta);
        expect(projected.x).toBeCloseTo(closed.x, 12);
        expect(projected.y).toBeCloseTo(closed.y, 12);
      }
    });
  }

  it("stands exactly upright when it is not somersaulting", () => {
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const world = mulMV(qToMat(orientationFor(dx, dz, 0)), [0, 1, 0]);
      const projected = isoVector(world[0], world[1], world[2]);
      expect(projected.x).toBeCloseTo(UPRIGHT.x, 12);
      expect(projected.y).toBeCloseTo(UPRIGHT.y, 12);
    }
  });
});

describe("the rendered piece", () => {
  const SCALE = 2;

  it("is taller on screen than it is in the world, by its own footprint", () => {
    const shot = renderPiece({ q: orientationFor(1, 0, 0) }, SCALE);
    const { height } = measure(shot.image);
    // Not equal to the shape's height, and the difference is the camera rather
    // than a bug. `iso` sends a ground direction to `-(x + z) · ISO_Y` on
    // screen, so the base's own 44-unit width contributes about 13 units of
    // screen height on top of the 83 the piece stands. Asserting equality here
    // would have been asserting that the projection is orthographic from the
    // side, which it is not — it looks down at thirty degrees.
    expect(height).toBeGreaterThan(FIGURE_HEIGHT * SCALE);
    expect(height).toBeLessThan(FIGURE_HEIGHT * SCALE * 1.25);
  });

  it("turns about its centre of mass, not about its feet", () => {
    // Stated as the thing you would see rather than as the arithmetic: a body
    // in free flight turns about its centre of mass, so as the piece goes
    // through a somersault its bulk should stay put and rotate. Pivoted about
    // the feet instead it swings round them like a hand on a clock — which is
    // what the first version did, and what made the tumbling piece drift off
    // its own arc.
    //
    // The alpha-weighted centroid of the silhouette is not the centre of mass,
    // but it tracks it, so the test is that it barely moves.
    const offsets = [0, 0.25, 0.5, 0.75].map((turn) => {
      const shot = renderPiece({ q: orientationFor(1, 0, turn * Math.PI * 2) }, SCALE);
      let mass = 0;
      let cx = 0;
      let cy = 0;
      for (let y = 0; y < shot.image.h; y++) {
        for (let x = 0; x < shot.image.w; x++) {
          const a = shot.image.rgba[(y * shot.image.w + x) * 4 + 3]!;
          if (a === 0) continue;
          mass += a;
          cx += a * (x + shot.ox);
          cy += a * (y + shot.oy);
        }
      }
      return Math.hypot(cx / mass, cy / mass);
    });
    // Pivoting about the feet would put every one of these about
    // `COM_LIFT * SCALE` away — some fifty pixels at this scale.
    expect(Math.max(...offsets), `centroid wandered ${Math.max(...offsets).toFixed(1)}px`)
      .toBeLessThan(COM_LIFT * SCALE * 0.25);
  });

  it("has soft edges, which is what a supersampled silhouette buys", () => {
    const shot = renderPiece({ q: orientationFor(1, 0, 0) }, SCALE);
    const { covered, partial } = measure(shot.image);
    // Every outline on this shape is a diagonal; without the box filter every
    // one of them is a staircase, and at 90px tall that is what reads as
    // "drawn by a program" rather than as an object. A hard-edged render has
    // exactly zero of these; the fraction is small because it is a perimeter
    // against an area.
    expect(partial).toBeGreaterThan(covered * 0.015);
    expect(partial).toBeLessThan(covered * 0.4);
    // And more than the two levels a 2x filter would give if it were only ever
    // half-covering: real coverage takes all five values.
    const levels = new Set<number>();
    for (let i = 3; i < shot.image.rgba.length; i += 4) levels.add(shot.image.rgba[i]!);
    expect(levels.size).toBeGreaterThan(3);
  });

  it("faces visibly the other way down the other axis", () => {
    // The user-visible claim, asserted on the pixels: down one axis and down
    // the other are different pictures, and specifically they are each other's
    // mirror image about the piece's own axis. A pawn would score 1.0 on both
    // comparisons, because a body of revolution has no heading to show.
    //
    // Two earlier attempts at this measured nothing. Sharing the covered pixels
    // left and right of the *image's* midpoint reported 0.009 either side of
    // even — a ruler that slides with the thing it measures. Sharing them about
    // the piece's own axis reported the same, because the base is a symmetric
    // lathe and outweighs the head that does the leaning. Overlap of the whole
    // silhouette is what actually looks at the shape.
    const covered = (dx: number, dz: number) => {
      const shot = renderPiece({ q: orientationFor(dx, dz, 0) }, SCALE);
      const set = new Set<string>();
      for (let y = 0; y < shot.image.h; y++) {
        for (let x = 0; x < shot.image.w; x++) {
          if (shot.image.rgba[(y * shot.image.w + x) * 4 + 3]! < 128) continue;
          set.add(`${Math.round(x + shot.ox)},${Math.round(y + shot.oy)}`);
        }
      }
      return set;
    };
    const overlap = (a: Set<string>, b: Set<string>) => {
      let both = 0;
      for (const key of a) if (b.has(key)) both++;
      return both / (a.size + b.size - both);
    };
    const mirror = (a: Set<string>) =>
      new Set([...a].map((key) => {
        const [x, y] = key.split(",");
        return `${-Number(x)},${y}`;
      }));

    const down = covered(1, 0);
    const across = covered(0, 1);
    expect(overlap(down, across), "the two headings render the same picture")
      .toBeLessThan(0.82);
    expect(overlap(down, mirror(across)), "the two headings are not mirror images")
      .toBeGreaterThan(0.93);
  });

  it("does not deform, whatever the game is doing", () => {
    // It used to. Charging squashed the piece along with the block it stood on
    // and the flight stretched it, which is cartoon logic applied to a carved
    // chess knight, and it read as rubber. A pose is now an orientation and
    // nothing else — there is no way to ask for a deformed piece, and the same
    // orientation always gives the same silhouette.
    const a = measure(renderPiece({ q: QID }, SCALE).image);
    const b = measure(renderPiece({ q: QID }, SCALE).image);
    expect(a).toEqual(b);
    // A rigid body's silhouette is the same size whichever way up it is, once
    // you allow for the camera looking down at it from thirty degrees.
    const turned = measure(renderPiece({ q: orientationFor(1, 0, Math.PI) }, SCALE).image);
    expect(turned.covered).toBeGreaterThan(a.covered * 0.75);
    expect(turned.covered).toBeLessThan(a.covered * 1.35);
  });

  it("renders at the scale each marking viewport actually asks for", () => {
    // `drawFigure` bails before rasterising when there is no canvas to hand the
    // result to, which is every jsdom run — so the boot test no longer exercises
    // the renderer end to end, and this is what replaces that. The scales are
    // the ones `main.ts` computes: the fitted scale times the device pixel
    // ratio, at both sizes the work is marked at.
    for (const [name, width, height, dpr] of [
      ["desktop 1920x1080 @1x", 1920, 1080, 1],
      ["desktop 1920x1080 @2x", 1920, 1080, 2],
      ["phone 390x844 @3x", 390, 844, 3],
    ] as const) {
      const shot = renderPiece({ q: orientationFor(1, 0, 0) }, fitScale(width, height) * dpr);
      const { covered, height: tall } = measure(shot.image);
      expect(covered, `${name} rendered nothing`).toBeGreaterThan(500);
      // Below about 40 device pixels the piece stops resolving and reads as a
      // pin, which is the same floor `spec/viewports.test.ts` holds.
      expect(tall, `${name} rendered ${tall}px tall`).toBeGreaterThan(40);
    }
  });

  it("draws nothing rather than allocating forever for an impossible pose", () => {
    // A zero-length jump divided elapsed time by a flight time of zero and
    // posed the piece at NaN. The flat painter swallowed it; this tried to size
    // a buffer to an infinite bounding box and took the frame loop with it.
    // Fixed at the source, and refused here as well.
    const shot = renderPiece({ q: [Number.NaN, 0, 0, 0] }, SCALE);
    expect(shot.image.w).toBe(0);
    expect(shot.image.h).toBe(0);
  });
});

describe("the rasteriser", () => {
  const near: Vertex[] = [
    { x: 1, y: 1, d: 1, r: 255, g: 0, b: 0 },
    { x: 9, y: 1, d: 1, r: 255, g: 0, b: 0 },
    { x: 5, y: 9, d: 1, r: 255, g: 0, b: 0 },
  ];
  const far: Vertex[] = near.map((v) => ({ ...v, d: 9, r: 0, b: 255 }));

  function draw(order: Vertex[][]): [number, number, number] {
    const s = surface(10, 10);
    clear(s);
    for (const [a, b, c] of order) triangle(s, a!, b!, c!);
    const o = (5 * 10 + 5) * 4;
    return [s.rgba[o]!, s.rgba[o + 1]!, s.rgba[o + 2]!];
  }

  it("resolves depth per pixel, whichever order the triangles arrive in", () => {
    // Per pixel, not per triangle. The knight's muzzle passes in front of its
    // own throat and its ear in front of its own mane; sorting whole triangles
    // by centroid gets both wrong from some angles and right from others, which
    // reads as the piece flickering inside out as it tumbles.
    expect(draw([near, far])).toEqual([255, 0, 0]);
    expect(draw([far, near])).toEqual([255, 0, 0]);
  });

  it("culls back faces", () => {
    const reversed = [near[0]!, near[2]!, near[1]!];
    const s = surface(10, 10);
    clear(s);
    triangle(s, reversed[0]!, reversed[1]!, reversed[2]!);
    expect(s.rgba[(5 * 10 + 5) * 4 + 3]).toBe(0);
  });

  it("averages coverage without dragging the empty pixels into the colour", () => {
    // Averaging over all samples instead of the covered ones mixes transparent
    // black into every edge and leaves a dark fringe round the whole piece.
    const s = surface(2, 2);
    clear(s);
    s.rgba.set([200, 100, 50, 255], 0);
    const out = downsample(s, 2);
    expect([out.rgba[0], out.rgba[1], out.rgba[2]]).toEqual([200, 100, 50]);
    expect(out.rgba[3]).toBe(Math.round(255 / 4));
  });
});
