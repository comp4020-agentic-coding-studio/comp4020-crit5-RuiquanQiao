// The knight, posed and lit and turned into pixels. Pure: it takes an
// orientation and a scale and gives back an RGBA image, so the browser and
// `scripts/preview-piece.ts` render byte-identical results and I can look at
// the second one without a browser being involved at all.

import { ISO_X, ISO_Y, isoDepth } from "./iso.ts";
import {
  COM_HEIGHT,
  MATERIAL_BASE,
  type Mesh,
  knight,
} from "./mesh.ts";
import { type Image, type Vertex, clear, downsample, surface, triangle } from "./raster.ts";
import {
  type Mat3,
  type Quat,
  type Vec3,
  dot,
  normalise,
  qAxisAngle,
  qMul,
  qToMat,
} from "./vec.ts";

/**
 * Rendered at twice the device resolution and averaged down. See
 * `raster.downsample` — at phone scale the piece is about 90px tall and every
 * edge of it is a diagonal.
 */
const SUPERSAMPLE = 2;

/**
 * The most device pixels per world unit the piece is ever rasterised at.
 *
 * Cost here is quadratic in this number — it sets the area of both the fill and
 * the box filter — and past a certain size the supersampling stops buying
 * anything. At 1920x1080 on a 2x display the fitted scale asks for 3.74, which
 * is a piece 360 device pixels tall and six milliseconds a frame of the
 * sixteen available. Rasterised at 3.0 and handed to `drawImage` to scale the
 * last 25%, it is under four, and the difference is a shape with no texture on
 * it being resampled by a quarter — which is not visible and a dropped frame
 * is. Below the cap, which is every phone and every 1x desktop, the piece is
 * still rendered at exactly the pixels it is drawn at.
 */
const RENDER_CAP = 3;

/** From the surface toward the viewer: the reverse of the camera ray. */
const VIEW: Vec3 = normalise([-1, 1, -1]);

/**
 * The key light, in world space, pointing from the surface toward the light.
 *
 * It has to satisfy three things at once and the first attempt got the third
 * backwards. Up the screen means `+y`; left across the screen means `x < z`,
 * since `iso` sends a direction to `((x - z) · ISO_X, …)`. Those two alone are
 * met by `(0.1, 0.8, 0.6)`, which is what was tried — and it lit the far flank
 * of the head while the flank actually facing the camera, whose normal is `-z`,
 * stayed in shadow. Half the piece rendered as a black card.
 *
 * So the third condition: `dot(L, VIEW) > 0`, the light in front of the piece
 * rather than behind it. `x < z` with `z` itself negative forces `x` well
 * negative, which is what this is.
 */
const KEY: Vec3 = normalise([-0.5, 0.88, -0.28]);
/** A cool bounce off the far side, so the shadowed half is not dead. */
const FILL: Vec3 = normalise([0.62, 0.1, 0.72]);
/** Halfway between key and view — the direction a mirror would flare at. */
const HALF: Vec3 = normalise([
  KEY[0] + VIEW[0],
  KEY[1] + VIEW[1],
  KEY[2] + VIEW[2],
]);

const AMBIENT = 0.26;
const KEY_GAIN = 0.80;
const FILL_GAIN = 0.22;
const SPECULAR = 0.5;
const SHININESS = 28;
/**
 * How much the silhouette's edge catches the sky.
 *
 * Small on purpose. The backdrop is a very pale grey and the piece has to read
 * against it, so the thing that separates them is the piece being *darker*, not
 * brighter. Turned up to 0.3 the rim lit the whole outline and the piece went
 * the same value as the sky it was standing in front of.
 */
const RIM = 0.16;

type Rgb = readonly [number, number, number];
/** Indexed by the mesh's material id. Lacquered indigo, on a darker plinth. */
const MATERIALS: readonly Rgb[] = [
  [92, 98, 145], // body: the head and neck
  [62, 67, 106], // base: the turned foot and collar
];
/** What the ambient term is tinted with — the backdrop, so it reads as sky. */
const SKY: Rgb = [206, 214, 236];

export interface Rendered {
  readonly image: Image;
  /**
   * Where the image's top-left sits relative to the centre of mass, in pixels
   * at `scale` — not necessarily device pixels. See `RENDER_CAP`.
   */
  readonly ox: number;
  readonly oy: number;
  /**
   * Pixels per world unit this was actually rasterised at, which is the
   * requested scale or `RENDER_CAP`, whichever is smaller. The caller divides
   * by it to get back to world units, so a capped render lands in exactly the
   * same place and is simply drawn larger.
   */
  readonly scale: number;
}

/**
 * The orientation of a piece travelling along `(dx, dz)` that has somersaulted
 * `theta` radians.
 *
 * Two rotations, and the order is the whole point. The pitch is applied in the
 * piece's own frame — a forward roll, nose over tail, about its own left/right
 * axis — and *then* the yaw turns the whole thing to face the way it is going.
 * Done the other way round the piece would tumble about a world axis while
 * facing somewhere else, which is a body cartwheeling sideways rather than
 * flipping.
 *
 * With `theta = 0` this is pure yaw, which is the standing pose: the knight
 * faces along the axis it is about to jump down, so the run turning from one
 * isometric axis to the other turns the piece with it. That is the thing a
 * pawn could never show, being a body of revolution: it has no front.
 */
