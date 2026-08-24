# Process overview

## What I built

HOP — a remake of the WeChat mini-game 跳一跳. A chess pawn on an isometric
block, one next block, hold to charge and release to jump. Overshoot kills as
surely as falling short, so the charge is a precision window rather than a
power meter. The mechanic is borrowed wholesale and deliberately: the
original's opening screen is one of the very few that teaches itself with no
words at all, which is what this brief asks for. Reimplemented geometrically,
using none of the original's assets.

## The moments that mattered

**The losing rule went in before the game did.**
[`e0b7e7f`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/commit/e0b7e7f)
The obvious move is to build the game and then reach into it for something
testable, which for a canvas game means jsdom and synthetic pointer events — a
test of the plumbing, not the rule. So `game.ts` came first, no DOM and no clock
in it, and `resolveLanding` is the only place that decides whether a run
continues. That layering is what let every later question be answered by a test.

**The first fix for the landing made it worse, and a test said so.**
[`c13ed7b...4af7cef`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/compare/c13ed7b...4af7cef)
Played, the level change read as a cut. The impact curve was a damped cosine, so
it began at full compression on the frame of contact, and since a squeezed block
loses height off its top, the top face and the piece on it dropped 32.1px in one
frame. Damping the cosine with a rise ramp fixed the discontinuity and halved
the impact: the ramp's time constant and the cosine's quarter period were within
a factor of two, so the ramp ate the first peak, 1.0 down to 0.32, and left the
rebound alone. A damped sine starts at zero because a sine does. The assertion
that caught the bad fix was about the curve in the abstract; I replaced it with
one in the units that failed — the tallest block, the larger marking scale, no
more than 8px of top-face movement between two 60Hz frames.

**The arc was not an arc.**
[`7efda1e`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/commit/7efda1e)
`sin(pi*t)` starts and ends in the right places and is not a parabola, which was
invisible until the piece somersaulted and then looked dragged along a wire.
One gravity and one launch angle now, with apex, flight time and impact speed
derived; `spec/physics.test.ts` takes the second difference of height with
respect to seconds and asserts it is −g. A miss is the same parabola continued,
asserted as velocity continuity across contact. And the somersault turns about
a horizontal axis perpendicular to travel — both isometric axes are diagonal on
screen, so a screen-space spin is wrong for both.

**I could not see any of it, so I built the instrument.**
[`9536002`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/commit/9536002)
A screenshot is one pose and the preview pane throttles `requestAnimationFrame`
to about 1fps; earlier it reported 794×808 after being told 390×844, which is
why the framing maths became pure and tested
([`c14eac3`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-RuiquanQiao/commit/c14eac3)).
`__jump.shoot()` renders a whole jump as a labelled grid off a virtual clock and
posts it to a dev-only middleware that writes a PNG — a canvas fills its backing
store whether or not the page is composited, so it works with the pane shut. The
first strip showed no rotation and a camera that jumped: this browser has
reduce-motion on, and my reduced path *snapped the camera* — the very
discontinuity the full path had been rebuilt to remove — and disabled the
attract hop, which is the only thing that teaches this game.
