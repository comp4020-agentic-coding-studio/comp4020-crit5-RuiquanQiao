// The piece, as actual geometry: vertices, triangles and normals in the
// piece's own frame. Nothing in here knows about pixels or about the game.
//
// Why a mesh at all. The piece used to be a chess pawn drawn as one fixed 2D
// outline with a horizontal gradient and three flat ellipses painted on to
// suggest a lathe. That fakes light and it cannot fake *facing*: a pawn is a
// body of revolution, so every yaw angle of it looks identical and there is no
// heading to show even if you compute one. A knight has a front. Once the piece
// has a front, the run turning from one isometric axis to the other has to turn
// the piece too, and that is only true if the shape is real.
//
// The piece's own frame: +x is the way it faces, +y is up from its feet, +z is
// across. Feet at y = 0, so `foot` in screen space maps to the local origin.

import {
  type Mat3,
  type Vec3,
  add,
  cross,
  dot,
  normalise,
  scale,
  sub,
} from "./vec.ts";

export interface Mesh {
  /** Flat triples: vertex i is at `positions[3i .. 3i+2]`. */
  readonly positions: Float64Array;
  /** Unit outward normal per vertex, same layout. */
  readonly normals: Float64Array;
  /** Flat triples of vertex indices, wound counter-clockwise seen from outside. */
  readonly indices: Uint32Array;
  /** Index of the material each triangle is painted with. */
  readonly materials: Uint8Array;
  /**
   * The same, per vertex.
   *
   * Redundant on the face of it, and it is there for speed: lighting is done
   * once per vertex rather than once per triangle corner, which is a sixfold
   * saving on a mesh where every vertex has six triangles round it. That is
   * only sound because each part is built with a single material and shares no
   * vertices with any other, so a vertex belongs to exactly one.
   */
  readonly vertexMaterials: Uint8Array;
}

/** Standing height of the piece, ear tip included. Roughly a block tall. */
export const FIGURE_HEIGHT = 83;

/**
 * Height of the centre of mass above the feet.
 *
 * A chess piece is weighted at the base — that is what makes a knocked one
 * rock and come back rather than go over. Measured off the built mesh by
 * `centroidHeight()` and asserted in `spec/mesh.test.ts`, so if the shape is
 * retuned and the mass moves, the test says so rather than the physics quietly
 * changing feel.
 */
export const COM_HEIGHT = 26.3;

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

interface Builder {
  pos: number[];
  idx: number[];
  mat: number[];
  vmat: number[];
}

function vertex(b: Builder, v: Vec3): number {
  const i = b.pos.length / 3;
  b.pos.push(v[0], v[1], v[2]);
  return i;
}

function tri(b: Builder, a: number, c: number, d: number, material: number): void {
  b.idx.push(a, c, d);
  b.mat.push(material);
}

function quad(
  b: Builder,
  a: number,
  c: number,
  d: number,
  e: number,
  material: number,
): void {
  tri(b, a, c, d, material);
  tri(b, a, d, e, material);
}

/**
 * A body of revolution about the y axis, from a profile of `(radius, y)` pairs
 * running bottom to top. Ends with a non-zero radius are capped with a fan, so
 * the result is closed and the underside of the base exists — which matters,
 * because a piece that has been knocked off a block spends most of its fall
 * showing you exactly that face.
 */
