// Our kitchen everywhere a photo can be chosen: beside the three sample
// rooms on Steps 2, 5 and 8, and beside Choose a photo on Your own room,
// as a card with its thumbnail titled "Our kitchen (a real photo)". Picked,
// it is read as Use ours always was (LIVE fresh through Meta's models; MOCK
// and REHEARSAL replay Meta's recorded 2026-10-27 answer through the same
// pipeline, with the honest words), and in a sample room's slot it is
// played as a sample room is: its results, Your three rooms, the closing
// screen and Free play.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, textOf, paintCanvases, until } from './apphost.js';
import { played } from './stub_game.js';
import { roadAt, DESK, LIVING, APARTMENT, SAMPLE_ROOMS, AT_OWN } from './roads.js';
import { replayReply, liveKitchenReply, KITCHEN_PIXELS } from './kitchen.js';
import { OURS, OURS_REF, REPLAY_WORDS } from '../src/own.js';
import { OURS_TITLE, oursCardView, closingRooms } from '../src/screens.js';
import * as R from '../src/road.js';
import { installFakeDocument } from './fakedom.js';
import { Layout, styleOf, MAIN_CHAIN, mainSpace, screenHeight } from './layoutmodel.js';
import { screens, headFor } from './screenset.js';

const won = (ratio = 1) => ({ status: 'won', ratio, words: { title: 'Room cleared!', body: 'Well done.' } });
const posted = (app) => app.requests.filter(([m]) => m === 'POST').map(([, u]) => u);
const cards = (app) => app.$('main').querySelectorAll('.room-card');
const oursCard = (app) => app.$('main').querySelector('.ours-card');

// ---- the road ----

test('the road: our kitchen in a sample room’s slot is played as a sample room is', () => {
  let road = { ...R.newRoad(), consent: true, step: 2, reached: 2 };
  road = R.chooseRoom(road, 0, OURS_REF);
  assert.equal(road.step, 3);
  assert.deepEqual(road.rooms[0], OURS_REF);
  road = R.startPlay(road);
  road = R.finishRound(road, 0, won(1.2));
  assert.deepEqual(road.best[0], 1.2);
  // the next sample room comes next, the first the road holds no slot for
  road = R.continueAfterRound(road);
  assert.equal(road.step, 6);
  assert.deepEqual(road.rooms[1], DESK);
  // picked again on a later step, it trades places with that slot's room, each keeping its results
  road = { ...road, step: 5 };
  road = R.chooseRoom(road, 1, OURS_REF);
  assert.deepEqual(road.rooms.slice(0, 2), [DESK, OURS_REF]);
  assert.deepEqual(road.best.slice(0, 2), [null, 1.2]);
  assert.deepEqual(road.finished.slice(0, 2), [false, true]);
  // a road saved with it in any slot keeps it there
  const saved = R.sanitizeRoad(JSON.parse(JSON.stringify({ ...road, step: 6 })));
  assert.deepEqual(saved.rooms.slice(0, 2), [DESK, OURS_REF]);
});

test('the card: its thumbnail, its title, its tag by mode, and its why when off or held', () => {
  installFakeDocument();
  let drawn = 0;
  const replay = oursCardView({ ours: { replay: true, off: null }, onPick() {}, draw: () => { drawn++; } });
  assert.equal(drawn, 1, 'the thumbnail is drawn');
  assert.ok(replay.querySelector('canvas.thumb'));
  assert.equal(textOf(replay), `${OURS_TITLE} REPLAY · recorded answer`);
  assert.equal(OURS_TITLE, 'Our kitchen (a real photo)');
  assert.equal(replay.disabled, false);
  assert.match(replay.dataset.tip, /recorded answer replayed; no model is called now/);
  const fresh = oursCardView({ ours: { replay: false, off: null }, onPick() {} });
  assert.equal(textOf(fresh), `${OURS_TITLE} LIVE · our photo`, 'never “your photo”: it is ours');
  const off = oursCardView({ ours: { replay: true, off: 'Off here: the server did not answer, so Meta’s recorded answer for our kitchen photo cannot be replayed.', short: 'Off here: no server answered' }, onPick() {} });
  assert.equal(off.disabled, true);
  assert.match(textOf(off), /Off here: no server answered$/);
  assert.match(off.dataset.tip, /^Off here: the server did not answer/, 'the whole why in its tip');
  const held = oursCardView({ ours: { replay: true, off: null }, held: 'Already your first room', onPick() {} });
  assert.equal(held.disabled, true);
  assert.match(textOf(held), /Already your first room$/);
});

// ---- on the page ----

async function at(road, opts) {
  const app = await bootApp({ road, ...opts });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  return app;
}

