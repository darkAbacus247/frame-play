// The three sample rooms in a row, on the real app.js (tests/apphost.js), in
// MOCK: the end card's primary goes straight into the next room's reveal;
// the pick steps stay on the road with the next room chosen there, so ←,
// the browser's Back and Choose a different room still reach them and any
// room can be picked; Your three rooms shows the three; and a road saved by
// the earlier 12-step page reads onto this one without a dead end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, textOf } from './apphost.js';
import { played } from './stub_game.js';
import { roadAt, DESK, LIVING, APARTMENT } from './roads.js';
import { OWN_STEP, LAST_STEP, FREE_PLAY } from '../src/road.js';

const WON = { status: 'won', ratio: 1, words: { title: 'Room cleared!', body: 'You took the shortest route.' } };
const LOST = { status: 'lost', ratio: null, words: { title: 'Out of time', body: 'Try again.' } };
const primaries = (app) => app.$('main').querySelectorAll('[data-primary]').map(textOf);
const roomTitle = (app) => textOf(app.$('main').querySelector('.level-label') || app.$('main'));

async function at(road) {
  const app = await bootApp({ mode: 'mock', road });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  return app;
}

// a round on the board ends; the end card is up
async function endRound(app, r = WON) {
  assert.ok(app.$('main').querySelector('.game'), `a board on ${app.counter()}`);
  played.last.onEnd(r);
  await app.settle(3);
  assert.ok(app.cardOpen(), 'the end card');
}

test('the end card goes straight on: The Desk Top, The Living Room, The Apartment, then Your three rooms', async () => {
  const app = await at(roadAt(4, { rooms: [DESK, null, null, null] }));
  const seen = [];
  const titles = [];
  for (const next of ['Continue: the second room', 'Continue: the third room', 'Continue: your three rooms']) {
    await endRound(app, seen.length === 1 ? LOST : WON);
    assert.equal(textOf(app.cardPrimary()), next, 'the card’s primary names where it goes');
    app.cardPrimary().click();
    await app.settle();
    seen.push(app.step());
    // claims-12: a sample room drawn by code is never headed as what the AI found
    if (app.h1() === 'What is in this room') {
      assert.equal(app.counter(), `Step ${app.step()} of 15: What is in this room`);
      titles.push(app.savedRoad().rooms[app.step() === 6 ? 1 : 2].id);
      assert.deepEqual(primaries(app), ['Play this room']);
      app.mainPrimary().click();
      await app.settle();
    }
  }
  assert.deepEqual(seen, [6, 9, 11], 'no stop at a pick screen');
  assert.deepEqual(titles, ['living', 'apartment']);
  const road = app.savedRoad();
  assert.deepEqual(road.rooms, [DESK, LIVING, APARTMENT, null]);
  assert.deepEqual(road.finished, [true, true, true, false]);
  assert.ok(road.reached >= 11);
  // Your three rooms: three cards, one primary on to your own room
  assert.equal(app.h1(), 'Your three rooms');
  assert.equal(app.counter(), 'Step 11 of 15: Your three rooms');
  const cards = app.$('main').querySelectorAll('.room-sum');
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => textOf(c.querySelector('h2'))), ['The Desk Top', 'The Living Room', 'The Apartment']);
  assert.match(textOf(cards[1]), /Your best: not won yet/, 'a lost round is not a best');
  assert.deepEqual(primaries(app), ['Continue: your own room']);
  app.mainPrimary().click();
  await app.settle();
  assert.equal(app.step(), OWN_STEP);
});

test('← from a reveal the chain reached comes to its pick step, the room chosen there; Continue goes on with it', async () => {
  const app = await at(roadAt(6, { rooms: [DESK, LIVING, null, null], finished: [true, false, false, false] }));
  app.back();
  await app.settle();
  assert.equal(app.step(), 5);
  assert.equal(app.h1(), 'Another room: pick a second photo');
  assert.match(app.main(), /On your road: The Living Room\./);
  const chosen = app.$('main').querySelectorAll('.room-card[aria-current]');
  assert.equal(chosen.length, 1);
  assert.match(textOf(chosen[0]), /The Living Room/);
  assert.match(textOf(app.$('main').querySelectorAll('.room-card').find((c) => /The Desk Top/.test(textOf(c)))), /Already your first room/);
  assert.equal(app.why(), '', '→ is open: the step holds its room');
  assert.deepEqual(primaries(app), ['Continue with The Living Room'], 'one primary, and it goes forward');
  app.mainPrimary().click();
  await app.settle();
  assert.equal(app.step(), 6);
});

