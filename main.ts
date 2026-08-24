// Input, the clock and the camera. The rules are in `game.ts` and the drawing
// is in `render.ts`; this file is the only one that knows both exist.

import {
  MAX_CHARGE_MS,
  MAX_DISTANCE,
  PLATFORM_REACH,
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
import * as sound from "./audio";
import {
  IMPACT_BLOCK,
  IMPACT_FIGURE,
  IMPACT_KICKED,
  SETTLE_MS,
  arcAt,
  cameraProgress,
  easeOutBack,
  easeOutCubic,
  fallAt,
  flightSeconds,
  ring as ringCurve,
  smoothing,
} from "./motion";
import {
  BACKDROP_BOTTOM,
  BACKDROP_TOP,
  type Point,
  drawFigure,
  drawPlatform,
  drawShadow,
  UPRIGHT,
  fitScale,
  iso,
  isoVector,
  sinkOf,
  tumbleUp,
} from "./render";

const canvas = document.querySelector<HTMLCanvasElement>("#stage")!;
const ctx = canvas.getContext("2d")!;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

type Phase = "ready" | "charging" | "flying" | "settling" | "falling" | "over";

interface Flight {
  readonly from: Point;
  readonly to: Point;
  /** World units covered, which sets the apex and the time in the air. */
  readonly range: number;
  readonly ms: number;
  /** Ground direction of travel, so the somersault turns in the right plane. */
  readonly dx: number;
  readonly dz: number;
  readonly landing: Landing;
  started: number;
}

/** A missed landing: the same parabola, continued, with the piece tumbling. */
interface Fall {
  readonly at: Point;
  readonly range: number;
  /** Screen-space horizontal drift per second, already projected. */
  readonly drift: Point;
  readonly dx: number;
  readonly dz: number;
  readonly omega: number;
  readonly theta0: number;
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

/**
 * The blocks worth drawing, oldest first, ending with `current` and `next`.
 *
 * Three was not enough. The camera frames the pair you are jumping between, so
 * the block two back is still partly on screen when it gets dropped, and it
 * vanished mid-pan. Four keeps the discarded one off screen by the time it
 * goes.
 */
let trail: Platform[] = [];
const TRAIL = 4;
/** When each block first existed, so a new one can arrive rather than appear. */
const bornAt = new Map<number, number>();

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
/** The piece's stretch at the instant of contact, decayed away rather than cut. */
let squashAtImpact = 0;
let pop: Pop | null = null;

/** Where the figure's feet are, in unscaled projected space. */
let foot: Point = { x: 0, y: 0 };
/** The piece's own axis, projected. Direction is lean, length is foreshortening. */
let up: Point = UPRIGHT;
let falling: Fall | null = null;

let cam: Point = { x: 0, y: 0 };
let camReady = false;
let lastFrame = -1;
/**
 * The camera holds still through the jump and the settle, then glides.
 *
 * Chasing the target continuously meant it started moving the instant the
 * piece touched down, on top of the settle and the bounce, and three things
 * moving at once read as the whole scene being swapped rather than as the view
 * following the player. `camAt` is when the glide is due to start.
 */
let camFrom: Point = { x: 0, y: 0 };
let camTo: Point = { x: 0, y: 0 };
let landedAt = -1;

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
  // A run can end mid-hold — the charge tone must not outlive it.
  sound.cancelCharge();
  random = rng(seed);
  current = firstPlatform(random);
  next = nextPlatform(current, random);
  previous = null;
  trail = [current, next];
  bornAt.clear();
  // The opening pair is simply there. Only blocks generated during a run
  // animate in, or the first thing a player sees is furniture assembling.
  for (const block of trail) bornAt.set(block.id, Number.NEGATIVE_INFINITY);
  phase = "ready";
  score = 0;
  streak = 0;
  jumps = 0;
  charge = 0;
  blockSquash = 0;
  figureSquash = 0;
  impactStarted = -1;
  releaseStarted = -1;
  squashAtImpact = 0;
  lastFrame = -1;
  up = UPRIGHT;
  falling = null;
  flight = null;
  landedAt = -1;
  pop = null;
  settleFrom = null;
  foot = iso(current.x, current.z);
  camReady = false;
  hopStarted = 0;
}

function beginCharge(now: number): void {
  sound.unlock();
  if (phase === "over") {
    reset();
    return;
  }
  if (phase !== "ready") return;
  phase = "charging";
  chargeStart = now;
  sound.startCharge();
}

function release(now: number): void {
  if (phase !== "charging") return;

  const held = now - chargeStart;
  const travelled = chargeToDistance(held);
  const gap = gapBetween(current, next);
  const landing = resolveLanding(travelled, gap);

  const axis = current.axis;
  const dx = axis === "x" ? 1 : 0;
  const dz = axis === "z" ? 1 : 0;
  const target = iso(current.x + dx * travelled, current.z + dz * travelled);

  flight = {
    from: iso(current.x, current.z),
    to: target,
    range: travelled,
    // Not chosen — derived. One gravity, one launch angle, so a long jump
    // hangs longer than a short one and nobody had to tune a curve for it.
    ms: flightSeconds(travelled) * 1000,
    dx,
    dz,
    landing,
    started: now,
  };

  sound.launch(charge);
  phase = "flying";
  charge = 0;
  releaseStarted = now;
  hasPlayed = true;
  jumps += 1;
}

function land(now: number, landing: Landing): void {
  const shot = flight!;

  if (landing.kind === "fall") {
    // Not a separate animation: the same arc, still under the same gravity,
    // with whatever the piece was doing when it ran out of block.
    const speed = shot.range / (shot.ms / 1000);
    const clipped =
      Math.abs(Math.abs(gapBetween(current, next) - shot.range) - PLATFORM_REACH) < 22;
    const damp = clipped ? 0.45 : 1;
    const drift = isoVector(shot.dx * speed * damp, 0, shot.dz * speed * damp);

    falling = {
      at: foot,
      range: shot.range,
      drift,
      dx: shot.dx,
      dz: shot.dz,
      // Catching the edge kicks it end over end; missing cleanly does not.
      omega: ((Math.PI * 2) / (shot.ms / 1000)) * (clipped ? 2.4 : 1),
      theta0: Math.PI * 2,
      started: now,
    };

    phase = "falling";
    fallStarted = now;
    best = Math.max(best, score);
    if (clipped) sound.scuff();
    sound.lost();
    return;
  }

  if (landing.kind === "stay") {
    // A hold too weak to leave the block. Not a loss; slide back to centre.
    settleFrom = foot;
    settleStarted = now;
    impactStarted = now;
    squashAtImpact = figureSquash;
    up = UPRIGHT;
    phase = "settling";
    streak = 0;
    sound.landed();
    return;
  }

  const points = scoreFor(landing.perfect, streak);
  score += points;
  sound.landed();
  if (landing.perfect) {
    sound.chime(streak);
    pop = { at: foot, points, started: now };
  }
  streak = landing.perfect ? streak + 1 : 0;

  previous = current;
  current = next;
  next = nextPlatform(current, random);
  bornAt.set(next.id, now);
  trail.push(next);
  if (trail.length > TRAIL) {
    const dropped = trail.shift();
    if (dropped) bornAt.delete(dropped.id);
  }

  settleFrom = foot;
  settleStarted = now;
  impactStarted = now;
  squashAtImpact = figureSquash;
  up = UPRIGHT;
  phase = "settling";
  // The view waits until the piece has finished arriving, then glides.
  camFrom = { ...cam };
  camTo = cameraTarget();
  landedAt = now;
}

/** The impact bounce, silenced when the player has asked for less movement. */
function ring(sinceMs: number): number {
  return reduceMotion.matches ? 0 : ringCurve(sinceMs);
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

function step(now: number): void {
  if (phase === "charging") {
    charge = Math.min((now - chargeStart) / MAX_CHARGE_MS, 1);
  }

  if (phase === "charging") sound.setCharge(charge);

  if (phase === "flying" && flight) {
    const t = Math.min((now - flight.started) / flight.ms, 1);
    foot = {
      x: flight.from.x + (flight.to.x - flight.from.x) * t,
      // A parabola, not a sine hump. The difference is invisible on a static
      // shape and obvious on a spinning one, because the rotation is linear in
      // time and a sine's vertical speed is not.
      y: flight.from.y + (flight.to.y - flight.from.y) * t - arcAt(flight.range, t),
    };
    // One somersault, in the vertical plane the piece is actually travelling
    // through — which is diagonal on screen for both isometric axes.
    up = reduceMotion.matches
      ? UPRIGHT
      : tumbleUp(flight.dx, flight.dz, t * Math.PI * 2);
    // Stretched leaving the block and again on the way down, neutral at the
    // apex — the other half of squash-and-stretch.
    figureSquash = reduceMotion.matches ? 0 : -0.32 * Math.abs(Math.cos(t * Math.PI));
    if (t >= 1) {
      land(now, flight.landing);
      flight = null;
      // `land` either starts a fall, which keeps tumbling, or puts the piece
      // back on its feet.
      if (!falling) up = UPRIGHT;
    }
  }

  if (phase === "settling") {
    // Eased, and slower than it was: the piece slides at most 29 world units
    // back to centre while the camera pans a whole gap, and a linear 160ms
    // slide finished long before the pan did, which read as two separate
    // movements rather than one.
    const t = Math.min((now - settleStarted) / SETTLE_MS, 1);
    const e = easeOutCubic(t);
    const home = iso(current.x, current.z);
    const from = settleFrom ?? home;
    foot = {
      x: from.x + (home.x - from.x) * e,
      y: from.y + (home.y - from.y) * e,
    };
    if (t >= 1) phase = "ready";
  }

  if (phase === "falling" && falling) {
    const tau = (now - falling.started) / 1000;
    foot = {
      x: falling.at.x + falling.drift.x * tau,
      // `fallAt` is height above the plane and goes negative, so subtracting
      // it moves the piece down the screen. Same gravity as the arc.
      y: falling.at.y + falling.drift.y * tau - fallAt(falling.range, tau),
    };
    up = reduceMotion.matches
      ? UPRIGHT
      : tumbleUp(falling.dx, falling.dz, falling.theta0 + falling.omega * tau);
    figureSquash = 0;
    if (tau > 1.1) phase = "over";
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
    blockSquash = bounce * IMPACT_BLOCK;
    // The piece arrives stretched. Decaying that away as the bounce ramps in
    // keeps the shape continuous across the frame of contact; cutting straight
    // to the bounce popped it from -0.32 to 0 in one frame.
    const carry =
      impactStarted < 0 ? 0 : squashAtImpact * Math.exp(-((now - impactStarted) / 1000) * 26);
    figureSquash = carry + bounce * IMPACT_FIGURE;
  } else {
    blockSquash = 0;
  }

  // Exponential smoothing on elapsed time, not on frames. As a per-frame
  // constant this panned 2.4x faster on a 144Hz screen than on a 60Hz one,
  // which is a different game depending on the monitor it is marked on.
  const dt = lastFrame < 0 ? 0 : Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  const target = cameraTarget();
  if (!camReady || reduceMotion.matches) {
    cam = target;
    camReady = true;
    landedAt = -1;
    return;
  }

  if (landedAt >= 0) {
    const p = cameraProgress(now - landedAt);
    cam = {
      x: camFrom.x + (camTo.x - camFrom.x) * p,
      y: camFrom.y + (camTo.y - camFrom.y) * p,
    };
    if (p >= 1) landedAt = -1;
    return;
  }

  // Otherwise hold, correcting only slowly for anything that moved the target
  // without a landing — a window resize mid-run.
  const k = smoothing(dt, 2.5);
  cam = { x: cam.x + (target.x - cam.x) * k, y: cam.y + (target.y - cam.y) * k };
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
  const blocks = [...trail].sort((a, b) => b.x + b.z - (a.x + a.z));
  // The block you pushed off springs back too, a third as hard.
  const kicked = ring(now - releaseStarted) * IMPACT_KICKED;
  for (const block of blocks) {
    const deform =
      block === current ? blockSquash : block === previous ? kicked : 0;

    // A block generated mid-run rises into place instead of appearing. The
    // camera frames the pair you are jumping between, so a newly generated
    // target is always already on screen — without this it materialises.
    const age = (now - (bornAt.get(block.id) ?? Number.NEGATIVE_INFINITY)) / 300;
    if (age >= 1 || reduceMotion.matches) {
      drawPlatform(ctx, block, deform);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, age * 1.8));
    ctx.translate(0, (1 - easeOutBack(Math.max(0, age))) * 30);
    drawPlatform(ctx, block, deform);
    ctx.restore();
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

  drawFigure(ctx, { foot: standing, squash: figureSquash, up });

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

let paused = false;

function frame(now: number): void {
  if (!paused) {
    step(now);
    draw(now);
  }
  requestAnimationFrame(frame);
}

/**
 * Render a whole jump as a grid of frames, on the canvas, in one go.
 *
 * A single screenshot of a running game shows one pose, and the preview pane
 * throttles requestAnimationFrame hard enough that sampling the live loop
 * measures nothing. Both of those made it possible to ship motion that was
 * obviously wrong to anyone who played it and invisible to me. This drives the
 * real `step` and `draw` off a virtual clock, so what a tile shows is what the
 * game does at that millisecond — not a reconstruction of it.
 */
function filmstrip(holdMs: number, cols = 5, rows = 4, dtMs = 45, seed = 20260831): void {
  paused = true;
  const realW = width;
  const realH = height;
  const realScale = scale;

  const cellW = realW / cols;
  const cellH = realH / rows;
  width = cellW;
  height = cellH;
  scale = fitScale(cellW, cellH);

  reset(seed);
  const t0 = 1000;
  beginCharge(t0);
  release(t0 + holdMs);
  const start = t0 + holdMs;

  ctx.save();
  ctx.setTransform(
    Math.min(window.devicePixelRatio || 1, 2.5),
    0,
    0,
    Math.min(window.devicePixelRatio || 1, 2.5),
    0,
    0,
  );
  ctx.clearRect(0, 0, realW, realH);
  for (let i = 0; i < cols * rows; i++) {
    const now = start + i * dtMs;
    step(now);
    ctx.save();
    ctx.translate((i % cols) * cellW, Math.floor(i / cols) * cellH);
    ctx.beginPath();
    ctx.rect(0, 0, cellW, cellH);
    ctx.clip();
    draw(now);
    ctx.fillStyle = "rgba(59,63,88,0.5)";
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${i * dtMs}ms ${phase}`, 8, cellH - 6);
    ctx.strokeStyle = "rgba(59,63,88,0.14)";
    ctx.strokeRect(0.5, 0.5, cellW - 1, cellH - 1);
    ctx.restore();
  }
  ctx.restore();

  width = realW;
  height = realH;
  scale = realScale;
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
const endHold = () => release(performance.now());
window.addEventListener("pointerup", endHold);
window.addEventListener("pointercancel", endHold);

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
        blockSquash,
        figureSquash,
        // What the block's top face is doing. This is the number that used to
        // teleport on contact, so it is the one worth being able to sample.
        sink: grounded() ? sinkOf(current, blockSquash) : 0,
        blocks: trail.length,
      };
    },
    /** Drive a jump without a pointer, for measuring rather than playing. */
    hold(ms: number) {
      const now = performance.now();
      beginCharge(now - ms);
      release(now);
    },
    /** Hold time that lands dead centre on the current gap. */
    perfectHold() {
      return (gapBetween(current, next) * MAX_CHARGE_MS) / MAX_DISTANCE;
    },
    filmstrip,
    resume() {
      paused = false;
      lastFrame = -1;
      reset();
    },
    reset,
  },
});
