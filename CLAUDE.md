# COMP4020 prototype

A static site in HTML/CSS/TypeScript that builds to plain HTML/CSS/JS and
deploys to GitHub Pages. The deployed site is what gets marked, not this repo.

The
[course website](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/)
publishes this deliverable's brief and spec, and this repo's name tells you
which deliverable applies. Read both before you plan or build.

## How to work in here

- Keep the dev server running (`pnpm dev`) so you see changes as you make them.
- Run `pnpm check` before you push.
- Open the page in a browser and look at it. The rendered page is the truth;
  your mental model of it isn't.
- When a check fails, read its output before you change anything.
- Never commit a red state.

## The checks

`pnpm check` runs typecheck, build and tests; `pnpm check:evidence` is the
extra gate before you ship. CI runs the same plus links, secrets and the
deploy, and **`deploy` needs `check`** — so `PROCESS.md` without its
`TEMPLATE:` marker, a resolving citation in it, and `reflections/crit-N.md`
under exactly that name are deployment prerequisites, not marking extras.

`spec/README.md`, `PROCESS.md` and `reflections/README.md` say what they are for.

## Standards this repo holds to, whatever the brief

These are the ones that have already caught something. They come forward.

- **If you cannot look at it without a browser, you cannot look at it.** The
  renderer for the piece fills a plain `Uint8ClampedArray` rather than drawing
  onto a canvas, and `scripts/png.ts` turns one into a PNG. That is what makes
  `scripts/preview-piece.ts` and `scripts/preview-fall.ts` possible: the real
  renderer, at an exact scale, off an explicit pose, in Node, writing a file.
  The first picture it produced had three faults in it that a browser would have
  shown slowly and a test suite would not have shown at all. Anything new that
  draws goes on the same side of that line.
- **If the preview tool can lie about it, compute it.** The pane renders at its
  own physical size, and a pane that is not on screen stops compositing — so
  `resize` never reaches the page and `requestAnimationFrame` throttles to about
  1fps. It reported 794×808 after being told 390×844, and sampling a running
  animation through it measured nothing. Anything about geometry or timing gets
  written as a pure function that takes what it needs, and asserted in
  `spec/`. `fitScale` and `motion.ts` are both there for this reason.
- **Assert in the units that failed.** A test about a curve in the abstract let
  a bad fix through; the same property stated in pixels, at the marking scale,
  would have caught the original bug too. When a person reports something,
  write the assertion in their terms.
- **Two marking viewports, 1920×1080 and 390×844, both count**, every week.
  `spec/viewports.test.ts` holds them.
- **Never link a font or asset CDN.** CI's linkinator walks outbound URLs in
  `dist/`, and an external host that 403s automated requests fails the check and
  blocks the deploy.
- **`prefers-reduced-motion` means less motion, not instant.** Instant is the
  most jarring option there is: the first version of this snapped the camera a
  whole gap in one frame, which is the exact discontinuity the full path had
  just been rebuilt to remove. Position still animates — arc, settle, camera
  glide. Rotation and elastic overshoot go. And it never removes *feedback* or
  *teaching*: the charge squash stays because it is how you read the next jump,
  and the attract hop stays because it is the only thing that teaches the game.
  An accessibility setting must not take the tutorial away.
- **Check the effective setting before believing what you see.** The preview
  browser here has reduce-motion on. Every animation in this repo was being
  rendered through the degraded path for a whole session before that surfaced.
  `window.__jump.motion` reports it and `setMotion('full'|'reduced'|'auto')`
  forces either path.
- **`git config core.hooksPath .githooks` after every fresh clone.** The
  template's `prepare` script fails silently on Windows, so the hook that blocks
  committing a key is not installed until you do this by hand.

## This prototype: HOP (跳一跳)

- **`game.ts` imports nothing and `render.ts` imports only `game.ts`.** That
  layering is the reason the losing rule is testable without jsdom. Putting a
  `window` or a `performance.now()` into either of them is how this starts
  needing synthetic pointer events to test a rule.
- **`resolveLanding` is the only place that decides whether a run continues.**
  It has three outcomes, not two: a hold too weak to leave the block is a
  `stay`, not a loss. Adding a second liveness check somewhere else would pass
  the build and break the one spec line the game is built around.
