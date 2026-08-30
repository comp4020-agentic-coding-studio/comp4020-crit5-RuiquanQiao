// Everything that knows about pixels. `game.ts` holds the rules and never
// imports this file; this file holds the picture and never decides anything.

import { MAX_GAP, PLATFORM_SIZE, type Platform } from "./game.ts";
import { ISO_X, ISO_Y, type Point, iso } from "./iso.ts";
import { comLift, renderPiece } from "./piece.ts";
import type { Quat } from "./vec.ts";

// The camera primitives live in `iso.ts` so the 3D rasteriser can use them
// without importing this file, which is full of canvas calls. Re-exported here
// because everything that draws already imports this one.
export { ISO_X, ISO_Y, iso, isoVector, isoDepth, tumbleUp, UPRIGHT } from "./iso.ts";
export type { Point } from "./iso.ts";
/** The piece's height comes off the mesh now, not off a drawing. */
export { FIGURE_HEIGHT } from "./mesh.ts";

/** Room above the blocks for the figure standing on one and the arc it flies. */
const HEADROOM = 150;

/** The widest and tallest pair of blocks the generator can ever place. */
export const WORST_PAIR = {
  wide: MAX_GAP * ISO_X + PLATFORM_SIZE * ISO_X * 2,
  tall: MAX_GAP * ISO_Y + PLATFORM_SIZE * ISO_Y * 2 + HEADROOM,
};

/**
 * One scale for a whole run: the largest that still fits the worst pair the
 * generator can produce, so no jump can ever put its target off screen.
 *
 * Pure, and it takes the viewport rather than reading it, because the two
 * sizes that matter are the two the work is marked at and a test can pass
 * those in. Measuring this in the preview pane is not an option — the pane
 * renders at its own physical size and a hidden pane does not resize at all.
 */
export function fitScale(width: number, height: number): number {
  return Math.max(
    0.45,
    Math.min(
      2.2,
      Math.min((width * 0.86) / WORST_PAIR.wide, (height * 0.62) / WORST_PAIR.tall),
    ),
  );
}

/** The pastel run, cycled by platform id so the sequence never repeats a neighbour. */
const FACES = [
  ["#f2b8b5", "#d99693", "#c07d7b"],
  ["#a8d5c8", "#86b8a9", "#6d9b8d"],
  ["#b9c7ea", "#96a6d1", "#7c8cb6"],
  ["#f5d9a8", "#d9b87f", "#bf9d66"],
  ["#d7bde8", "#b598c9", "#9a7dae"],
  ["#a9cfe8", "#87b0cc", "#6e93af"],
] as const;

export function paletteFor(platform: Platform): readonly [string, string, string] {
  return FACES[platform.id % FACES.length] as unknown as readonly [
    string,
    string,
    string,
  ];
}

export const BACKDROP_TOP = "#eef1f6";
export const BACKDROP_BOTTOM = "#dfe4ee";
export const SHADOW = "rgba(70, 78, 104, 0.13)";

/**
 * How hard a block is being squeezed. Positive compresses and spreads it,
 * negative stretches and narrows it — the two halves of squash-and-stretch,
 * which is the whole difference between a wooden crate and a gum drop.
 */
export function deformOf(squash: number): { wide: number; tall: number } {
  return { wide: 1 + squash * 0.26, tall: 1 - squash * 0.42 };
}

/**
 * A block: top face, then the two visible sides. The top is drawn last so its
 * edge sits cleanly over the sides, which is what stops the seams shimmering
 * when the camera pans a fraction of a pixel.
 *
 * `squash` spreads the footprint as it flattens the height, so the block bulges
 * sideways under load instead of merely getting shorter.
 */