function lathe(
  b: Builder,
  profile: readonly (readonly [number, number])[],
  segments: number,
  material: number,
): void {
  const rings = profile.map(([r, y]) =>
    Array.from({ length: segments }, (_, s) => {
      const phi = (s / segments) * Math.PI * 2;
      return vertex(b, [r * Math.cos(phi), y, r * Math.sin(phi)]);
    }),
  );

  for (let j = 0; j + 1 < rings.length; j++) {
    const lo = rings[j]!;
    const hi = rings[j + 1]!;
    for (let s = 0; s < segments; s++) {
      const t = (s + 1) % segments;
      quad(b, lo[s]!, hi[s]!, hi[t]!, lo[t]!, material);
    }
  }

  // Fanned from a hub. Wound so the top cap's normal is +y and the bottom's is
  // -y: `hub -> s -> t` with `t` one step anticlockwise about +y comes out
  // facing *down*, which is the opposite of what reading it left to right
  // suggests, and is why this is spelled out rather than guessed.
  const cap = (ring: number[], y: number, up: boolean) => {
    const hub = vertex(b, [0, y, 0]);
    for (let s = 0; s < segments; s++) {
      const t = (s + 1) % segments;
      if (up) tri(b, hub, ring[t]!, ring[s]!, material);
      else tri(b, hub, ring[s]!, ring[t]!, material);
    }
  };
  const first = profile[0]!;
  const last = profile[profile.length - 1]!;
  if (first[0] > 1e-6) cap(rings[0]!, first[1], false);
  if (last[0] > 1e-6) cap(rings[rings.length - 1]!, last[1], true);
}

/** One point of the head's side view: where it is, and how thick it is there. */
interface Rib {
  /** Forward. */ readonly x: number;
  /** Up. */ readonly y: number;
  /** Half-thickness across, at this point of the outline. */ readonly w: number;
}

/**
 * A closed 2D outline in the forward/up plane, swollen into a solid.
 *
 * The alternative — extruding the outline flat and rounding nothing — gives a
 * biscuit cutter: correct in silhouette from the side and a flat card from
 * anywhere else, which is the whole failing this replaced. So each rib is swept
 * through a half-turn: at the middle of the sweep it sits on the outline
 * exactly, and by either edge it has moved `w` across and pulled `r` back
 * *along its own inward normal*, so the surface leaves the silhouette
 * tangentially instead of at a right angle. That is the difference between a
 * cheek and a chamfer.
 */
function loft(
  b: Builder,
  outline: readonly Rib[],
  slices: number,
  material: number,
): void {
  // The outline is written in whichever direction reads well as prose — this
  // one runs up the back of the neck and down the throat, which is clockwise.
  // Everything below assumes anticlockwise, because that is what makes
  // `(dy, -dx)` the *outward* normal, so the winding is measured and fixed
  // rather than asserted in a comment. Getting this backwards does not fail
  // loudly: it rounds the outline outward instead of inward, and the head
  // inflates into a blob with its surface facing in.
  const twiceArea = outline.reduce((sum, rib, i) => {
    const next = outline[(i + 1) % outline.length]!;
    return sum + (rib.x * next.y - next.x * rib.y);
  }, 0);
  const ribs = twiceArea < 0 ? [...outline].reverse() : outline;
  const n = ribs.length;

  // Outward normal at each rib, averaged from the two edges meeting there.
  // Anticlockwise puts the interior on the left of each edge, so the outward
  // side of an edge (dx, dy) is (dy, -dx).
  const normals: [number, number][] = ribs.map((rib, i) => {
    const prev = ribs[(i - 1 + n) % n]!;
    const next = ribs[(i + 1) % n]!;
    const e1 = [rib.x - prev.x, rib.y - prev.y] as const;
    const e2 = [next.x - rib.x, next.y - rib.y] as const;
    const l1 = Math.hypot(e1[0], e1[1]) || 1;
    const l2 = Math.hypot(e2[0], e2[1]) || 1;
    const nx = e1[1] / l1 + e2[1] / l2;
    const ny = -e1[0] / l1 - e2[0] / l2;
    const l = Math.hypot(nx, ny) || 1;
    return [nx / l, ny / l];
  });

  // Rounding radius. Capped well under the local half-thickness: pulled back
  // further than that, the two sides of a thin part (an ear) cross over each
  // other and the surface turns inside out.
  const radii = ribs.map((rib) => Math.min(rib.w * 0.85, 3.6));

  const rings: number[][] = [];
  for (let k = 0; k <= slices; k++) {
    const alpha = -Math.PI / 2 + (k / slices) * Math.PI;
    const s = Math.sin(alpha);
    const pull = 1 - Math.cos(alpha);
    rings.push(
      ribs.map((rib, i) =>
        vertex(b, [
          rib.x - normals[i]![0] * radii[i]! * pull,
          rib.y - normals[i]![1] * radii[i]! * pull,
          rib.w * s,
        ]),
      ),
    );
  }

  for (let k = 0; k < slices; k++) {
    const lo = rings[k]!;
    const hi = rings[k + 1]!;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      quad(b, lo[i]!, lo[j]!, hi[j]!, hi[i]!, material);
    }
  }

  // The two flanks. Their rings are not planar — `w` varies along the outline —
  // so they are fanned from the ring's own centroid rather than from a plane.
  const capRing = (ring: number[], front: boolean) => {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const v of ring) {
      cx += b.pos[v * 3]!;
      cy += b.pos[v * 3 + 1]!;
      cz += b.pos[v * 3 + 2]!;
    }
    const hub = vertex(b, [cx / n, cy / n, cz / n]);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (front) tri(b, hub, ring[i]!, ring[j]!, material);
      else tri(b, hub, ring[j]!, ring[i]!, material);
    }
  };
  capRing(rings[0]!, false);
  capRing(rings[slices]!, true);
}

