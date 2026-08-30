// The camera. Two constants and three functions, in their own file because
// both the flat painter (`render.ts`) and the 3D rasteriser (`piece.ts`) need
// them and neither may import the other.

/** 2:1 isometric. One world unit of x goes right-and-down, z goes left-and-down. */
export const ISO_X = Math.cos(Math.PI / 6); // 0.866
export const ISO_Y = Math.sin(Math.PI / 6); // 0.5

export interface Point {
  x: number;
  y: number;
}

/**
 * World (x along one ground axis, z along the other, y up) to unscaled screen
 * space. The camera offset and the device pixel ratio are applied by the
 * caller's transform, so nothing in here reads `window`.
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

/**
 * Screen displacement of a world *direction* under the same camera.
 *
 * `iso` maps points; this maps vectors, which is what an orientation needs. It
 * is just `iso`'s linear part: no translation, and `y` still points up in the
 * world and down on the screen.
 */
export function isoVector(vx: number, vy: number, vz: number): Point {
  return { x: (vx - vz) * ISO_X, y: -(vx + vz) * ISO_Y - vy };
}

/**
 * How far a world point is from the camera, in the same units as the screen.
 *
 * The projection above is orthographic, so it has a null direction — the ray
 * along which points land on the same pixel. Solving `iso(d) = 0` gives
 * `d = (1, -1, 1)`: one step further along both ground axes and one step down.
 * Depth is the component along it, and the sign is chosen so that larger is
 * further away, matching the painter's order the blocks already use (`x + z`)
 * and extending it with height, which blocks do not need and a tumbling piece
 * does.
 */
export function isoDepth(x: number, y: number, z: number): number {
  return x + z - y;
}

/** A piece standing upright: its own axis projects straight up the screen. */
export const UPRIGHT: Point = { x: 0, y: -1 };

/**
 * Where the piece's own vertical axis points after somersaulting `theta`
 * radians while travelling along the ground direction `(dx, dz)`.
 *
 * This is the difference between a tumble and a spin. A rotation applied in
 * screen space turns the piece in the picture plane, which is right only for a
 * jump that happens to run across the screen. Every jump here runs along one of
 * the two isometric axes, so both of them are diagonal on screen and neither is
 * in the picture plane.
 *
 * It is no longer what poses the piece — the piece is a mesh now, and it is
 * turned by a quaternion. What this is for is *checking* that: it states the
 * same rotation in closed form, in two dimensions, and `spec/piece.test.ts`
 * asserts the quaternion path reproduces it to twelve places. A hand-derived
 * scalar and a matrix pipeline agreeing is worth more than either alone.
 */
export function tumbleUp(dx: number, dz: number, theta: number): Point {
  const s = Math.sin(theta);
  return isoVector(dx * s, Math.cos(theta), dz * s);
}
