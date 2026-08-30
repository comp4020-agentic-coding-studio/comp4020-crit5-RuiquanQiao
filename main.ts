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
} from "./game.ts";
import * as sound from "./audio.ts";
import {
  IMPACT_BLOCK,
  IMPACT_KICKED,
  SETTLE_MS,
  arcAt,
  cameraProgress,
  easeOutBack,
  easeOutCubic,
  flightSeconds,
  ring as ringCurve,
  smoothing,
} from "./motion.ts";
import {
  BACKDROP_BOTTOM,
  BACKDROP_TOP,
  type Point,
  comAbove,
  drawFigure,
  drawPlatform,
  drawShadow,
  fitScale,
  iso,
  COM_LIFT,
  orientationAt,
  paintOrder,
  sinkOf,
  yawFor,
} from "./render.ts";
import { type Sim, type Slab, advance, launch } from "./physics.ts";
import type { Quat } from "./vec.ts";

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

/**
 * A missed landing, handed to the rigid body in `physics.ts`.
 *
 * The handover is exact rather than approximate, and that is the whole reason
 * it reads as one movement. At the last instant of the arc the piece has a
 * position, a velocity from the ballistics, an orientation from the somersault
 * and an angular velocity from the somersault's rate; the body starts with all
 * four. Before this, the fall restarted with a fresh parabola and a fresh spin,
 * and the seam showed.
 */
