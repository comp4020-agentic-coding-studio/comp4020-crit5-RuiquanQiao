# Process overview

## What I built

HOP — a remake of 跳一跳. A chess knight on an isometric block, one next block,
hold to charge and release to jump. Overshoot kills as surely as falling short,
so the charge is a precision window, not a power meter. The mechanic is borrowed
deliberately: the original's opening screen teaches itself with no words, which
is what this brief asks for. None of its assets are used — the piece is a mesh
built in code and its fall is integrated, not drawn.

## The moments that mattered

**The losing rule went in before the game did.**
[`e0b7e7f`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/commit/e0b7e7f)
Building the game first and then reaching into it for something testable means
jsdom and synthetic pointer events — a test of the plumbing, not the rule. So
`game.ts` came first, no DOM and no clock in it, and `resolveLanding` is the
only place that decides whether a run continues. That is why a rigid-body solver
could be dropped in later without the rule moving an inch.

**The first fix for the landing made it worse, and a test in the wrong units let
it through.**
[`c13ed7b...4af7cef`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/compare/c13ed7b...4af7cef)
The impact curve was a damped cosine, so it began at full compression on the
frame of contact, and a squeezed block loses height off its top: the top face
and the piece on it dropped 32.1px in one frame. Damping the cosine with a rise
ramp removed the discontinuity and halved the impact — the ramp's time constant
and the cosine's quarter period were within a factor of two, so it ate the first
peak, 1.0 down to 0.32, and left the rebound alone. A damped sine starts at zero
because a sine does. The assertion that let the bad fix through was about the
curve in the abstract; its replacement is in the units that failed — tallest
block, larger marking scale, no more than 8px of top-face movement per frame.

**A renderer I could run without a browser found three errors in one picture.**
[`5f9fa04`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/commit/5f9fa04)
The piece was a pawn: one outline with a gradient and three painted ellipses. A
pawn is a body of revolution, so every yaw of it is the same picture and it
cannot show which way the next jump goes. Replacing it with real geometry meant
writing a rasteriser, and I wrote it to fill a plain array rather than a canvas
— so `scripts/preview-piece.ts` runs it in Node and hands me a PNG, rather than
a preview pane that renders at its own size and throttles animation to 1fps ([`9536002`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/commit/9536002)).
The first file showed both parts wound inside out, a head inflated into a blob
by normals that pointed inward, and a key light sitting behind the piece. My
whole-mesh volume check had been green throughout, because the two winding
errors cancelled; it walks the manifold edge by edge now.

**The rule and the solid disagreed, and tuning only moved the problem.**
[`1a07d2a`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/commit/1a07d2a)
`resolveLanding` treats a landing as a point; the piece has a base with a
radius. Once the fall was a real solver, a jump the rule scored as a miss put
its toe on the far edge, skated on, and came to rest standing on the block it
had failed to reach. Friction at 0.62 stopped it dead — 761 units per second to
50 in one frame — and balanced it upright for 180ms; at 0.22 it skated on again.
The fix was the contact radius, 22 units down to 9, not the coefficients. The
invariant is asserted over all 317 misses the generator can produce: worst
finish −13, none on top of anything.