export function drawPlatform(
  ctx: CanvasRenderingContext2D,
  platform: Platform,
  squash = 0,
): void {
  const [top, right, left] = paletteFor(platform);
  const { wide, tall } = deformOf(squash);
  const half = (PLATFORM_SIZE / 2) * wide;
  const height = platform.height * tall;
  const { x, z } = platform;

  // A squeezed block loses height off its top, not off its base — the base is
  // on the ground. Everything is drawn from the top face down, so the whole
  // top sinks by whatever height the squash took away.
  const sink = sinkOf(platform, squash);

  // Top face, named by where each corner lands on screen: far is the corner
  // pointing away from the viewer, near is the one pointing at them.
  const lift = (p: Point): Point => ({ x: p.x, y: p.y + sink });
  const far = lift(iso(x + half, z + half));
  const rightCorner = lift(iso(x + half, z - half));
  const near = lift(iso(x - half, z - half));
  const leftCorner = lift(iso(x - half, z + half));

  const face = (points: Point[], fill: string | CanvasGradient) => {
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  const drop = (p: Point): Point => ({ x: p.x, y: p.y + height });

  // Every face is drawn sharp and then clipped to one rounded outline. Rounding
  // each face on its own leaves a notch where two of them meet; rounding the
  // silhouette rounds only the corners that are actually corners.
  ctx.save();
  roundedPath(
    ctx,
    [far, rightCorner, drop(rightCorner), drop(near), drop(leftCorner), leftCorner],
    CORNER,
  );
  ctx.clip();

  const sideLight = (from: Point, colour: string) => {
    const g = ctx.createLinearGradient(from.x, from.y, from.x, from.y + height);
    g.addColorStop(0, colour);
    g.addColorStop(1, shade(colour, -0.14));
    return g;
  };

  face([leftCorner, near, drop(near), drop(leftCorner)], sideLight(leftCorner, left));
  face([near, rightCorner, drop(rightCorner), drop(near)], sideLight(near, right));

  // Top face, lit from the far corner so the block reads as domed.
  const lit = ctx.createLinearGradient(far.x, far.y, near.x, near.y);
  lit.addColorStop(0, shade(top, 0.1));
  lit.addColorStop(1, shade(top, -0.05));
  face([far, rightCorner, near, leftCorner], lit);

  // The sheen. A sweet catches the light in a soft patch, not along a line.
  const sheen = ctx.createRadialGradient(
    far.x - half * ISO_X * 0.4,
    far.y + PLATFORM_SIZE * ISO_Y * 0.45,
    2,
    far.x - half * ISO_X * 0.4,
    far.y + PLATFORM_SIZE * ISO_Y * 0.45,
    half * 1.1,
  );
  sheen.addColorStop(0, "rgba(255, 255, 255, 0.5)");
  sheen.addColorStop(1, "rgba(255, 255, 255, 0)");
  face([far, rightCorner, near, leftCorner], sheen);

  ctx.restore();
}

/** Corner radius on a block's silhouette. The whole difference from a crate. */
const CORNER = 8;

/** Nudge a hex colour toward white (positive) or black (negative). */
function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  return `rgb(${mix((n >> 16) & 255)} ${mix((n >> 8) & 255)} ${mix(n & 255)})`;
}

/** A closed polygon with every corner rounded to `r`. */
function roundedPath(ctx: CanvasRenderingContext2D, pts: Point[], r: number): void {
  const n = pts.length;
  const mid = (a: Point, b: Point): Point => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  const start = mid(pts[0]!, pts[1]!);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  for (let i = 1; i <= n; i++) {
    const corner = pts[i % n]!;
    const to = mid(corner, pts[(i + 1) % n]!);
    ctx.arcTo(corner.x, corner.y, to.x, to.y, r);
  }
  ctx.closePath();
}

/** How far a block's top face drops when it is squeezed by `squash`. */
export function sinkOf(platform: Platform, squash: number): number {
  return platform.height * (1 - deformOf(squash).tall);
}

/**
 * The soft ellipse under the figure. It is the only cue for how high off the
 * block the figure is, so it spreads and fades as the figure rises rather
 * than merely dimming.
 */
export function drawShadow(
  ctx: CanvasRenderingContext2D,
  at: Point,
  strength: number,
): void {
  const r = 17 * (1.5 - strength * 0.5);
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.scale(1, ISO_Y);
  const soft = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  soft.addColorStop(0, `rgba(70, 78, 104, ${0.2 * strength})`);
  soft.addColorStop(0.6, `rgba(70, 78, 104, ${0.11 * strength})`);
  soft.addColorStop(1, "rgba(70, 78, 104, 0)");
  ctx.fillStyle = soft;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}


