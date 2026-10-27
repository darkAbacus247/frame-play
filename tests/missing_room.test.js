// A room on the road whose level is not in memory (a return visit): the
// real app.js, booted in Node (tests/apphost.js). No primary may move the
// counter back, and Forward from Your own room never leads to a screen
// whose only way on is back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, photoFile } from './apphost.js';
import { replyFor } from './replies.js';
import { OTHER_ROOM_WORDS, NOT_SAME_WORDS } from '../src/own.js';
import * as R from '../src/road.js';

const SAMPLES = [{ kind: 'sample', id: 'desk' }, { kind: 'sample', id: 'living' }, { kind: 'sample', id: 'apartment' }];
const road = (S) => ({
  v: 4, step: S, reached: S, consent: true, own: null,
  rooms: [...SAMPLES, { kind: 'photo', sha256: 'ab'.repeat(32) }],
  finished: [true, true, true, false], best: [1.24, null, null, null],
});

for (const mode of ['rehearsal', 'mock']) {
  for (const S of [13, 14]) {
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
        assert.equal(app.why(), S === 14 ? 'Pick the same photo to play this room' : '', 'the header names an action this screen offers');
      }
      p.click();
      await app.settle();
      seen.push(app.step());
      assert.ok(seen.every((s) => s >= S), `the counter went ${seen.join(' → ')}`);
      if (mode === 'mock') {
        assert.equal(app.step(), 15, 'on to the closing screen');
        assert.match(app.main(), /Your own room/);
        assert.doesNotMatch(app.main(), /Not made/, 'the room stays on the road');
      }
    });
  }

  test(`${mode}: ← to Your own room, then →, never reaches a screen whose primary leads back`, async () => {
    const app = await bootApp({ mode, road: road(13) });
    app.cardPrimary().click();
    await app.settle();
    app.back();
    await app.settle();
    assert.equal(app.step(), 12);
    app.forward();
    await app.settle();
    assert.equal(app.step(), 13);
    app.mainPrimary().click();
    await app.settle();
    assert.ok(app.step() >= 13, `the primary moved the counter to ${app.counter()}`);
  });
}

// A first or second room made by the stand-in (REHEARSAL), back on its
// Found step on a return visit. Only the stand-in started for that very
// room may make it again; any other would answer with its own room, drawn
// over the wrong sample picture.
const standInRoad = (slot, id) => {
  const rooms = [{ kind: 'sample', id: 'desk' }, null, null, null];
  rooms[slot] = { kind: 'rehearsal', id };
  const step = slot === 0 ? 3 : 6;
  return { v: 4, step, reached: step, consent: true, own: null, rooms, finished: [slot === 1, false, false, false], best: [null, null, null, null] };
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

// The photo a room was made from, picked again in place (slots 0 to 2 in
// LIVE, your own room, slot 3, in LIVE and REHEARSAL). A different photo is
// known by its sha256 before anything is sent: in LIVE it never reaches Meta.
const mine = photoFile(7), other = photoFile(9);
const OWN = R.OWN_SLOT;
const photoRoad = (slot) => {
  const step = R.PICK_STEPS[slot] + 1;
  const rooms = [...SAMPLES, null];
  rooms[slot] = { kind: 'photo', sha256: mine.sha256 };
  return { v: 4, step, reached: step, consent: true, own: null, rooms, finished: [slot > 0, slot > 1, slot > 2, false], best: [null, null, null, null] };
};

for (const [mode, slot] of [['live', 0], ['live', 1], ['live', 2], ['live', OWN], ['rehearsal', OWN]]) {
  test(`${mode}: slot ${slot} in place: a different photo is refused before any send, and nothing is saved`, async () => {
    const app = await bootApp({ mode, road: photoRoad(slot), answer: () => replyFor('desk', mode) });
    app.cardPrimary().click();
    await app.settle();
    const step = app.step();
    assert.equal(app.mainPrimary().textContent, 'Choose the same photo');
    app.choose(other);
    await app.settle(60);
    assert.equal(app.posts(), 0, 'nothing sent');
    assert.deepEqual(app.levels(), [], 'nothing saved');
    assert.equal(app.step(), step);
    const words = app.main();
    assert.ok(words.includes(NOT_SAME_WORDS), words);
    // only the ways this screen offers
    if (slot === OWN) {
      assert.ok(words.includes('Pick the same photo, or continue to the end.'), words);
      assert.ok(app.button('Continue to the end'), 'and the screen offers it');
    } else {
      assert.ok(words.includes(`use ← to go back to Step ${R.PICK_STEPS[slot]} for another room`), words);
    }
    assert.doesNotMatch(words, /try another photo|play a sample room below/);
  });
}

for (const slot of [0, 1, 2]) {
  test(`live: slot ${slot}, the same photo made again in place: read once, on the same step`, async () => {
    const app = await bootApp({ mode: 'live', road: photoRoad(slot), answer: () => replyFor('desk', 'live') });
    app.cardPrimary().click();
    await app.settle();
    const seen = [app.step()];
    app.choose(mine);
    await app.settle(60);
    seen.push(app.step());
    assert.equal(app.posts(), 1);
    assert.deepEqual(seen, [[3, 6, 9][slot], [3, 6, 9][slot]], 'the counter never moved');
    assert.ok(app.button('Play this room'), app.main());
    assert.deepEqual(app.levels().map((e) => e.sha256), [mine.sha256], 'its level is kept on this device');
  });
}

test('live: your own room in place, a read that fails names only what this screen offers', async () => {
  const app = await bootApp({ mode: 'live', road: photoRoad(OWN), answer: () => { throw new Error('down'); } });
  app.cardPrimary().click();
  await app.settle();
  app.choose(mine);
  await app.settle(60);
  const words = app.main();
  assert.match(words, /The server could not be reached\. Please check the connection and try again\. Pick the same photo, or continue to the end\./);
  assert.doesNotMatch(words, /try another photo/);
  assert.equal(app.step(), 13);
});

test('rehearsal: your own room made in LIVE cannot load here; the way on is forward, in words', async () => {
  const kept = { sha256: mine.sha256, level: { schema: 'frameplay.level/2', origin: 'live', picture: { kind: 'photo', sha256: mine.sha256, width: 1024, height: 768 } } };
  for (const S of [13, 14]) {
    const app = await bootApp({ mode: 'rehearsal', road: { ...photoRoad(OWN), step: S, reached: S }, prefs: { levels: [kept] } });
    app.cardPrimary().click();
    await app.settle();
    assert.equal(app.h1(), 'This room cannot load here');
    assert.match(app.main(), /This room was made in LIVE\. This copy runs in REHEARSAL, so its level cannot load here, and this copy cannot make it again\./);
    assert.equal(app.button('Choose the same photo'), null, 'no re-pick that can never succeed');
    assert.equal(app.mainPrimary().textContent, 'Continue to the end');
    app.mainPrimary().click();
    await app.settle();
    assert.equal(app.step(), 15);
    assert.doesNotMatch(app.main(), /Not made/, 'the room stays on the road');
    assert.match(app.main(), /Your own room[\s\S]*this copy cannot make it again/);
    assert.equal(app.posts(), 0);
  }
});

test('rehearsal: your own room with no kept level offers the same picture, and a forward way on', async () => {
  const app = await bootApp({ mode: 'rehearsal', road: photoRoad(OWN) });
  app.cardPrimary().click();
  await app.settle();
  assert.match(app.main(), /only its own sample picture can be made again here/);
  app.button('Continue to the end').click();
  await app.settle();
  assert.equal(app.step(), 15);
  assert.doesNotMatch(app.main(), /Not made/);
});
