import { describe, expect, it } from "vitest";
import { MAX_GAP, MIN_GAP } from "../game";
import {
  CAM_GLIDE_MS,
  GRAVITY,
  SETTLE_MS,
  arcAt,
  arcHeight,
  cameraProgress,
  fallAt,
  flightSeconds,
  impactSpeed,
} from "../motion";
import { UPRIGHT, isoVector, tumbleUp } from "../render";

// The arc used to be `sin(pi * t) * height`, which looks like a jump and is
// not one. It only started to matter once the piece somersaulted: rotation is
// linear in time, a sine's vertical speed is not, and the mismatch reads as
// the piece being dragged along a wire. So the trajectory is asserted as
// physics — one gravity, one launch angle, everything else derived — rather
// than as a shape someone liked.

const RANGES = [MIN_GAP, 150, 220, MAX_GAP];

describe("the jump is a projectile under one constant gravity", () => {
  for (const range of RANGES) {
    it(`accelerates downward at exactly g for a ${range}-unit jump`, () => {
      // Second difference of height with respect to *seconds* is the vertical
      // acceleration. If this is g, the path is the real thing and not a curve
      // that happens to start and end in the right places.
      const T = flightSeconds(range);
      const h = (tau: number) => arcAt(range, tau / T);
      const dt = 0.001;
      for (const tau of [0.1 * T, 0.35 * T, 0.5 * T, 0.8 * T]) {
        const accel = (h(tau + dt) - 2 * h(tau) + h(tau - dt)) / dt ** 2;
        expect(accel).toBeCloseTo(-GRAVITY, 0);
      }
    });
  }

  it("leaves and lands on the same plane", () => {
    for (const range of RANGES) {
      expect(arcAt(range, 0)).toBeCloseTo(0, 9);
      expect(arcAt(range, 1)).toBeCloseTo(0, 9);
    }
  });

  it("peaks in the middle, at the height the launch angle implies", () => {
    for (const range of RANGES) {
      expect(arcAt(range, 0.5)).toBeCloseTo(arcHeight(range), 9);
    }
  });

  it("hangs longer for a longer jump, as the square root of the range", () => {
    // Nobody tuned this. It falls out of fixing gravity and the launch angle,
    // and it is the reason a big jump feels heavy without a special case.
    expect(flightSeconds(4 * MIN_GAP)).toBeCloseTo(2 * flightSeconds(MIN_GAP), 6);
    for (const range of RANGES) {
      const T = flightSeconds(range) * 1000;
      expect(T).toBeGreaterThan(300);
      expect(T).toBeLessThan(750);
    }
  });
});

describe("a missed landing is the same parabola, continued", () => {
  it("carries the contact speed into the fall, with no kink", () => {
    // Velocity has to match across the moment of contact or the piece visibly
    // changes its mind about how fast it was falling.
    for (const range of RANGES) {
      const T = flightSeconds(range);
      const dt = 0.0005;
      const arcSpeed = (arcAt(range, 1) - arcAt(range, 1 - dt / T)) / dt;
      const fallSpeed = (fallAt(range, dt) - fallAt(range, 0)) / dt;
      // Relative, because these are one-sided differences: under g=2127 each
      // carries about 0.5*g*dt of truncation error, so an absolute tolerance
      // here would be testing the arithmetic in the test rather than the
      // continuity in the game.
      expect(Math.abs(fallSpeed - arcSpeed) / Math.abs(arcSpeed)).toBeLessThan(0.01);
      expect(Math.abs(fallSpeed - impactSpeed(range)) / Math.abs(impactSpeed(range))).toBeLessThan(
        0.01,
      );
    }
  });

  it("keeps accelerating at g on the way down", () => {
    const range = 220;
    const dt = 0.001;
    for (const tau of [0.05, 0.3, 0.7]) {
      const accel =
        (fallAt(range, tau + dt) - 2 * fallAt(range, tau) + fallAt(range, tau - dt)) /
        dt ** 2;
      expect(accel).toBeCloseTo(-GRAVITY, 0);
    }
  });

  it("is well below the blocks within about a second", () => {
    expect(fallAt(MIN_GAP, 1.0)).toBeLessThan(-800);
  });
});