test('on a pick step any room can still be picked; a room a later step holds trades places with it', async () => {
  const app = await at(roadAt(8, { rooms: [DESK, LIVING, APARTMENT, null], finished: [true, true, true, false], best: [1.1, null, 1.6, null] }));
  // back to Step 2, through the browser's Back
  app.popstate({ step: 2 });
  await app.settle();
  assert.equal(app.step(), 2);
  assert.match(app.main(), /On your road: The Desk Top\./);
  const apt = app.$('main').querySelectorAll('.room-card').find((c) => /The Apartment/.test(textOf(c)));
  assert.ok(!apt.disabled, 'a room a later step holds can be picked');
  apt.click();
  await app.settle();
  assert.equal(app.step(), 3);
  const road = app.savedRoad();
  assert.deepEqual(road.rooms.slice(0, 3), [APARTMENT, LIVING, DESK]);
  assert.deepEqual(road.best.slice(0, 3), [1.6, null, 1.1], 'each room keeps its own result');
});

test('→ onto a pick step chooses the next room there, as the end card does', async () => {
  const app = await at(roadAt(7, { rooms: [DESK, LIVING, null, null], finished: [true, true, false, false] }));
  app.forward();
  await app.settle();
  assert.equal(app.step(), 8);
  assert.equal(app.h1(), 'A third room: pick a third photo');
  assert.match(app.main(), /On your road: The Apartment\./);
  assert.deepEqual(app.savedRoad().rooms[2], APARTMENT);
  // the first and second rooms cannot be picked again here
  const disabled = app.$('main').querySelectorAll('.room-card:not(.ours-card)').filter((c) => c.disabled).map(textOf);
  assert.equal(disabled.length, 2);
  assert.match(disabled.join(' '), /Already your first room/);
  assert.match(disabled.join(' '), /Already your second room/);
});

test('the browser’s Back and Forward walk every step of the whole road, never past what is allowed', async () => {
  const whole = roadAt(FREE_PLAY, { rooms: [DESK, LIVING, APARTMENT, null], finished: [true, true, true, false], own: 'skipped' });
  const app = await at(whole);
  assert.equal(app.step(), FREE_PLAY);
  const back = [];
  for (let s = LAST_STEP; s >= 1; s--) {
    app.popstate({ step: s });
    await app.settle(4);
    back.push(app.step());
  }
  // your own room passed by: its reveal and play are passed by too
  assert.deepEqual(back, [15, 12, 12, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  const fwd = [];
  for (let s = 2; s <= FREE_PLAY; s++) {
    app.popstate({ step: s });
    await app.settle(4);
    fwd.push(app.step());
  }
  assert.deepEqual(fwd, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 12, 15, 16], 'never onto the reveal or play of a room passed by');
  // a road with a round not finished stops there
  const half = await at(roadAt(4, { rooms: [DESK, null, null, null] }));
  half.popstate({ step: 9 });
  await half.settle(4);
  assert.equal(half.step(), 4, 'a round must be finished first');
});

test('a road saved by the 12-step page: welcome back names where it goes on, and that road has a way on to the end', async () => {
  const old = { v: 3, step: 12, reached: 12, consent: true, own: null, rooms: [DESK, LIVING, null], finished: [true, true, false], best: [1.24, null, null] };
  const app = await bootApp({ mode: 'mock', road: old });
  assert.ok(app.cardOpen());
  assert.equal(textOf(app.cardPrimary()), 'Continue where you left off (Step 10 of 15: Play)');
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 10);
  assert.deepEqual(app.savedRoad().rooms, [DESK, LIVING, APARTMENT, null]);
  assert.equal(app.savedRoad().v, 4);
  // play The Apartment, then on, with only the emphasized controls
  for (let i = 0; i < 20 && app.step() !== LAST_STEP; i++) {
    if (app.cardOpen()) app.cardPrimary().click();
    else if (app.$('main').querySelector('.game')) played.last.onEnd(WON);
    else app.mainPrimary().click();
    await app.settle(3);
  }
  assert.equal(app.step(), LAST_STEP);
  assert.match(app.main(), /Third room: The Apartment/);
});