- **Blocks squash about their base; the piece squashes about its feet — but it
  *rotates* about its centre of mass.** `renderPiece` draws about the centre of
  mass and the caller says where that is; `comAbove` converts from the feet for
  the phases that track those instead.
- **Blocks squash about their base; the piece squashes about its feet.** So a
  block's squash moves its top face, and anything standing on it has to move by
  `sinkOf()` too or it wades. This is why the block's impact amplitude is a
  quarter of the piece's — the ground must not lurch under the player.
- **No deformation curve may start anywhere but rest.** A curve at full value on
  its first frame teleports whatever it deforms, and nothing goes red.
  `spec/motion.test.ts` holds the line at 8px of top-face movement per 60Hz
  frame.
- **Smoothing is a rate over elapsed time, never a per-frame constant.** As a
  constant the camera panned 2.4x faster at 144Hz than at 60Hz.
- **No instructions anywhere, on screen or off** — including `README.md`, which
  the brief names explicitly. The opening screen's attract hop is the tutorial:
  the piece compresses and springs in place until the first real jump.
- **The piece is a mesh, and the rule is a point. That is a real contradiction
  and `mesh.CONTACT_RADIUS` is where it is resolved.** `resolveLanding` decides
  on the centre of the landing; a base with a radius means a jump scored as a
  miss can still have rim over the block, and at the drawn radius of 22 it
  skated on and stood up on the block it had missed. Nine units keeps the
  near-miss clip and keeps the disagreement smaller than the piece. Do not
  reach for the friction or the restitution when a fall looks wrong at an edge —
  every setting of those fixes one case and breaks another, which is the shape
  of a parameter that is not the problem.
- **Nothing in `physics.ts` decides anything.** It animates a decision
  `resolveLanding` already took. `spec/body.test.ts` walks every miss the
  generator can produce and asserts each one finishes below the play plane; if
  that goes red, the picture has started contradicting the rule.
- **The solver runs at a fixed 1/240s substep, whatever the display does.** A
  rim that clips an edge at 144Hz is already past it by the first sample at
  30Hz. This is the same lesson `smoothing` had to learn, somewhere it changes
  the outcome rather than the speed.
- **Light per vertex, not per corner, and check `dot(L, view) > 0`.** A light
  can satisfy "above" and "screen-left" and still sit behind the piece: `iso`
  sends `+z` up-and-left on screen, and `+z` is also away from the camera.
- **Verify the winding by measuring it, per part.** A whole-mesh volume check
  passes when two parts are both inside out, because the errors cancel.
- **Draw the piece in the depth order, not on top.** Depth on the ground plane
  is `x + z`; blocks at least as far away as the piece go first, nearer ones
  after. Drawn last, an overshooting piece sails across the front of the block
  it just flew *behind*.
- **Read the fall as numbers first.** `node scripts/preview-fall.ts [hold]
  [seed]` prints position, speed, spin, how far the lowest contact point is into
  a block, and how many substeps resolved a contact, and then writes a filmstrip
  with the blocks drawn in. `node scripts/sweep-falls.ts` walks every miss on
  several seeds and reports any that finishes on top of something.
- **To see motion, use `window.__jump.shoot()`.** A screenshot of a running
  game is one pose, and the pane throttles `requestAnimationFrame` to about
  1fps, so neither tool can show an animation. `shoot(name, holdMs, opts)`
  drives the real `step`/`draw` off a virtual clock, lays a whole jump out as a
  labelled grid on the canvas at an explicit pixel size, and posts it to the
  dev server, which writes `.frames/<name>.png`. A canvas draws into its
  backing store whether or not the page is composited, so this works with the
  pane closed — which is when it is needed. `cols: 1, rows: 1, w: 390, h: 844`
  gives a true phone frame. The `/__frame` middleware is `apply: "serve"` and
  never ships.
- **Read state from `window.__jump`, not from screenshots.** It exposes phase,
  score, streak, scale, viewport, gap, charge, both squash values, the current
  sink and the trail length, plus `hold(ms)` to drive a jump without a pointer
  and `reset(seed)` for a reproducible run. Two traps: rAF is throttled in the
  pane, and `setPointerCapture` throws for a synthetic pointer id.
- **Dev server runs on port 5194** (`.tools/serve-jump.cmd`): 5173 is CertAIn and
  5195–5199 are the earlier prototypes. Node 24 is required.