describe("the piece tumbles in the plane it is travelling through", () => {
  // The complaint this answers: both isometric axes are diagonal on screen, so
  // a rotation applied in screen space is wrong for both of them. The piece
  // has to turn about a horizontal axis perpendicular to its own travel.

  it("stands upright at the start and end of a somersault", () => {
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
    ]) {
      const start = tumbleUp(dx!, dz!, 0);
      expect(start.x).toBeCloseTo(UPRIGHT.x, 9);
      expect(start.y).toBeCloseTo(UPRIGHT.y, 9);
      const end = tumbleUp(dx!, dz!, Math.PI * 2);
      expect(end.x).toBeCloseTo(UPRIGHT.x, 9);
      expect(end.y).toBeCloseTo(UPRIGHT.y, 9);
    }
  });

  it("is upside down halfway round", () => {
    const half = tumbleUp(1, 0, Math.PI);
    expect(half.x).toBeCloseTo(0, 9);
    expect(half.y).toBeCloseTo(1, 9); // screen y grows downward
  });

  it("tips the way it is going, and the two axes lean opposite ways", () => {
    // This is the whole point. Travelling along x the piece leans to screen
    // right; along z, to screen left. A screen-space spin cannot tell them
    // apart, and that is what made the jump look fake.
    const alongX = tumbleUp(1, 0, Math.PI / 2);
    const alongZ = tumbleUp(0, 1, Math.PI / 2);
    expect(alongX.x).toBeGreaterThan(0);
    expect(alongZ.x).toBeLessThan(0);
    expect(Math.sign(alongX.x)).not.toBe(Math.sign(alongZ.x));

    // And each points along its own direction of travel, projected.
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
    ]) {
      const flat = tumbleUp(dx!, dz!, Math.PI / 2);
      const travel = isoVector(dx!, 0, dz!);
      const cross = flat.x * travel.y - flat.y * travel.x;
      expect(cross).toBeCloseTo(0, 9);
    }
  });

  it("foreshortens, so the piece is not just a rotating cut-out", () => {
    const lengths = Array.from({ length: 73 }, (_, i) =>
      Math.hypot(...Object.values(tumbleUp(1, 0, (i * Math.PI) / 36)) as [number, number]),
    );
    // A flat spin would keep the apparent length at exactly 1 the whole way.
    expect(Math.max(...lengths)).toBeGreaterThan(1.15);
    expect(Math.min(...lengths)).toBeLessThan(0.8);
  });
});

describe("the view holds still while the piece lands, then glides", () => {
  it("does not move at all until the piece has settled", () => {
    for (let ms = 0; ms <= SETTLE_MS; ms += 10) {
      expect(cameraProgress(ms), `camera moved at ${ms}ms`).toBe(0);
    }
  });

  it("arrives, exactly, and stays", () => {
    expect(cameraProgress(SETTLE_MS + CAM_GLIDE_MS)).toBeCloseTo(1, 9);
    expect(cameraProgress(SETTLE_MS + CAM_GLIDE_MS + 5000)).toBe(1);
  });

  it("starts and stops gently rather than at full speed", () => {
    // An ease-out alone leaves at full speed, and the departure is what reads
    // as a cut. Speed at both ends must be a fraction of the speed at the
    // midpoint.
    const speed = (ms: number) => cameraProgress(ms + 1) - cameraProgress(ms - 1);
    const mid = speed(SETTLE_MS + CAM_GLIDE_MS / 2);
    expect(speed(SETTLE_MS + 12)).toBeLessThan(mid * 0.25);
    expect(speed(SETTLE_MS + CAM_GLIDE_MS - 12)).toBeLessThan(mid * 0.25);
  });

  it("is over well inside a second, so play is never waiting on it", () => {
    expect(SETTLE_MS + CAM_GLIDE_MS).toBeLessThan(1000);
  });
});
