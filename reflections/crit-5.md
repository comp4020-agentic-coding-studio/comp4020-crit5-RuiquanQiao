# Crit 5 — HOP

## What was the breakthrough that moved the work forward?

Writing the losing rule and its test before there was a game to lose.

The obvious order is to build the thing and then reach into it for something
testable, and with a canvas game that means jsdom and synthetic pointer events —
a test of the plumbing, not of the rule. So `game.ts` went first, with no DOM
and no clock in it, and `resolveLanding` came out as the only place that decides
whether a run continues.

The payoff arrived later and somewhere else. Every part of this game I could not
measure by looking at it — the framing at 390×844, the shape of an impact, the
trajectory of a jump — I could hand to a test, because the first file had
already established that none of it needs a browser.

## What did this work change about who I want to be as a software developer?

I want to write the test in the units that failed.

The landing felt like a cut, and my first fix made it worse in a way I could not
see: it removed the discontinuity and quietly halved the impact. The assertion
that caught it was about the curve in the abstract. Its replacement says the
tallest block's top face may not move more than 8px between two frames — actual
pixels, at the marking scale. That one would have caught the original bug too.

And I want to make sure I can see a thing before spending an afternoon tuning
it. When I finally built a way to watch the animation frame by frame, the first
strip showed no rotation and a camera that jumped — not from anything I had just
written, but because the browser had reduce-motion on and every animation here
had been rendering through the degraded path all session. Two rounds of tuning
went into a path nobody was looking at. The instrument should have come first.
