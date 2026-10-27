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
What happens to that photo depends on the server's mode, and Step 9 says
so before you choose one.

### How a photo becomes a room

- **LIVE** (a key and the live switch on the server): the photo is shrunk
  and stripped of its camera data on the device, then goes through this
  app's server to Meta's Model API for one read: one Muse Spark call, then
  one SAM 3.1 call for the surface and one for each kind of object on it,
  at most 13 calls in all, each carrying the photo (a failed call may be
  sent one more time, a busy answer twice; the room read is never sent
  again after a timeout). This app does not store the photo. The room is
  built from what the models found in it: Muse Spark names the things and
  gives each a role and a few points on it; SAM 3.1 answers each name with
  its matches (boxes), and of several, the ones holding Muse Spark's points
  are kept. Code traces each outline inside SAM's box. Muse Spark also says
  how the camera sees the room (at eye level, from above as in a floor
  plan, or at a slant) and gives points on the open floor, one or more a
  room; SAM 3.1 answers "floor" with one match a room. Code grows the floor
  from those points, by colour and edges, inside SAM's floor boxes, and
  that floor, less what stands on it, is where the explorer may walk:
  everything else is wall, and a doorway is where the floor runs on from
  one room into the next. Seen from above, a thing blocks its whole
  outline. With no floor found (no points, no floor match, or too little
  floor around the points) the play area is everything below the horizon
  (from above, the whole picture), and the level's provenance says so in
  words. For a thing SAM
  finds nothing usable for, code traces around Muse Spark's own points
  instead, with the same tracer, and the reveal says how many came each way
  ("SAM 3.1 found 5; for 4 more, code traced around Muse Spark's points").
  Only when SAM finds nothing and Muse Spark gave no points does the read
  make no room. If the read fails or makes no room (the key the
  operator set is refused, the account has no credit, the read runs out of
  time, the server cannot be reached), the screen says why in words, and
  for a refused key it says plainly that it is the operator's key, not
  anything of yours; then Mark your room is the way on, and nothing more is
  sent.
- **MOCK** (no key): no model reads the photo, so nothing is invented. The
  photo is shown on your device only, and Mark your room, right under it,
  is the way on: you mark the room yourself. Nothing is sent.
- **REHEARSAL** (the local stand-in): the stand-in only knows its sample
  room's own picture, which the page offers to save. Any other photo, or a
  copy of that picture edited enough for the page's check to see (an
  object erased or pasted, an object moved by 8 px or more, a crop), is
  refused in words before anything is sent, and no level is made from it.
  An edit of a few pixels (a coin nudged by 4 px, a small mark) can pass,
  and the stand-in then answers with its sample's own places, in the very
  grammar sam-3.1 answers in, so the same reader, match choice and point
  fallback run (its zero_matches drill makes the whole room from Muse
  Spark's points; its sam_busy drill answers every SAM call as busy, so the
  page shows the busy words and Try this photo again; its 401 drill refuses
  the key, and the page turns the picker off with Check again, as LIVE does
  after an account problem). A refused photo, or a read that fails, can be
  marked as in MOCK.

**Floors, walls and doorways.** Where a room's floor is known (drawn by
code in a sample room, or grown by code from a LIVE or REHEARSAL read),
the explorer stands only on it: the arrow pad, the keys, a tap and the
walk-to chips all keep to the floor, the start is on it, and a path to
another room goes through its doorway. A goal behind walls with no doorway
cannot be reached, and every word says so: code makes it solid and lists
why ("Out of reach: behind walls with no doorway"), a tap there is refused
("No doorway leads there"), and the proof names it. **Show walls** draws
where the explorer can stand, the floor's outline and a ring on each
doorway.

The people refusal (a person in the photo) and Muse Spark declining to
read a photo for its content are the refusals with no marking after them:
such a photo makes no room in any way. A photo that is
refused is not shown on Step 9; the screen says in words why no room was
made from it, and the photo appears again only on the marking board, if
you choose to mark it.

