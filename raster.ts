// A depth-buffered triangle rasteriser that writes into a plain array.
//
// It deliberately knows nothing about `CanvasRenderingContext2D`. The whole
// reason the piece could ship looking wrong for a session at a time is that
// checking it needed a browser: the preview pane renders at its own size and
// throttles animation to about 1fps, so the picture I was arguing from was not
// the picture being marked. A rasteriser that fills a `Uint8ClampedArray` runs
// in Node, in a test, with no DOM at all — `scripts/preview-piece.ts` renders
// the same pixels the browser gets and writes them to a PNG I can open.
//
// Depth is "further from the camera is larger", and the test is `<` — the same
// convention throughout. Triangles arrive in any order.

export interface Surface {
  readonly w: number;
  readonly h: number;
  readonly rgba: Uint8ClampedArray;
  readonly depth: Float32Array;
}

/** A projected vertex: screen position, depth, and its already-lit colour. */
export interface Vertex {
  readonly x: number;
  readonly y: number;
  readonly d: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function surface(w: number, h: number): Surface {
  return {
    w,
    h,
    rgba: new Uint8ClampedArray(w * h * 4),
    depth: new Float32Array(w * h),
  };
}

export function clear(s: Surface): void {
  s.rgba.fill(0);
  s.depth.fill(Infinity);
}

/**
 * Twice the signed area of the triangle on screen.
 *
 * Under an orthographic projection this sign *is* the facing: a closed mesh
 * wound counter-clockwise from outside puts every back face the other way
 * round, so culling on the sign removes exactly the half of the surface that
 * faces away. Without it the inside of the base draws over the outside
 * wherever the depth buffer ties, which it does along every silhouette edge.
 */
export function area2(a: Vertex, b: Vertex, c: Vertex): number {
  return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
}

/**
 * Fill one triangle, depth-tested per pixel.
 *
 * Per pixel rather than per triangle: a knight's muzzle passes in front of its
 * own throat, and its ear passes in front of its own mane. Sorting whole
 * triangles by their centroid — the cheap way — gets both of those wrong from
 * some angles and right from others, which reads as the piece flickering
 * inside out as it tumbles.
 *
 * Two things make that affordable at sixty frames a second. The barycentrics
 * are affine in x, so every interpolated quantity — depth and three colour
 * channels — advances by a constant per pixel rather than being recomputed.
 * And each row is solved for the span it actually covers, rather than walked
 * across the bounding box testing whether each pixel is inside: this mesh is
 * mostly long thin quads split into two slivers, so that test was rejecting
 * more pixels than it kept. Together they took the piece from 7.6ms a frame at
 * desktop scale to well inside a frame.
 */
export function triangle(s: Surface, a: Vertex, b: Vertex, c: Vertex): void {
  const doubled = area2(a, b, c);
  if (doubled <= 0) return; // back-facing or degenerate

  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(s.h - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const clipLeft = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const clipRight = Math.min(s.w - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  if (minY > maxY || clipLeft > clipRight) return;

  const inv = 1 / doubled;

  // The two barycentrics as affine functions of the pixel centre. Both are
  // linear in x, which is the whole basis of what follows: evaluating them from
  // scratch at every pixel, as the first version did, recomputed the same two
  // planes a quarter of a million times a frame.
  const w0dx = -(b.y - a.y) * inv;
  const w1dx = (c.y - a.y) * inv;
  const sumdx = w0dx + w1dx;

  // Depth and colour are affine in the barycentrics, so they are affine in x
  // too, and each one becomes an add per pixel.
  const dd = (c.d - a.d) * w0dx + (b.d - a.d) * w1dx;
  const dr = (c.r - a.r) * w0dx + (b.r - a.r) * w1dx;
  const dg = (c.g - a.g) * w0dx + (b.g - a.g) * w1dx;
  const db = (c.b - a.b) * w0dx + (b.b - a.b) * w1dx;

  for (let py = minY; py <= maxY; py++) {
    const y = py + 0.5;
    const x0 = clipLeft + 0.5;
    let w0 = ((b.x - a.x) * (y - a.y) - (x0 - a.x) * (b.y - a.y)) * inv;
    let w1 = ((x0 - a.x) * (c.y - a.y) - (c.x - a.x) * (y - a.y)) * inv;

    // Solve the row analytically instead of testing every pixel across the
    // bounding box. A triangle covers about half its own box, and the mesh is
    // mostly long thin quads split diagonally, so the box test was rejecting
    // more pixels than it kept.
    let lo = clipLeft;
    let hi = clipRight;
    const narrow = (value: number, slope: number): boolean => {
      // Where along the row `value + slope * (px - clipLeft)` is non-negative.
      if (Math.abs(slope) < 1e-12) return value >= 0;
      const crossing = clipLeft - value / slope;
      if (slope > 0) lo = Math.max(lo, Math.ceil(crossing));
      else hi = Math.min(hi, Math.floor(crossing));
      return true;
    };
    if (!narrow(w0, w0dx)) continue;
    if (!narrow(w1, w1dx)) continue;
    // The third edge, written as `1 - w0 - w1 >= 0`.
    if (!narrow(1 - w0 - w1, -sumdx)) continue;
    if (lo > hi) continue;

    const step = lo - clipLeft;
    w0 += w0dx * step;
    w1 += w1dx * step;
    let d = a.d + (c.d - a.d) * w0 + (b.d - a.d) * w1;
    let r = a.r + (c.r - a.r) * w0 + (b.r - a.r) * w1;
    let g = a.g + (c.g - a.g) * w0 + (b.g - a.g) * w1;
    let bl = a.b + (c.b - a.b) * w0 + (b.b - a.b) * w1;

    let at = py * s.w + lo;
    for (let px = lo; px <= hi; px++, at++) {
      if (d < s.depth[at]!) {
        s.depth[at] = d;
        const o = at * 4;
        s.rgba[o] = r;
        s.rgba[o + 1] = g;
        s.rgba[o + 2] = bl;
        s.rgba[o + 3] = 255;
      }
      d += dd;
      r += dr;
      g += dg;
      bl += db;
    }
  }
}

export interface Image {
  readonly w: number;
  readonly h: number;
  readonly rgba: Uint8ClampedArray;
}

/**
 * Box-downsample by an integer factor, averaging colour *and* coverage.
 *
 * This is the anti-aliasing, and it is why the piece is rendered at twice the
 * device resolution. A hard-edged silhouette at phone scale is about 90px tall
 * and every one of its outlines is a diagonal; unsampled it crawls with stair
 * steps against a flat pastel background, which is exactly the thing that reads
 * as "drawn by a program" rather than as an object.
 *
 * Colour is averaged over covered samples only. Averaging over all of them
 * instead mixes the transparent black of the empty ones into the edge and
 * leaves a dark fringe all the way round the piece.
 */
// Reused between frames. A fresh output buffer every frame is a couple of
// hundred kilobytes of garbage sixty times a second, which is a collector pause
// in the middle of a jump — the one place in this game it would be felt.
let cache = new Uint8ClampedArray(0);

export function downsample(s: Surface, factor: number): Image {
  const w = Math.floor(s.w / factor);
  const h = Math.floor(s.h / factor);
  if (cache.length < w * h * 4) cache = new Uint8ClampedArray(w * h * 4);
  const out = cache.subarray(0, w * h * 4);
  out.fill(0);

  const src = s.rgba;
  if (factor === 2) {
    // Unrolled for the only factor anything actually uses.
    //
    // Worth doing because this pass is not a small part of the cost: at desktop
    // scale it walks about a quarter of a million supersampled pixels, which is
    // the same order as the rasteriser itself. The generic loop below spends
    // most of its time on loop control and an inner branch, for four samples.
    for (let y = 0; y < h; y++) {
      let top = y * 2 * s.w * 4;
      let bottom = top + s.w * 4;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, top += 8, bottom += 8, o += 4) {
        const a0 = src[top + 3]!;
        const a1 = src[top + 7]!;
        const a2 = src[bottom + 3]!;
        const a3 = src[bottom + 7]!;
        const covered =
          (a0 !== 0 ? 1 : 0) + (a1 !== 0 ? 1 : 0) + (a2 !== 0 ? 1 : 0) + (a3 !== 0 ? 1 : 0);
        if (covered === 0) continue;
        if (covered === 4) {
          // The common case by a long way: an interior pixel, fully covered.
          out[o] = (src[top]! + src[top + 4]! + src[bottom]! + src[bottom + 4]!) / 4;
          out[o + 1] =
            (src[top + 1]! + src[top + 5]! + src[bottom + 1]! + src[bottom + 5]!) / 4;
          out[o + 2] =
            (src[top + 2]! + src[top + 6]! + src[bottom + 2]! + src[bottom + 6]!) / 4;
          out[o + 3] = 255;
          continue;
        }
        // An edge pixel. Colour is averaged over the covered samples only:
        // including the empty ones mixes transparent black into every outline
        // and leaves a dark fringe right round the piece.
        let r = 0;
        let g = 0;
        let b = 0;
        if (a0 !== 0) {
          r += src[top]!;
          g += src[top + 1]!;
          b += src[top + 2]!;
        }
        if (a1 !== 0) {
          r += src[top + 4]!;
          g += src[top + 5]!;
          b += src[top + 6]!;
        }
        if (a2 !== 0) {
          r += src[bottom]!;
          g += src[bottom + 1]!;
          b += src[bottom + 2]!;
        }
        if (a3 !== 0) {
          r += src[bottom + 4]!;
          g += src[bottom + 5]!;
          b += src[bottom + 6]!;
        }
        out[o] = r / covered;
        out[o + 1] = g / covered;
        out[o + 2] = b / covered;
        out[o + 3] = covered * 63.75;
      }
    }
    return { w, h, rgba: out };
  }

  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < factor; sy++) {
        const row = (y * factor + sy) * s.w + x * factor;
        for (let sx = 0; sx < factor; sx++) {
          const o = (row + sx) * 4;
          if (src[o + 3]! === 0) continue;
          r += src[o]!;
          g += src[o + 1]!;
          b += src[o + 2]!;
          covered++;
        }
      }
      const o = (y * w + x) * 4;
      if (covered === 0) continue;
      out[o] = r / covered;
      out[o + 1] = g / covered;
      out[o + 2] = b / covered;
      out[o + 3] = (covered / n) * 255;
    }
  }
  return { w, h, rgba: out };
}
