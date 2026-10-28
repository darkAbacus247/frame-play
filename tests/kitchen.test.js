// "Don't have a photo? Use ours": our kitchen photo (rooms/kitchen.jpg, the
// author's own, released with the repository). In LIVE it is read fresh,
// exactly as a chosen photo is: one send. In MOCK and REHEARSAL the server
// replays Meta's real recorded answer for it (2026-10-27) through its own
// pipeline (server/replay.py), with no model called now, and every screen
// says so. The replay below is the real pipeline's (tests/kitchen.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootApp, textOf, paintCanvases, until } from './apphost.js';
import { played } from './stub_game.js';
import { AT_OWN, roadAt, SAMPLE_ROOMS } from './roads.js';
import { replayReply, liveKitchenReply, KITCHEN_JPG, KITCHEN_PIXELS, W, H } from './kitchen.js';
import { replayOurs, OURS, OURS_REF, REPLAY_WORDS, OURS_NOT_SAME, OURS_REPLY_NOT_SAME } from '../src/own.js';
import { acceptReply } from '../src/reply.js';
import { validateLevel, LABELS } from '../src/level.js';
import { summaryLine, aiLine, closingRooms, OURS_TITLE, OURS_WORDS } from '../src/screens.js';
import { sanitizeRoad, OWN_SLOT, OWN_STEP, LAST_STEP } from '../src/road.js';
import { installFakeDocument } from './fakedom.js';

const WORDS = 'Meta’s models read this photo on Oct 27, 2026; this copy replays their recorded answer; no model was called now.';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const deps = (reply, bytes = KITCHEN_JPG) => ({
  photo: async () => ({ bytes, picture: { width: W, height: H }, pixels: KITCHEN_PIXELS }),
  sha256: async (b) => sha(Buffer.from(b)),
  send: async () => reply,
});

test('the sample photo is the one the recorded answers are for', () => {
  assert.equal(sha(KITCHEN_JPG), OURS.sha256);
  assert.deepEqual([KITCHEN_JPG[0], KITCHEN_JPG[1], KITCHEN_JPG[2]], [0xff, 0xd8, 0xff], 'a JPEG');
  assert.deepEqual([OURS.width, OURS.height], [1024, 399]);
  assert.equal(REPLAY_WORDS, WORDS, 'the honest words, exactly');
});

test('the replay through the real pipeline builds a winnable kitchen from SAM 3.1’s own masks', async () => {
  const reply = replayReply();
  assert.equal(reply.provenance.mode, 'replay');
  assert.equal(reply.provenance.label, LABELS.replay);
  assert.deepEqual(reply.provenance.models, [], 'no model is called now');
  assert.equal(reply.provenance.replay.recorded, '2026-10-27');
  assert.deepEqual(reply.provenance.replay.models, ['muse-spark-1.3', 'sam-3.1']);
  assert.equal(reply.provenance.replay.words, WORDS);
  assert.ok(reply.provenance.calls.length === 7 && reply.provenance.calls.every((c) => c.replayed === true && c.status === 200), 'one read and six SAM answers, every one replayed');
  assert.equal(reply.usage.calls, 0);
  assert.equal(reply.usage.estimated_usd, 0);
  assert.ok(acceptReply('replay', reply, OURS).ok);
  const r = await replayOurs({ deps: deps(reply), yieldNow: async () => {} });
  assert.equal(r.kind, 'built', r.words);
  assert.deepEqual(r.ref, OURS_REF);
  const { level } = r.entry.built;
  assert.equal(level.origin, 'replay');
  assert.equal(level.label, 'REPLAY · Meta’s recorded answer of Oct 27, 2026 · no model was called now');
  assert.equal(level.title, 'Golden Kitchen Quest');
  assert.ok(validateLevel(JSON.parse(JSON.stringify(level))).ok, 'code proves the room can be won');
  // as the live read went: Muse Spark named 8 things, SAM's masks gave 5
  // exact outlines plus the floor, code made 2 changes, winnable
  assert.equal(r.entry.summary.named, 8);
  assert.deepEqual(level.provenance.outline_sources, { exact: 0, sam_mask: 5, traced_in_box: 0, box: 0, traced_at_points: 0, points_box: 0 });
  assert.ok(level.objects.every((o) => o.outline.source === 'sam_mask'));
  assert.equal(level.surface.source, 'sam_mask', 'the floor is SAM 3.1’s floor mask');
  assert.equal(level.provenance.floor.source, 'sam_mask');
  assert.equal(level.changes_by_code.length, 2);
  assert.deepEqual(level.objects.map((o) => o.name).sort(), ['counter', 'door', 'kitchen island', 'refrigerator', 'stove']);
  assert.equal(r.entry.summary.ours, true);
  // the words, on the reveal and the closing screen
  const s = summaryLine(level, r.entry.summary);
  assert.ok(s.startsWith(WORDS), s);
  assert.match(s, /Muse Spark named 8 things and gave each a role\. SAM 3\.1 found 5 of them\. SAM 3\.1’s masks gave 5 exact outlines; code traced 0\./);
  const ai = aiLine(level, r.entry.summary);
  assert.ok(ai.startsWith(WORDS), ai);
  assert.equal(ai, `${WORDS} SAM 3.1’s masks gave 5 exact outlines; code traced 0; code proved the room can be won.`);
});

