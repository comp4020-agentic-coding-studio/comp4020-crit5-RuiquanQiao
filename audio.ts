// The sound. Synthesised, so there is nothing to fetch and nothing to 403 a
// deploy, and so the charge tone can track the hold continuously rather than
// being a clip that either has or has not finished.
//
// Nothing here runs until a real pointer or key press, because a browser keeps
// an AudioContext suspended otherwise and the page goes silently dead.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** Call from inside a user gesture. Safe to call on every press. */
export function unlock(): void {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state !== "running") void ctx.resume();
}

/** The charge tone: pitch rises with the hold, which is the point of it. */
export const CHARGE_LOW = 180;
export const CHARGE_HIGH = 900;

/** Hold 0..1 to the frequency the charge tone sings at. */
export function chargeHz(charge: number): number {
  // Geometric, not linear: pitch is heard in ratios, so a linear ramp sounds
  // like it stalls at the top exactly where the aiming gets delicate.
  return CHARGE_LOW * (CHARGE_HIGH / CHARGE_LOW) ** Math.min(Math.max(charge, 0), 1);
}

interface Charge {
  osc: OscillatorNode;
  sub: OscillatorNode;
  gain: GainNode;
}
let charging: Charge | null = null;

export function startCharge(): void {
  if (!ctx || !master || charging) return;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.05);

  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(CHARGE_LOW, ctx.currentTime);

  // An octave below at low level, so the tone has a body rather than a whistle.
  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.setValueAtTime(CHARGE_LOW / 2, ctx.currentTime);
  const subGain = ctx.createGain();
  subGain.gain.value = 0.5;

  osc.connect(gain);
  sub.connect(subGain).connect(gain);
  gain.connect(master);
  osc.start();
  sub.start();
  charging = { osc, sub, gain };
}

export function setCharge(charge: number): void {
  if (!ctx || !charging) return;
  const hz = chargeHz(charge);
  // Short ramp rather than a set: stepping the frequency once a frame clicks.
  charging.osc.frequency.setTargetAtTime(hz, ctx.currentTime, 0.012);
  charging.sub.frequency.setTargetAtTime(hz / 2, ctx.currentTime, 0.012);
  charging.gain.gain.setTargetAtTime(0.13 + charge * 0.1, ctx.currentTime, 0.05);
}

function stopCharge(): void {
  if (!ctx || !charging) return;
  const { osc, sub, gain } = charging;
  charging = null;
  gain.gain.cancelScheduledValues(ctx.currentTime);
  gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.06);
  osc.stop(ctx.currentTime + 0.08);
  sub.stop(ctx.currentTime + 0.08);
}

/** A short blip off the top of the charge as the piece leaves the block. */
export function launch(charge: number): void {
  stopCharge();
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  const top = chargeHz(charge) * 1.5;
  osc.frequency.setValueAtTime(top, t);
  osc.frequency.exponentialRampToValueAtTime(top * 0.4, t + 0.13);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.22, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + 0.16);
}

/** Filtered noise: the body of a soft thing hitting a soft thing. */
function thud(level: number, hz: number, decay: number): void {
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  const frames = Math.floor(ctx.sampleRate * decay);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(hz, t);
  filter.frequency.exponentialRampToValueAtTime(hz * 0.35, t + decay);
  const gain = ctx.createGain();
  gain.gain.value = level;
  src.connect(filter).connect(gain).connect(master);
  src.start(t);
}

/** A pentatonic bell, climbing with the streak so a run of centres sings. */
const PENTATONIC = [0, 2, 4, 7, 9];
export function chime(streak: number): void {
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  const step = PENTATONIC[streak % PENTATONIC.length]! + 12 * Math.floor(streak / 5);
  const hz = 523.25 * 2 ** (Math.min(step, 24) / 12);
  for (const [mult, level, len] of [
    [1, 0.2, 0.9],
    [2.01, 0.07, 0.55],
    [3.02, 0.03, 0.35],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = hz * mult;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + len + 0.02);
  }
}

export function landed(): void {
  thud(0.5, 420, 0.16);
}

/** Clipping the edge on the way past: a scuff, then the drop. */
export function scuff(): void {
  thud(0.35, 1400, 0.09);
}

export function lost(): void {
  stopCharge();
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(200, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + 0.55);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.24, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + 0.62);
  thud(0.4, 260, 0.3);
}

export function cancelCharge(): void {
  stopCharge();
}