export interface Pose {
  /**
   * Screen position of the piece's centre of mass, unscaled.
   *
   * The centre of mass rather than the feet, because that is the point a body
   * in free flight turns about and the point the rigid body actually tracks.
   * `comLift` converts, for the phases that know where the feet are instead.
   */
  readonly at: Point;
  /** 0 = upright, 1 = fully compressed. Negative stretches. */
  readonly squash: number;
  /** Orientation of the piece. Built by `orientationFor` or by the solver. */
  readonly q: Quat;
}

/**
 * The scratch canvas the rasterised piece is handed over on.
 *
 * `putImageData` would be the direct route and it is the wrong one: it ignores
 * the current transform *and* it replaces the destination rather than
 * compositing, so the piece would arrive as an opaque rectangle of backdrop
 * with a knight in it. Going via a canvas and `drawImage` gets alpha blending
 * and the camera transform for free.
 *
 * Null in jsdom, which has no canvas at all — `spec/boot.test.ts` drives the
 * real entry point through a stub context, and the point of that test is the
 * wiring rather than the pixels.
 */
let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function scratchFor(w: number, h: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  scratch ??= document.createElement("canvas");
  if (!scratch) return null;
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, w);
    scratch.height = Math.max(scratch.height, h);
    scratchCtx = null;
  }
  scratchCtx ??= scratch.getContext("2d");
  return scratchCtx;
}

/**
 * The piece: an actual mesh, projected, lit and depth-buffered by `piece.ts`,
 * then composited at exactly one device pixel per rendered pixel.
 *
 * `pxScale` is passed in rather than read back off `ctx.getTransform()`. The
 * caller knows it — it is the run's fitted scale times the device pixel ratio —
 * and reading it back would make this the one drawing function that cannot run
 * against a stub context, which is the context every boot test uses.
 */
export function drawFigure(
  ctx: CanvasRenderingContext2D,
  pose: Pose,
  pxScale: number,
): void {
  const shot = renderPiece({ q: pose.q, squash: pose.squash }, pxScale);
  const { w, h, rgba } = shot.image;
  if (w <= 0 || h <= 0) return;

  const off = scratchFor(w, h);
  if (!off) return;

  // Wipe a margin beyond the image before writing it.
  //
  // The scratch canvas only ever grows, so after one big frame it holds a
  // bigger picture than the next small one overwrites. `drawImage` is given an
  // exact source rectangle, but it filters, and filtering at the edge of that
  // rectangle samples half a pixel outside it — straight into the leftovers.
  // The symptom was a faint bright line down the right of the piece and another
  // under it, on every frame, which reads as a rendering fault rather than as a
  // chess piece. Only right and bottom: past the left and top edges there is no
  // canvas to sample, and transparent black is what should be there anyway.
  off.clearRect(
    0,
    0,
    Math.min(off.canvas.width, w + 2),
    Math.min(off.canvas.height, h + 2),
  );
  // Via `createImageData` rather than the `ImageData` constructor: the array
  // the rasteriser hands back is a view on a reused buffer, and copying into
  // a fresh one is both what the constructor overload wants and one fewer
  // allocation per frame than cloning it first.
  const bitmap = off.createImageData(w, h);
  bitmap.data.set(rgba);
  off.putImageData(bitmap, 0, 0);

  // Drawn back at world size, so the transform already in force puts it exactly
  // where the projection said. Divided by the scale the rasteriser *used*, not
  // the one it was asked for: past `RENDER_CAP` it renders smaller on purpose
  // and this is what scales it back up.
  ctx.drawImage(
    off.canvas,
    0,
    0,
    w,
    h,
    pose.at.x + shot.ox / shot.scale,
    pose.at.y + shot.oy / shot.scale,
    w / shot.scale,
    h / shot.scale,
  );
}

/** Screen position of the centre of mass of a piece whose feet are at `foot`. */
export function comAbove(foot: Point, squash: number): Point {
  return { x: foot.x, y: foot.y - comLift(squash) };
}

export { comLift, orientationAt, orientationFor, tumbleAxis, yawFor } from "./piece.ts";
