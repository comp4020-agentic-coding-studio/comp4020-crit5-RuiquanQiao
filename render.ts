// Everything that knows about pixels. `game.ts` holds the rules and never
// imports this file; this file holds the picture and never decides anything.

import { MAX_GAP, PLATFORM_SIZE, type Platform } from "./game";

/** 2:1 isometric. One world unit of x goes right-and-down, z goes left-and-down. */
export const ISO_X = Math.cos(Math.PI / 6); // 0.866
export const ISO_Y = Math.sin(Math.PI / 6); // 0.5

export interface Point {
  x: number;
  y: number;
}

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

/**
 * World (x along one ground axis, z along the other, y up) to unscaled screen
 * space. The camera and the device pixel ratio are applied by the caller's
 * transform, so nothing in here reads `window`.
 *
 * Both ground axes recede *up* the screen, which is what puts the next block
 * up-and-right (axis x) or up-and-left (axis z) rather than down in front of
 * you. The run therefore climbs away from the viewer, as the original's does.
 */
export function iso(x: number, z: number, y = 0): Point {
  return {
    x: (x - z) * ISO_X,
    y: -(x + z) * ISO_Y - y,
  };
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

/**
 * Screen displacement of a world *direction* under the isometric camera.
 *
 * `iso` maps points; this maps vectors, which is what an orientation needs. It
 * is just `iso`'s linear part: no translation, and `y` still points up in the
 * world and down on the screen.
 */
export function isoVector(vx: number, vy: number, vz: number): Point {
  return { x: (vx - vz) * ISO_X, y: -(vx + vz) * ISO_Y - vy };
}

/** A piece standing upright: its own axis projects straight up the screen. */
export const UPRIGHT: Point = { x: 0, y: -1 };

/**
 * Where the piece's own vertical axis points after somersaulting `theta`
 * radians while travelling along the ground direction `(dx, dz)`.
 *
 * This is the difference between a tumble and a spin. A rotation applied in
 * screen space turns the piece in the picture plane, which is right only for a
 * jump that happens to run across the screen. Every jump here runs along one
 * of the two isometric axes, so both of them are diagonal on screen and
 * neither is in the picture plane — the piece has to rotate about a horizontal
 * axis perpendicular to its own travel, and then be projected.
 *
 * Rotating the world up-vector (0,1,0) by `theta` about the horizontal axis
 * perpendicular to `(dx, 0, dz)` gives `(dx sin, cos, dz sin)`, and projecting
 * that gives both the lean *and* the foreshortening for free: the returned
 * vector shortens as the piece goes over, which is what selling the third
 * dimension actually needs. At the top of a somersault it is nearly flat, and
 * you are looking at the piece side-on.
 */
export function tumbleUp(dx: number, dz: number, theta: number): Point {
  const s = Math.sin(theta);
  return isoVector(dx * s, Math.cos(theta), dz * s);
}

export interface Pose {
  /** Screen position of the point the figure stands on. */
  readonly foot: Point;
  /** 0 = upright, 1 = fully compressed. Negative stretches. */
  readonly squash: number;
  /**
   * The piece's own up axis, already projected. Direction gives the lean,
   * length gives the foreshortening. `UPRIGHT` for a piece standing still.
   */
  readonly up: Point;
}

const BODY_TOP = "#6a6f96";
const BODY_MID = "#4a4f72";
const BODY_FOOT = "#383c5a";
const HEAD_LIT = "#fffdf8";
const HEAD_MID = "#f2ece0";
const HEAD_SHADE = "#cfc7b7";

/** Standing height of the piece, ball included. Roughly a block tall. */
export const FIGURE_HEIGHT = 83;
const HEAD_Y = -70;
const HEAD_R = 13;

/**
 * The silhouette of a chess pawn, drawn once in its own units: a flared base,
 * a concave stem, a collar, a bulb and a neck. The ball on top is a separate
 * circle so it can carry its own light.
 *
 * The right-hand profile is written out and then mirrored in reverse, which is
 * the only way the two sides stay identical when the curves get tuned.
 */
function pawnOutline(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  // Vertical proportions matter more than the curves: a pawn is about an
  // eighth base, a third stem, and the rest bulb and ball. An earlier version
  // gave the base 8% and it read as a person in a coat rather than a piece.
  ctx.moveTo(22, 0);
  ctx.quadraticCurveTo(22, -7, 19, -9); // rolled edge of the base
  ctx.lineTo(13.5, -13); // step up off the base
  ctx.bezierCurveTo(11.5, -20, 8.4, -26, 8, -31); // stem, waisted hard
  ctx.lineTo(16, -34); // collar, flared proud of the stem
  ctx.lineTo(12, -40);
  ctx.bezierCurveTo(17, -46, 16, -54, 8.5, -57); // bulb
  ctx.lineTo(7.5, -60); // neck
  ctx.lineTo(-7.5, -60);
  ctx.lineTo(-8.5, -57);
  ctx.bezierCurveTo(-16, -54, -17, -46, -12, -40);
  ctx.lineTo(-16, -34);
  ctx.lineTo(-8, -31);
  ctx.bezierCurveTo(-8.4, -26, -11.5, -20, -13.5, -13);
  ctx.lineTo(-19, -9);
  ctx.quadraticCurveTo(-22, -7, -22, 0);
  ctx.closePath();
}

/**
 * The pawn, squashed and stretched about its feet.
 *
 * The deformation is uniform — head included — on purpose. Holding the ball at
 * a constant size reads as a figure crouching; letting it flatten with the rest
 * reads as something soft being pressed, which is the feel this is after.
 */
export function drawFigure(ctx: CanvasRenderingContext2D, pose: Pose): void {
  const { foot, squash, up } = pose;
  const { wide, tall } = deformOf(squash);

  // Lean is where the piece's axis points; foreshortening is how much of that
  // axis is facing the camera. Standing, `up` is (0,-1): no lean, no
  // shortening, and this reduces to a plain translate.
  const lean = Math.atan2(up.x, -up.y);
  const fore = Math.hypot(up.x, up.y);

  ctx.save();
  ctx.translate(foot.x, foot.y);
  // A tumbling body rotates about its centre of mass, not about its feet.
  const pivot = (FIGURE_HEIGHT / 2) * tall;
  ctx.translate(0, -pivot);
  ctx.rotate(lean);
  ctx.translate(0, pivot);
  ctx.scale(wide, tall * fore);

  // Body, lit from above so the base stays heavy.
  pawnOutline(ctx);
  const body = ctx.createLinearGradient(0, -60, 0, 0);
  body.addColorStop(0, BODY_TOP);
  body.addColorStop(0.55, BODY_MID);
  body.addColorStop(1, BODY_FOOT);
  ctx.fillStyle = body;
  ctx.fill();

  // A soft vertical sheen down the left, clipped to the silhouette.
  // A soft sheen, not a stripe: a flat ellipse at this width reads as a scarf
  // slung over the piece rather than as light on a curved surface.
  ctx.save();
  pawnOutline(ctx);
  ctx.clip();
  const gloss = ctx.createRadialGradient(-6.5, -36, 0, -6.5, -36, 22);
  gloss.addColorStop(0, "rgba(255, 255, 255, 0.34)");
  gloss.addColorStop(0.5, "rgba(255, 255, 255, 0.13)");
  gloss.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = gloss;
  ctx.beginPath();
  ctx.ellipse(-6.5, -36, 9, 26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Ball: a lit sphere rather than a flat disc, which is most of the candy.
  const ball = ctx.createRadialGradient(
    -HEAD_R * 0.35,
    HEAD_Y - HEAD_R * 0.4,
    HEAD_R * 0.15,
    0,
    HEAD_Y,
    HEAD_R * 1.25,
  );
  ball.addColorStop(0, HEAD_LIT);
  ball.addColorStop(0.55, HEAD_MID);
  ball.addColorStop(1, HEAD_SHADE);
  ctx.beginPath();
  ctx.arc(0, HEAD_Y, HEAD_R, 0, Math.PI * 2);
  ctx.fillStyle = ball;
  ctx.fill();

  // The specular dot. Small, and the thing that sells it as a sweet.
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(-HEAD_R * 0.34, HEAD_Y - HEAD_R * 0.42, 3.0, 2.2, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}