// ---------------------------------------------------------------------------
// The knight
// ---------------------------------------------------------------------------

export const MATERIAL_BODY = 0;
export const MATERIAL_BASE = 1;

/**
 * The base and its collar: a flared foot, a rolled edge, a waist and the
 * plinth the head sits on. Rotationally symmetric, as a turned base is.
 */
const BASE_PROFILE: readonly (readonly [number, number])[] = [
  [20.5, 0],
  [22, 1.6],
  [22, 4.2],
  [20.4, 6.6],
  [17.2, 8.6],
  [15.4, 10.4],
  [14.6, 13],
  [15.6, 15],
  [15.2, 16.6],
  [13.4, 18],
  [12.6, 20.5],
];

/**
 * The head and neck in side view, walked anticlockwise: up the back of the
 * neck, over the mane, out to the two ears, down the forehead, along the nose
 * to the muzzle, back under the jaw, and down the throat to the collar.
 *
 * The thicknesses carry as much of the shape as the outline does. A horse's
 * head is widest at the cheek and narrowest at the muzzle and the mane, and
 * getting that backwards gives you a fish. The ears are two spikes in the
 * outline rather than separate cones, which is what a carved Staunton knight
 * actually does with them.
 */
// The first and last ribs sit at y = 15.5, below the collar's top face at 20.5
// and inside its radius. The head is not joined to the base — the two are
// separate closed solids and the depth buffer unions them — so the neck has to
// be buried in the collar rather than resting on it, or you can see the seam
// where the loft's flank cap ends and a sliver of backdrop between the two.
const HEAD_RIBS: readonly Rib[] = [
  { x: -12.4, y: 15.5, w: 11.6 },
  { x: -15.0, y: 27.0, w: 11.0 },
  { x: -15.2, y: 36.0, w: 10.4 },
  { x: -13.4, y: 45.0, w: 9.4 },
  { x: -11.2, y: 53.0, w: 8.2 },
  { x: -10.0, y: 60.0, w: 7.0 },
  { x: -10.8, y: 66.0, w: 5.8 },
  { x: -9.2, y: 71.0, w: 5.6 },
  { x: -8.4, y: 78.5, w: 3.0 },
  { x: -7.2, y: 83.0, w: 2.0 },
  { x: -5.6, y: 76.5, w: 4.6 },
  { x: -3.2, y: 74.0, w: 6.0 },
  { x: -1.4, y: 81.5, w: 2.0 },
  { x: 0.6, y: 76.0, w: 5.2 },
  { x: 2.6, y: 72.6, w: 7.6 },
  { x: 7.4, y: 70.4, w: 8.0 },
  { x: 12.4, y: 65.6, w: 7.4 },
  { x: 17.2, y: 59.4, w: 6.6 },
  { x: 21.8, y: 52.8, w: 6.0 },
  { x: 25.0, y: 47.0, w: 5.4 },
  { x: 26.2, y: 42.6, w: 4.8 },
  { x: 23.4, y: 39.4, w: 5.0 },
  { x: 19.0, y: 39.0, w: 5.8 },
  { x: 14.0, y: 41.0, w: 7.2 },
  { x: 8.6, y: 44.6, w: 8.6 },
  { x: 3.6, y: 43.4, w: 8.4 },
  { x: 1.8, y: 36.0, w: 9.2 },
  { x: 3.4, y: 28.0, w: 10.2 },
  { x: 7.0, y: 22.0, w: 10.8 },
  { x: 10.2, y: 15.5, w: 11.2 },
];

