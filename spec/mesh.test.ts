import { describe, expect, it } from "vitest";
import {
  COM_HEIGHT,
  FIGURE_HEIGHT,
  bounds,
  centroidHeight,
  contactPoints,
  knight,
  massProperties,
  signedVolume6,
} from "../mesh.ts";
import { orientationFor } from "../piece.ts";
import { mulMV, qToMat } from "../vec.ts";

// The piece is geometry now rather than a drawing, and geometry can be wrong in
// ways a picture hides. Two of these were written after the render came out
// visibly broken and it took a while to work out which of four candidate
// mistakes it was; both would have said so immediately.

const mesh = knight();

describe("the knight is a closed solid", () => {
  it("is a manifold: every edge is shared by exactly two triangles, once each way", () => {
    // The strongest single statement about a mesh. A hole, a duplicated face
    // or a triangle wound the wrong way all show up here, and nothing else in
    // this file would catch a hole at all.
    const edges = new Map<string, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const tri = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      for (let i = 0; i < 3; i++) {
        const a = tri[i]!;
        const b = tri[(i + 1) % 3]!;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        edges.set(key, (edges.get(key) ?? 0) + (a < b ? 1 : -1));
      }
    }
    const bad = [...edges].filter(([, n]) => n !== 0);
    expect(bad.length, `${bad.length} edges are not shared exactly once each way`).toBe(0);
  });

  it("is wound outward, so back-face culling removes the inside and not the outside", () => {
    // This is the check that was there and still let a broken mesh through:
    // taken over the whole piece it only says the errors did not cancel. The
    // base and the head were *both* inside out, their volumes summed positive,
    // and the render showed the inside of the base through the outside of it.
    // `mesh.ts` now orients each part on its own; this is the backstop.
    expect(signedVolume6(mesh)).toBeGreaterThan(0);
  });

  it("has a unit normal at every vertex", () => {
    for (let v = 0; v < mesh.normals.length; v += 3) {
      const n = Math.hypot(mesh.normals[v]!, mesh.normals[v + 1]!, mesh.normals[v + 2]!);
      expect(n).toBeCloseTo(1, 6);
    }
  });

  it("has no degenerate triangles", () => {
    let worst = Infinity;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const p = (i: number) => [
        mesh.positions[mesh.indices[t + i]! * 3]!,
        mesh.positions[mesh.indices[t + i]! * 3 + 1]!,
        mesh.positions[mesh.indices[t + i]! * 3 + 2]!,
      ];
      const [a, b, c] = [p(0), p(1), p(2)];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const area = Math.hypot(
        u[1]! * w[2]! - u[2]! * w[1]!,
        u[2]! * w[0]! - u[0]! * w[2]!,
        u[0]! * w[1]! - u[1]! * w[0]!,
      );
      worst = Math.min(worst, area);
    }
    expect(worst).toBeGreaterThan(1e-9);
  });

  it("stands as tall as the layout was fitted for", () => {
    // `render.WORST_PAIR` and `spec/viewports.test.ts` both size the run around
    // this number. If the shape is retuned taller, the framing has to follow.
    const { min, max } = bounds(mesh);
    expect(max[1] - min[1]).toBeCloseTo(FIGURE_HEIGHT, 3);
    expect(min[1]).toBeCloseTo(0, 6);
  });
});

