# Crit 5 — 跳一跳

## What was the breakthrough that moved the work forward?

Writing the losing rule and its test before there was a game to lose.

The obvious order is to build the thing and then reach into it for something
testable, and with a canvas game that means booting jsdom and firing synthetic
pointer events at a rendered page — a test of the plumbing, not of the rule. So
`game.ts` went first, with no DOM and no clock in it, and `resolveLanding` came
out as the only place in the codebase that decides whether a run continues.
Reading the original closely enough to write the arithmetic is what surfaced the
third outcome: a hold too weak to leave the block drops you back on the block
you were already standing on, and that is not a loss. I had it as pass/fail.

The payoff arrived later and somewhere else. Every part of this game that I
could not measure by looking at it — the framing at 390×844, the shape of an
impact — I could make pure and hand to a test, because the first file had
already established that the rules do not need a browser.

## What did this work change about who I want to be as a software developer?

I want to write the test in the units that failed.

The landing felt like a cut rather than a movement, and my first fix made it
measurably worse in a way I could not see: it fixed the discontinuity and
quietly halved the impact. The assertion that caught it was one I had written
about the curve in the abstract. The one I replaced it with says the tallest
block's top face may not move more than 8px between two frames — the actual
pixels, at the actual marking scale. That test would have caught the original
bug on the day I wrote it, and the abstract one would not have.

Next time the thing I am fixing is something a person noticed, I want the
assertion to be in the same terms the person used.
