// Input, the clock and the camera. The rules are in `game.ts` and the drawing
// is in `render.ts`; this file is the only one that knows both exist.

import {
  MAX_CHARGE_MS,
  type Landing,
  type Platform,
  chargeToDistance,
  firstPlatform,
  gapBetween,
  nextPlatform,
  resolveLanding,
  rng,
  scoreFor,
} from "./game";
import {
  BACKDROP_BOTTOM,
  BACKDROP_TOP,
  type Point,
  drawFigure,
  drawPlatform,
  drawShadow,
  fitScale,
  iso,
  sinkOf,
} from "./render";

const canvas = document.querySelector<HTMLCanvasElement>("#stage")!;
const ctx = canvas.getContext("2d")!;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

type Phase = "ready" | "charging" | "flying" | "settling" | "falling" | "over";

interface Flight {
  readonly from: Point;
  readonly to: Point;
  readonly arc: number;
  readonly ms: number;
  readonly landing: Landing;
  started: number;
}

interface Pop {
  readonly at: Point;
  readonly points: number;
  started: number;
}

let width = 0;
let height = 0;
let scale = 1;

let random = rng(1);
let current: Platform;
let next: Platform;
let previous: Platform | null = null;

let phase: Phase = "ready";
let score = 0;
let best = 0;
let streak = 0;
let jumps = 0;

let chargeStart = 0;
/** 0..1, how full the charge is. Not a deformation — that is derived below. */
let charge = 0;
/** Signed squash for the block being stood on, and for the piece itself. */
let blockSquash = 0;
let figureSquash = 0;
let flight: Flight | null = null;
let fallStarted = 0;
let settleFrom: Point | null = null;
let settleStarted = 0;
let impactStarted = -1;
let releaseStarted = -1;
let pop: Pop | null = null;

/** Where the figure's feet are, in unscaled projected space. */
let foot: Point = { x: 0, y: 0 };
let spin = 0;
let topple = 0;

let cam: Point = { x: 0, y: 0 };
let camReady = false;

/** Set once the player has taken their first jump; kills the attract hop. */
let hasPlayed = false;
let hopStarted = 0;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * One scale for the whole run, chosen so the widest pair the generator can
 * produce still fits with margin. Re-fitting per jump would keep both blocks
 * on screen too, but the world would breathe in and out under the player.
 */
function fit(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  scale = fitScale(width, height);
  camReady = false;
}

/** The camera frames the pair you are jumping between, and nothing else. */
function cameraTarget(): Point {
  const a = iso(current.x, current.z);
  const b = iso(next.x, next.z);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return {
    x: width / 2 - mid.x * scale,
    y: height * 0.56 - mid.y * scale,
  };
}

