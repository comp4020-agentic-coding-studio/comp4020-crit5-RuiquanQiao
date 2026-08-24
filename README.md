# HOP

A remake of the WeChat mini-game 跳一跳, in TypeScript on a canvas, with no
dependencies at runtime and no assets to load — the art is drawn and the sound
is synthesised.

Live: <https://comp4020-agentic-coding-studio.github.io/comp4020-crit5-RuiquanQiao/>

This file deliberately does not say how to play. The brief this answers forbids
instructions anywhere, on screen or off, and names the README as one of the
places that cannot stand in for them. The opening screen is the whole tutorial.

## The code

| file | what it owns |
|---|---|
| `game.ts` | the rules. No DOM, no clock. `resolveLanding` is the only place that decides whether a run continues |
| `motion.ts` | the curves and the ballistics — one gravity, one launch angle, everything else derived. Pure, for the same reason |
| `audio.ts` | the synthesised sound. Unlocked inside a gesture, never at load |
| `render.ts` | everything that knows about pixels. Imports `game.ts`, and nothing imports it back |
| `main.ts` | input, the clock and the camera; the only file that knows the other three exist |

`spec/` holds the checks. `game.test.ts` answers this week's spec and retires
with it; `viewports.test.ts` and `motion.test.ts` are sensors and carry
forward. `PROCESS.md` is the map to how it came together.

## Running it

```
pnpm install
pnpm dev
pnpm check    # typecheck, build, tests
```

Requires Node 24 — `pnpm check:evidence` runs a TypeScript file directly.

## Credit

The game is 跳一跳 (Tiao Yi Tiao), published by Tencent for WeChat in 2017. The
mechanic and the isometric look are its; the code and the art here are written
from scratch, and none of the original's assets are used. `PROCESS.md` says why
the borrowing was the right call for this brief.
