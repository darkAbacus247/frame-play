# FRAME//PLAY

Photograph your room. Play it.

FRAME//PLAY turns one still photo of a room or a desk top into a small 2.5D
adventure stage. The outlines of the real objects in the picture become the
walls you walk around, the things you collect, the hazard you avoid and the
exit you reach.

Built during the Meta Global AI Developer Hackathon (Indie track). This
repository was created on 2026-10-26 after 16:00 UTC, during the event.
Pre-existing: Meta's Muse Spark and SAM 3.1 models, SAM's mask format
(ported under its license), and the written notes of my pre-event prototype
(Oct 21 to 25), read as a spec, with none of its code; built during the
event, from the first commit: all the code, art, music and tests. The port's
license is in the NOTICE under License, below.

**Who it is for.** Any room you can photograph becomes a game: kids learning
the names of things (the riddles), people in rehab or memory care playing in
a room they know, and anyone: every screen is built for the keyboard and a
screen reader, with labelled buttons, keys that steer and a spoken line for
what happens (checked on a stand-in page by the tests; no run with a real
screen reader is recorded here yet).

**Try it in a minute.** Open the demo (the link is in the submission), or run
`python server/server.py` and open `http://127.0.0.1:8191/`. On Step 2, pick
**Our kitchen (a real photo)**: with no key it replays Meta's recorded answer
for that photo, and says so; on a live server it is read fresh. Play the
round, then press **Ask the room** on its end card. The demo video is linked
in the submission too.

## The road

One road of 15 steps with one step counter: Welcome, then the three sample
rooms in a row, The Desk Top, The Living Room and The Apartment (each:
pick, see what is in it, play), the three side by side (Your three
rooms), then **your own room**: a photo from your device, or from the
camera where the browser offers one. What happens to that photo depends on
the server's mode, and Step 12 says so before you choose one.