test('a replay is used only for the very photo, and only as a replay', async () => {
  const reply = replayReply();
  const other = new Uint8Array(KITCHEN_JPG);
  other[500] ^= 1;
  assert.equal((await replayOurs({ deps: deps(reply, other) })).words, OURS_NOT_SAME);
  assert.equal((await replayOurs({ deps: deps({ ...reply, provenance: { ...reply.provenance, image_sha256: 'ab'.repeat(32) } }) })).words, OURS_REPLY_NOT_SAME);
  const asLive = liveKitchenReply();
  assert.match((await replayOurs({ deps: deps(asLive) })).words, /answered as a fresh read/);
  const claims = { ...reply, provenance: { ...reply.provenance, models: ['muse-spark-1.3'] } };
  assert.match((await replayOurs({ deps: deps(claims) })).words, /may not claim a model called now/);
  assert.match(acceptReply('live', reply, OURS).why, /answered with a replay where a fresh read was asked for/);
});

test('a saved road keeps ours in any room’s slot', () => {
  const road = { ...AT_OWN, step: LAST_STEP, rooms: [...SAMPLE_ROOMS, OURS_REF], finished: [true, true, true, true] };
  assert.deepEqual(sanitizeRoad(JSON.parse(JSON.stringify(road))).rooms[OWN_SLOT], OURS_REF);
  assert.equal(sanitizeRoad(JSON.parse(JSON.stringify(road))).step, LAST_STEP);
  assert.deepEqual(sanitizeRoad({ ...road, rooms: [OURS_REF, null, null, null], finished: [false, false, false, false], step: 3 }).rooms[0], OURS_REF);
  assert.equal(sanitizeRoad({ ...road, rooms: [OURS_REF, null, null, null], finished: [false, false, false, false], step: 3 }).step, 3);
  assert.equal(sanitizeRoad({ ...road, rooms: [...SAMPLE_ROOMS, { kind: 'replay', id: 'other' }] }).rooms[OWN_SLOT], null);
});

test('the closing screen: your own room, our kitchen, with the replay’s words; missing, replayed again where it can be', async () => {
  installFakeDocument();
  const r = await replayOurs({ deps: deps(replayReply()), yieldNow: async () => {} });
  const road = { ...AT_OWN, step: LAST_STEP, rooms: [...SAMPLE_ROOMS, OURS_REF], finished: [true, true, true, true], best: [1.2, null, null, 1.1] };
  const rows = closingRooms({ road, mode: 'mock', levels: [null, null, null, r.entry.built.level], summaries: [null, null, null, r.entry.summary], canReplay: true });
  assert.equal(rows[3].title, 'our kitchen');
  assert.ok(rows[3].ai.startsWith(WORDS));
  const gone = closingRooms({ road, mode: 'rehearsal', levels: [null, null, null, null], canReplay: true });
  assert.equal(gone[3].ai, 'Its level is not in memory on this visit; replay it again on Step 12 to see it.');
  const cannot = closingRooms({ road, mode: 'mock', levels: [null, null, null, null], canReplay: false });
  assert.equal(cannot[3].ai, 'Its level is not in memory on this visit, and this copy cannot replay it.');
});

// ---- on the page ----

