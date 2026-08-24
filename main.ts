// Input, the clock and the camera. The rules are in `game.ts` and the drawing
// is in `render.ts`; this file is the only one that knows both exist.

import {
  MAX_CHARGE_MS,
  MAX_GAP,
  PLATFORM_SIZE,
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
  iso,
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
let squash = 0;
let flight: Flight | null = null;
let fallStarted = 0;
let settleFrom: Point | null = null;
let settleStarted = 0;
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

const ISO_X = Math.cos(Math.PI / 6);
const ISO_Y = Math.sin(Math.PI / 6);

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

  // Worst case is the widest gap the generator can place, plus a block at each
  // end, plus room for the figure standing on the far one and the arc it flies.
  const worstWide = MAX_GAP * ISO_X + PLATFORM_SIZE * ISO_X * 2;
  const worstTall = MAX_GAP * ISO_Y + PLATFORM_SIZE * ISO_Y * 2 + 150;
  scale = Math.max(
    0.45,
    Math.min(2.2, Math.min((width * 0.86) / worstWide, (height * 0.62) / worstTall)),
  );
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

function toScreen(p: Point): Point {
  return { x: p.x * scale + cam.x, y: p.y * scale + cam.y };
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
  squash = 0;
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
  squash = 0;
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
  phase = "settling";
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

function step(now: number): void {
  if (phase === "charging") {
    squash = Math.min((now - chargeStart) / MAX_CHARGE_MS, 1);
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
      squash = t < 0.55 ? (t / 0.55) * 0.75 : 0;
      const spring = t < 0.55 ? 0 : Math.sin(((t - 0.55) / 0.45) * Math.PI);
      const home = iso(current.x, current.z);
      foot = { x: home.x, y: home.y - spring * 16 };
    } else if (t > 1) {
      hopStarted = now + 1400;
      squash = 0;
      foot = iso(current.x, current.z);
    }
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
  for (const block of blocks) {
    drawPlatform(ctx, block, block === current ? squash : 0);
  }

  const ground = iso(current.x, current.z);
  const airborne = Math.max(0, (ground.y - foot.y) / 90);
  if (phase !== "falling" && phase !== "over") {
    drawShadow(ctx, { x: foot.x, y: ground.y }, Math.max(0, 1 - airborne));
  }

  drawFigure(ctx, { foot, squash, spin, topple });

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

  if (phase !== "over") return;

  ctx.save();
  ctx.fillStyle = "rgba(238, 241, 246, 0.86)";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#3b3f58";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(Math.min(150, width * 0.3))}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(String(score), width / 2, height * 0.45);
  if (best > score) {
    ctx.globalAlpha = 0.45;
    ctx.font = "600 20px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(String(best), width / 2, height * 0.45 + Math.min(150, width * 0.3) * 0.7);
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
  canvas.setPointerCapture(event.pointerId);
  beginCharge(performance.now());
});

const up = () => release(performance.now());
canvas.addEventListener("pointerup", up);
canvas.addEventListener("pointercancel", up);

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
        squash,
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