for (const [step, slot] of [[2, 0], [5, 1], [8, 2]]) {
  test(`Step ${step}: four cards, the three sample rooms then our kitchen with its thumbnail`, async () => {
    const rooms = [null, null, null, null];
    for (let k = 0; k < slot; k++) rooms[k] = SAMPLE_ROOMS[k];
    const app = await at(roadAt(step, { rooms, finished: [true, true, true, false].map((f, k) => k < slot && f) }), { mode: 'mock', server: true, replay: replayReply });
    assert.equal(app.step(), step);
    const all = cards(app);
    assert.equal(all.length, 4);
    assert.deepEqual(all.map((c) => textOf(c).replace(/ (MOCK|REPLAY) · .*$/, '')), ['The Desk Top', 'The Living Room', 'The Apartment', OURS_TITLE]);
    assert.ok(all[3].classList.contains('ours-card') && all[3].querySelector('canvas.thumb'));
    assert.equal(all[3].disabled, false, 'a server that can replay it');
    assert.ok(app.requests.some(([m, u]) => m === 'GET' && u === OURS.photo), 'its thumbnail is the photo, from this page’s own server');
    assert.deepEqual(posted(app), [], 'nothing is sent for a thumbnail');
  });
}

for (const mode of ['mock', 'rehearsal']) {
  test(`${mode.toUpperCase()}: our kitchen picked on Step 2 is replayed and played as the first room, to the end`, async () => {
    const app = await at(roadAt(2), { mode, server: true, replay: replayReply });
    paintCanvases(app, KITCHEN_PIXELS);
    try {
      oursCard(app).click();
      await until(app, () => app.step() === 3, 'the replayed room', 120000);
    } finally { delete globalThis.createImageBitmap; }
    assert.deepEqual(posted(app), ['api/replay/kitchen'], 'the replay on this page’s own server, nothing to Meta');
    assert.equal(app.h1(), 'What the AI found');
    assert.ok(app.main().includes(REPLAY_WORDS), 'the honest words');
    assert.deepEqual(app.savedRoad().rooms[0], OURS_REF);
    app.mainPrimary().click();
    await app.settle();
    assert.equal(app.step(), 4);
    played.last.onEnd(won(1.3));
    await app.settle(3);
    app.cardPrimary().click();
    await app.settle();
    // straight on to the next room, a sample room
    assert.equal(app.step(), 6);
    assert.deepEqual(app.savedRoad().rooms[1], DESK);
    // back to Step 5: our kitchen is your first room, not picked again
    app.back();
    await app.settle();
    assert.equal(app.step(), 5);
    assert.equal(oursCard(app).disabled, true);
    assert.match(textOf(oursCard(app)), /Already your first room/);
    assert.match(app.main(), /On your road: The Desk Top\./);
    // on to Your three rooms by the one primary, rounds won
    for (let i = 0; i < 20 && app.step() !== R.THREE_STEP; i++) {
      if (app.cardOpen()) app.cardPrimary().click();
      else if (app.$('main').querySelector('.game')) played.last.onEnd(won());
      else app.mainPrimary().click();
      await app.settle(3);
    }
    assert.equal(app.step(), R.THREE_STEP);
    assert.deepEqual(app.savedRoad().rooms.slice(0, 3), [OURS_REF, DESK, LIVING]);
    const sums = app.$('main').querySelectorAll('.room-sum h2').map(textOf);
    assert.deepEqual(sums, [OURS_TITLE, 'The Desk Top', 'The Living Room']);
    // your own room passed by, then the end
    app.mainPrimary().click(); await app.settle();
    app.button('Continue to the end').click(); await app.settle();
    assert.equal(app.step(), R.LAST_STEP);
    const rows = app.$('main').querySelectorAll('.closing-rooms li').map(textOf);
    assert.match(rows[0], /^First room: our kitchen Won · best route 1\.3 times the shortest/);
    assert.ok(rows[0].includes(REPLAY_WORDS));
    assert.ok(app.button('Play again: our kitchen'), 'played again from the closing screen');
    app.mainPrimary().click(); await app.settle();
    assert.equal(app.step(), R.FREE_PLAY);
    const free = cards(app).map(textOf);
    assert.deepEqual(free.map((t) => t.replace(/ (MOCK|REPLAY) · .*$/, '')), ['The Desk Top', 'The Living Room', 'The Apartment', OURS_TITLE]);
    assert.match(free[3], /REPLAY · recorded answer/);
  });
}

test('LIVE: our kitchen picked on Step 5 goes through Meta’s models fresh, as a chosen photo does: one send, kept on the device', async () => {
  const app = await at(roadAt(5, { rooms: [DESK, LIVING, null, null], finished: [true, false, false, false] }), { mode: 'live', answer: () => liveKitchenReply(), replay: replayReply });
  assert.equal(app.step(), 5);
  assert.match(textOf(oursCard(app)), /LIVE · our photo/);
  paintCanvases(app, KITCHEN_PIXELS);
  try {
    oursCard(app).click();
    await until(app, () => app.step() === 6, 'the room read fresh', 120000);
  } finally { delete globalThis.createImageBitmap; }
  assert.deepEqual(posted(app), ['api/room'], 'one send, through the live path; never the replay');
  assert.match(app.main(), /Our kitchen photo, read by Meta’s models now\. Muse Spark named 8 things/);
  const ref = app.savedRoad().rooms[1];
  assert.deepEqual(ref, { kind: 'photo', sha256: OURS.sha256 });
  assert.equal(app.levels().length, 1, 'kept on this device like a chosen photo');
  // the living room it took the place of was not lost: it is on no step now,
  // and on Step 8 the road chooses the next sample room
  app.mainPrimary().click(); await app.settle();
  played.last.onEnd(won(1.1));
  await app.settle(3);
  app.cardPrimary().click(); await app.settle();
  assert.equal(app.step(), 9);
  assert.deepEqual(app.savedRoad().rooms[2], LIVING);
});

