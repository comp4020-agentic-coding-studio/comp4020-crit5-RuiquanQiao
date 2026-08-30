// A rigid body, and what happens when it hits a block.
//
// This replaces a fall that was a parabola with a rotation bolted onto it: the
// piece drifted sideways at a constant speed, spun at a constant rate about one
// axis, and passed through the block it had just failed to land on as though it
// were not there. It read as an animation of losing rather than as losing.
//
// So the whole of it is integrated instead. Gravity, an inertia tensor taken
// off the actual mesh, impulses with restitution and Coulomb friction resolved
// at contact points, and the tumble as an emergent consequence: a base rim that
// clips the edge of a block gets an upward impulse a long way off the centre of
// mass, and the torque that produces is what sends the piece over. Nothing in
// here decides that the run has ended. `resolveLanding` in `game.ts` is still
// the only place that does; this animates a decision already taken.
//
// Pure, and with no clock: `advance` takes an elapsed time. That is what lets
// `spec/physics.test.ts` assert conservation, penetration and frame-rate
// independence without a browser.

import { PLATFORM_REACH } from "./game.ts";
import { contactPoints, knight, massProperties } from "./mesh.ts";
import {
  type Mat3,
  type Quat,
  QID,
  type Vec3,
  add,
  cross,
  dot,
  length,
  mulMV,
  qIntegrate,
  qToMat,
  scale,
  sub,
  transpose,
} from "./vec.ts";

/** World units per second squared. The same g the jump arc is derived from. */
export { GRAVITY } from "./motion.ts";
import { GRAVITY, impactSpeed } from "./motion.ts";
import { orientationAt, tumbleAxis, yawFor } from "./piece.ts";

/**
 * How bouncy a landing is. Well under a half: a weighted chess piece dropped on
 * a hard surface makes one short hop and a lot of noise, not four clean bounces.
 */
export const RESTITUTION = 0.14;
/** Coulomb friction. High enough that the base grips and tips rather than skids. */
export const FRICTION = 0.45;
/**
 * Bleeds spin so a piece that has come to rest on a face stays there.
 *
 * Applied only in substeps that actually resolved a contact. Applied always, it
 * slows the somersault of a piece falling through open air, which nothing is
 * touching and nothing should be slowing: over a quarter of a second of free
 * flight it took the spin from 11.5 rad/s to 9.6. A body under no torque keeps
 * turning, and `spec/body.test.ts` now says so.
 */
const ANGULAR_DAMPING = 0.7;

/**
 * The integrator runs at a fixed rate whatever the display does.
 *
 * The camera smoothing in `motion.ts` had to learn this the hard way — written
 * as a per-frame constant it panned 2.4x faster at 144Hz than at 60Hz. A
 * collision solver is far less forgiving than a smoothing filter: at a 144Hz
 * step the base rim clips the block's edge and is pushed out again, and at a
 * 30Hz step the same rim is already past the edge by the first sample and the
 * piece falls straight through. Same hold, same seed, different computer,
 * different outcome on screen.
 */
export const SUBSTEP = 1 / 240;
/** A stall must not be paid back all at once. Anything older than this is dropped. */
const MAX_CATCHUP = 0.25;

/** A block, as the solver sees it: a box whose top face is the play plane. */
export interface Slab {
  readonly x: number;
  readonly z: number;
  /** How far the box extends below y = 0. */
  readonly height: number;
}

export interface Body {
  /** Centre of mass. */
  readonly p: Vec3;
  readonly v: Vec3;
  readonly q: Quat;
  /** Angular velocity, in world axes. */
  readonly w: Vec3;
}

export interface Sim {
  readonly body: Body;
  /** Time owed to the integrator but not yet stepped. */
  readonly carry: number;
  /** Substeps in which at least one contact was resolved, since the start. */
  readonly contacts: number;
}

// Taken off the built mesh once, at module load. Both are constants of the
// shape; recomputing them per frame would integrate 1396 triangles sixty times
// a second to get the same two answers.
const MASS = massProperties(knight());
/** Contact points, moved onto the centre of mass so `r` is what the solver wants. */
const CONTACTS: readonly Vec3[] = contactPoints().map((c) => sub(c, MASS.com));

/** Inverse of the body-frame inertia tensor. Also constant. */
const INV_INERTIA: Mat3 = invert(MASS.inertia);

export function inertia(): Mat3 {
  return MASS.inertia;
}

/** 3x3 inverse by cofactors. The tensor is symmetric positive definite, so this
 * cannot hit a zero determinant for any real shape. */
function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

