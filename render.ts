// Everything that knows about pixels. `game.ts` holds the rules and never
// imports this file; this file holds the picture and never decides anything.

import { PLATFORM_SIZE, type Platform } from "./game";

/** 2:1 isometric. One world unit of x goes right-and-down, z goes left-and-down. */
const ISO_X = Math.cos(Math.PI / 6); // 0.866
const ISO_Y = Math.sin(Math.PI / 6); // 0.5

export interface Point {
  x: number;
  y: number;
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
 * A block: top face, then the two visible sides. The top is drawn last so its
 * edge sits cleanly over the sides, which is what stops the seams shimmering
 * when the camera pans a fraction of a pixel.
 */
export function drawPlatform(
  ctx: CanvasRenderingContext2D,
  platform: Platform,
  squash = 0,
): void {
  const [top, right, left] = paletteFor(platform);
  const half = PLATFORM_SIZE / 2;
  const height = platform.height * (1 - squash * 0.16);
  const { x, z } = platform;

  // Top face, named by where each corner lands on screen: far is the corner
  // pointing away from the viewer, near is the one pointing at them.
  const far = iso(x + half, z + half);
  const rightCorner = iso(x + half, z - half);
  const near = iso(x - half, z - half);
  const leftCorner = iso(x - half, z + half);

  const face = (points: Point[], fill: string) => {
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  const drop = (p: Point): Point => ({ x: p.x, y: p.y + height });

  // The two sides below the near corner are the only ones facing the camera.
  face([leftCorner, near, drop(near), drop(leftCorner)], left);
  face([near, rightCorner, drop(rightCorner), drop(near)], right);
  // Top last, so its edge covers the seams where the sides meet it.
  face([far, rightCorner, near, leftCorner], top);
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
  /** Screen position of the point the figure stands on. */
  readonly foot: Point;
  /** 0 = upright, 1 = fully compressed. */
  readonly squash: number;
  /** Radians, about the figure's own middle. */
  readonly spin: number;
  /** Radians of topple once the run is lost. */
  readonly topple: number;
}

const BODY = "#454a68";
const BODY_LIT = "#5b6183";
const HEAD = "#f6f3ec";
const HEAD_SHADE = "#d9d4c8";

/** Standing height of the figure, head included. Roughly a block tall. */
export const FIGURE_HEIGHT = 62;

/**
 * A pawn: rounded base, waist pinched in, a big pale ball on top. The two
 * pieces are drawn separately so the charge can squash the body while the
 * head keeps its size — which is what makes the compression read as effort
 * rather than as the whole figure being scaled down.
 */
export function drawFigure(ctx: CanvasRenderingContext2D, pose: Pose): void {
  const { foot, squash, spin, topple } = pose;
  const bodyH = 44 * (1 - squash * 0.4);
  const baseW = 23 * (1 + squash * 0.34);
  const shoulderW = 13 * (1 + squash * 0.5);
  const headR = 12 * (1 + squash * 0.06);
  const headY = -bodyH - headR * 0.72;

  ctx.save();
  ctx.translate(foot.x, foot.y);
  if (topple !== 0) ctx.rotate(topple);
  // Spin happens about the figure's middle, not its feet.
  if (spin !== 0) {
    const pivot = (bodyH + headR * 1.7) / 2;
    ctx.translate(0, -pivot);
    ctx.rotate(spin);
    ctx.translate(0, pivot);
  }

  // Body: rounded foot, waist curving in to narrow shoulders.
  ctx.beginPath();
  ctx.moveTo(-baseW / 2, -baseW * 0.16);
  ctx.quadraticCurveTo(-baseW / 2, -bodyH * 0.62, -shoulderW / 2, -bodyH);
  ctx.lineTo(shoulderW / 2, -bodyH);
  ctx.quadraticCurveTo(baseW / 2, -bodyH * 0.62, baseW / 2, -baseW * 0.16);
  ctx.ellipse(0, -baseW * 0.16, baseW / 2, baseW * 0.3, 0, 0, Math.PI);
  ctx.closePath();
  ctx.fillStyle = BODY;
  ctx.fill();

  // A lit edge down the left, which is where the backdrop is brightest.
  ctx.save();
  ctx.clip();
  ctx.fillStyle = BODY_LIT;
  ctx.beginPath();
  ctx.ellipse(-baseW * 0.26, -bodyH * 0.5, baseW * 0.2, bodyH * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Head, with a soft underside so it sits on the shoulders rather than float.
  ctx.beginPath();
  ctx.arc(0, headY, headR, 0, Math.PI * 2);
  ctx.fillStyle = HEAD;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = HEAD_SHADE;
  ctx.beginPath();
  ctx.arc(headR * 0.35, headY + headR * 0.62, headR * 0.85, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}