async function ownStep(opts) {
  const app = await bootApp({ road: AT_OWN, ...opts });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  assert.equal(app.step(), OWN_STEP);
  return app;
}
const oursCard = (app) => app.$('main').querySelector('.ours-card');
const oursButton = (app) => app.$('main').querySelector('.ours-card .ours-use');
const posted = (app) => app.requests.filter(([m]) => m === 'POST').map(([, u]) => u);

for (const mode of ['mock', 'rehearsal']) {
  test(`${mode.toUpperCase()}: Use ours replays the recorded answer: no model call, the honest words, a room on the road`, async () => {
    const app = await ownStep({ mode, server: true, replay: replayReply });
    const b = oursButton(app);
    const card = oursCard(app);
    assert.ok(b && !b.disabled, 'beside Choose a photo');
    assert.ok(textOf(card).startsWith(`${OURS_TITLE} REPLAY · recorded answer`), textOf(card));
    assert.ok(card.querySelector('canvas.thumb'), 'with its thumbnail');
    assert.ok(app.button('Choose a photo'), 'Choose a photo stays');
    assert.equal(card.parentNode, app.button('Choose a photo').parentNode, 'in the same row');
    assert.ok(app.main().includes(OURS_WORDS.replay), 'what it does, said before it is pressed');
    // replayed (MOCK and REHEARSAL), its button is the one primary
    assert.equal(app.mainPrimary(), b);
    paintCanvases(app, KITCHEN_PIXELS);
    try {
      b.click();
      await until(app, () => app.step() === OWN_STEP + 1, 'the replayed room', 120000);
    } finally { delete globalThis.createImageBitmap; }
    assert.deepEqual(posted(app), ['api/replay/kitchen'], 'only the replay on this page’s server; never api/room, nothing to Meta');
    assert.equal(app.h1(), 'What the AI found');
    assert.ok(app.main().includes(WORDS), 'the reveal says it is a replay');
    assert.match(app.main(), /REPLAY · Meta’s recorded answer of Oct 27, 2026 · no model was called now/);
    assert.deepEqual(app.savedRoad().rooms[OWN_SLOT], OURS_REF);
    assert.deepEqual(app.levels(), [], 'a replay is made again on each visit, never kept as a photo’s level');
    // play it, then the end
    app.mainPrimary().click();
    await app.settle();
    assert.equal(app.step(), OWN_STEP + 2);
    played.last.onEnd({ status: 'won', ratio: 1.1, words: { title: 'Room cleared!', body: 'Well done.' } });
    await app.settle(3);
    app.cardPrimary().click();
    await app.settle();
    assert.equal(app.step(), LAST_STEP);
    const row = textOf(app.$('main').querySelectorAll('.closing-rooms li')[3]);
    assert.ok(row.startsWith('Your own room: our kitchen Won'), row);
    assert.ok(row.includes(WORDS), row);
  });
}

test('MOCK with no server: Use ours is off, in words, and Continue to the end stays the one primary', async () => {
  const app = await ownStep({ mode: 'mock' });
  const b = oursButton(app);
  assert.ok(b && b.disabled);
  assert.match(app.main(), /Off here: the server did not answer, so Meta’s recorded answer for our kitchen photo cannot be replayed\./);
  assert.equal(textOf(app.mainPrimary()), 'Continue to the end');
  const old = await ownStep({ mode: 'mock', server: true });
  assert.ok(oursButton(old).disabled, 'a server with no replay');
  assert.match(old.main(), /this server cannot replay/);
});

test('LIVE: Use ours goes through Meta’s models fresh, exactly like a chosen photo: one send, then kept like one', async () => {
  const app = await ownStep({ mode: 'live', answer: () => liveKitchenReply(), replay: replayReply });
  assert.ok(app.main().includes(OURS_WORDS.fresh));
  assert.equal(textOf(app.mainPrimary()), 'Choose a photo');
  paintCanvases(app, KITCHEN_PIXELS);
  try {
    oursButton(app).click();
    await until(app, () => app.step() === OWN_STEP + 1, 'the room read fresh', 120000);
  } finally { delete globalThis.createImageBitmap; }
  assert.deepEqual(posted(app), ['api/room'], 'one send, through the live path; never the replay');
  assert.ok(app.requests.some(([m, u]) => m === 'GET' && u === 'rooms/kitchen.jpg'), 'the photo from this page’s own server');
  assert.match(app.main(), /Our kitchen photo, read by Meta’s models now\. Muse Spark named 8 things/);
  assert.doesNotMatch(app.main(), /replays their recorded answer/);
  const own = app.savedRoad().rooms[OWN_SLOT];
  assert.equal(own.kind, 'photo', 'a photo like any other');
  assert.equal(app.levels().length, 1, 'kept on this device like a chosen photo');
  // back on its step and Use ours again: its level loads from this device, no second send
  app.back();
  await app.settle();
  assert.equal(app.step(), OWN_STEP);
  paintCanvases(app, KITCHEN_PIXELS);
  try {
    oursButton(app).click();
    await until(app, () => app.step() === OWN_STEP + 1, 'the room again', 120000);
  } finally { delete globalThis.createImageBitmap; }
  assert.deepEqual(posted(app), ['api/room'], 'still one send');
  assert.match(app.main(), /Loaded from this device: no model was called this time\./);
});