The rooms follow one another: when a round ends, win or lose, the end
card's primary goes straight on to the next room's reveal. The
pick steps stay on the road with the next room already chosen there, so
← (or the browser's Back, or Choose a different room) still reaches them,
and any room can be picked there instead. Every pick step offers four
cards: the three sample rooms and **Our kitchen (a real photo)**, with its
thumbnail (see "Don't have a photo? Use ours" below). Picked there, our
kitchen is played as a sample room is: its result, Your three rooms, the
closing screen and Free play all show it, the next sample room follows it,
and, like a sample room, it is never on the road twice. A road saved by the earlier
12-step page reads onto this one: its rooms and results are kept, and it
goes on from the first room it has not played (The Apartment, chosen for
it).

### Sample rooms

Drawn by code, with exact outlines, and labelled MOCK: The Desk Top and
The Living Room, seen at eye level, and The Apartment, a floor plan seen
from above: a living room, a kitchen, a bedroom and a hall, joined by
three doorways and walled off everywhere else, with a coin in each of
three rooms, a cactus in the kitchen, obstacles (a sofa, a coffee table, a
dining table and two chairs, a bed, a cabinet) and the exit in the
bedroom, which only the kitchen opens onto. The stand-in answers for any
of them (`--room apartment`), so a rehearsal of the apartment runs the
whole live path: a read seen from above, a floor in four matches whose
masks (each doorway in the mask of a room it opens from) are the play
area, every outline a decoded mask, walls and doorways.

### How a photo becomes a room

- **LIVE** (a key and the live switch on the server): the photo is shrunk
  and stripped of its camera data on the device, then goes through this
  app's server to Meta's Model API for one read: one Muse Spark call, then
  one SAM 3.1 call for the surface and one for each kind of object on it;
  then, while you play, one more Muse Spark call writes up to 3 riddles
  about it (Ask the room, below); at most 14 calls in all, each carrying
  the photo (a failed call may be
  sent one more time, a busy answer twice; the room read is never sent
  again after a timeout). This app does not store the photo. The room is
  built from what the models found in it: Muse Spark names the things and
  gives each a role and a few points on it; SAM 3.1 answers each name with
  its matches (a box and a mask each), and of several, the ones holding
  Muse Spark's points are kept (a point on a match's mask pixels counts
  before one only inside its box). **SAM 3.1's masks are the outlines:**
  the server decodes each kept match's mask into its exact outline, holes
  kept (a mug's handle stays open), with its area and bounds, and the page
  uses it as it is; only where a mask does not decode does code trace the
  outline inside SAM's box instead, and the reveal counts each way ("SAM
  3.1's masks gave 9 exact outlines; code traced 0"). Muse Spark also says
  how the camera sees the room (at eye level, from above as in a floor
  plan, or at a slant) and gives points on the open floor, one or more a
  room; SAM 3.1 answers "floor" (or the desk, the table) with one match a
  room. **SAM 3.1's floor mask is the play area:** the server lays the
  masks of SAM's floor matches together, and that floor is where the
  explorer may walk, together with **the floor you cannot see**: the floor
  hidden behind and under the things standing on it, inferred from the floor
  that was seen. An object's outline keeps its holes; the floor's holes,
  where things stand, are filled as hidden floor, and so are the slivers a mask leaves between a thing and
  the floor around it (within 0.6% of the picture's long side of a thing);
  then only each thing's footprint is taken out (seen at eye level, the band
  at its base where it meets the floor, not its whole silhouette; from
  above, its outline). So the explorer walks behind a kitchen island or a
  sofa, hidden by it while it is there, as it would in the room. The
  floor's outer boundary away from things, and the picture's edges, stay
  walls, and seen from above a thing never opens a wall. Everything else is wall. Pieces of the mask that
  touch only at a corner or lie one or two squares of the explorer's grid
  apart (a seam in the mask, never a real wall) are joined, with a passage
  the explorer fits through, so no coin is cut off, and the words say how
  many gaps were joined. A doorway is where the floor runs on from one room
  into the next, and where it meets the exit's outline. The proof that the
  room can be won runs on this floor. Only when no floor mask decodes does
  code grow the floor from Muse Spark's points, by colour and edges, inside
  SAM's floor boxes, as before. Seen from above, a thing blocks its whole
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
  is the way on: you mark the room yourself. Nothing is sent. (Or use ours:
  see below.)
- **REHEARSAL** (the local stand-in): the stand-in only knows its sample
  room's own picture, which the page offers to save. Any other photo, or a
  copy of that picture edited enough for the page's check to see (an
  object erased or pasted, an object moved by 8 px or more, a crop), is
  refused in words before anything is sent, and no level is made from it.
  An edit of a few pixels (a coin nudged by 4 px, a small mark) can pass,
  and the stand-in then answers with its sample's own places, in the very
  grammar sam-3.1 answers in and with real one_bit masks (the painter's
  exact silhouettes of what the picture shows, coded by the codec's own
  canonical encoder; `server/standin_masks/`, made by
  `tests/standin_silhouettes.js`), so the same reader, mask decoder, match
  choice, floor and point fallback run (its zero_matches drill makes the whole room from Muse
  Spark's points; its sam_busy drill answers every SAM call as busy, so the
  page shows the busy words and Try this photo again; its 401 drill refuses
  the key, and the page turns the picker off with Check again, as LIVE does
  after an account problem). A refused photo, or a read that fails, can be
  marked as in MOCK.

### Don't have a photo? Use ours

Everywhere a photo can be chosen, our kitchen is offered as a card with its
thumbnail, **Our kitchen (a real photo)**: beside the three sample rooms on
Steps 2, 5 and 8, and beside **Choose a photo** on your own room (Step 12).
It is `rooms/kitchen.jpg`, a photo of a real kitchen. It is the author's
own photo, taken by the author, with its camera data removed (1024 x 399,
no people), and it is released with this repository under its license.

- **LIVE**: it goes through Meta's models fresh, exactly like a photo you
  choose: shrunk and stripped on the device, one read (one Muse Spark call,
  then SAM 3.1, then one more Muse Spark call for its riddles), kept on the device like any photo's level, so pressing it
  again loads that level and sends nothing. Its words say it is our kitchen
  photo, read now, not yours.