**Mark it yourself.** On Step 10 (named Your marks) you pick what a box is
(a coin to collect, an obstacle, a hazard or the exit) and drag one over
each object, with a mouse, pen or finger, or with the keyboard alone (Tab
to the photo; a box cursor: the arrow keys move it, Shift with an arrow
resizes it, Enter adds it, Space selects the box under it, Delete removes
it, 1 to 4 pick what a box is, Ctrl+Z undoes). A box can be selected,
changed or removed, and Undo takes back the last change. A line says what
the room still needs to be winnable (a coin at least, and one exit; with
no exit but another box, code makes one box the exit and lists it). Make
the room then runs the same code a model's reply goes through: the marks
become the same reply shape, code first finds the object's own bounds
inside each of your boxes, then traces its outline there with the same
tracer and tightness test as SAM's boxes, keeping your box where the trace
is not tight; the level builder and the proof follow. If the marks cannot
make a room that can be won, the board says why and stays. The reveal, the
play label, the closing screen ("Your own room: marked by you") and Free
play say you marked the objects and code traced the outlines, and that no
model was called. Nothing is sent, in any mode: the marks (roles and
boxes) and the level are kept on this device under the photo's
fingerprint, taken on the device, never the photo, so after a reload the
same photo picked again brings the room back in place.

The road ends on a closing screen (the counter's last step) that says the
circuit is complete: each room with whether you won and your best route,
one sentence on what the AI did in it, and the ways on: Free play, Play
again for any room, Try your own room, and Start over, which asks first
and clears nothing unless you confirm. While a card or the settings are open, a round in play holds
still, so no round ends under them. Free play always opens on the list of rooms; a replay lasts only
while you stay on it, and its rounds never change the road's results (its
end card says so). Your own room, when made, stays on the road: going
back to its step and choosing Continue to the end keeps it, its result and
its place in Free play.

**Phone photos.** The browser's own decoder decides what a photo is, not
the file's label, so a HEIC or HEIF photo is tried wherever the browser can
open it, and one it cannot open is refused in words that say how to get a
JPEG (a screenshot, or the camera's most compatible setting); a photo too
large to open at full size is tried a second, leaner way. A photo taken in
portrait is turned as its camera recorded, so it is shown and sent
upright, and the copy that leaves the device is a fresh JPEG with every
camera, place and time field stripped. While a photo is read, **Cancel**
stops waiting at once and the send itself is aborted (a read also stops by
itself after 120 seconds), and nothing from it is used or kept. When every
reader on the server is busy, the page waits and sends the same copy again
(at most 3 sends, 30 seconds of waiting in all), with a countdown under the
progress lines.

**Check again; Try this photo again.** The page asks the server for its
mode up to 3 times (a slow or waking host gets 4, 6, then 8 seconds). If no
answer comes, or the live AI is unavailable, the picker says so and a
**Check again** button asks once more; your own room can still be marked by
hand. When a read fails for a reason that may pass (a busy model, a time
out, a read cut off, or Cancel), **Try this photo again** sends the same
photo once more, with no new pick. A level read while some calls were
failing is played but not kept on this device, so the same photo is read
again next time.

The photo itself is never stored, so on a return visit a photo room's level
may not be in memory. That room's screen then makes it again right there,
on the same step: pick the same photo (its level loads from this device
when it was kept here, or the photo is read again; a different photo is
known by its fingerprint and refused before anything is sent, so in LIVE it
never reaches Meta), or send a stand-in room through the stand-in again,
only when the running stand-in answers for that same room (a stand-in
started for another room would answer with its own room, so nothing is
sent). Your own room always offers Continue to the end; where this copy
cannot make it (a LIVE or REHEARSAL room reopened in MOCK, or one whose
level kept here was made in the other mode) the screen says so and that is
the way on. A first or second room this copy cannot make is picked again on
its own step, with ←. No primary button ever moves the step counter back.
On the closing screen such a room says on which step it can be made again,
or that this copy cannot make it again.

Every screen is written to fit without scrolling at 100% zoom: one short
line up front, short labelled facts, and the longer text (the full consent
notice, the list of what the AI found, the proof) in a disclosure that
starts closed. Text runs in one column held to 65ch (65 widths of the
digit zero), so a line of ordinary words runs to about 75 letters.
`tests/fit.test.js` checks every road screen and the closing screen at
839x945 and 1259x1418, and `tests/layout.test.js` checks the play screen,
both with a layout model built on the stylesheet's own rules and no
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

In LIVE the server reads at most 4 photos at once and 120 an hour, 200 a
day, and stops for the day at an estimated $5. A photo is one Muse Spark
call and at most 12 SAM 3.1 calls: at the published prices about four
cents, and about six cents at worst (every call answered once; a call sent
again costs again), so the stop allows at least 80 photos a day. If the Model API refuses the
key, the account has no credit or quota, or a model is gone, the server
stops sending photos, says so in health (live_state: unavailable), and lets
one photo check again every 10 minutes.

A rehearsal runs the live path against a local stand-in, never Meta, and
holds no key:

```
python server/standin.py --room desk --port 8192
python server/server.py --rehearse http://127.0.0.1:8192/v1 --rehearsal-room desk
```

A rehearsal listens on this machine only: the server refuses `--rehearse`
with `--public` or with a `--host` that is not a loopback address. A level
kept on the device is reused only in the mode that made it.

## Tests

```
node --test
python -B -m unittest discover
```

The Node tests need Node 20.6 or newer and no packages. Some boot the real
`app.js` on a small fake page (`tests/apphost.js`) with the play board
stood in for. `tests/own_e2e.test.js` starts the stand-in and the server in
rehearsal on this machine's loopback (it runs `python` on Windows,
`python3` elsewhere, or `$PYTHON` when set) and uploads the desk's own
picture through them.

