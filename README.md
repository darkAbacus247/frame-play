# FRAME//PLAY

Photograph your room. Play it.

FRAME//PLAY turns one still photo of a room or a desk top into a small 2.5D
adventure stage. The outlines of the real objects in the picture become the
walls you walk around, the things you collect, the hazard you avoid and the
exit you reach.

Built during the Meta Global AI Developer Hackathon (Indie track). This
repository was created on 2026-10-26 after 16:00 UTC, during the event
([FIRST_COMMITS.md](FIRST_COMMITS.md) lists every file's first commit;
[PROVENANCE.md](PROVENANCE.md) says what wrote each part).
Pre-existing: Meta's Muse Spark and SAM 3.1 models, SAM's mask format
(ported under its license), and the written notes of my pre-event prototype
(Oct 21 to 25), read as a spec, with none of its code; built during the
event, from the first commit: all the code, art, music and tests. The port
(of meta-sam-parser 0.1.0's mask codec and contour tracing,
`server/sam_mask.py`) and its license are named in the NOTICE under
License, below. Apart from Meta's SAM License text, kept verbatim in
`LICENSES/SAM_LICENSE.txt`, the one file that may be older than the event
is the sample kitchen photo, `rooms/kitchen.jpg`, added on Oct 27 with no
recorded capture date.

**Who it is for.** Any room you can photograph becomes a game: someone
who wants to play their own desk as a level in a minute, two friends
passing one phone round a kitchen table, an English learner matching
riddles about their own kitchen to the names of its things (reading a
photo, and riddles about it, need a server running LIVE; without one you
mark the room yourself). It is for players
18 and over (see Privacy, below). Every screen is built for the keyboard and a screen
reader, with labeled buttons, keys that steer and a spoken line for what
happens (checked on a stand-in page by the tests; no run with a real
screen reader is recorded here yet).

**Try it in a minute.** Open the demo at https://huggingface.co/spaces/darkAbacus247/frame-play, or run
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

The sample rooms follow one another: when a round ends, win or lose, the
end card's primary goes straight on to the next room's reveal (after the
third, to Your three rooms). The
pick steps stay on the road with the next room already chosen there, so
← (or the browser's Back, or Choose a different room) still reaches them,
and a room can be picked there instead, unless an earlier step or your own
room holds it. Every pick step offers four
cards: the three sample rooms and **Our kitchen (a real photo)**, with its
thumbnail (see "Don't have a photo? Use ours" below). Picked there, our
kitchen is played as a sample room is: its result, Your three rooms, the
closing screen and Free play all show it, the next sample room follows it,
and, like a sample room, it is never on the road twice. A road saved by the earlier
12-step page reads onto this one: its rooms and results are kept, and it
goes on from the first room it has not played (The Apartment, chosen for
it).

### Sample rooms

Drawn by code, with exact outlines, and labeled MOCK: The Desk Top and
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
  sent one more time, a busy one two more times; the room read is never
  sent again by itself after a timeout); a postcard, where a server has it
  on and you ask for one, sends the same photo to Muse Image one more time
  (Postcard, below). This app does not store the photo. While this
  demo runs on Meta's free hackathon credits, Meta may use the photos it
  receives to improve its products (Meta's Billing page for the demo's
  key: "While using free credits your content may be used for product
  improvement."); the page says so before a photo is sent. The room is
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
  room; SAM 3.1 answers "floor" (or the desk, the table) with its
  matches. **SAM 3.1's floor mask is the play area:** the server lays the
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
  lie at most two squares of the explorer's grid apart (a seam in the mask,
  never a real wall) are joined, with a passage the explorer fits through,
  and the words say how many gaps were joined (a piece under 0.4% of the
  picture is left as it is). A doorway is where the floor runs on from one room
  into the next, and where it meets the exit's outline. The proof that the
  room can be won runs on this floor. Only when no floor mask decodes does
  code grow the floor from Muse Spark's points, by colour and edges, inside
  SAM's floor boxes (each grown by 2% of the picture's long side). Seen from above, a thing blocks its whole
  outline. With no floor found (no points, no floor match, or too little
  floor around the points) the play area is everything below the horizon
  (from above, the whole picture), and the level's provenance says so in
  words. For a thing SAM
  finds nothing usable for, code traces around Muse Spark's own points
  instead, with the same tracer, and the reveal says how many came each way
  ("SAM 3.1 found 5; for 4 more, code traced around Muse Spark's points").
  When SAM finds nothing and Muse Spark gave no points, the read makes no
  room. Where a read fails for a reason that may pass (a busy model, a read
  that ran out of time), the screen says so and **Try this photo again**
  sends the same photo one more time. If the read fails otherwise or makes
  no room (the key the operator set is refused, the account has no credit,
  the server cannot be reached), the screen says why in words, and for a
  refused key it says plainly that it is the operator's key, not anything
  of yours; then Mark your room is the way on, and nothing more is sent.
  (On Steps 2, 5 and 8, the way on is another photo or a sample room.)
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
own photo; when it was taken is not recorded. It was added on Oct 27,
2026, during the event, with its camera data removed (1024 x 399, no
people), and is released with this repository under the MIT license.