- **MOCK and REHEARSAL** (no model may be called; also LIVE while the live
  AI is unavailable): the server replays Meta's real recorded answer for
  this exact photo, taken on 2026-10-27: one muse-spark-1.3 answer and six
  sam-3.1 answers (the stove, the kitchen island, the refrigerator, the
  counter, the floor and the door, with real one_bit masks), kept byte for
  byte in `server/replay/kitchen/`. `POST /api/replay/kitchen` (`server/replay.py`)
  runs the very same pipeline a live photo goes through, its transport
  answering each call with its recorded answer in place of the network, so
  the same reader, mask decoder, match choice, floor and outlines run, and
  nothing is sent anywhere. The reply's mode is `replay`: it claims no
  model called now, its calls are marked replayed, its cost is zero, and
  the server replays nothing for a photo whose fingerprint is not the
  recorded one. The page checks the same fingerprint, builds the room from
  SAM 3.1's masks, and every screen that shows it says: "Meta's models read
  this photo on Oct 27, 2026; this copy replays their recorded answer; no
  model was called now." The replay makes the room the live read made:
  Muse Spark named 8 things (5 on the floor, 3 as scenery), SAM 3.1's
  masks gave 5 exact outlines plus the floor, code made 2 changes, and the
  room can be won. The floor behind the kitchen island, which the camera
  never saw, is walked on: a path runs all the way around the island, and
  the explorer walks it by the keys, the pad and taps (a tap on
  the island's far part walks behind it).

In MOCK, where a server answers, our kitchen's card is the one primary on
your own room (it is the one room a model's answer can make there); with
no server at all it is off, and says why, on every screen that offers it.
A replayed room is never kept on the device: on a return visit it is
replayed again in place. Its thumbnail is the photo itself, fetched from
this page's own server and decoded on the device; nothing is sent for it.

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

The people refusal (in LIVE, Muse Spark sees a person in the photo it
reads, and the read stops there) and Muse Spark declining to read a photo
for its content are the refusals with no marking after them: such a photo
makes no room in any way. In MOCK no model reads the photo, so nothing
checks it for people; it stays on the device and can only be marked by
hand. A photo that is
refused is not shown on Step 12; the screen says in words why no room was
made from it, and the photo appears again only on the marking board, if
you choose to mark it.

**Mark it yourself.** On Step 13 (named Your marks) you pick what a box is
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

**A sure way to completion.** Every Play step on the road has a plainly
labelled secondary, **End this round**. It asks first in a true modal card
("End this round? It counts as played, not won.", with End it and Keep
playing; Keep playing has the focus and Escape never closes it). Ended, the
round counts as played, not won (a room won before keeps its best), and the
road goes on as the end card would. So every path, in every mode, reaches
the closing screen after the last room, whether your own room was made from
a photo you chose, from our kitchen, marked by you, or passed by.

The road ends on a closing screen (Step 15, the counter's last step) that
says the circuit is complete, and celebrates: the music's sting and confetti
over the screen, once on each arrival (no confetti with Reduce motion, and
neither with Effects off), and one line of the rooms won ("You won two of
your four rooms."). Then each of the four rooms (the three sample
rooms, or our kitchen where it took one's place, then your own room: yours, ours, or not made) with whether you won
and your best route, a line on what the AI did in it (for ours replayed,
the replay's own words), and the ways on: Free play, I'm done, Play again for any
room, Try your own room (a photo of yours, or ours), and Start over, which
asks first and clears nothing unless you confirm. I'm done ends the visit
with a short thank-you (one line of the rooms played and won, a soft fade,
the music's closing sting once) and then closes the app window; an ordinary
browser tab cannot be closed by the page, so there it says "You can close
this tab now." and offers Free play and Start over.

Install it as an app: the page is an installable web app
(`manifest.webmanifest`, icons in `icons/` drawn from the favicon by
`python -B tools/make_icons.py`, and a small service worker, `sw.js`, that
keeps only the page's own static files, never `api/...`, a photo or a key).
Open the page from the local server in a browser that offers installation
(Chrome or Edge, for example); Settings then shows Install (it appears only
while the browser offers it), or use the browser's own install item. The
installed app opens in its own window from your apps, and there I'm done
closes that window. It is the same page: LIVE (and REHEARSAL) still need
the local server running, started as above, and the installed app is tied
to the address it was installed from. While a card or the settings are open, a round in play holds
still, so no round ends under them. Free play always opens on the list of rooms (the three sample rooms, and
your own room once made: our kitchen carries its REPLAY tag where it was
replayed); a replay of a room there lasts only
while you stay on it, and its rounds never change the road's results (its
end card says so). Your own room, when made, stays on the road: going
back to its step and choosing Continue to the end keeps it, its result and
its place in Free play.

Every room's reveal and play steps have a plain **Choose a different
room** button (**Choose a different photo** for your own room) that goes
back to the step where the room was picked, to pick again. It is never the
primary button. With a round under way it asks first ("Leave this room?
Your round so far is not kept."), and Keep playing is the default.

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
the way on. A sample step's room this copy cannot make is picked again on
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

### Ask the room

After any round, won or lost, the end card offers **Ask the room**: a
riddle about the room, answered by touching a thing in it. The road never
waits for it: the card's primary still goes on, and so does the counter's →.

- **Who writes it.** In LIVE, Muse Spark, in one more call made after the
  room's reply has gone to the page, so the reveal never waits: it sees the
  photo and the list of what SAM 3.1 found, under the reply's own ids, and
  answers with up to three riddles, each with its answers by id and one
  point on each answer. The sample rooms' riddles are written into the room
  files and labelled "Riddle written into this sample room · MOCK · no model
  was asked"; in REHEARSAL the stand-in answers with them. Our kitchen's
  replay replays riddles Muse Spark wrote for that photo in a LIVE read on
  2026-10-28 (`server/replay/kitchen_riddles.json`), on the same stream and
  through the same checks, labelled "REPLAY · Riddle by muse-spark-1.3,
  recorded Oct 28, 2026 · no model was called now". That read's answers
  were its own ids, so each riddle's points go through the game's own pick
  on the replay's SAM 3.1 masks: the refrigerator and the stove are
  replayed; the four cabinets are not, since the replayed answers found no
  cabinets. No call is made for them.
- **Who decides what is right.** Muse Spark says which things answer a
  riddle, and every answer must be a thing SAM 3.1 found; SAM 3.1 says
  where they are; code fills in the count of those answers (the number in
  "find the four ..."), so no model writes a number; code decides whether the player touched them, on each
  thing's own outline: SAM 3.1's mask in LIVE, the painted shape in the
  samples. No model judges an answer.
- **What is kept.** Code keeps a riddle only if it passes every check
  (`server/riddles.py`): 12 to 90 characters and no digits, the count only
  as `{n}`, no word of an answer's name, nothing about people or bodies,
  answers on the list and fewer than all of it, a rule that fits its
  answers, each answer's point within 1.5% of the picture's long side of
  the box SAM found for it, and no two riddles with the same answer. Each
  riddle dropped is listed in words.
- **Answering.** Tap or click a thing (a near miss within 1.2% of the long
  side, or 16 CSS pixels, counts and is said aloud), or choose it under
  **Answer with** (every thing with its place, in alphabetical order) and
  press **Pick it**. A right pick lights the thing's own pixels inside its
  outline and leaves a check; a wrong pick is outlined in red dashes with a
  cross; two misses end the riddle. Esc or **Stop the riddle** goes back to
  the end card.
- **Cost and switch.** One more Muse Spark call a photo, about 0.8 cent;
  `FRAMEPLAY_RIDDLES=no` on the server turns it off. Checked live on our
  kitchen photo on 2026-10-28: three riddles 6.4 s after the reveal (the
  refrigerator, the stove, and the four cabinets, their count filled in
  by code),
  every answer graded on SAM 3.1's own masks.

## Sound and motion

Every sound and the music are made in code with the Web Audio API; there
are no audio files or samples, and the music is written for this game. The
music is a calm loop of pads, a bass and a light melody that changes every
phrase; it is quieter and sparser during a round and plays a short sting on
the closing screen. It starts only with the first press or key, never by
itself after a reload. Sound and music are on for a fresh visitor, the
music at a gentle level under the game's own sounds (soft steps, a coin
chime, a hazard thud, the exit opening, a win jingle, a loss sting, a
shimmer as the reveal's outlines draw in, a quiet click on primary
buttons). A hidden tab holds them all.

Particles (coin sparkles, win confetti, a hazard puff, step dust, a trace
along each outline on the reveal) are drawn on a second canvas laid over
the board, so they never change its size or the page's layout. Their
counts are capped, and with reduced motion (the system's setting or the
page's) there are none.

`src/settings_fx.js` builds the controls for the Settings drawer: Music on
or off with a volume, Effects on or off, and Reduce motion (the same choice
as the Motion switch). Each choice is kept on this device, and only once
changed. The game tells a small event bus (`src/events.js`) what happens;
the sound and the music listen. All of this is checked by unit tests
against a stand-in AudioContext and a fake page, not yet in a browser.

## Running it

Python 3.10 or newer, standard library only; no packages to install.

```
python server/server.py
```

The page is at `http://127.0.0.1:8191/`. Without `MODEL_API_KEY` and
`FRAMEPLAY_LIVE=yes` in the operator's own environment the server runs in
MOCK mode: sample rooms drawn by code, labeled MOCK, and no model is called;
our kitchen photo's recorded answer is replayed there (`POST
/api/replay/kitchen`, served in every mode, costs nothing and sends nothing).

In LIVE the server reads at most 4 photos at once and 120 an hour, 200 a
day, and stops for the day at an estimated $5. Within those, each client
gets at most 3 photos an hour and 10 a day, so one visitor cannot use up the
day for everyone. The client is the connection's address, or with
`--public` the first `X-Forwarded-For` hop (the visitor's address as the
Space's proxy gives it); if a proxy passed on a hop the visitor wrote, one
visitor could pose as several, and the server's own ceilings still hold. A photo is one Muse Spark
call, at most 12 SAM 3.1 calls and one more Muse Spark call for its riddles
(at most 14 calls in all): at the published prices about four to five
cents, and about nine cents at worst (every call answered once; a call sent
again costs again), so the stop allows at least 50 photos a day. If the Model API refuses the
key, the account has no credit or quota, or a model is gone, the server
stops sending photos, says so in health (live_state: unavailable), and lets
one photo check again every 10 minutes. When LIVE cannot read a photo for
any of these reasons, our kitchen photo falls back to its recorded answer,
replayed and labeled REPLAY, and the page says why it was not read live.

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

- Live mode has been run against Meta on 2026-10-27: the desk sample
  picture, then our kitchen photo, whose answers the server replays. The
  first calls showed that the first reader of sam-3.1's answer
  text, written from a summary of Meta's documents, did not match the real
  grammar, so every box was dropped. The reader is now written from those
  recorded answers and tested against them
  (`server/tests/fixtures/desk_1027.json`); a photo unlike the desk may
  still bring a surprise, which the reader reports as a diagnostic instead
  of guessing.
- SAM's mask payloads ('!' one_bit, which this app asks for, or '~'
  lossless, the API's default) are read by a strict decoder
  (`server/sam_mask.py`, see NOTICE below), each mask once per photo and only
  for the matches kept, while the photo has time left; the reply says of
  each mask whether it decoded, and a call whose mask did not decode
  carries the diagnostic `mask_undecodable` (`mask_time` when the photo
  ran out of time); that match's outline is then traced by code inside its
  box, and the reveal counts it as traced.
  The desk surface's mask, 1024 x 368, the largest recorded, decodes and
  is outlined in about 0.5 s in pure Python.
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
- Live outlines are SAM 3.1's own masks, simplified by at most 0.75 px. Where
  a mask does not decode, the outline is traced by code inside SAM's box; an
  object whose trace is not tight is traced again on a finer and a coarser
  grid, and if it is still not tight it falls back to its box, and the
  reveal says so. Small, low contrast objects are the hardest to trace. On
  the recorded desk answers the masks' outlines lie on the painter's exact
  silhouettes at IoU 0.958 (the coins, 34 x 21 px) to 0.994.
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
- Ask the room: a riddle's answer is Muse Spark's judgement of the photo;
  where its answers are comes from SAM 3.1, so a thing SAM did not find is
  never an answer, and their count is the number of answers Muse Spark
  chose (if SAM found five cabinets and Muse Spark chose four, the riddle
  asks for four). English only, at most three riddles a room.

## Disclosure

FRAME//PLAY was built during the Meta Global AI Developer Hackathon (October
26 to Nov. 4, 2026). Pre-existing: Meta's Muse Spark and SAM 3.1 models,
SAM's mask format (ported under its license), and the written notes of my
pre-event prototype (Oct 21 to 25), read as a spec, with none of its code;
built during the event, from the first commit: all the code, art, music and
tests. Built with AI assistance: Claude Code (Anthropic) wrote the code
under my direction. Live rooms are read by Meta's muse-spark-1.3 and sam-3.1
through the Meta Model API; sample rooms are drawn by code and labeled MOCK.

## License

MIT, except two files under the SAM License (see NOTICE below). See
[LICENSE](LICENSE). The sample kitchen photo, `rooms/kitchen.jpg`, is the
author's own photo, released with this repository under the MIT license.

**NOTICE.** `server/sam_mask.py` is derived from Meta's meta-sam-parser 0.1.0
(its mask codec, including the canonical one_bit encoder the stand-in
uses, and the contour tracing of its mask conversion): it is a port
written for this repository, and it is distributed under the SAM License,
not MIT. So is `server/tests/lossless_encoder.py`, a test-only lossless
encoder written as the mirror of that decoder. The license text is in
[LICENSES/SAM_LICENSE.txt](LICENSES/SAM_LICENSE.txt), verbatim, as plain
UTF-8 text. Everything else in this repository is MIT.
