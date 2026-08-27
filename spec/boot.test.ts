import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

// A sensor, and the most expensive lesson in this repo.
//
// An edit deleted the entire input-and-boot block from main.ts — the pointer
// listeners, the resize handler, `fit()`, and the call that starts the frame
// loop. Nothing went red. Every other test here works on pure functions that
// the entry point never touches, and the debug filmstrip calls `step` and
// `draw` directly, so it went on producing perfect pictures of a game that
// could not be started or touched. It shipped, and the deployed page was a
// blank canvas with a wordmark in the corner.
//
// A tool that bypasses the entry path cannot verify the entry path. So this
// one loads the *built* bundle into a document and plays it: press, hold,
// release, and check the run actually moved.

const DIST = resolve("dist");

/**
 * A 2D context that records nothing and refuses nothing.
 *
 * jsdom has no canvas, and the point here is the wiring rather than the
 * pixels, so every drawing call is a no-op and the few that must return
 * something (gradients) return the least it can be used as.
 */
function stubContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop() {} };
  const noop = () => undefined;
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (key.startsWith("create")) return () => gradient;
        if (key === "measureText") return () => ({ width: 0 });
        if (key === "canvas") return undefined;
        return noop;
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

interface Booted {
  window: Window & typeof globalThis & { __jump: any };
  canvas: HTMLCanvasElement;
}

function boot(width = 1280, height = 800): Booted {
  const bundle = readdirSync(join(DIST, "assets")).find((f) => f.endsWith(".js"));
  expect(bundle, "no javascript bundle in dist/assets — did the build run?").toBeTruthy();

  const dom = new JSDOM(readFileSync(join(DIST, "index.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;

  // jsdom does no layout, so the canvas would report zero and `fit()` would
  // size it to nothing. Give it the viewport the test is asking about.
  const canvas = window.document.querySelector("canvas")!;
  Object.defineProperty(canvas, "clientWidth", { value: width });
  Object.defineProperty(canvas, "clientHeight", { value: height });
  canvas.getContext = stubContext as unknown as HTMLCanvasElement["getContext"];

  // The two browser APIs the entry path reads that jsdom does not provide.
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });

  window.eval(readFileSync(join(DIST, "assets", bundle!), "utf8"));

  return { window: window as never, canvas };
}

function press(booted: Booted): void {
  const { window, canvas } = booted;
  canvas.dispatchEvent(
    new window.Event("pointerdown", { bubbles: true, cancelable: true }) as never,
  );
}

function releaseHold(booted: Booted): void {
  const { window } = booted;
  window.dispatchEvent(new window.Event("pointerup", { bubbles: true }) as never);
}

describe("the built bundle boots", () => {
  let booted: Booted;
  beforeAll(() => {
    booted = boot();
  });

  it("runs without throwing and exposes its state", () => {
    expect(booted.window.__jump, "the bundle never finished evaluating").toBeTruthy();
    expect(booted.window.__jump.state.phase).toBe("ready");
  });

  it("sizes the canvas to the viewport, so there is something to look at", () => {
    // This is the assertion the blank deployed page would have failed: the
    // canvas kept its 300x150 default because `fit()` was never called.
    expect(booted.canvas.width).toBeGreaterThan(0);
    expect(booted.canvas.height).toBeGreaterThan(0);
    expect(booted.window.__jump.state.viewport).toEqual([1280, 800]);
  });

  it("starts with a block under the piece and one to aim at", () => {
    expect(booted.window.__jump.state.gap).toBeGreaterThan(0);
    expect(booted.window.__jump.state.blocks).toBeGreaterThanOrEqual(2);
  });
});

describe("the built bundle can actually be played", () => {
  it("charges while the pointer is held", () => {
    const booted = boot();
    press(booted);
    expect(
      booted.window.__jump.state.phase,
      "pointerdown did not reach the game — is the listener registered?",
    ).toBe("charging");
  });

  it("jumps when the pointer is released", () => {
    const booted = boot();
    press(booted);
    releaseHold(booted);
    const { phase, jumps } = booted.window.__jump.state;
    expect(jumps).toBe(1);
    expect(phase).toBe("flying");
  });

  it("ends a hold released away from the canvas", () => {
    // The listener is on the window for this reason: a charge that never
    // resolves leaves the piece stuck mid-crouch forever.
    const booted = boot();
    press(booted);
    booted.window.document.body.dispatchEvent(
      new booted.window.Event("pointerup", { bubbles: true }) as never,
    );
    expect(booted.window.__jump.state.phase).not.toBe("charging");
  });

  it("plays from the keyboard too", () => {
    const booted = boot();
    const { window } = booted;
    window.dispatchEvent(
      new window.KeyboardEvent("keydown", { code: "Space", bubbles: true }) as never,
    );
    expect(window.__jump.state.phase).toBe("charging");
    window.dispatchEvent(
      new window.KeyboardEvent("keyup", { code: "Space", bubbles: true }) as never,
    );
    expect(window.__jump.state.jumps).toBe(1);
  });
});