describe("the knight has a front, which is the entire point", () => {
  /** The projected outline's extent along the screen's horizontal, in world units. */
  function silhouette(dx: number, dz: number): { left: number; right: number } {
    const r = qToMat(orientationFor(dx, dz, 0));
    let left = Infinity;
    let right = -Infinity;
    for (let v = 0; v < mesh.positions.length; v += 3) {
      const p = mulMV(r, [
        mesh.positions[v]!,
        mesh.positions[v + 1]!,
        mesh.positions[v + 2]!,
      ]);
      // `iso`'s horizontal component. The vertical one barely moves under yaw,
      // because yaw is a rotation about the screen's own vertical.
      const x = (p[0]! - p[2]!) * Math.cos(Math.PI / 6);
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
    return { left, right };
  }

  it("looks materially different down each of the two axes the run can turn", () => {
    // The complaint this whole change answers: a pawn is a body of revolution,
    // so every heading of it is the same picture and there is nothing to see
    // when the run turns a corner. A knight's muzzle is 26 units in front of
    // its axis and its mane 15 behind, so the two headings put the overhang on
    // opposite sides of the screen.
    const x = silhouette(1, 0);
    const z = silhouette(0, 1);
    expect(x.right).toBeGreaterThan(20);
    expect(z.left).toBeLessThan(-20);
    // Mirror images of each other, to the precision of the shape's own symmetry.
    expect(x.right).toBeCloseTo(-z.left, 6);
    expect(x.left).toBeCloseTo(-z.right, 6);
  });

  it("carries its head off its own axis, which a body of revolution cannot", () => {
    // Measured over the head alone, above the collar. The base is a lathe and
    // is symmetric by construction, so including it in this averages the very
    // asymmetry the test is about back out — the first version of this compared
    // whole-mesh bounds and read 4.2 units of overhang where the head has 11.
    let front = -Infinity;
    let back = Infinity;
    for (let v = 0; v < mesh.positions.length; v += 3) {
      if (mesh.positions[v + 1]! < 30) continue;
      front = Math.max(front, mesh.positions[v]!);
      back = Math.min(back, mesh.positions[v]!);
    }
    expect(front).toBeGreaterThan(24);
    expect(front + back).toBeGreaterThan(9);
  });
});

describe("the mass is where the shape says it is", () => {
  const mass = massProperties(mesh);

  it("agrees with the constant the physics is built on", () => {
    // `COM_HEIGHT` is a number the solver uses every substep, and the shape it
    // came from is a hundred lines of profile that anyone might retune. This is
    // the wire between them.
    expect(centroidHeight(mesh)).toBeCloseTo(COM_HEIGHT, 1);
  });

  it("sits low, as a weighted piece does", () => {
    expect(mass.com[1]).toBeLessThan(FIGURE_HEIGHT * 0.4);
  });

  it("has a symmetric, positive-definite inertia tensor", () => {
    const I = mass.inertia;
    expect(I[1]).toBeCloseTo(I[3]!, 6);
    expect(I[2]).toBeCloseTo(I[6]!, 6);
    expect(I[5]).toBeCloseTo(I[7]!, 6);
    for (const d of [I[0]!, I[4]!, I[8]!]) expect(d).toBeGreaterThan(0);
    // The piece is mirror-symmetric across its own forward/up plane, so nothing
    // couples the sideways axis to the other two. Relative to the diagonal, not
    // absolute: the tensor's own entries run to the hundreds, and the residue
    // left by summing several thousand signed tetrahedra in floating point is
    // about one part in a hundred thousand of that. Asserting an absolute zero
    // here is asserting that double precision is exact.
    const size = Math.max(I[0]!, I[4]!, I[8]!);
    expect(Math.abs(I[2]!) / size).toBeLessThan(1e-4);
    expect(Math.abs(I[5]!) / size).toBeLessThan(1e-4);
  });

  it("turns more easily than the box it fits inside", () => {
    // The reason the tensor is integrated rather than guessed. A bounding box
    // of the same size has its mass out at the corners; the piece has most of
    // its mass in the base. Taking the box would have made every tumble too
    // slow, and it would have been tuned back by eye with a fudge factor.
    const { min, max } = bounds(mesh);
    const half = [
      (max[0]! - min[0]!) / 2,
      (max[1]! - min[1]!) / 2,
      (max[2]! - min[2]!) / 2,
    ];
    const boxIzz = (half[0]! ** 2 + half[1]! ** 2) / 3;
    expect(mass.inertia[8]).toBeLessThan(boxIzz * 0.75);
  });
});

describe("the contact hull", () => {
  const points = contactPoints();

  it("is inside the solid it stands in for", () => {
    const { min, max } = bounds(mesh);
    for (const p of points) {
      for (let k = 0; k < 3; k++) {
        expect(p[k]!).toBeGreaterThanOrEqual(min[k]! - 0.001);
        expect(p[k]!).toBeLessThanOrEqual(max[k]! + 0.001);
      }
    }
  });

  it("keeps its base ring well inside the block's own half-width", () => {
    // Stated as the reason it exists: `resolveLanding` treats a landing as a
    // point, so any base radius is the picture disagreeing with the rule about
    // where the edge is. `spec/physics.test.ts` asserts the consequence — that
    // no miss finishes on top of a block — and this pins the cause.
    const ring = points.filter((p) => p[1]! < 1);
    const radius = Math.max(...ring.map((p) => Math.hypot(p[0]!, p[2]!)));
    expect(radius).toBeLessThan(12);
    expect(radius).toBeGreaterThan(4);
  });
});
