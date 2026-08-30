import { describe, expect, it } from "vitest";
import { FIGURE_HEIGHT, WORST_PAIR, fitScale } from "../render.ts";

// A sensor, not a contract test: the two viewports below are the ones the work
// is marked at, every week, whatever the brief. It stays in the repo when the
// game does not.
//
// It exists because measuring this in the preview pane does not work. The pane
// renders at its own physical size rather than the emulated viewport, and a
// pane that is not on screen stops compositing — so `resize` never reaches the
// page and the numbers read back are from whatever size it happened to be.
// The framing maths is pure for exactly this reason: pass the viewport in.

const MARKED = [
  { name: "desktop 1920x1080", width: 1920, height: 1080 },
  { name: "phone 390x844", width: 390, height: 844 },
];

describe("the worst pair of blocks fits both marking viewports", () => {
  for (const { name, width, height } of MARKED) {
    describe(name, () => {
      const scale = fitScale(width, height);

      it("fits across, with margin", () => {
        const used = WORST_PAIR.wide * scale;
        expect(used).toBeLessThan(width);
        // Enough left over that the blocks are not jammed against the edges.
        expect(width - used).toBeGreaterThan(width * 0.1);
      });

      it("fits down the screen, leaving room for the arc", () => {
        const used = WORST_PAIR.tall * scale;
        expect(used).toBeLessThan(height);
        expect(height - used).toBeGreaterThan(height * 0.1);
      });

      it("is large enough that the piece is not a speck", () => {
        // Below about 40 device pixels the pawn's collar and ball stop
        // resolving and it reads as a pin.
        expect(FIGURE_HEIGHT * scale).toBeGreaterThan(40);
      });
    });
  }

  it("never returns a degenerate scale, however odd the window", () => {
    for (const [w, h] of [
      [320, 480],
      [1280, 300],
      [3840, 2160],
      [100, 100],
    ]) {
      const scale = fitScale(w!, h!);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThanOrEqual(0.45);
      expect(scale).toBeLessThanOrEqual(2.2);
    }
  });
});