interface Fall {
  sim: Sim;
  started: number;
  /** Whether the scuff has been played. It fires on first real contact now. */
  scuffed: boolean;
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
/** Signed squash for the block being stood on. The piece never deforms. */
let blockSquash = 0;
let flight: Flight | null = null;
let fallStarted = 0;
let settleStarted = 0;
let impactStarted = -1;
let releaseStarted = -1;
let pop: Pop | null = null;

/**
 * Where the piece is standing, on the ground plane.
 *
 * Not the centre of the block it is on. A landing leaves the piece exactly
 * where it landed — near an edge if that is where it came down — and the next
 * jump is measured from there. Sliding it back to the middle, which is what
 * this used to do over the settle, quietly gave back whatever the player had
 * got wrong, and looked like the game correcting for them.
 */
let standX = 0;
let standZ = 0;

/** Where the figure's feet are, in unscaled projected space. */
let foot: Point = { x: 0, y: 0 };
/** And where they are on the ground plane, which is what casts the shadow. */
let groundX = 0;
let groundZ = 0;
/** How far above the tops of the blocks, in world units. */
let airHeight = 0;
/**
 * Which way the knight is facing, and how far through its somersault it is.
 *
 * A yaw and a pitch rather than a projected up-vector, because the piece has a
 * front now. A pawn is a body of revolution and looks the same at every yaw, so
 * an axis was all it could carry; a knight's heading is the thing that shows
 * the run turning from one isometric axis to the other, and there is nowhere to
 * put it but here.
 */
let yaw = 0;
let pitch = 0;
/** Where the yaw is turning from and to during the settle. */
let yawFrom = 0;
let yawTo = 0;
let falling: Fall | null = null;
/** Device pixels per world unit. The rasteriser needs it and cannot read it. */
let pxScale = 1;

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
  // The piece is rasterised at device resolution, so it needs the whole chain:
  // world units to CSS pixels to device pixels. Reading it back off the canvas
  // transform would work in a browser and break every test that runs against a
  // stub context, so it is kept here where it is set.
  pxScale = scale * dpr;
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

/** The ground direction you leave a block along, as a unit vector. */
function headingOf(axis: "x" | "z"): [number, number] {
  return axis === "x" ? [1, 0] : [0, 1];
}

/** The blocks, as the solver sees them: boxes whose top faces are the play plane. */
function slabs(): Slab[] {
  return trail.map((b) => ({ x: b.x, z: b.z, height: b.height }));
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
  impactStarted = -1;
  releaseStarted = -1;
  lastFrame = -1;
  yaw = yawFor(...headingOf(current.axis));
  yawFrom = yaw;
  yawTo = yaw;
  pitch = 0;
  falling = null;
  flight = null;
  landedAt = -1;
  pop = null;
  standX = current.x;
  standZ = current.z;
  foot = iso(standX, standZ);
  groundX = standX;
  groundZ = standZ;
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
  const [dx, dz] = headingOf(current.axis);
  // Where the piece is standing, measured along the axis it is about to jump
  // down. Zero at the centre of the block, and up to half a block either way.
  const from = dx * (standX - current.x) + dz * (standZ - current.z);
  const landing = resolveLanding(from, travelled, gap);

  flight = {
    from: iso(standX, standZ),
    to: iso(standX + dx * travelled, standZ + dz * travelled),
    fromX: standX,
    fromZ: standZ,
    range: travelled,
    // Not chosen — derived. One gravity, one launch angle, so a long jump
    // hangs longer than a short one and nobody had to tune a curve for it.
    //
    // Floored at a millisecond because a tap released inside a single frame
    // holds for exactly zero, which covers exactly zero distance, which under
    // one gravity takes exactly zero seconds — and the flight parameter is
    // elapsed over that, so the first frame of it was 0/0. The flat painter
    // swallowed the NaN and drew nothing for one frame; the rasteriser tried to
    // allocate a buffer of infinite width and took the whole frame loop down
    // with it. The bug was always there. Only the second renderer reported it.
    ms: Math.max(1, flightSeconds(travelled) * 1000),
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
    // Everything the body starts with is the arc's own last instant, so there
    // is no seam: horizontal speed from the range and the flight time, vertical
    // speed from the ballistics, orientation from the end of the somersault,
    // and spin from the rate that somersault was turning at.
    //
    // What used to be here instead was a guess dressed as physics. It measured
    // how close the landing was to the block's edge, and if it was within 22
    // units it damped the drift to 0.45 and multiplied the spin by 2.4 — a
    // hand-tuned impression of catching an edge, applied whether or not the
    // piece went anywhere near one, and doing nothing at all about the block
    // itself, which the piece then fell straight through. Now the piece is
    // simply released into a world that has the blocks in it, and clipping an
    // edge is a contact with a torque rather than a coefficient.
    falling = {
      sim: launch({
        x: groundX,
        z: groundZ,
        dx: shot.dx,
        dz: shot.dz,
        range: shot.range,
        seconds: shot.ms / 1000,
        spin: reduced() ? 0.45 : 1,
      }),
      started: now,
      scuffed: false,
    };

    phase = "falling";
    fallStarted = now;
    best = Math.max(best, score);
    sound.lost();
    return;
  }

  if (landing.kind === "stay") {
    // A hold too weak to leave the block. Not a loss, and not a reset either:
    // it moved the piece a little way across the top face and that is where it
    // now stands.
    stand(now);
    turnTo(current.axis);
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

  stand(now);
  turnTo(current.axis);
  phase = "settling";
  // The view waits until the piece has finished arriving, then glides.
  camFrom = { ...cam };
  camTo = cameraTarget();
  landedAt = now;
}

/**
 * Take up a standing position wherever the piece has just come down.
 *
 * The piece keeps the spot it landed on. Everything downstream reads `standX`
 * and `standZ` — the next jump's starting offset, the shadow, the painter's
 * order — so this is the single place the run's position is committed.
 */
function stand(now: number): void {
  standX = groundX;
  standZ = groundZ;
  foot = iso(standX, standZ);
  settleStarted = now;
  impactStarted = now;
}

/**
 * Point the knight at the jump it is about to make, over the settle.
 *
 * It lands facing the way it travelled, and the next block is down the other
 * isometric axis as often as not, so it turns ninety degrees on the spot before
 * it can go. This survives reduced motion, unlike the somersault: which way the
 * piece is facing is *where the next jump goes*, and an accessibility setting
 * must not take information away — only decoration. What it loses there is the
 * spin, not the heading.
 */
function turnTo(axis: "x" | "z"): void {
  pitch = 0;
  yawFrom = yaw;
  yawTo = yawFor(...headingOf(axis));
}

/** The impact bounce, silenced when the player has asked for less movement. */
function ring(sinceMs: number): number {
  return reduced() ? 0 : ringCurve(sinceMs);
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

function step(now: number): void {
  // Elapsed time first, because the rigid body needs it. Clamped, and measured
  // in seconds against the previous frame rather than assumed: the solver runs
  // at a fixed rate underneath and this is only how much of that rate is owed.
  const dt = lastFrame < 0 ? 0 : Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

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
    // One somersault, nose over tail, about the piece's own left/right axis.
    // Applied in the body frame and then yawed, so it is a flip along the line
    // of travel rather than a cartwheel across it — which is what it would be
    // if the same angle were applied about a world axis.
    pitch = reduced() ? 0 : t * Math.PI * 2;
    if (t >= 1) {
      land(now, flight.landing);
      flight = null;
      // `land` either starts a fall, which keeps tumbling, or puts the piece
      // back on its feet.
      if (!falling) pitch = 0;
    }
  }

  if (phase === "settling") {
    // The piece does not move. It landed where it landed and it stays there;
    // what the settle still carries is the impact bounce under it and the
    // ninety-degree turn toward the next jump, both of which take time.
    const t = Math.min((now - settleStarted) / SETTLE_MS, 1);
    airHeight = 0;
    yaw = yawFrom + (yawTo - yawFrom) * easeOutCubic(t);
    if (t >= 1) phase = "ready";
  }

  if (phase === "falling" && falling) {
    // A piece that has missed is falling whatever the setting: keeping it
    // primly upright as it drops off the world is not less motion, it is a
    // different and worse story about what just happened. Reduced motion takes
    // the spin down instead, at launch.
    falling.sim = advance(falling.sim, slabs(), dt);
    const body = falling.sim.body;

    // The scuff is played on the first substep that actually resolved a
    // contact, rather than on a guess about whether the landing was close
    // enough to an edge to count. If you hear it, the piece hit something.
    if (falling.sim.contacts > 0 && !falling.scuffed) {
      falling.scuffed = true;
      sound.scuff();
    }

    groundX = body.p[0];
    groundZ = body.p[2];
    airHeight = 0;
    // Gone when it is well below anything drawn, or after long enough that a
    // solver that has somehow wedged it cannot hold the run open.
    if (body.p[1] < -340 || now - fallStarted > 1300) phase = "over";
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
      const home = iso(standX, standZ);
      foot = { x: home.x, y: home.y - spring * 18 };
      if (t >= 0.55 && impactStarted < hopStarted) impactStarted = hopStarted + 900;
    } else if (t > 1) {
      hopStarted = now + 1400;
      charge = 0;
      foot = iso(standX, standZ);
    }
  }

  // The block deforms; the piece does not. A carved chess knight is a rigid
  // solid, and squashing it along with the block read as rubber. What is left
  // is truer anyway: a squeezed block loses height off its *top*, and the piece
  // rides that face down, so charging still visibly presses the piece into the
  // board — which is what would actually happen. That is the charge feedback,
  // and it survives reduced motion for the same reason it always did.
  if (phase === "charging") {
    blockSquash = charge * 0.9;
  } else if (phase !== "flying") {
    blockSquash = ring(now - impactStarted) * IMPACT_BLOCK;
  } else {
    blockSquash = 0;
  }

  // Exponential smoothing on elapsed time, not on frames. As a per-frame
  // constant this panned 2.4x faster on a 144Hz screen than on a 60Hz one,
  // which is a different game depending on the monitor it is marked on.
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

  drawFigure(ctx, { at: comPoint(sink), q: attitude() }, pxScale);
}

/**
 * Where the piece's centre of mass is on screen.
 *
 * Two sources, because the piece is driven two different ways. Standing, the
 * arc and the settle all track the *feet*, so the centre of mass is lifted off
 * them — and lifted by less when the piece is squashed, which is why `comAbove`
 * takes the squash. Falling, the rigid body tracks the centre of mass itself
 * and the feet are wherever the tumble has put them.
 */
function comPoint(sink: number): Point {
  if (phase === "falling" && falling) {
    const p = falling.sim.body.p;
    return iso(p[0], p[2], p[1]);
  }
  return comAbove({ x: foot.x, y: foot.y + sink });
}

/**
 * How high the piece's centre of mass is above the plane the blocks' tops lie
 * in. The painter's order needs it; see `paintOrder`.
 *
 * The centre of mass, and not the lowest point of the piece, which is what this
 * tried first. A knight leaning out over an edge has its muzzle 26 units in
 * front of its own axis and hanging in mid-air, so its lowest point drops below
 * the top face while it is still standing squarely on the block — and the
 * solver leaves a fraction of a unit of penetration besides. Between them the
 * lowest point hovered either side of zero for a tenth of a second and the
 * painter's order flipped every frame with it. The centre of mass is monotone
 * through the same movement: 28 units up while it rests, decaying through the
 * twenties as it goes over, crossing zero exactly when it has left the block.
 */
function pieceHeight(): number {
  if (phase === "falling" && falling) return falling.sim.body.p[1];
  return airHeight + COM_LIFT;
}

/** The piece's orientation: a yaw and a pitch, or the solver's own quaternion. */
function attitude(): Quat {
  if (phase === "falling" && falling) return falling.sim.body.q;
  return orientationAt(yaw, pitch);
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

  // The block you pushed off springs back too, a third as hard.
  const kicked = ring(now - releaseStarted) * IMPACT_KICKED;

  // Far to near, with the piece in its place among them. The rule is in
  // `paintOrder` and asserted in `spec/paint.test.ts`, because getting it wrong
  // is a quarter of a second of a block painted over the piece's feet — long
  // enough to see and short enough to doubt.
  const { order: blocks, pieceAt } = paintOrder(trail, groundX, groundZ, pieceHeight());

  let placed = 0;
  const placePiece = () => {
    if (placed++) return;
    drawPiece(now);
  };

  for (const [index, block] of blocks.entries()) {
    if (index === pieceAt) placePiece();
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
  if (pieceAt >= blocks.length) placePiece();

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
  // No device pixel ratio here: the strip is written at exactly the pixels it
  // asks for, so that a tile can be compared with a measurement.
  pxScale = scale;

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

// ---------------------------------------------------------------------------
// Input, and the boot. One verb: press and release, wherever the pointer is.
//
// `spec/boot.test.ts` loads the built bundle and drives it through this block,
// because this block was once deleted wholesale by a careless edit and nothing
// noticed. The filmstrip calls `step` and `draw` directly, so it went on
// producing perfect pictures of a game that could not be started or touched,
// and every other test here works on pure functions that the entry point never
// reaches. A tool that bypasses the entry path cannot verify the entry path.
// ---------------------------------------------------------------------------

canvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  // Capture so a finger that slides off the canvas still ends its own hold.
  // It throws for a pointer id the browser does not consider active, and a
  // throw here would swallow the charge — the jump must not depend on it.
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    /* not capturable; the window listeners below still end the hold */
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
        // Where the piece is standing, which is no longer the block's centre.
        stand: [standX, standZ],
        // What the block's top face is doing. This is the number that used to
        // teleport on contact, so it is the one worth being able to sample.
        sink: grounded() ? sinkOf(current, blockSquash) : 0,
        blocks: trail.length,
        // The piece has a heading now, so it is worth being able to read it
        // back: `yaw` should be 0 down the x axis and -pi/2 down the z axis,
        // and it should be turning between them through every settle.
        yaw,
        pitch,
        // And the rigid body, for a fall: where it is, how fast, and how many
        // substeps have actually resolved a contact. `contacts` staying at 0
        // through a fall that visibly hit a block is the bug this reports.
        body: falling
          ? {
              p: falling.sim.body.p,
              v: falling.sim.body.v,
              w: falling.sim.body.w,
              contacts: falling.sim.contacts,
            }
          : null,
      };
    },
    /** Drive a jump without a pointer, for measuring rather than playing. */
    hold(ms: number) {
      const now = performance.now();
      beginCharge(now - ms);
      release(now);
    },
    /**
     * Hold time that lands dead centre on the current gap — from wherever the
     * piece is actually standing, which is the point of it.
     */
    perfectHold() {
      const [dx, dz] = headingOf(current.axis);
      const from = dx * (standX - current.x) + dz * (standZ - current.z);
      return ((gapBetween(current, next) - from) * MAX_CHARGE_MS) / MAX_DISTANCE;
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