/** True while the piece has its feet on `current` rather than being in the air. */
function grounded(): boolean {
  return phase === "ready" || phase === "charging" || phase === "settling";
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function reset(seed = Math.floor(Math.random() * 0xffffffff)): void {
  random = rng(seed);
  current = firstPlatform(random);
  next = nextPlatform(current, random);
  previous = null;
  phase = "ready";
  score = 0;
  streak = 0;
  jumps = 0;
  charge = 0;
  blockSquash = 0;
  figureSquash = 0;
  impactStarted = -1;
  releaseStarted = -1;
  spin = 0;
  topple = 0;
  flight = null;
  pop = null;
  settleFrom = null;
  foot = iso(current.x, current.z);
  camReady = false;
  hopStarted = 0;
}

function beginCharge(now: number): void {
  if (phase === "over") {
    reset();
    return;
  }
  if (phase !== "ready") return;
  phase = "charging";
  chargeStart = now;
}

function release(now: number): void {
  if (phase !== "charging") return;

  const held = now - chargeStart;
  const travelled = chargeToDistance(held);
  const gap = gapBetween(current, next);
  const landing = resolveLanding(travelled, gap);

  const axis = current.axis;
  const target = iso(
    axis === "x" ? current.x + travelled : current.x,
    axis === "z" ? current.z + travelled : current.z,
  );

  flight = {
    from: iso(current.x, current.z),
    to: target,
    arc: 46 + travelled * 0.3,
    ms: 330 + travelled * 0.42,
    landing,
    started: now,
  };

  phase = "flying";
  charge = 0;
  releaseStarted = now;
  hasPlayed = true;
  jumps += 1;
}

function land(now: number, landing: Landing): void {
  if (landing.kind === "fall") {
    phase = "falling";
    fallStarted = now;
    best = Math.max(best, score);
    return;
  }

  if (landing.kind === "stay") {
    // A hold too weak to leave the block. Not a loss; slide back to centre.
    settleFrom = foot;
    settleStarted = now;
    impactStarted = now;
    phase = "settling";
    streak = 0;
    return;
  }

  const points = scoreFor(landing.perfect, streak);
  score += points;
  streak = landing.perfect ? streak + 1 : 0;
  if (landing.perfect) pop = { at: foot, points, started: now };

  previous = current;
  current = next;
  next = nextPlatform(current, random);
  settleFrom = foot;
  settleStarted = now;
  impactStarted = now;
  phase = "settling";
}

/**
 * A damped bounce. 1 at the moment of impact, ringing out inside about 0.6s.
 *
 * This is the whole difference between landing on a crate and landing on a
 * gum drop: a single ease back to rest reads as rigid however soft the colours
 * are, because nothing overshoots. The cosine crosses zero and goes negative,
 * so the block flattens, springs past its own height, and settles.
 */
function ring(sinceMs: number): number {
  if (sinceMs < 0 || reduceMotion.matches) return 0;
  const t = sinceMs / 1000;
  if (t > 0.62) return 0;
  return Math.exp(-t * 9.5) * Math.cos(t * 33);
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

function step(now: number): void {
  if (phase === "charging") {
    charge = Math.min((now - chargeStart) / MAX_CHARGE_MS, 1);
  }

  if (phase === "flying" && flight) {
    const t = Math.min((now - flight.started) / flight.ms, 1);
    foot = {
      x: flight.from.x + (flight.to.x - flight.from.x) * t,
      y:
        flight.from.y +
        (flight.to.y - flight.from.y) * t -
        Math.sin(t * Math.PI) * flight.arc,
    };
    spin = reduceMotion.matches ? 0 : t * Math.PI * 2;
    // Stretched leaving the block and again on the way down, neutral at the
    // apex — the other half of squash-and-stretch.
    figureSquash = reduceMotion.matches ? 0 : -0.32 * Math.abs(Math.cos(t * Math.PI));
    if (t >= 1) {
      spin = 0;
      land(now, flight.landing);
      flight = null;
    }
  }

  if (phase === "settling") {
    const t = Math.min((now - settleStarted) / 160, 1);
    const home = iso(current.x, current.z);
    const from = settleFrom ?? home;
    foot = {
      x: from.x + (home.x - from.x) * t,
      y: from.y + (home.y - from.y) * t,
    };
    if (t >= 1) phase = "ready";
  }

  if (phase === "falling") {
    const t = (now - fallStarted) / 1000;
    foot = { x: foot.x, y: foot.y + 1400 * t * 0.016 };
    topple = Math.min(t * 3.2, Math.PI / 2);
    if (t > 0.85) phase = "over";
  }

  // The attract hop: with nothing on screen but a figure and a block, the one
  // thing the opening has to say is that the figure compresses and springs.
  // It says it by doing it, and only until the first jump.
  if (phase === "ready" && !hasPlayed && !reduceMotion.matches) {
    if (hopStarted === 0) hopStarted = now + 1600;
    const t = (now - hopStarted) / 900;
    if (t >= 0 && t <= 1) {
      charge = t < 0.55 ? (t / 0.55) * 0.8 : 0;
      const spring = t < 0.55 ? 0 : Math.sin(((t - 0.55) / 0.45) * Math.PI);
      const home = iso(current.x, current.z);
      foot = { x: home.x, y: home.y - spring * 18 };
      if (t >= 0.55 && impactStarted < hopStarted) impactStarted = hopStarted + 900;
    } else if (t > 1) {
      hopStarted = now + 1400;
      charge = 0;
      foot = iso(current.x, current.z);
    }
  }

  // Charge deforms; impact rings. The charge squash is feedback — it is how
  // you read how far the next jump goes — so reduced motion keeps it and
  // drops only the ringing.
  if (phase === "charging") {
    blockSquash = charge * 0.9;
    figureSquash = charge;
  } else if (phase !== "flying") {
    const bounce = ring(now - impactStarted);
    blockSquash = bounce * 0.6;
    figureSquash = bounce * 0.85;
  } else {
    blockSquash = 0;
  }

  const target = cameraTarget();
  if (!camReady) {
    cam = target;
    camReady = true;
  } else {
    const k = reduceMotion.matches ? 1 : 0.14;
    cam = { x: cam.x + (target.x - cam.x) * k, y: cam.y + (target.y - cam.y) * k };
  }
}

function draw(now: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, BACKDROP_TOP);
  sky.addColorStop(1, BACKDROP_BOTTOM);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(cam.x, cam.y);
  ctx.scale(scale, scale);

  // Far to near, so the near blocks overlap the far ones.
  const blocks = [previous, current, next].filter((p): p is Platform => p !== null);
  blocks.sort((a, b) => b.x + b.z - (a.x + a.z));
  // The block you pushed off springs back too, a third as hard.
  const kicked = ring(now - releaseStarted) * 0.35;
  for (const block of blocks) {
    const deform =
      block === current ? blockSquash : block === previous ? kicked : 0;
    drawPlatform(ctx, block, deform);
  }

  // Standing on a block that is being squeezed means going down with it. The
  // piece and the top face have to move by the same amount or it wades.
  const sink = grounded() ? sinkOf(current, blockSquash) : 0;
  const top = iso(current.x, current.z);
  const standing = { x: foot.x, y: foot.y + sink };
  const airborne = Math.max(0, (top.y + sink - standing.y) / 90);
  if (phase !== "falling" && phase !== "over") {
    drawShadow(ctx, { x: standing.x, y: top.y + sink }, Math.max(0, 1 - airborne));
  }

  drawFigure(ctx, { foot: standing, squash: figureSquash, spin, topple });

  if (pop) {
    const t = (now - pop.started) / 700;
    if (t > 1) {
      pop = null;
    } else {
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = "#3b3f58";
      ctx.font = "600 18px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`+${pop.points}`, pop.at.x, pop.at.y - 58 - t * 26);
      ctx.restore();
    }
  }

  ctx.restore();

  drawHud();
}

function drawHud(): void {
  // The running score is the corner one. When the run is over it becomes the
  // only thing on screen, so the corner copy goes — two of the same number in
  // two sizes reads as a bug.
  if (phase !== "over") {
    ctx.save();
    ctx.fillStyle = "#3b3f58";
    ctx.textBaseline = "top";
    ctx.font = `700 ${Math.round(Math.min(64, width * 0.11))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(String(score), 26, 22);

    if (streak > 1) {
      ctx.globalAlpha = 0.55;
      ctx.font = "600 15px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(`×${streak}`, 28, 22 + Math.min(64, width * 0.11) + 6);
    }
    ctx.restore();
    return;
  }

  // A scrim heavy enough to be a scrim. At 0.86 the blocks showed through as
  // ghosts behind the number and read as a rendering fault rather than a card.
  ctx.save();
  ctx.fillStyle = "rgba(238, 241, 246, 0.95)";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#3b3f58";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const size = Math.round(Math.min(190, width * 0.34));
  ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(String(score), width / 2, height * 0.46);
  if (best > score) {
    ctx.globalAlpha = 0.38;
    ctx.font = "600 22px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(String(best), width / 2, height * 0.46 + size * 0.72);
  }
  ctx.restore();
}

function frame(now: number): void {
  step(now);
  draw(now);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Input — one verb, press and release, wherever the pointer is.
// ---------------------------------------------------------------------------

canvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  // Capture so a finger that slides off the canvas still ends its own hold.
  // It throws for a pointer id the browser does not consider active, and a
  // throw here would swallow the charge — the jump must not depend on it.
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    /* not capturable; the window-level listeners below still end the hold */
  }
  beginCharge(performance.now());
});

// On the window, not the canvas: a hold that ends with the pointer somewhere
// else — dragged off the edge, or over the wordmark — is still a released hold,
// and a charge that never resolves leaves the piece stuck mid-crouch.
const up = () => release(performance.now());
window.addEventListener("pointerup", up);
window.addEventListener("pointercancel", up);

window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  event.preventDefault();
  beginCharge(performance.now());
});
window.addEventListener("keyup", (event) => {
  if (event.code !== "Space") return;
  event.preventDefault();
  release(performance.now());
});

window.addEventListener("resize", fit);

fit();
reset();
requestAnimationFrame(frame);

// Read the run's state from here rather than from a screenshot: the preview
// pane renders at its own physical size, so it lies about 1920x1080 and
// 390x844. (Sensor carried over from the guzheng.)
Object.defineProperty(window, "__jump", {
  value: {
    get state() {
      return {
        phase,
        score,
        streak,
        jumps,
        scale,
        viewport: [width, height],
        gap: gapBetween(current, next),
        charge,
      };
    },
    /** Drive a jump without a pointer, for measuring rather than playing. */
    hold(ms: number) {
      const now = performance.now();
      beginCharge(now - ms);
      release(now);
    },
    reset,
  },
});