- **LIVE**: it goes through Meta's models fresh, exactly like a photo you
  choose: shrunk and stripped on the device, one read (one Muse Spark call,
  then SAM 3.1, then one more Muse Spark call for its riddles), kept on the device like any photo's level, so pressing it
  again loads that level and sends nothing. Its words say it is our kitchen
  photo, read now, not yours.
- **MOCK and REHEARSAL** (no model may be called; also LIVE while the live
  AI is unavailable): the server replays Meta's real recorded answer for
  this exact photo, taken on 2026-10-27: one muse-spark-1.3 answer and six
  sam-3.1 answers (the stove, the kitchen island, the refrigerator, the
  counter, the floor and the door, with real one_bit masks), kept in
  `server/replay/kitchen/`. `POST /api/replay/kitchen` (`server/replay.py`)
  runs the very same pipeline a live photo goes through, its transport
  answering each call with its recorded answer in place of the network, so
  the same reader, mask decoder, match choice, floor and outlines run, and
  nothing is sent anywhere. The reply's mode is `replay`: it claims no
  model called now, its calls are marked replayed, its cost is zero, and
  the server replays nothing for a photo whose fingerprint is not the
  recorded one. The page checks the same fingerprint, builds the room from
  SAM 3.1's masks, and its reveal and the closing screen say: "Meta's models
  read this photo on Oct 27, 2026; this copy replays their recorded answer;
  no model was called now." Every other screen that shows it labels it
  REPLAY. Replayed, the recorded answer makes this room:
  Muse Spark named 8 things (5 on the floor, 3 as scenery), SAM 3.1's
  masks gave 5 exact outlines plus the floor, code made 2 changes, and the
  room can be won. The floor behind the kitchen island, which the camera
  never saw, is walked on: a path runs all the way around the island, and
  the explorer walks it by the keys, the pad and taps (a tap on
  the island's far part walks behind it).

In MOCK, where a server answers, our kitchen's card is the one primary on
your own room (it is the one room a model's answer can make there) unless
an earlier room already holds it; with no server at all it is off, and
says why, on every screen that offers it.
A replayed room is never kept on the device: on a return visit it is
replayed again in place. Its thumbnail is the photo itself, fetched from
this page's own server and decoded on the device; nothing is sent for it.

**Floors, walls and doorways.** Where a room's floor is known (drawn by
code in a sample room; from a read, SAM 3.1's floor mask, or where none
decodes, a floor grown by code from Muse Spark's points),
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
labeled secondary, **End this round**. It asks first in a true modal card
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
the music's closing sting once) and then asks the browser to close the
window; where the browser keeps it open (it keeps most ordinary tabs
open), it says "You can close this tab now." and offers Free play and
Start over.

Install it as an app: the page is an installable web app
(`manifest.webmanifest`, icons in `icons/` drawn from the favicon by
`python -B tools/make_icons.py`, and a small service worker, `sw.js`, that
keeps only the page's own static files, never `api/...`, a photo or a key).
Open the page from the local server in a browser that offers installation
(Chrome or Edge, for example); Settings then shows Install (it appears only
while the browser offers it), or use the browser's own install item. The
installed app opens in its own window from your apps, and there I'm done
asks the browser to close that window. It is the same page: LIVE (and REHEARSAL) still need
the local server running, started as above, and the installed app is tied
to the address it was installed from. While a card or the settings are open, a round in play holds
still, so no round ends under them. Free play opens on the list of rooms
(the three sample rooms, our kitchen once it is on your road, and your own
room once made; our kitchen carries its REPLAY tag where it was replayed),
and Play again on the closing screen opens that room's round there at
once; a replay of a room there lasts only
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

Every screen is written to fit without scrolling at 100% zoom in a window
945 px tall or more: one short line up front, short labeled facts, and the
longer text (the full consent notice, the list of what the AI found, the
proof) in a disclosure that starts closed. Text runs in one column held to
65ch (65 widths of the digit zero). In a 1280x800 window the closing screen
fits whole (its ways on sit right under the won line, and the four rooms
two by two), and so does every road screen but three: in MOCK, your own
room with a photo kept here (landscape or portrait), and in REHEARSAL,
under its band, Your three rooms. Those three scroll by 29 to 40 px there,
in the model.
`tests/fit.test.js` checks every road screen and the closing screen at
839x945 and 1259x1418, and at 1280x800 names those three and checks the
rest, and `tests/layout.test.js` checks the play screen,
both with a layout model built on the stylesheet's own rules and no
tolerance; it is a model, not a browser. A picture sized to fill the space
left (the reveal, the play board) rounds what it subtracts up and the space
down, so it never overshoots by a fraction of a pixel. The small tour offer
that appears by itself after 45 seconds without progress stays only where
it fits without making the screen scroll.

### Ask the room

After any round, won or lost, in a room with riddles, the end card offers
**Ask the room**: a riddle about the room, answered by touching a thing in it. The road never
waits for it: the card's primary still goes on, and so does the counter's →.

- **Who writes it.** In LIVE, Muse Spark, in one more call made after the
  room's reply has gone to the page, so the reveal never waits: it sees the
  photo and the list of the room's things, under the reply's own ids, and
  answers with up to three riddles, each with its answers by id and one
  point on each answer. The sample rooms' riddles are written into the room
  files and labeled "Riddle written into this sample room · MOCK · no model
  was asked"; in REHEARSAL the stand-in answers with them. Our kitchen's
  replay replays riddles Muse Spark wrote for that photo in a LIVE read on
  2026-10-28 (`server/replay/kitchen_riddles.json`), on the same stream and
  through the same checks, labeled "REPLAY · Riddle by muse-spark-1.3,
  recorded Oct 28, 2026 · no model was called now". That read's answers
  were its own ids, so each riddle's points go through the game's own pick
  on the replay's SAM 3.1 masks: the refrigerator and the stove are
  replayed; the four cabinets are not, since the replayed answers found no
  cabinets. No call is made for them.
- **Who decides what is right.** Muse Spark says which things answer a
  riddle, each one a thing in the room's reply: found by SAM 3.1, or traced
  by code around Muse Spark's own points where SAM gave nothing usable;
  code fills in the count of those answers (the number in "find the four
  ..."); code decides whether the player touched them, on each thing's own
  outline (or its box, where that outline missed the part Muse Spark
  pointed at): in LIVE, SAM 3.1's mask or the outline code traced; in the
  samples, the painted shape. No model judges an answer.
- **What is kept.** Code keeps a riddle only if it passes every check
  (`server/riddles.py`): 12 to 90 characters and no digits, the count only
  as `{n}` in a riddle that asks for all its answers, no word of three
  letters or more from an answer's name, none of a list of words for people
  and bodies, answers on the list and fewer than all of it, a rule that
  fits its answers, each answer's point within 1.5% of the picture's long
  side of that thing's box, and no two riddles with the same answer. Each
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
  kitchen photo on 2026-10-28: three riddles (the refrigerator, the stove,
  and the four cabinets, their count filled in by code).

### Postcard (Muse Image)

After a round in a room read live from a photo, the end card and the
closing screen offer **Make a postcard (Muse Image)** as a secondary
button: press it and the same shrunk, stripped photo the round used goes to
Meta's Muse Image one more time, which draws a postcard of that very room
with "Greetings from" and the room's name printed on it, then Muse Spark
reads the printed text back and the card says whether it matches. It is off
on the public demo and off by default: `FRAMEPLAY_IMAGE=yes` on the server
turns it on (health says `postcard: on`), and the page offers it only then,
and never for a sample room, a replay, a rehearsal or a marked room.

- **What the card shows.** The picture, labeled "Made by Muse Image (AI) ·
  LIVE", the read-back in one line (a match, or the difference named, such
  as `expected "Kitchen" but read "Kitchn"`), and **Save the postcard**,
  which downloads the JPEG. A postcard that fails says why in words, and
  the round's own card is a press away; the round itself is never blocked.
- **What is kept.** While the page is open, the shrunk photo of a LIVE room
  stays in its memory with its level, whether or not the postcard is on,
  and is never saved on the device or the server; a level loaded from the
  device offers no postcard until its photo is picked again. The consent
  notices say, before a photo is sent, that a postcard sends the same
  shrunk photo to Muse Image one more time and that this app keeps no
  photo on the device or its server.
- **Cost and limits.** About one cent a postcard (`POSTCARD_USD`) plus the
  read-back's Muse Spark tokens, counted in the server's daily spending
  stop, and at most 100 postcards a day on a server (`POSTCARD_DAY_CAP`).

### Say it (Muse Voice Transcribe)

Optional, and off unless the server runs LIVE with `FRAMEPLAY_VOICE=yes`;
health shows the switch (`voice`). When it is on, the riddle panel gets
**Say it** beside **Answer with** (the V key does the same while the board
has focus): the page records up to five seconds from the microphone, turns
the clip into a mono 16-bit 16 kHz WAV on the device (`src/voice.js`), and
posts it to `POST /api/voice`, where the server has Meta's Muse Voice
Transcribe write it down and code matches the words against the room's
things by name (`server/voice.py`); no model judges the answer. One thing
named is picked exactly as a tap would be; none, or two, shows the server's
words and what was heard; a failure shows its words and the riddle goes on,
to be answered by a tap or under Answer with. Before the first clip the
panel asks for consent, one time a visit, with an OK button. Voice is for
players 18 and over. This app keeps no clip, on the device or on its
server; while the demo runs on Meta's free hackathon credits, Meta may use
what it receives to improve its products. Cost: about five seconds of audio
at $0.18 an hour, under a tenth of a cent a clip, counted in the server's
daily spending stop; the server takes at most 6 s a clip, 200 clips a day
and 10 an hour from one client.

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
or off with a volume, Effects on or off, and Reduce motion. Each choice is kept on this device, and only once
changed. The game tells a small event bus (`src/events.js`) what happens;
the sound and the music listen. All of this is checked by unit tests
against a stand-in AudioContext and a fake page, not yet in a browser.

## Privacy

FRAME//PLAY is for players 18 and over: the first screen says "You must be
18 or over to send a photo (Meta's terms)." and its button reads "I am 18
or over and I understand. Continue". That screen also asks you to keep
people and anything private out of the photo.

- **What is sent.** Only in LIVE, after that screen: the photo, shrunk and
  stripped of its camera data on the device, through this app's server to
  Meta's Model API; where a server has them on, the same copy to Muse Image
  for a postcard you ask for, and a voice clip of about five seconds (at
  most six) to Muse Voice Transcribe. While this demo runs on Meta's free hackathon
  credits, Meta may use the photos and voice clips it receives to improve
  its products; the page says so before anything is sent. In MOCK and
  REHEARSAL nothing is sent to Meta.
- **What is kept.** No photo and no voice clip is saved, on the device or
  on the server. Levels made from your photos (outlines, names and roles,
  never the photo) stay on your device, with your step, sound and tour
  choices, until you clear this site's data. While the page is open, the
  shrunk photo of a LIVE room (read now, or a kept level whose photo was
  picked again) stays in its memory for a postcard, and is never saved.
- **What is logged.** The server's log keeps, for each request, its method,
  path and status, and for each photo its size, the time each stage took,
  the calls, tokens and estimated cost, and how many things were found;
  never the photo, and never the visitor's address (the per-visitor caps
  use a digest salted for each run, which is not logged). The service
  hosting a copy may keep its own access log.

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
The replay has its own 4 places at once, never LIVE's, so it never waits
behind a live read, and each client may replay it 10 times a minute.

`FRAMEPLAY_LIVE_UNTIL` (an ISO time in UTC, such as
`2026-11-09T00:00:00Z`) sets when LIVE turns itself off; unset, LIVE has no
end. After that time the server calls no model: health says MOCK and why
(and `live_until` in its ceilings), the sample rooms are drawn by code, our
kitchen replays Meta's recorded answer labeled REPLAY, and a photo sent from
a page opened earlier, to a server already running before that time, is
refused in words (503 live_unavailable), so our kitchen falls back to its
replay there too. A time that cannot be read
stops the server from starting.

In LIVE the server reads at most 4 photos at once and 120 an hour, 200 a
day, and stops for the day at an estimated $5. Within those, each address
gets at most 12 photos an hour and 40 a day, so one visitor cannot use up
the day for everyone. The client is the connection's address, or with
`--public` the last `X-Forwarded-For` hop (the address the Space's own
proxy saw and appended); behind that proxy a hop a visitor writes comes
before it and is never used, so a visitor cannot pose as several by
writing new ones (run `--public` only behind a proxy that appends the
address it saw).
Visitors who share one address (an office, a VPN) share its photos.
A photo's place is taken before its upload is read, so no more photos than
the readers at work are held in memory; a request that sends nothing for 15
seconds is dropped, and an upload that takes longer than 15 seconds is
given up (time for a 4 MiB photo on a slow phone link; the page shrinks
photos first). Each client uploads one photo at a time, so slow uploads
from one client hold one of the 4 places at most. A photo is one Muse Spark
call, at most 12 SAM 3.1 calls and one more Muse Spark call for its riddles
(at most 14 calls in all): at the published prices about three to five
cents, and about nine cents at worst (every call answered once; a call sent
again costs again, and the estimate counts each send), so, with no
postcard or voice clip that day, the stop allows at least 50 photos a day
(postcards and voice clips draw on the same stop).

The $5 stop is an estimate kept by this server, not a limit on the Meta
account. In LIVE the day's estimated spend and photo count are kept in a
small JSON file (`spend.json` in `FRAMEPLAY_DATA_DIR`, by default a
`frameplay` folder in the system's temporary folder), keyed by the UTC day,
read at start and written on every change, so a restart of the same server
keeps the day's count. A fresh container (a rebuilt or moved Space, or a
folder that is not kept) starts a new count; the per-photo and per-client
caps still bound what it can spend. Health says where the count is meant
to be kept (spend_kept: file when a folder is set, else memory); if that
folder cannot be written, the count holds in memory only.

If the Model API refuses the
key or a model is gone, the server stops sending photos, says so in health
(live_state: unavailable), and lets one photo check again every 10 minutes.
If it refuses for billing or credit (a 402, a used-up quota, or a 401 or
403 whose code names billing, credit, payment or funds), photos and
postcards are stopped for the rest
of the UTC day: no photo is sent until midnight UTC, when one photo may
check again. Health lists both (ceilings: live_hold_seconds,
billing_stop_until). When LIVE cannot read a photo for
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

- Live mode has been run against Meta on 2026-10-27 (the desk sample
  picture, then our kitchen photo, whose answers the server replays) and
  again on 2026-10-28 (our kitchen photo, read fresh, with its riddles). The
  first calls showed that the first reader of sam-3.1's answer
  text, written from a summary of Meta's documents, did not match the real
  grammar, so every box was dropped. The reader is now written from those
  recorded answers and tested against them
  (`server/tests/fixtures/desk_1027.json`); a photo unlike the desk may
  still bring a surprise, which the reader reports as a diagnostic instead
  of guessing.
- Two live reads of one photo can make two different rooms: one live read
  of our kitchen photo on 2026-10-28 gave 7 exact outlines from SAM 3.1's
  masks, cabinets among them; the 2026-10-27 answers the replay uses gave
  5, none of them a cabinet. The replay shows one read, not the room a live
  read will make.
- SAM's mask payloads ('!' one_bit, which this app asks for, or '~'
  lossless, the API's default) are read by a strict decoder
  (`server/sam_mask.py`, see NOTICE below), each mask at most once per
  photo, while the photo has time left; the reply says of
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
  match, the most confident from 0.5 up and at least 75% of the best. A
  kind keeps at most 3 things to
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
- The floor is SAM 3.1's floor mask wherever one decodes. Where none does,
  code grows it by colour instead, and a floor much like its walls (white
  boards under white walls) can run past its edge, up to 2% of the
  picture's long side beyond SAM's floor boxes. Either way the floor's
  holes are filled as hidden floor, so a thing on the floor that SAM did
  not find is walked over where the floor surrounds it; only one at the
  floor's outer edge stays a wall. Marked rooms keep the horizon.
- A box you mark is looser than SAM's: code looks for the one shape that
  stands out inside it and traces that. A box over several things, or over
  a thing much like its background, keeps your box as you drew it, and the
  reveal counts it as kept as a box.
- One photo, one room; a 2.5D approximation with one baseline per object.
  Seen at eye level, the floor inferred behind a low thing takes in its
  top, so the explorer can appear to cross a table or a sofa seat: it
  starts on the floor the camera saw where a cell of it reaches the goals,
  but it may still walk over such a top on its way.
- Ask the room: a riddle's answer is Muse Spark's judgement of the photo;
  where its answers are comes from the room's things (found by SAM 3.1, or
  traced by code around Muse Spark's points), so a thing the read did not
  find is never an answer, and their count is the number of answers Muse Spark
  chose (if SAM found five cabinets and Muse Spark chose four, the riddle
  asks for four). English only, at most three riddles a room.

## Disclosure

FRAME//PLAY was built during the Meta Global AI Developer Hackathon (October
26 to Nov. 4, 2026). Pre-existing: Meta's Muse Spark and SAM 3.1 models,
SAM's mask format (ported under its license), and the written notes of my
pre-event prototype (Oct 21 to 25), read as a spec, with none of its code;
built during the event, from the first commit: all the code, art, music and
tests. Built with AI assistance: Meta's muse-spark-1.3, run as a coding
agent on the event's API credits, wrote the server side of the postcard and
of Say it under my direction, reviewed by me and by Claude Code; everything
else was written by Claude Code (Anthropic) under my direction. Live rooms
are read by Meta's muse-spark-1.3 and sam-3.1 through the Meta Model API;
where a server turns them on, muse-image-1.0 draws the postcard and
muse-voice-transcribe-1.0 writes down a spoken riddle answer; sample rooms
are drawn by code and labeled MOCK.

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
UTF-8 text. Everything else in this repository is MIT;
`server/tests/test_sam_mask.py` also quotes, as test data, the sample mask
payloads and error messages published with meta-sam-parser 0.1.0.
