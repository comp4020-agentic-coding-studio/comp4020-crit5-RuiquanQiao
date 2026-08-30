// Watch a miss, in Node, as numbers and as a picture.
//
//   node scripts/preview-fall.ts [holdMs] [seed]
//
// The rigid body is the part of this game that cannot be judged from a still,
// and the browser is the worst place to watch it: the preview pane throttles
// animation to about 1fps and renders at its own physical size. Both halves of
// the answer are here instead. The trace says what the solver did — position,
// speed, spin, how far the lowest contact point is below a block's top face,
// and how many substeps resolved a contact. The filmstrip says what it looked
// like, with the blocks drawn in, because "did it fall off" is a question about
// the piece *and* the block and a piece alone on a blank field cannot answer it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  chargeToDistance,
  firstPlatform,
  gapBetween,
  nextPlatform,
  resolveLanding,
  rng,
} from "../game.ts";
import { ISO_X, ISO_Y, iso } from "../iso.ts";
import { flightSeconds } from "../motion.ts";
import { type Slab, advance, launch, lowestContact } from "../physics.ts";
import { renderPiece } from "../piece.ts";
import { length, mulMV, qToMat } from "../vec.ts";
import { compose, encodePng, fillPolygon } from "./png.ts";

const holdMs = Number(process.argv[2] ?? 900);
const seed = Number(process.argv[3] ?? 20260831);

const random = rng(seed);
const current = firstPlatform(random);
const next = nextPlatform(current, random);
const gap = gapBetween(current, next);
const travelled = chargeToDistance(holdMs);
const landing = resolveLanding(travelled, gap);

const seconds = flightSeconds(travelled);
const [dx, dz] = current.axis === "x" ? [1, 0] : [0, 1];

const slabs: Slab[] = [current, next].map((b) => ({ x: b.x, z: b.z, height: b.height }));

console.log(
  `seed ${seed}  hold ${holdMs}ms  gap ${gap.toFixed(1)}  travelled ${travelled.toFixed(1)}`,
);
console.log(`landing ${JSON.stringify(landing)}  offset ${(travelled - gap).toFixed(1)}`);
console.log(
  `blocks ${slabs.map((s) => `(x${s.x.toFixed(0)} z${s.z.toFixed(0)} h${s.height})`).join(" ")}`,
);
if (landing.kind !== "fall") {
  console.log("not a miss — nothing for the rigid body to do");
  process.exit(0);
}

let sim = launch({
  x: current.x + dx * travelled,
  z: current.z + dz * travelled,
  dx,
  dz,
  range: travelled,
  seconds,
});

const FRAMES = 76;
const STRIDE = 4;
const poses: { p: readonly number[]; q: readonly number[] }[] = [];

console.log("\n  ms   x      y      z    |v|    |w|   up.y   sunk  contacts");
for (let frame = 0; frame <= FRAMES; frame++) {
  const body = sim.body;
  if (frame % STRIDE === 0) poses.push({ p: body.p, q: body.q });
  const up = mulMV(qToMat(body.q), [0, 1, 0]);
  console.log(
    [
      String(Math.round((frame * 1000) / 60)).padStart(4),
      body.p[0].toFixed(0).padStart(6),
      body.p[1].toFixed(0).padStart(6),
      body.p[2].toFixed(0).padStart(6),
      length(body.v).toFixed(0).padStart(6),
      length(body.w).toFixed(1).padStart(6),
      up[1].toFixed(2).padStart(6),
      lowestContact(body).toFixed(1).padStart(6),
      String(sim.contacts).padStart(9),
    ].join(""),
  );
  sim = advance(sim, slabs, 1 / 60);
}

// ---------------------------------------------------------------------------
// The picture
// ---------------------------------------------------------------------------

const SCALE = 0.5;
const COLS = 8;
const CELL_W = 300;
const CELL_H = 240;
const rows = Math.ceil(poses.length / COLS);
const W = COLS * CELL_W;
const H = rows * CELL_H;

/** Screen point of a world point, inside the tile at `(ox, oy)`. */
function at(ox: number, oy: number, x: number, y: number, z: number): [number, number] {
  const p = iso(x, z, y);
  // Framed on the block being missed, so the piece leaves the tile rather than
  // the tile following it — which is the whole question being asked.
  const focus = iso((current.x + next.x) / 2, (current.z + next.z) / 2);
  return [
    ox + CELL_W / 2 + (p.x - focus.x) * SCALE,
    oy + CELL_H * 0.42 + (p.y - focus.y) * SCALE,
  ];
}

const background = compose(W, H, [0xee, 0xf1, 0xf6], []);
const items: { rgba: Uint8ClampedArray; w: number; h: number; x: number; y: number }[] = [];

poses.forEach((pose, i) => {
  const ox = (i % COLS) * CELL_W;
  const oy = Math.floor(i / COLS) * CELL_H;

  for (const block of [current, next]) {
    const half = 29;
    const corner = (sx: number, sz: number, y = 0) =>
      at(ox, oy, block.x + sx * half, y, block.z + sz * half);
    const far = corner(1, 1);
    const right = corner(1, -1);
    const near = corner(-1, -1);
    const left = corner(-1, 1);
    const drop = ([x, y]: [number, number]): [number, number] => [x, y + block.height * SCALE];
    fillPolygon(background, W, H, [left, near, drop(near), drop(left)], [0xc9, 0x9b, 0x99]);
    fillPolygon(background, W, H, [near, right, drop(right), drop(near)], [0xd9, 0xa8, 0xa6]);
    fillPolygon(background, W, H, [far, right, near, left], [0xf2, 0xb8, 0xb5]);
  }

  const shot = renderPiece({ q: pose.q as never, squash: 0 }, SCALE);
  const [px, py] = at(ox, oy, pose.p[0]!, pose.p[1]!, pose.p[2]!);
  items.push({
    rgba: new Uint8ClampedArray(shot.image.rgba),
    w: shot.image.w,
    h: shot.image.h,
    x: Math.round(px + shot.ox),
    y: Math.round(py + shot.oy),
  });
});

mkdirSync(".frames", { recursive: true });
const path = join(".frames", "fall-trace.png");
writeFileSync(
  path,
  encodePng(W, H, compose(W, H, [0xee, 0xf1, 0xf6], [
    { rgba: background, w: W, h: H, x: 0, y: 0 },
    ...items,
  ])),
);
console.log(`\n${path}  ${W}x${H}  every ${STRIDE} frames at 60Hz`);

void ISO_X;
void ISO_Y;
