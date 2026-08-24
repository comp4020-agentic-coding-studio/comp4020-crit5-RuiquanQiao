// Input, the clock and the camera. The rules are in `game.ts` and the drawing
// is in `render.ts`; this file is the only one that knows both exist.

import {
  MAX_CHARGE_MS,
  MAX_DISTANCE,
  PLATFORM_REACH,
  type Landing,
  type Platform,
  blockUnder,
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

const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
/** "auto" follows the OS. The other two exist so both paths can be inspected. */
let motionMode: "auto" | "full" | "reduced" = "auto";

/**
 * What reduced motion means here.
 *
 * Not "instant". Instant is the most jarring option there is — the first
 * version of this snapped the camera a whole gap in one frame, which is
 * exactly the discontinuity the full path was rebuilt to remove. So *position*
 * still animates: the arc, the settle, the camera glide. What goes is rotation
 * and elastic overshoot — the somersault, the impact ring, the block arriving
 * with a bounce — which are the parts that actually trigger anyone.
 *
 * And the attract hop stays. It is the only thing that teaches the game, and an
 * accessibility setting must not take the tutorial away; it just loses its
 * spring and becomes a compression.
 */
function reduced(): boolean {
  return motionMode === "auto" ? reduceMotionQuery.matches : motionMode === "reduced";
}

type Phase = "ready" | "charging" | "flying" | "settling" | "falling" | "over";

interface Flight {
  readonly from: Point;
  readonly to: Point;
  /** Ground position the jump started from, so the shadow knows where it is. */
  readonly fromX: number;
  readonly fromZ: number;
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
let settleFromX = 0;
let settleFromZ = 0;
let settleStarted = 0;
let impactStarted = -1;
let releaseStarted = -1;
/** The piece's stretch at the instant of contact, decayed away rather than cut. */
let squashAtImpact = 0;
let pop: Pop | null = null;

/** Where the figure's feet are, in unscaled projected space. */
let foot: Point = { x: 0, y: 0 };
/** And where they are on the ground plane, which is what casts the shadow. */
let groundX = 0;
let groundZ = 0;
/** How far above the tops of the blocks, in world units. */
let airHeight = 0;
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
  groundX = current.x;
  groundZ = current.z;
  airHeight = 0;
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
    fromX: current.x,
    fromZ: current.z,
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
    settleFromX = groundX;
    settleFromZ = groundZ;
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
  settleFromX = groundX;
  settleFromZ = groundZ;
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
  return reduced() ? 0 : ringCurve(sinceMs);
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
    groundX = flight.fromX + flight.dx * flight.range * t;
    groundZ = flight.fromZ + flight.dz * flight.range * t;
    airHeight = arcAt(flight.range, t);
    // One somersault, in the vertical plane the piece is actually travelling
    // through — which is diagonal on screen for both isometric axes.
    up = reduced() ? UPRIGHT : tumbleUp(flight.dx, flight.dz, t * Math.PI * 2);
    // Stretched leaving the block and again on the way down, neutral at the
    // apex — the other half of squash-and-stretch.
    figureSquash = reduced() ? 0 : -0.32 * Math.abs(Math.cos(t * Math.PI));
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
    // The ground point has to ease with the piece, or the shadow snaps to the
    // block's centre while the piece is still sliding over it.
    groundX = settleFromX + (current.x - settleFromX) * e;
    groundZ = settleFromZ + (current.z - settleFromZ) * e;
    airHeight = 0;
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
    // A piece that has missed is falling whatever the setting: keeping it
    // primly upright as it drops off the world is not less motion, it is a
    // different and worse story about what just happened.
    up = tumbleUp(
      falling.dx,
      falling.dz,
      falling.theta0 + falling.omega * tau * (reduced() ? 0.4 : 1),
    );
    figureSquash = 0;
    if (tau > 1.1) phase = "over";
  }

  // The attract hop: with nothing on screen but a figure and a block, the one
  // thing the opening has to say is that the figure compresses and springs.
  // It says it by doing it, and only until the first jump.
  if (phase === "ready" && !hasPlayed) {
    if (hopStarted === 0) hopStarted = now + 1600;
    const t = (now - hopStarted) / 900;
    if (t >= 0 && t <= 1) {
      charge = t < 0.55 ? (t / 0.55) * 0.8 : 0;
      const spring = t < 0.55 || reduced() ? 0 : Math.sin(((t - 0.55) / 0.45) * Math.PI);
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
  if (!camReady) {
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

/** The shadow and the piece, drawn together so they keep the same depth slot. */
function drawPiece(now: number): void {
  void now;
  // Standing on a block that is being squeezed means going down with it. The
  // piece and the top face have to move by the same amount or it wades.
  const sink = grounded() ? sinkOf(current, blockSquash) : 0;
  const standing = { x: foot.x, y: foot.y + sink };

  // The shadow falls on whatever is under the piece, and on nothing at all
  // over the gap. It is the one honest depth cue in the picture, and it turns
  // out to be how you learn to read a jump: it slides out over the void, and
  // whether it reappears on the far block before you land is the whole game.
  const under = blockUnder(trail, groundX, groundZ);
  if (under && phase !== "falling" && phase !== "over") {
    const drop = under === current ? sink : 0;
    // The point on the top face directly under the piece, not the block's
    // centre — they differ by up to half a block when a landing is off-centre.
    drawShadow(
      ctx,
      { x: standing.x, y: iso(groundX, groundZ).y + drop },
      Math.max(0.12, 1 - airHeight / 120),
    );
  }

  drawFigure(ctx, { foot: standing, squash: figureSquash, up });
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

  // The piece belongs in that order too, not on top of it. Overshooting sends
  // it *past* the target — further from the camera — and drawing it last had
  // it sail across the front of a block it was behind. Depth along the ground
  // plane is x+z; anything at least as far away as the piece is drawn first,
  // and the block it is standing on ties, so that one goes underneath.
  const pieceDepth = groundX + groundZ;
  let piecePlaced = false;
  const placePiece = () => {
    if (piecePlaced) return;
    piecePlaced = true;
    drawPiece(now);
  };

  for (const block of blocks) {
    if (block.x + block.z < pieceDepth) placePiece();
    const deform =
      block === current ? blockSquash : block === previous ? kicked : 0;

    // A block generated mid-run rises into place instead of appearing. The
    // camera frames the pair you are jumping between, so a newly generated
    // target is always already on screen — without this it materialises.
    const age = (now - (bornAt.get(block.id) ?? Number.NEGATIVE_INFINITY)) / 300;
    if (age >= 1) {
      drawPlatform(ctx, block, deform);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, age * 1.8));
    // Reduced motion keeps the fade and loses the overshooting rise: it still
    // arrives rather than appearing, without anything springing.
    if (!reduced()) ctx.translate(0, (1 - easeOutBack(Math.max(0, age))) * 30);
    drawPlatform(ctx, block, deform);
    ctx.restore();
  }
  placePiece();

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

  if (chrome) drawHud();
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
/** Off while rendering a link-preview card, which wants the scene and no HUD. */
let chrome = true;

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
function filmstrip(
  holdMs: number,
  cols = 5,
  rows = 4,
  dtMs = 45,
  seed = 20260831,
  pxW = 1500,
  pxH = 1000,
  label = true,
  fromMs = 0,
): void {
  paused = true;
  chrome = label;

  // Explicit pixels rather than the element's size. A hidden pane reports a
  // zero-width canvas, and the whole point of this is to work when the pane is
  // not there.
  canvas.width = pxW;
  canvas.height = pxH;
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const cellW = pxW / cols;
  const cellH = pxH / rows;
  width = cellW;
  height = cellH;
  scale = fitScale(cellW, cellH);

  reset(seed);
  const t0 = 1000;
  beginCharge(t0);
  release(t0 + holdMs);
  const start = t0 + holdMs + fromMs;

  ctx.clearRect(0, 0, pxW, pxH);
  for (let i = 0; i < cols * rows; i++) {
    const now = start + i * dtMs;
    step(now);
    ctx.save();
    ctx.translate((i % cols) * cellW, Math.floor(i / cols) * cellH);
    ctx.beginPath();
    ctx.rect(0, 0, cellW, cellH);
    ctx.clip();
    draw(now);
    if (!label) {
      ctx.restore();
      continue;
    }
    ctx.fillStyle = "rgba(59,63,88,0.65)";
    ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`+${i * dtMs}ms  ${phase}`, 10, cellH - 8);
    ctx.strokeStyle = "rgba(59,63,88,0.16)";
    ctx.strokeRect(0.5, 0.5, cellW - 1, cellH - 1);
    ctx.restore();
  }
  chrome = true;
}

/** Render a strip and post it to the dev server, which writes it to .frames/. */
async function shoot(name: string, holdMs: number, opts: Partial<{
  cols: number;
  rows: number;
  dt: number;
  seed: number;
  w: number;
  h: number;
  label: boolean;
  from: number;
}> = {}): Promise<string> {
  const {
    cols = 5,
    rows = 4,
    dt = 45,
    seed = 20260831,
    w = 1500,
    h = 1000,
    label = true,
    from = 0,
  } = opts;
  filmstrip(holdMs, cols, rows, dt, seed, w, h, label, from);
  await fetch("/__frame", { method: "POST", body: `${name}|${canvas.toDataURL("image/png")}` });
  return `.frames/${name}.png`;
}

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
    shoot,
    get motion() {
      return { mode: motionMode, effective: reduced() ? "reduced" : "full" };
    },
    setMotion(mode: "auto" | "full" | "reduced") {
      motionMode = mode;
    },
    resume() {
      paused = false;
      lastFrame = -1;
      reset();
    },
    reset,
  },
});