/** The piece standing upright and still, with its feet at `y` on `(x, z)`. */
export function atRest(x: number, y: number, z: number, q: Quat = QID): Body {
  return { p: [x, y + MASS.com[1], z], v: [0, 0, 0], q, w: [0, 0, 0] };
}

/** How far above the feet the centre of mass sits. */
export function comHeight(): number {
  return MASS.com[1];
}

interface Contact {
  /** World offset from the centre of mass to the touching point. */
  readonly r: Vec3;
  /** Unit normal, pointing out of the block. */
  readonly n: Vec3;
  readonly depth: number;
}

/**
 * Where a world point is inside a block, and which face it is nearest getting
 * out through.
 *
 * The face with the *least* penetration, not the top one. Choosing the top
 * unconditionally is what makes a piece that clipped the side of a block
 * levitate up onto it; choosing the nearest face is what makes it scuff down
 * the side and drop, which is the thing that actually happens.
 */
function overlap(point: Vec3, slab: Slab): { n: Vec3; depth: number } | null {
  const dx = point[0] - slab.x;
  const dz = point[2] - slab.z;
  const y = point[1];
  if (y > 0 || y < -slab.height) return null;
  if (Math.abs(dx) > PLATFORM_REACH || Math.abs(dz) > PLATFORM_REACH) return null;

  let n: Vec3 = [0, 1, 0];
  let depth = -y; // out through the top
  const candidates: [Vec3, number][] = [
    [[1, 0, 0], PLATFORM_REACH - dx],
    [[-1, 0, 0], PLATFORM_REACH + dx],
    [[0, 0, 1], PLATFORM_REACH - dz],
    [[0, 0, -1], PLATFORM_REACH + dz],
    [[0, -1, 0], slab.height + y],
  ];
  for (const [candidate, d] of candidates) {
    if (d < depth) {
      depth = d;
      n = candidate;
    }
  }
  return { n, depth };
}

/**
 * One substep: gravity, integration, then contacts.
 *
 * Semi-implicit Euler — velocity first, then position from the *new* velocity.
 * Explicit Euler at this step size gains energy on every bounce and the piece
 * ends up climbing the block it fell off.
 */
function substep(body: Body, slabs: readonly Slab[], h: number): [Body, boolean] {
  let v = add(body.v, [0, -GRAVITY * h, 0]);
  let p = add(body.p, scale(v, h));
  const q = qIntegrate(body.q, body.w, h);
  let w = body.w;

  const r3 = qToMat(q);
  const invI = mulMM(mulMM(r3, INV_INERTIA), transpose(r3));

  const found: Contact[] = [];
  for (const local of CONTACTS) {
    const r = mulMV(r3, local);
    const world = add(p, r);
    let best: Contact | null = null;
    for (const slab of slabs) {
      const hit = overlap(world, slab);
      if (!hit) continue;
      if (!best || hit.depth < best.depth) best = { r, n: hit.n, depth: hit.depth };
    }
    if (best) found.push(best);
  }
  if (found.length === 0) return [{ p, v, q, w }, false];

  // Sequential impulses. One pass per contact, repeated: a base landing on its
  // rim touches at several points at once, and resolving each in isolation
  // leaves the others violated. Four passes is enough for this many points and
  // is bounded work, which matters when it runs inside a frame.
  for (let pass = 0; pass < 2; pass++) {
    for (const contact of found) {
      const { r, n } = contact;
      const vAt = add(v, cross(w, r));
      const vn = dot(vAt, n);
      if (vn >= 0) continue;

      // Effective mass along n for a body of unit mass at offset r.
      const rn = cross(r, n);
      const denom = 1 + dot(n, cross(mulMV(invI, rn), r));
      // Restitution only on the first pass, and only for a real approach: kept
      // on every pass it pumps energy in, and applied to a resting contact it
      // makes the piece jitter forever on the block it came to rest on.
      const bounce = pass === 0 && vn < -40 ? RESTITUTION : 0;
      const j = (-(1 + bounce) * vn) / denom;

      v = add(v, scale(n, j));
      w = add(w, mulMV(invI, cross(r, scale(n, j))));

      // Coulomb friction, along whatever tangential motion is left after the
      // normal impulse. This is what turns a base clipping an edge into a
      // topple: without it the piece slides off the corner flat.
      const after = add(v, cross(w, r));
      const vt = sub(after, scale(n, dot(after, n)));
      const speed = length(vt);
      if (speed < 1e-6) continue;
      const t = scale(vt, -1 / speed);
      const rt = cross(r, t);
      const denomT = 1 + dot(t, cross(mulMV(invI, rt), r));
      const jt = Math.min(speed / denomT, FRICTION * j);
      v = add(v, scale(t, jt));
      w = add(w, mulMV(invI, cross(r, scale(t, jt))));
    }
  }

  w = scale(w, Math.exp(-ANGULAR_DAMPING * h));

  // Push out of the deepest overlap, most of the way rather than all of it.
  // All of it makes a resting contact oscillate between touching and free;
  // none of it lets the piece sink through over a few dozen substeps.
  const deepest = found.reduce((a, b) => (b.depth > a.depth ? b : a));
  p = add(p, scale(deepest.n, deepest.depth * 0.8));

  return [{ p, v, q, w }, true];
}

