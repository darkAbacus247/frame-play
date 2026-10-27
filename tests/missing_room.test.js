// A room on the road whose level is not in memory (a return visit): the
// real app.js, booted in Node (tests/apphost.js). No primary may move the
// counter back, and Forward from Your own room never leads to a screen
// whose only way on is back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './apphost.js';
import { replyFor } from './replies.js';
import { OTHER_ROOM_WORDS } from '../src/own.js';
import * as R from '../src/road.js';

const road = (S) => ({
  v: 3, step: S, reached: S, consent: true, own: null,
  rooms: [{ kind: 'sample', id: 'desk' }, { kind: 'sample', id: 'living' }, { kind: 'photo', sha256: 'ab'.repeat(32) }],
  finished: [true, true, false], best: [1.24, null, null],
});

for (const mode of ['rehearsal', 'mock']) {
  for (const S of [10, 11]) {
    test(`${mode}: back on Step ${S} with your own room's level missing, no primary moves the counter back`, async () => {
      const app = await bootApp({ mode, road: road(S) });
      assert.ok(app.cardOpen(), 'the welcome-back card');
      app.cardPrimary().click();
      await app.settle();
      assert.equal(app.step(), S);
      const seen = [app.step()];
      const p = app.mainPrimary();
      assert.ok(p, 'the screen has a primary');
      if (mode === 'mock') {
        assert.match(app.main(), /This copy runs in MOCK, so its level cannot load here\./);
        assert.equal(p.textContent, 'Continue to the end');
      } else {
        assert.match(app.main(), /Choose the same photo/);
        assert.doesNotMatch(app.main(), /when it can/);
        assert.equal(app.why(), S === 11 ? 'Pick the same photo to play this room' : '', 'the header names an action this screen offers');
      }
      p.click();
      await app.settle();
      seen.push(app.step());
      assert.ok(seen.every((s) => s >= S), `the counter went ${seen.join(' → ')}`);
      if (mode === 'mock') {
        assert.equal(app.step(), 12, 'on to the closing screen');
        assert.match(app.main(), /Your own room/);
        assert.doesNotMatch(app.main(), /Not made/, 'the room stays on the road');
      }
    });
  }

  test(`${mode}: ← to Your own room, then →, never reaches a screen whose primary leads back`, async () => {
    const app = await bootApp({ mode, road: road(10) });
    app.cardPrimary().click();
    await app.settle();
    app.back();
    await app.settle();
    assert.equal(app.step(), 9);
    app.forward();
    await app.settle();
    assert.equal(app.step(), 10);
    app.mainPrimary().click();
    await app.settle();
    assert.ok(app.step() >= 10, `the primary moved the counter to ${app.counter()}`);
  });
}

// A first or second room made by the stand-in (REHEARSAL), back on its
// Found step on a return visit. Only the stand-in started for that very
// room may make it again; any other would answer with its own room, drawn
// over the wrong sample picture.
const standInRoad = (slot, id) => {
  const rooms = [{ kind: 'sample', id: 'desk' }, null, null];
  rooms[slot] = { kind: 'rehearsal', id };
  const step = slot === 0 ? 3 : 6;
  return { v: 3, step, reached: step, consent: true, own: null, rooms, finished: [slot === 1, false, false], best: [null, null, null] };
};

for (const [slot, made, here, madeTitle, hereTitle] of [[0, 'living', 'desk', 'The Living Room', 'The Desk Top'], [1, 'desk', 'living', 'The Desk Top', 'The Living Room']]) {
  test(`rehearsal: a room the ${made} stand-in made is not sent through the ${here} stand-in; nothing is sent`, async () => {
    const step = slot === 0 ? 3 : 6;
    const app = await bootApp({ mode: 'rehearsal', room: here, road: standInRoad(slot, made), answer: () => replyFor(here, 'rehearsal') });
    app.cardPrimary().click();
    await app.settle();
    assert.equal(app.step(), step);
    assert.equal(app.h1(), 'This room cannot load here');
    assert.equal(app.button('Send it through the stand-in'), null);
    assert.equal(app.mainPrimary(), null, 'no primary: the way on is in words');
    const words = app.main();
    assert.ok(words.includes(`stand-in for ${madeTitle}`) && words.includes(`answers for ${hereTitle}`), words);
    assert.ok(words.includes(`Use ← to go back to Step ${R.PICK_STEPS[slot]} and pick a room.`), words);
    // → is open here (its Play step says the same); where the header gives a
    // reason, it names the way this screen offers
    if (app.why()) assert.equal(app.why(), `Go back to Step ${R.PICK_STEPS[slot]} to pick a room`);
    app.forward();
    await app.settle();
    assert.equal(app.button('Send it through the stand-in'), null, 'nor on its Play step');
    assert.equal(app.posts(), 0);
  });
}

test('rehearsal: the stand-in started for this room makes it again in place, and only from its answer for that room', async () => {
  const app = await bootApp({ mode: 'rehearsal', room: 'desk', road: standInRoad(0, 'desk'), answer: () => replyFor('desk', 'rehearsal') });
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.h1(), 'Rehearse this room again');
  app.button('Send it through the stand-in').click();
  await app.settle(60);
  assert.equal(app.posts(), 1);
  assert.equal(app.step(), 3, 'made again on the same step');
  assert.ok(app.button('Play this room'), app.main());

  // the server now answers for another room (restarted during the visit)
  const other = await bootApp({ mode: 'rehearsal', room: 'desk', road: standInRoad(0, 'desk'), answer: () => replyFor('desk', 'rehearsal', { room: 'living' }) });
  other.cardPrimary().click();
  await other.settle();
  other.button('Send it through the stand-in').click();
  await other.settle(60);
  assert.equal(other.posts(), 1);
  assert.equal(other.step(), 3);
  assert.ok(other.main().includes(OTHER_ROOM_WORDS), other.main());
  assert.doesNotMatch(other.main(), /Nothing was sent/, 'something was sent');
  assert.equal(other.button('Play this room'), null);
});
