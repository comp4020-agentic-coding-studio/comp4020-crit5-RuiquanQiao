// A PNG encoder, in about forty lines, so that nothing in this repo needs a
// browser in order to be looked at.
//
// The rasteriser in `raster.ts` writes RGBA into a plain array. That was the
// point of writing it that way: `scripts/preview-piece.ts` can run the real
// renderer in Node, at an exact size, off a fixed pose, and hand me a file to
// open. The alternative was a preview pane that renders at its own physical
// size and throttles animation to about 1fps, which is how a piece that was
// obviously wrong to anyone who played it stayed invisible to me for a session.

import { deflateSync } from "node:zlib";

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(name.length + data.length);
  body.set(name);
  body.set(data, name.length);

  const out = new Uint8Array(body.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(out.length - 4, crc32(body));
  return out;
}

/** 8-bit RGBA, no interlacing, one deflate stream. */
export function encodePng(w: number, h: number, rgba: Uint8ClampedArray): Uint8Array {
  // Each row is prefixed with its filter type. Zero — "none" — throughout:
  // deflate does the work, and a filter would only save bytes on a file that
  // is never shipped.
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const head = new DataView(ihdr.buffer);
  head.setUint32(0, w);
  head.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 are compression, filter and interlace methods; zero is the only
  // value the format defines for all three.

  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];

  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

/**
 * Fill a convex polygon, by scanline. Enough to put blocks behind the piece in
 * a Node-rendered preview, which is what makes a fall judgeable without a
 * browser: a tumbling piece on a blank field tells you nothing about whether it
 * cleared the block it was supposed to hit.
 */
export function fillPolygon(
  out: Uint8ClampedArray,
  w: number,
  h: number,
  points: readonly (readonly [number, number])[],
  colour: readonly [number, number, number],
): void {
  const ys = points.map((p) => p[1]);
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const bottom = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  for (let y = top; y <= bottom; y++) {
    const crossings: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      if (a[1] === b[1]) continue;
      const lo = Math.min(a[1], b[1]);
      const hi = Math.max(a[1], b[1]);
      if (y + 0.5 < lo || y + 0.5 >= hi) continue;
      crossings.push(a[0] + ((y + 0.5 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.round(crossings[i]!));
      const to = Math.min(w - 1, Math.round(crossings[i + 1]!));
      for (let x = from; x <= to; x++) {
        const o = (y * w + x) * 4;
        out[o] = colour[0];
        out[o + 1] = colour[1];
        out[o + 2] = colour[2];
        out[o + 3] = 255;
      }
    }
  }
}

/** Lay images out on a background, left to right, with their own offsets. */
export function compose(
  w: number,
  h: number,
  background: readonly [number, number, number],
  items: readonly { rgba: Uint8ClampedArray; w: number; h: number; x: number; y: number }[],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = background[0];
    out[i * 4 + 1] = background[1];
    out[i * 4 + 2] = background[2];
    out[i * 4 + 3] = 255;
  }
  for (const item of items) {
    for (let y = 0; y < item.h; y++) {
      const dy = item.y + y;
      if (dy < 0 || dy >= h) continue;
      for (let x = 0; x < item.w; x++) {
        const dx = item.x + x;
        if (dx < 0 || dx >= w) continue;
        const s = (y * item.w + x) * 4;
        const a = item.rgba[s + 3]! / 255;
        if (a === 0) continue;
        const d = (dy * w + dx) * 4;
        for (let k = 0; k < 3; k++) {
          out[d + k] = item.rgba[s + k]! * a + out[d + k]! * (1 - a);
        }
      }
    }
  }
  return out;
}
