# Crit 5 — HOP

## What was the breakthrough that moved the work forward?

Building the thing I needed in order to *see* the thing I was making.

Twice now the same shape of problem has cost me an afternoon. The preview pane
renders at its own physical size and throttles animation to about 1fps, so for
most of a session I was arguing about an animation from a still frame at an
unknown scale — and the whole time every animation was running through the
reduced-motion path, because that browser has the setting on. Nothing was red.
Everything looked fine. It was just wrong.

So when I replaced the piece with real geometry, I wrote the rasteriser to fill
a plain array instead of drawing onto a canvas. That one decision means a script
can run the same renderer in Node and write me a PNG. The first picture it gave
me had three separate faults in it — the mesh was inside out, the head had been
rounded the wrong way and inflated into a blob, and the key light was sitting
behind the piece lighting the side I could not see. I would not have found any
of them by staring at test output, and I would not have found them quickly in a
browser either.

The instrument is not a detour from the work. It is the part of the work that
decides how fast everything after it goes.

And then it failed to catch one, which is the other half of the lesson. Playing
the finished build, I saw a block paint over the piece's feet for a quarter of a
second after landing and then stop. The instrument renders exactly those frames
and I had looked at dozens of them without noticing, because the fault heals
itself and what you see is a flicker you then doubt. A tool that shows you
everything still needs someone who knows what wrong looks like.

## What did this work change about who I want to be as a software developer?

I want to notice when I am tuning a number to hide a disagreement.

The fall used to be a parabola with a spin bolted on, and it had a fudge in it:
if the landing came within 22 units of an edge, damp the drift to 0.45 and
multiply the spin by 2.4. That is not physics, it is an impression of physics,
and it was applied whether or not the piece went near an edge. Replacing it with
an actual rigid-body solver felt like the honest thing to do — and it
immediately produced something worse. A jump the rule had scored as a miss put
its toe on the block's far edge, skated forward on its own momentum, and came to
rest standing on the block it had failed to reach. The game said I had lost and
the picture said I had not.

I spent a while on the coefficients. More friction stopped the piece dead in one
frame and left it balanced upright on the edge for a fifth of a second, which
reads as a freeze. Less friction let it skate on again. More bounce launched it
onto the block from above. Every setting fixed one case and broke another,
which in hindsight is exactly what it looks like when the parameter is not the
problem.

The problem was that the rule treats a landing as a single point and the piece
is a solid with a base twenty-two units wide. Those two things cannot both be
right at the edge, and no coefficient reconciles them. Shrinking the contact
ring to nine units did, because it makes the disagreement smaller than the piece
— and then the property could be stated and checked rather than eyeballed:
every one of the 317 misses the generator can produce now ends below the plane
the blocks sit on.

The lesson I want to keep is the order. When something looks wrong, find out
which two things are contradicting each other before touching a constant. The
painter's order turned out to be the same shape of problem in miniature: the
piece's landing point was being compared against a block's centre, two things
that are not comparable, and no amount of nudging the comparison would have
fixed it. What fixed it was writing down the rule — something standing on a box
is painted after the box — and then it was a function with tests instead of a
line of arithmetic nobody could check.
