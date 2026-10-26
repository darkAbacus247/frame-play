# FRAME//PLAY

Photograph your room. Play it.

FRAME//PLAY turns one still photo of a room or a desk top into a small 2.5D
adventure stage. The outlines of the real objects in the picture become the
walls you walk around, the things you collect, the hazard you avoid and the
exit you reach.

Status: work in progress. This repository was created on 2026-10-26 after
16:00 UTC, during the event. The full README is written as the build lands.

## The road

One road with one step counter: Welcome, then two sample rooms (pick, see
what the AI found, play), the two side by side, then **your own room**: a
photo from your device, or from the camera where the browser offers one.
What happens to that photo depends on the server's mode, and the page says
so plainly:

- **LIVE** (a key and the live switch on the server): the photo is shrunk
  and stripped of its camera data on the device, sent once through the
  server to Meta's models, and the room is built from what they found in
  it.
- **MOCK** (no key): nothing reads the photo, so nothing is invented. It is
  shown on your device only, and the road goes on to its end.
- **REHEARSAL** (the local stand-in): the stand-in only knows its sample
  room's own picture, which the page offers to save. Any other photo, or an
  edited copy of that picture (an object erased, moved or pasted, a crop),
  is refused in words before anything is sent, and no level is made from
  it.

The road ends on a closing screen (the counter's last step) that says the
circuit is complete: each room with whether you won and your best route,
one sentence on what the AI did in it, and the ways on: Free play, Play
again for any room, Try your own room (or, in MOCK, why it needs the live
AI), and Start over. Free play always opens on the list of rooms; a replay
lasts only while you stay on it. Your own room, once made, stays on the road: going
back to its step and choosing Continue to the end keeps it, its result and
its place in Free play.

The photo itself is never stored, so on a return visit a photo room's level
may not be in memory. That room's screen then makes it again right there,
on the same step: pick the same photo (its level loads from this device
when it was kept here, or the photo is read again), or send a stand-in room
through the stand-in again. Where this copy cannot make it (a LIVE or
REHEARSAL room reopened in MOCK) the screen says so and the way on is
forward. No primary button ever moves the step counter back. On the closing
screen such a room says on which step it can be made again, or that this
copy cannot make it again.

Every screen is written to fit without scrolling at 100% zoom: one short
line up front, short labelled facts, and the longer text (the full consent
notice, the list of what the AI found, the proof) in a disclosure that
starts closed. Text runs in one column of at most about 65 characters.
`tests/fit.test.js` checks this for every road screen at 839x945 and
1259x1418 with a layout model built on the stylesheet's own rules, with no
tolerance; it is a model, not a browser. A picture sized to fill the space
left (the reveal, the play board) rounds what it subtracts up and the space
down, so it never overshoots by a fraction of a pixel. The small tour offer
that appears by itself after 45 seconds without progress stays only where
it fits without making the screen scroll.

## Running it

Python 3.10 or newer, standard library only; no packages to install.

```
python server/server.py
```

The page is at `http://127.0.0.1:8191/`. Without `MODEL_API_KEY` and
`FRAMEPLAY_LIVE=yes` in the operator's own environment the server runs in
MOCK mode: sample rooms drawn by code, labeled MOCK, and no model is called.

A rehearsal runs the live path against a local stand-in, never Meta, and
holds no key:

```
python server/standin.py --room desk --port 8192
python server/server.py --rehearse http://127.0.0.1:8192/v1 --rehearsal-room desk
```

## Tests

```
node --test
python -B -m unittest discover
```

`tests/own_e2e.test.js` starts the stand-in and the server in rehearsal on
this machine's loopback (it runs `python`, or `$PYTHON`) and uploads the
desk's own picture through them.

## Known limits (so far)

- Live mode is written against the Model API's documented shapes and tested
  only against a local stand-in; it has not yet been run against Meta.
- sam-3.1's answer text is parsed from our reading of Meta's published SAM 3
  text format; the first live answers will confirm it.
- Live outlines are traced by code inside SAM's boxes; an object whose trace
  is not tight falls back to its box, and the reveal says so. Small, low
  contrast objects are the hardest to trace.
- One photo, one room; a 2.5D approximation with one baseline per object.

## Disclosure

FRAME//PLAY was built during the Meta Global AI Developer Hackathon (October 26
to Nov. 4, 2026). An earlier prototype informed the design; no prototype
code is included. Built with AI assistance: Claude Code (Anthropic) wrote the
code under my direction. Live rooms are read by Meta's muse-spark-1.3 and
sam-3.1 through the Meta Model API; sample rooms are drawn by code and labeled
MOCK.

## License

MIT. See [LICENSE](LICENSE).
