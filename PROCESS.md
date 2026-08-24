# Process overview

## What I built

跳一跳 — a remake of the WeChat mini-game. A chess pawn on an isometric block,
one next block, hold to charge and release to jump. Land off it and the run
ends. Overshoot kills as surely as falling short, so the charge is a precision
window rather than a power meter, and centre hits pay a rising streak so there
is a reason to aim rather than merely clear the gap. The mechanic is borrowed
wholesale and deliberately: the original's opening screen is one of the few
that teaches itself with no words at all, which is what this brief asks for. I
reimplemented the look geometrically and used none of the original's assets.

## The moments that mattered

**The losing rule went in before the game did.**
[`e0b7e7f`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/commit/e0b7e7f)
The obvious move is to build the game and then reach into it for something
testable, which for a canvas game means jsdom and synthetic pointer events — a
test of the plumbing rather than the rule. So `game.ts` came first with no DOM
and no clock in it, and `resolveLanding` is the only place that decides whether
a run continues. Reading the original closely enough to write the arithmetic is
what surfaced a third outcome I did not have: a hold too weak to leave the
block is not a loss. 23 tests, eight of them walking the boundary a pixel at a
time, plus assertions that the generator can never place a target beyond full
charge or so close that leaving the block clears it — either would make the
losing rule unreachable in one direction without anything going red.

**The preview pane reported a viewport it was not showing.**
[`c14eac3`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/commit/c14eac3)
I resized it to 390×844 and read 794×808 back. The pane had been hidden, and a
hidden pane stops compositing, so `resize` never reached the page — the number
looked like a measurement and was a leftover. Rather than be more careful with
the tool, I made the framing not need one: `fitScale(width, height)` is pure
and takes the viewport, so `spec/viewports.test.ts` passes in both marking
sizes and asserts the widest pair the generator can produce fits with better
than 10% margin at each. That one is a sensor, not a contract test, and comes
with me next week.

**The first fix for the landing made it worse, and a test said so.**
[`c13ed7b...4af7cef`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/compare/c13ed7b...4af7cef)
Playing it, the level change read as a cut: the impact curve was a damped
cosine, so it began at full compression on the frame of contact, and since a
squeezed block loses height off its top the top face and the piece standing on
it dropped 32.1px in one frame. Damping the cosine with a rise ramp fixed the
discontinuity and halved the impact — the ramp's time constant and the cosine's
quarter period were within a factor of two, so the ramp ate the first peak, 1.0
down to 0.32, and left the rebound alone. A damped sine starts at zero because
a sine does. Peak now 1.0 at 56ms, rebound 28% of it, top face dipping 13.4px
total and never more than 6.93px in a frame.

The assertion that caught the bad fix was about the curve in the abstract. I
replaced it with one in the units that actually failed: the tallest block the
generator makes, the larger of the two marking scales, and no more than 8px of
top-face movement between two 60Hz frames.