/**
 * Vertex normals, area-weighted over the triangles that share a vertex.
 *
 * Area weighting rather than a plain average because the lathe's fan caps have
 * one hub vertex shared by every cap triangle: unweighted, a hundred slivers
 * outvote the two large triangles beside them and the cap goes lumpy.
 */
function shade(pos: Float64Array, idx: Uint32Array): Float64Array {
  const normals = new Float64Array(pos.length);
  const at = (i: number): Vec3 => [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!];

  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!;
    const b = idx[t + 1]!;
    const c = idx[t + 2]!;
    // Unnormalised, so its length is twice the triangle's area.
    const n = cross(sub(at(b), at(a)), sub(at(c), at(a)));
    for (const v of [a, b, c]) {
      normals[v * 3] += n[0];
      normals[v * 3 + 1] += n[1];
      normals[v * 3 + 2] += n[2];
    }
  }

  for (let v = 0; v < normals.length; v += 3) {
    const u = normalise([normals[v]!, normals[v + 1]!, normals[v + 2]!]);
    normals[v] = u[0];
    normals[v + 1] = u[1];
    normals[v + 2] = u[2];
  }
  return normals;
}

/**
 * Six times the signed volume. Positive when the triangles are wound
 * counter-clockwise seen from outside, which is what back-face culling and the
 * lighting both assume.
 *
 * It is here rather than in a test because getting the winding right by hand
 * across a lathe, two fan caps, a loft and two flank caps is fiddly and
 * checking it is one line. The test asserts it stays positive.
 */
export function signedVolume6(mesh: Mesh): number {
  const { positions: p, indices: i } = mesh;
  let sum = 0;
  for (let t = 0; t < i.length; t += 3) {
    const a = i[t]! * 3;
    const b = i[t + 1]! * 3;
    const c = i[t + 2]! * 3;
    sum += dot(
      [p[a]!, p[a + 1]!, p[a + 2]!],
      cross(
        [p[b]!, p[b + 1]!, p[b + 2]!],
        [p[c]!, p[c + 1]!, p[c + 2]!],
      ),
    );
  }
  return sum;
}

/**
 * Build one closed part on its own, turn it the right way out, and append it.
 *
 * Per part, not once over the finished mesh. A whole-mesh volume check passes
 * as long as the parts' errors cancel, and the first version of this shipped
 * exactly that: a base wound inside out and a head wound inside out summed to a
 * positive volume, so the check was green and the render showed the inside of
 * the base through the outside of it.
 */
function part(into: Builder, material: number, make: (b: Builder) => void): void {
  const b: Builder = { pos: [], idx: [], mat: [], vmat: [] };
  make(b);

  let volume6 = 0;
  const at = (v: number): Vec3 => [b.pos[v * 3]!, b.pos[v * 3 + 1]!, b.pos[v * 3 + 2]!];
  for (let t = 0; t < b.idx.length; t += 3) {
    volume6 += dot(at(b.idx[t]!), cross(at(b.idx[t + 1]!), at(b.idx[t + 2]!)));
  }
  if (volume6 < 0) {
    for (let t = 0; t < b.idx.length; t += 3) {
      const swap = b.idx[t + 1]!;
      b.idx[t + 1] = b.idx[t + 2]!;
      b.idx[t + 2] = swap;
    }
  }

  const offset = into.pos.length / 3;
  into.pos.push(...b.pos);
  for (const i of b.idx) into.idx.push(i + offset);
  into.mat.push(...b.mat);
  for (let v = 0; v < b.pos.length / 3; v++) into.vmat.push(material);
}

