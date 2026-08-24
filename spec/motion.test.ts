import { describe, expect, it } from "vitest";
import { MAX_HEIGHT } from "../game";
import {
  IMPACT_BLOCK,
  RING_MS,
  easeOutBack,
  easeOutCubic,
  ring,
  smoothing,
} from "../motion";
import { fitScale, sinkOf } from "../render";

// A sensor. The bug it was written for: the impact curve started at full
// value, so on the frame of contact the block and the piece standing on it
// both jumped about 20px. Every check in the repo was green — a deformation
// curve that starts away from rest is a discontinuity, not a failure, and the
// only thing that catches it is playing the game or asserting the property.
//
// So the property is asserted: nothing that deforms the world may begin
// anywhere but at rest.

describe("no deformation curve starts anywhere but rest", () => {
  it("the impact bounce is zero at the moment of contact", () => {
    expect(ring(0)).toBe(0);
  });

  it("never moves the ground more than a few pixels in a frame", () => {
    // Asserted in pixels, not in curve units, because pixels are what went
    // wrong: the block's top face is what the piece stands on, so the number
    // that must not jump is how far that face travels between two frames.
    //
    // Worst case everywhere — the tallest block the generator makes, the
    // largest scale either marking viewport uses, and the slowest frame rate,
    // which gives the curve the most time to move between two drawn frames.
    const tallest = { id: 0, x: 0, z: 0, height: MAX_HEIGHT, axis: "x" } as const;
    const scale = Math.max(fitScale(1920, 1080), fitScale(390, 844));
    const FRAME = 1000 / 60;

    let worst = 0;
    for (let ms = 0; ms <= RING_MS + FRAME; ms += FRAME) {
      const a = sinkOf(tallest, ring(ms) * IMPACT_BLOCK) * scale;
      const b = sinkOf(tallest, ring(ms + FRAME) * IMPACT_BLOCK) * scale;
      worst = Math.max(worst, Math.abs(b - a));
    }
    expect(worst, `top face moved ${worst.toFixed(1)}px in one frame`).toBeLessThan(8);
  });

  it("returns to exactly rest, and stays there", () => {
    expect(ring(RING_MS)).toBe(0);
    expect(ring(RING_MS + 1)).toBe(0);
    expect(ring(100000)).toBe(0);
    expect(ring(-1)).toBe(0);
  });
});

describe("the bounce is soft rather than merely damped", () => {
  const sampled = Array.from({ length: RING_MS + 1 }, (_, ms) => ring(ms));

  it("compresses hard enough to be seen", () => {
    expect(Math.max(...sampled)).toBeGreaterThan(0.4);
  });

  it("arrives quickly — an impact, not a swell", () => {
    const peak = sampled.indexOf(Math.max(...sampled));
    expect(peak).toBeGreaterThan(10);
    expect(peak).toBeLessThan(90);
  });

  it("springs past its own resting shape on the rebound", () => {
    // The property that separates a gum drop from a crate: without a negative
    // excursion the material reads as rigid whatever colour it is painted.
    expect(Math.min(...sampled)).toBeLessThan(-0.05);
  });

  it("settles rather than oscillating forever", () => {
    const late = sampled.slice(Math.round(RING_MS * 0.8));
    expect(Math.max(...late.map(Math.abs))).toBeLessThan(0.05);
  });
});

describe("eases land on their endpoints", () => {
  it("easeOutCubic runs 0 to 1 without turning back", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    let previous = -1;
    for (let t = 0; t <= 1; t += 0.02) {
      const v = easeOutCubic(t);
      expect(v).toBeGreaterThan(previous);
      previous = v;
    }
  });

  it("easeOutBack overshoots and comes back to exactly 1", () => {
    expect(easeOutBack(0)).toBeCloseTo(0, 10);
    expect(easeOutBack(1)).toBeCloseTo(1, 10);
    const peak = Math.max(
      ...Array.from({ length: 101 }, (_, i) => easeOutBack(i / 100)),
    );
    expect(peak).toBeGreaterThan(1);
  });
});

describe("smoothing is a rate, not a per-frame constant", () => {
  it("moves the same fraction per second whatever the frame rate", () => {
    // One second of 60Hz frames and one second of 144Hz frames must leave the
    // camera in the same place, or the pan speed depends on the monitor.
    const settle = (fps: number) => {
      let value = 0;
      for (let i = 0; i < fps; i++) value += (1 - value) * smoothing(1 / fps, 9);
      return value;
    };
    expect(settle(144)).toBeCloseTo(settle(60), 3);
  });

  it("is bounded, so a long stall cannot overshoot the target", () => {
    expect(smoothing(10, 9)).toBeLessThanOrEqual(1);
    expect(smoothing(0, 9)).toBe(0);
  });
});