export function orientationFor(dx: number, dz: number, theta: number): Quat {
  return orientationAt(yawFor(dx, dz), theta);
}

/** The yaw that turns the piece's own `+x` onto the ground direction `(dx, dz)`. */
export function yawFor(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

/**
 * The same two rotations, taken as angles rather than as a direction.
 *
 * The settle needs this: a piece that has just landed is facing the way it
 * travelled, and the next jump is down the other isometric axis, so it turns
 * ninety degrees on the spot before it can go. Interpolating the yaw is how
 * that turn happens, and it needs a yaw to interpolate rather than a direction.
 */
export function orientationAt(yaw: number, pitch: number): Quat {
  return qMul(qAxisAngle([0, 1, 0], yaw), qAxisAngle([0, 0, -1], pitch));
}

/** World axis the somersault turns about, for a jump along `(dx, dz)`. */
export function tumbleAxis(dx: number, dz: number): Vec3 {
  return [dz, 0, -dx];
}

export interface Pose3 {
  readonly q: Quat;
  /** 0 upright, positive compresses and spreads, negative stretches. */
  readonly squash: number;
}

/** Squash factors, matching `render.deformOf` so piece and block agree. */
export function deform(squash: number): { wide: number; tall: number } {
  return { wide: 1 + squash * 0.26, tall: 1 - squash * 0.42 };
}

/**
 * World units from the feet up to the centre of mass, at a given squash.
 *
 * `renderPiece` draws about the centre of mass, so anything that knows where
 * the *feet* are — standing on a block, or partway through the flight arc —
 * goes through this to find the point to draw about. A squashed piece's centre
 * of mass drops, which is the whole reason this takes an argument.
 */
export function comLift(squash: number): number {
  return COM_HEIGHT * deform(squash).tall;
}

/**
 * Six numbers a vertex carries into the rasteriser: screen x, screen y, depth,
 * and the colour it was lit to.
 */
const STRIDE = 6;

// Scratch, reused across frames. Reallocating an array a few thousand elements
// long sixty times a second is a garbage collector pause in the middle of a
// jump, which is the one place in this game it would be felt.
let scratch = new Float64Array(0);
let cachedSurface = surface(1, 1);

/**
 * Buffer sizes are rounded up to a multiple of this, in supersampled pixels.
 *
 * The piece's bounding box changes every frame as it turns, so an exact fit
 * means a new surface and a new depth buffer sixty times a second. Quantising
 * costs a strip of transparent pixels down two edges, which composite as
 * nothing, and buys a reallocation only when the piece grows past a step.
 */
const QUANTUM = 32;

function ensure(w: number, h: number): void {
  if (cachedSurface.w !== w || cachedSurface.h !== h) cachedSurface = surface(w, h);
}

/**
 * Project, light and rasterise the knight.
 *
 * `pxScale` is device pixels per world unit — the product of the run's fitted
 * scale and the device pixel ratio. The caller knows it; nothing here reads a
 * DOM to find it out, which is what keeps this runnable in a test.
 */
/** Mutable stand-ins for the immutable `Vertex` the rasteriser reads. */
type Corner = { -readonly [K in keyof Vertex]: Vertex[K] };
const corner: Corner[] = Array.from({ length: 3 }, () => ({
  x: 0,
  y: 0,
  d: 0,
  r: 0,
  g: 0,
  b: 0,
}));

function load(into: Corner, v: Float64Array, index: number, ox: number, oy: number): void {
  const o = index * STRIDE;
  into.x = v[o]! - ox;
  into.y = v[o + 1]! - oy;
  into.d = v[o + 2]!;
  into.r = v[o + 3]!;
  into.g = v[o + 4]!;
  into.b = v[o + 5]!;
}

export function renderPiece(pose: Pose3, pxScale: number): Rendered {
  const mesh = knight();
  const r: Mat3 = qToMat(pose.q);
  const { wide, tall } = deform(pose.squash);
  const scale = Math.min(pxScale, RENDER_CAP);
  const ss = scale * SUPERSAMPLE;

  const count = mesh.positions.length / 3;
  const need = count * STRIDE;
  if (scratch.length < need) scratch = new Float64Array(need);
  const v = scratch;

  // Pass one: pose every vertex, project it, light it, and find the bounding
  // box, all in a single walk of the mesh.
  const nWide = 1 / wide;
  const nTall = 1 / tall;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  // The squash is about the feet — a piece pressed into a block does not lift
  // off it — but the *rotation* is about the centre of mass, because that is
  // what a body in free flight turns about. So the origin of the returned image
  // is the centre of mass, not the feet, and the caller says where that is.
  const pivot = COM_HEIGHT * tall;

  for (let i = 0; i < count; i++) {
    const p = i * 3;
    const lx = mesh.positions[p]! * wide;
    const ly = mesh.positions[p + 1]! * tall - pivot;
    const lz = mesh.positions[p + 2]! * wide;

    const wx = r[0]! * lx + r[1]! * ly + r[2]! * lz;
    const wy = r[3]! * lx + r[4]! * ly + r[5]! * lz;
    const wz = r[6]! * lx + r[7]! * ly + r[8]! * lz;

    const sx = (wx - wz) * ISO_X * ss;
    const sy = (-(wx + wz) * ISO_Y - wy) * ss;
    const sd = isoDepth(wx, wy, wz) * ss;

    const o = i * STRIDE;
    v[o] = sx;
    v[o + 1] = sy;
    v[o + 2] = sd;

    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;

    // The normal gets the inverse-transpose of the squash, which for a diagonal
    // scale is the reciprocal. Skip it and a compressed piece lights as though
    // it were still upright, and the terminator slides off the form.
    const nx0 = mesh.normals[p]! * nWide;
    const ny0 = mesh.normals[p + 1]! * nTall;
    const nz0 = mesh.normals[p + 2]! * nWide;
    let nx = r[0]! * nx0 + r[1]! * ny0 + r[2]! * nz0;
    let ny = r[3]! * nx0 + r[4]! * ny0 + r[5]! * nz0;
    let nz = r[6]! * nx0 + r[7]! * ny0 + r[8]! * nz0;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    // Lit here, once per vertex, rather than once per triangle corner.
    //
    // Every vertex on this mesh has about six triangles round it, so lighting
    // per corner ran the same Blinn exponent six times for the same answer:
    // four thousand of them a frame where seven hundred will do. It is only
    // sound because a vertex belongs to exactly one material, which is what
    // `mesh.vertexMaterials` records.
    const base = MATERIALS[mesh.vertexMaterials[i] === MATERIAL_BASE ? 1 : 0]!;
    const key = KEY[0] * nx + KEY[1] * ny + KEY[2] * nz;
    const fill = FILL[0] * nx + FILL[1] * ny + FILL[2] * nz;
    const half = HALF[0] * nx + HALF[1] * ny + HALF[2] * nz;
    const view = VIEW[0] * nx + VIEW[1] * ny + VIEW[2] * nz;
    const diffuse = KEY_GAIN * (key > 0 ? key : 0) + FILL_GAIN * (fill > 0 ? fill : 0);
    const spec = half > 0 ? SPECULAR * half ** SHININESS : 0;
    const grazing = 1 - (view > 0 ? view : 0);
    const glow = 255 * (spec + RIM * grazing * grazing * grazing);
    const ambient = AMBIENT * (0.55 + 0.45 * ny);
    v[o + 3] = base[0] * diffuse + SKY[0] * ambient + glow;
    v[o + 4] = base[1] * diffuse + SKY[1] * ambient + glow;
    v[o + 5] = base[2] * diffuse + SKY[2] * ambient + glow;
  }

  // Nothing to draw rather than a buffer of infinite width. The projection is
  // linear, so a non-finite pose can only come from upstream — and it did: a
  // zero-length flight divided elapsed time by a flight time of zero and posed
  // the piece at NaN. Fixed at the source in `main.ts`, and refused here as
  // well, because a renderer that takes the whole frame loop down over one bad
  // frame is a worse failure than one that skips it.
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || minX > maxX) {
    return { image: { w: 0, h: 0, rgba: new Uint8ClampedArray(0) }, ox: 0, oy: 0, scale };
  }

  // A margin of one downsampled pixel, so the box filter always has an empty
  // ring to fade into and the silhouette never ends on a hard buffer edge.
  const pad = SUPERSAMPLE;
  const ox = Math.floor(minX) - pad;
  const oy = Math.floor(minY) - pad;
  const w = Math.ceil(maxX) - ox + pad;
  const h = Math.ceil(maxY) - oy + pad;
  const bw = Math.ceil(w / QUANTUM) * QUANTUM;
  const bh = Math.ceil(h / QUANTUM) * QUANTUM;

  ensure(bw, bh);
  const s = cachedSurface;
  clear(s);

  // Pass two: fill. Three vertex records, reused. `triangle` keeps no reference
  // to what it is handed, and a fresh object per corner was four thousand
  // allocations a frame for no benefit at all.
  for (let t = 0; t < mesh.indices.length; t += 3) {
    load(corner[0]!, v, mesh.indices[t]!, ox, oy);
    load(corner[1]!, v, mesh.indices[t + 1]!, ox, oy);
    load(corner[2]!, v, mesh.indices[t + 2]!, ox, oy);
    triangle(s, corner[0]!, corner[1]!, corner[2]!);
  }

  return {
    image: downsample(s, SUPERSAMPLE),
    ox: ox / SUPERSAMPLE,
    oy: oy / SUPERSAMPLE,
    scale,
  };
}