function build(): Mesh {
  const b: Builder = { pos: [], idx: [], mat: [], vmat: [] };
  part(b, MATERIAL_BASE, (p) => lathe(p, BASE_PROFILE, 28, MATERIAL_BASE));
  part(b, MATERIAL_BODY, (p) => loft(p, HEAD_RIBS, 12, MATERIAL_BODY));

  const positions = Float64Array.from(b.pos);
  const indices = Uint32Array.from(b.idx);
  return {
    positions,
    indices,
    materials: Uint8Array.from(b.mat),
    vertexMaterials: Uint8Array.from(b.vmat),
    normals: shade(positions, indices),
  };
}

let cached: Mesh | null = null;

/** The knight. Built once — it is a constant, and it is not cheap. */
export function knight(): Mesh {
  cached ??= build();
  return cached;
}

/**
 * Height of the volume centroid above the feet, by the divergence theorem over
 * the closed surface. `COM_HEIGHT` is this number, and the test ties them
 * together so the physics cannot silently disagree with the shape.
 */
export function centroidHeight(mesh: Mesh): number {
  return massProperties(mesh).com[1];
}

export interface MassProperties {
  readonly volume: number;
  readonly com: Vec3;
  /** About the centre of mass, in the piece's own frame, for unit mass. */
  readonly inertia: Mat3;
}

/**
 * Volume, centre of mass and inertia tensor, integrated over the actual solid.
 *
 * Not a cylinder-shaped guess with a fudge factor on it. Every triangle of a
 * closed surface, taken with the origin, is a tetrahedron whose signed volume
 * is `det[a b c] / 6`; the signs cancel over the interior and what is left is
 * the solid. The same decomposition gives the second moment, because the
 * covariance of the canonical tetrahedron is a known constant matrix and an
 * affine map takes it to any other: `C = det(J) · J · C₀ · Jᵀ`.
 *
 * This matters to how the game feels rather than to how it looks. A chess piece
 * is weighted at the base — that is why a knocked one rocks and comes back
 * instead of going straight over — and a box of the same bounding size has
 * nearly twice the moment about a horizontal axis. Guessing it would have meant
 * tuning the tumble by eye until it looked right, which is the thing that later
 * turns out to be right at one frame rate and wrong at another.
 */
