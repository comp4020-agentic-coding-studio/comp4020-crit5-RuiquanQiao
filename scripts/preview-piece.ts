// Render the piece, in Node, to `.frames/piece-<name>.png`.
//
//   node scripts/preview-piece.ts
//
// The only way to judge a shape is to look at it, and the browser was the worst
// available place to do that: the preview pane renders at its own physical size
// rather than the emulated viewport, and a pane that is not on screen stops
// compositing, so a screenshot of a running game is one throttled frame at an
// unknown scale. This drives the same `renderPiece` the browser calls, at an
// exact pixel scale, off explicit poses, and writes files.
//
// Not a test — it asserts nothing. `spec/piece.test.ts` holds the properties.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COM_LIFT, orientationFor, renderPiece } from "../piece.ts";
import { compose, encodePng } from "./png.ts";

const BACKDROP: [number, number, number] = [0xee, 0xf1, 0xf6];
const OUT = ".frames";

interface Tile {
  readonly label: string;
  readonly dx: number;
  readonly dz: number;
  readonly theta: number;
  readonly squash?: number;
}

/** One PNG: a row of poses, each drawn about its own feet on a common baseline. */
function sheet(name: string, tiles: readonly Tile[], pxScale: number): void {
  const cell = Math.round(150 * pxScale);
  const w = cell * tiles.length;
  const h = Math.round(200 * pxScale);
  const baseline = Math.round(h * 0.74);

  const items = tiles.map((tile, i) => {
    const shot = renderPiece(
      { q: orientationFor(tile.dx, tile.dz, tile.theta) },
      pxScale,
    );
    return {
      // `renderPiece` returns a fresh view of a reused buffer, so it has to be
      // copied before the next call overwrites it.
      rgba: new Uint8ClampedArray(shot.image.rgba),
      w: shot.image.w,
      h: shot.image.h,
      x: Math.round(i * cell + cell / 2 + shot.ox),
      // The image is drawn about the centre of mass, so the feet land on the
      // baseline only once that lift is taken back off.
      y: Math.round(baseline - COM_LIFT * pxScale + shot.oy),
    };
  });

  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `piece-${name}.png`);
  writeFileSync(path, encodePng(w, h, compose(w, h, BACKDROP, items)));
  console.log(`${path}  ${w}x${h}  ${tiles.map((t) => t.label).join("  ")}`);
}

// Standing, on each of the two axes the run can turn down, and the same pair
// mirrored back the other way. If these four are not visibly four different
// pictures, the piece has no front and the whole exercise failed.
sheet(
  "heading",
  [
    { label: "axis-x", dx: 1, dz: 0, theta: 0 },
    { label: "axis-z", dx: 0, dz: 1, theta: 0 },
    { label: "back-x", dx: -1, dz: 0, theta: 0 },
    { label: "back-z", dx: 0, dz: -1, theta: 0 },
  ],
  2.2,
);

// One somersault, in eighths. The piece must stay a solid all the way round:
// no face popping through another, no silhouette collapsing to a line.
sheet(
  "tumble",
  Array.from({ length: 8 }, (_, i) => ({
    label: `${i}/8`,
    dx: 1,
    dz: 0,
    theta: (i / 8) * Math.PI * 2,
  })),
  1.6,
);

// The deformations, at the amplitudes the game actually uses.
sheet(
  "squash",
  [
    { label: "-0.32", dx: 1, dz: 0, theta: 0 },
    { label: "0", dx: 1, dz: 0, theta: 0 },
    { label: "+0.5", dx: 1, dz: 0, theta: 0 },
    { label: "+1", dx: 1, dz: 0, theta: 0 },
  ],
  2.2,
);

// The size it is actually marked at: `fitScale(390, 844)` on a 3x phone.
sheet("phone", [{ label: "phone", dx: 1, dz: 0, theta: 0 }], 0.62 * 3);
