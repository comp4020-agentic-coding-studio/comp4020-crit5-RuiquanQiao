// Vectors, quaternions and 3x3 matrices. No canvas, no DOM, no clock — the
// mesh, the rasteriser and the rigid body all sit on top of this, which is why
// all three can be exercised in Node and rendered to a PNG without a browser.
//
// Column-major is not used anywhere here. A `Mat3` is nine numbers in row
// order, and `mulMV` reads them as rows, so the transpose of a rotation is its
// inverse and can be written out by hand where the inertia tensor needs it.

export type Vec3 = readonly [number, number, number];
/** `[w, x, y, z]`. Unit length means a rotation. */
export type Quat = readonly [number, number, number, number];
/** Row-major: `[m00, m01, m02, m10, ...]`. */
export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export const V0: Vec3 = [0, 0, 0];

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Unit vector, or the zero vector if there is no direction to give. */
export function normalise(a: Vec3): Vec3 {
  const n = length(a);
  return n < 1e-12 ? V0 : [a[0] / n, a[1] / n, a[2] / n];
}

// ---------------------------------------------------------------------------
// Quaternions
//
// The orientation is a quaternion rather than three angles because the piece
// tumbles freely once it has missed: a body under no torque keeps turning about
// a fixed world axis, and Euler angles cannot express that without gimbal
// trouble at exactly the poses a somersault passes through.
// ---------------------------------------------------------------------------

export const QID: Quat = [1, 0, 0, 0];

export function qMul(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

/** Rotation of `angle` radians about `axis`, right-handed. */
export function qAxisAngle(axis: Vec3, angle: number): Quat {
  const u = normalise(axis);
  if (u === V0) return QID;
  const h = angle / 2;
  const s = Math.sin(h);
  return [Math.cos(h), u[0] * s, u[1] * s, u[2] * s];
}

export function qNormalise(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n < 1e-12) return QID;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/**
 * One step of the orientation ODE: `q̇ = ½ ω q`, integrated and renormalised.
 *
 * Renormalising every step is not optional. Left alone the quaternion drifts
 * off the unit sphere within a second of tumbling, and a non-unit quaternion
 * turns into a scale — the piece quietly grows or shrinks as it falls.
 */
export function qIntegrate(q: Quat, omega: Vec3, dt: number): Quat {
  const w: Quat = [0, omega[0], omega[1], omega[2]];
  const d = qMul(w, q);
  return qNormalise([
    q[0] + 0.5 * d[0] * dt,
    q[1] + 0.5 * d[1] * dt,
    q[2] + 0.5 * d[2] * dt,
    q[3] + 0.5 * d[3] * dt,
  ]);
}

export function qToMat(q: Quat): Mat3 {
  const [w, x, y, z] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  ];
}

export function mulMV(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** For a rotation this is the inverse, which is what the inertia tensor needs. */
export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