export function massProperties(mesh: Mesh): MassProperties {
  const { positions: p, indices: i } = mesh;
  const at = (v: number): Vec3 => [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];

  let volume6 = 0;
  const moment: [number, number, number] = [0, 0, 0];
  // Second moment about the origin, ∫ x_a x_b dV, accumulated row-major.
  const c = new Float64Array(9);

  for (let t = 0; t < i.length; t += 3) {
    const a = at(i[t]!);
    const b = at(i[t + 1]!);
    const d = at(i[t + 2]!);
    const det = dot(a, cross(b, d));
    volume6 += det;
    for (let k = 0; k < 3; k++) moment[k] += det * (a[k]! + b[k]! + d[k]!);

    // det(J) · J · C₀ · Jᵀ with C₀ = ([[2,1,1],[1,2,1],[1,1,2]]) / 120, written
    // out: the diagonal of the bracket is 2·(aa + bb + dd) and the off-diagonal
    // terms are the six cross products, all over 120.
    const k = det / 120;
    for (let r = 0; r < 3; r++) {
      for (let s = 0; s < 3; s++) {
        c[r * 3 + s] +=
          k *
          (2 * (a[r]! * a[s]! + b[r]! * b[s]! + d[r]! * d[s]!) +
            a[r]! * b[s]! + b[r]! * a[s]! +
            a[r]! * d[s]! + d[r]! * a[s]! +
            b[r]! * d[s]! + d[r]! * b[s]!);
      }
    }
  }

  const volume = volume6 / 6;
  const com: Vec3 = [
    moment[0] / 4 / volume6,
    moment[1] / 4 / volume6,
    moment[2] / 4 / volume6,
  ];

  // Parallel axis, to move the second moment onto the centre of mass, then
  // `I = tr(C)·1 - C`, which is the definition rather than a shortcut.
  const cc = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let s = 0; s < 3; s++) {
      cc[r * 3 + s] = c[r * 3 + s]! - volume * com[r]! * com[s]!;
    }
  }
  const trace = cc[0]! + cc[4]! + cc[8]!;
  // Divided through by the volume, so the tensor is per unit *mass*: the piece
  // weighs 1 and nothing downstream has to carry a density around.
  const m = (r: number, s: number) =>
    ((r === s ? trace : 0) - cc[r * 3 + s]!) / volume;

  return {
    volume,
    com,
    inertia: [
      m(0, 0), m(0, 1), m(0, 2),
      m(1, 0), m(1, 1), m(1, 2),
      m(2, 0), m(2, 1), m(2, 2),
    ],
  };
}

/** The mesh's extent along each axis, for framing and for tests. */
export function bounds(mesh: Mesh): { min: Vec3; max: Vec3 } {
  const p = mesh.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < p.length; v += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[v + k]!);
      max[k] = Math.max(max[k]!, p[v + k]!);
    }
  }
  return { min, max };
}

/**
 * The points that are allowed to touch anything.
 *
 * The rigid body resolves contacts at points, not against the mesh — a thousand
 * triangles against a box every substep is the wrong shape of cost for a
 * silhouette this size. These are the places a real knight actually lands on:
 * the rim of its base, which is what catches an edge, plus the muzzle, the poll
 * and the back of the neck, which are what it comes to rest on once it is over.
 */

/**
 * Radius of the ring of contact points around the base — nine units, not the
 * twenty-two the base is actually drawn at.
 *
 * This is the one place the solid and the rule have to be reconciled, so it is
 * worth being exact about. `resolveLanding` treats a landing as a *point*: land
 * within `PLATFORM_REACH` of the centre and you are on, past it and you are
 * off. A base of radius r contradicts that, because a piece whose centre is up
 * to r beyond the edge still has rim under it to stand on. At r = 22 that
 * contradiction is most of a block wide, and it showed: a jump the rule scored
 * as a miss put its toe on the far edge, skated forward on its own momentum and
 * came to rest standing on the block it had just failed to reach. The game said
 * you lost and the picture said you did not.
 *
 * Nine keeps the part of the radius that is worth having — a landing just past
 * the edge still catches its toe and pivots off, which is the whole drama of a
 * near miss — while keeping the disagreement smaller than the piece is wide.
 * `spec/physics.test.ts` sweeps the offsets either side of the edge and asserts
 * that every landing the rule calls a miss ends up below the play plane.
 */
const CONTACT_RADIUS = 9;
export function contactPoints(): readonly Vec3[] {
  const rim: Vec3[] = [];
  for (let s = 0; s < 10; s++) {
    const phi = (s / 10) * Math.PI * 2;
    rim.push([CONTACT_RADIUS * Math.cos(phi), 0.4, CONTACT_RADIUS * Math.sin(phi)]);
  }
  return [
    ...rim,
    [0, 0, 0], // the centre of the underside
    [26.2, 42.6, 0], // muzzle
    [-7.2, 83, 0], // ear
    [-15.2, 36, 0], // back of the neck
    [-13, 19, 0], // back of the collar
    [10.6, 19, 0], // front of the collar
  ];
}

export { add, dot, cross, normalise, scale, sub };