test('a return visit: the replayed room is replayed again in place, never by moving the counter back', async () => {
  const road = roadAt(OWN_STEP + 1, { rooms: [...SAMPLE_ROOMS, OURS_REF], finished: [true, true, true, false] });
  const app = await bootApp({ mode: 'rehearsal', road, replay: replayReply });
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), OWN_STEP + 1);
  assert.equal(app.h1(), 'Replay our kitchen again');
  assert.equal(textOf(app.mainPrimary()), 'Replay it again');
  assert.ok(app.button('Continue to the end'));
  paintCanvases(app, KITCHEN_PIXELS);
  try {
    app.mainPrimary().click();
    await until(app, () => app.h1() === 'What the AI found', 'the room again', 120000);
  } finally { delete globalThis.createImageBitmap; }
  assert.equal(app.step(), OWN_STEP + 1, 'on the same step');
  assert.deepEqual(posted(app), ['api/replay/kitchen']);
  // with no server that can replay: the way on is forward, in words
  const none = await bootApp({ mode: 'mock', road });
  none.cardPrimary().click();
  await none.settle();
  assert.equal(none.h1(), 'This room cannot load here');
  assert.equal(textOf(none.mainPrimary()), 'Continue to the end');
});

// Our kitchen is the first card on every pick step (his 10-28 pick: judges see Meta's work first), so a
// newcomer's first click plays it first, then two sample rooms; Step 12 then goes on to the end.
test('the naive walker, in MOCK with a server, plays our kitchen first, then two sample rooms, to the end: zero wrong turns', async () => {
  const app = await bootApp({ mode: 'mock', server: true, replay: replayReply });
  paintCanvases(app, KITCHEN_PIXELS);
  const seen = [];
  try {
    for (let i = 0; i < 120 && app.step() !== LAST_STEP; i++) {
      const step = app.step();
      if (seen[seen.length - 1] !== step) seen.push(step);
      if (app.cardOpen()) app.cardPrimary().click();
      else if (app.mainPrimary()) app.mainPrimary().click();
      else if (app.$('main').querySelector('.room-card:not([disabled])')) app.$('main').querySelector('.room-card:not([disabled])').click();
      else if (app.$('main').querySelector('.game')) played.last.onEnd({ status: 'won', ratio: 1, words: { title: 'Room cleared!', body: 'You took the shortest route.' } });
      await app.settle(app.step() === OWN_STEP ? 40 : 3);
    }
  } finally { delete globalThis.createImageBitmap; }
  assert.deepEqual([...seen, app.step()], [1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 15]);
  const rows = app.$('main').querySelectorAll('.closing-rooms li').map(textOf);
  assert.equal(rows.length, 4);
  assert.match(rows[0], /^First room: our kitchen Won .*Meta’s models read this photo on Oct 27, 2026; this copy replays their recorded answer; no model was called now\./);
  assert.match(rows[3], /^Your own room Not made/);
  assert.deepEqual(posted(app), ['api/replay/kitchen']);
  // Free play lists the three sample rooms and our kitchen, tagged a replay
  app.mainPrimary().click();
  await app.settle();
  const cards = app.$('main').querySelectorAll('.room-card').map(textOf);
  assert.deepEqual(cards.map((t) => t.replace(/ (MOCK|REPLAY) · .*$/, '')), ['The Desk Top', 'The Living Room', 'The Apartment', 'Our kitchen (a real photo)']);
  assert.match(cards[3], /REPLAY · recorded answer/);
});