function mulMM(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out as unknown as Mat3;
}

/**
 * Advance by `dt` seconds, in fixed substeps, keeping the remainder for next
 * time. Deterministic: the same starting state and the same total elapsed time
 * give the same result whatever sizes the frames arrived in.
 */
export function advance(sim: Sim, slabs: readonly Slab[], dt: number): Sim {
  let owed = sim.carry + Math.min(dt, MAX_CATCHUP);
  let body = sim.body;
  let contacts = sim.contacts;
  while (owed >= SUBSTEP) {
    const [next, touched] = substep(body, slabs, SUBSTEP);
    body = next;
    if (touched) contacts++;
    owed -= SUBSTEP;
  }
  return { body, carry: owed, contacts };
}

export function start(body: Body): Sim {
  return { body, carry: 0, contacts: 0 };
}

/** The last instant of a jump that missed. */
export interface Miss {
  /** Ground position the feet reached. */
  readonly x: number;
  readonly z: number;
  /** Unit ground direction of travel. */
  readonly dx: number;
  readonly dz: number;
  /** World units covered, which set the speed and the time in the air. */
  readonly range: number;
  readonly seconds: number;
  /** Scales the somersault's spin. Reduced motion asks for less of it. */
  readonly spin?: number;
}

/**
 * Hand a missed jump to the rigid body, continuously.
 *
 * Every one of the four state variables is the arc's own last instant rather
 * than something chosen to look similar: horizontal speed is the range over the
 * flight time, vertical speed is `impactSpeed` from the same ballistics the
 * flight used, orientation is where the somersault finished, and angular
 * velocity is the rate that somersault was turning at, about the axis it was
 * turning about. There is no seam because there is nothing to seam.
 *
 * It lives here rather than in `main.ts` because three callers need it to be
 * the same launch: the game, `scripts/sweep-falls.ts`, and the test that walks
 * every miss the rule can produce. A launch reimplemented per caller is a test
 * that passes on a body the game never actually creates.
 */
export function launch(miss: Miss): Sim {
  const speed = miss.range / miss.seconds;
  const rate = ((Math.PI * 2) / miss.seconds) * (miss.spin ?? 1);
  const axis = tumbleAxis(miss.dx, miss.dz);
  return start({
    p: [miss.x, MASS.com[1], miss.z],
    v: [miss.dx * speed, impactSpeed(miss.range), miss.dz * speed],
    q: orientationAt(yawFor(miss.dx, miss.dz), 0),
    w: [axis[0] * rate, axis[1] * rate, axis[2] * rate],
  });
}

/**
 * Mechanical energy per unit mass, for the test that a collision can only ever
 * take energy out. Height is measured from the play plane, which is where the
 * blocks' top faces are.
 */
export function energy(body: Body): number {
  const linear = 0.5 * dot(body.v, body.v);
  const r3 = qToMat(body.q);
  const inertiaWorld = mulMM(mulMM(r3, MASS.inertia), transpose(r3));
  const angular = 0.5 * dot(body.w, mulMV(inertiaWorld, body.w));
  return linear + angular + GRAVITY * body.p[1];
}

/**
 * How far the worst contact point is inside a block, or zero if none is.
 *
 * This is the honest measure of penetration, and it is not the same as how low
 * the piece is. A piece tipping over an edge legitimately has points well below
 * the top face — they are over the gap, with nothing under them. The first
 * version of the test asserted on height and reported seventeen units of
 * "penetration" for a piece that was not touching anything.
 */
export function penetration(body: Body, slabs: readonly Slab[]): number {
  const r3 = qToMat(body.q);
  let deepest = 0;
  for (const local of CONTACTS) {
    const world = add(body.p, mulMV(r3, local));
    for (const slab of slabs) {
      const hit = overlap(world, slab);
      if (hit) deepest = Math.max(deepest, hit.depth);
    }
  }
  return deepest;
}

/** The lowest any contact point currently sits, whether or not it is over one. */
export function lowestContact(body: Body): number {
  const r3 = qToMat(body.q);
  let low = Infinity;
  for (const local of CONTACTS) {
    low = Math.min(low, body.p[1] + mulMV(r3, local)[1]);
  }
  return low;
}