## Known limits (so far)

- Live mode has been run against Meta once (2026-10-27, the desk sample
  picture). Those calls showed that the first reader of sam-3.1's answer
  text, written from a summary of Meta's documents, did not match the real
  grammar, so every box was dropped. The reader is now written from those
  recorded answers and tested against them
  (`server/tests/fixtures/desk_1027.json`); a photo unlike the desk may
  still bring a surprise, which the reader reports as a diagnostic instead
  of guessing.
- SAM's mask payload (Meta's opaque one_bit encoding) is checked for its
  alphabet and its shape and not decoded; outlines are traced by code
  inside SAM's boxes instead.
- Muse Spark names each kind of thing once, with the plain word SAM finds
  every one of ("chair", not "wooden chair" and "armchair"), and says how
  many it sees, up to 11 kinds. When SAM gives several matches for one
  name, the ones holding one of Muse Spark's points for it are kept (a
  point may fall up to 3% of the picture beside a box: Muse Spark's points
  are rough); when Muse Spark counted more than its points found (two
  chairs, a point on one), the most confident other matches, from 0.5 up
  and at least 75% of the best, make up the count; with no point in any
  match, the most confident from 0.5 up. A kind keeps at most 3 things to
  collect, 4 obstacles, 2 hazards and one exit; one box is never two
  things. What is dropped is listed with the reveal.
- When SAM finds nothing usable for a thing, code traces around Muse
  Spark's own points for it instead, in a region a little larger than the
  points. These shapes are smaller and rougher than SAM's, carry no
  confidence, and the reveal says how many there are ("SAM 3.1 found 5;
  for 4 more, code traced around Muse Spark's points"). A point that falls
  on the thing next to the right one (a coin lying on a notebook) traces
  that thing instead.
- Live outlines are traced by code inside SAM's boxes; an object whose trace
  is not tight is traced again on a finer and a coarser grid, and if it is
  still not tight it falls back to its box, and the reveal says so. Small, low
  contrast objects are the hardest to trace.
- The floor is grown by colour: a floor much like its walls (white boards
  under white walls) can run past its edge, up to 2% of the picture beyond
  SAM's floor boxes, and a thing much like the floor that SAM did not find
  is walked over. A thing on the floor that SAM did not find, unlike the
  floor, is a wall. Marked rooms keep the horizon.
- A box you mark is looser than SAM's: code looks for the one shape that
  stands out inside it and traces that. A box over several things, or over
  a thing much like its background, keeps your box as you drew it, and the
  reveal counts it as kept as a box.
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