test('MOCK with no server: our kitchen’s card is off, in a few words, and the walk picks a sample room', async () => {
  const app = await at(roadAt(2), { mode: 'mock' });
  const c = oursCard(app);
  assert.equal(c.disabled, true);
  assert.match(textOf(c), /Off here: no server answered/);
  assert.match(c.dataset.tip, /the server did not answer, so Meta’s recorded answer for our kitchen photo cannot be replayed/);
  assert.equal(app.$('main').querySelector('.room-card:not([disabled])'), cards(app)[0], 'the first card a walker reaches is still The Desk Top');
});

test('never on the road twice: your own room holding it keeps it from Steps 2, 5 and 8; a sample room holding it keeps it from Step 12', async () => {
  const own = await at(roadAt(5, { rooms: [DESK, LIVING, null, OURS_REF], finished: [true, false, false, true] }), { mode: 'mock', server: true, replay: replayReply });
  assert.equal(oursCard(own).disabled, true);
  assert.match(textOf(oursCard(own)), /Already your own room/);
  const sample = await at({ ...AT_OWN, rooms: [DESK, OURS_REF, APARTMENT, null] }, { mode: 'mock', server: true, replay: replayReply });
  assert.equal(sample.step(), R.OWN_STEP);
  assert.equal(oursCard(sample).querySelector('.ours-use').disabled, true);
  assert.match(textOf(oursCard(sample)), /Already your second room/);
  assert.equal(textOf(sample.mainPrimary()), 'Continue to the end', 'then the one primary goes on');
});

test('Your own room: our kitchen as a card with its thumbnail, beside Choose a photo, in every mode', async () => {
  for (const mode of ['mock', 'rehearsal', 'live']) {
    const app = await at(AT_OWN, { mode, server: true, replay: replayReply });
    assert.equal(app.step(), R.OWN_STEP);
    const c = oursCard(app);
    assert.ok(c && c.querySelector('canvas.thumb'), `${mode}: the card, with its thumbnail`);
    assert.ok(textOf(c).startsWith(OURS_TITLE), `${mode}: ${textOf(c)}`);
    assert.equal(c.parentNode, app.button('Choose a photo').parentNode, `${mode}: beside Choose a photo`);
  }
});

test('the closing screen names our kitchen in a sample room’s slot, replayed or read fresh', () => {
  installFakeDocument();
  const road = { ...AT_OWN, step: R.LAST_STEP, rooms: [OURS_REF, DESK, LIVING, null], own: 'skipped', finished: [true, true, true, false], best: [1.1, null, null, null] };
  const rows = closingRooms({ road, mode: 'mock', levels: [null, null, null, null], canReplay: true });
  assert.equal(rows[0].title, 'our kitchen');
  assert.equal(rows[0].ai, 'Its level is not in memory on this visit; replay it again on Step 2 to see it.');
  const fresh = { ...road, rooms: [{ kind: 'photo', sha256: OURS.sha256 }, DESK, LIVING, null] };
  const lr = closingRooms({ road: fresh, mode: 'live', levels: [null, null, null, null], summaries: [{ named: 8, ours: true }, null, null, null] });
  assert.equal(lr[0].title, 'our kitchen');
});

// ---- the fit ----

test('four cards share one row on Steps 2, 5 and 8 at both strict windows, and those screens fit main', () => {
  for (const [vw, vh] of [[839, 945], [1259, 1418]]) {
    const L = new Layout(vw, vh);
    const width = mainSpace(vw, vh, headFor(2, 'mock'), 'mock').width;
    const st = styleOf([...MAIN_CHAIN, { tag: 'section', cls: ['screen'] }, { tag: 'div', cls: ['room-cards'] }], vw, vh);
    const tracks = L.tracks(st, width, L.gaps(st).col, [], [], { size: 16, weight: 400, lh: 1.5 });
    assert.ok(tracks.length >= 4, `${vw}x${vh}: ${tracks.length} cards to a row`);
    for (const mode of ['mock', 'live', 'rehearsal']) {
      for (const s of screens(mode).filter((x) => /^Pick room/.test(x.name))) {
        assert.equal(s.section.querySelectorAll('.room-card').length, 4, `${mode} · ${s.name}: four cards`);
        const { space, width: w, layout } = mainSpace(vw, vh, headFor(s.step, mode, s.road), mode);
        const h = screenHeight(layout, s.section, w);
        assert.ok(h <= space, `${vw}x${vh} ${mode} · ${s.name}: ${h.toFixed(1)} of ${space.toFixed(1)}px`);
      }
    }
  }
});
