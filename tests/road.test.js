import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  newRoad, forward, back, canForward, giveConsent, chooseRoom, startPlay, finishRound, continueAfterRound,
  startFreePlay, towardStep, counterText, lapText, sanitizeRoad, primaryLabel, LAST_STEP, FREE_PLAY,
  toOwnRoom, skipOwnRoom, passOwnRoom, ownMade, stepKind, slotOf, OWN_STEP, AFTER_OWN, OWN_SLOT, PICK_STEPS,
  THREE_STEP, nextSample,
} from '../src/road.js';

const desk = { kind: 'sample', id: 'desk' };
const living = { kind: 'sample', id: 'living' };
const apartment = { kind: 'sample', id: 'apartment' };
const mine = { kind: 'photo', sha256: 'ab'.repeat(32) };
const won = (ratio) => ({ status: 'won', ratio });

// The primaries a player presses, in order: consent, a room card on Step 2,
// then Play this room and the end card's primary, room after room.
function walkThePrimaries({ skip = false } = {}) {
  const seen = [];
  let r = newRoad();
  const push = () => seen.push(r.step);
  push();
  r = giveConsent(r); push();
  r = chooseRoom(r, 0, desk); push();
  r = startPlay(r); push();
  r = finishRound(r, 0, won(1.2));
  r = continueAfterRound(r); push();
  r = startPlay(r); push();
  r = finishRound(r, 1, { status: 'lost', ratio: null });
  r = continueAfterRound(r); push();
  r = startPlay(r); push();
  r = finishRound(r, 2, won(1.4));
  r = continueAfterRound(r); push();
  r = toOwnRoom(r); push();
  if (skip) {
    r = skipOwnRoom(r); push();
  } else {
    r = chooseRoom(r, OWN_SLOT, mine); push();
    r = startPlay(r); push();
    r = finishRound(r, OWN_SLOT, won(1.0));
    r = continueAfterRound(r); push();
  }
  if (r.step === LAST_STEP) { r = startFreePlay(r); push(); }
  return { r, seen };
}

test('three sample rooms in a row: the end card goes straight to the next room’s reveal', () => {
  const { r, seen } = walkThePrimaries();
  assert.deepEqual(seen, [1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16], 'the pick steps of the second and third rooms are passed');
  assert.equal(r.step, FREE_PLAY);
  assert.deepEqual(r.rooms, [desk, living, apartment, mine], 'The Desk Top, The Living Room, The Apartment, then your own room');
  assert.deepEqual(r.best, [1.2, null, 1.4, 1.0]);
  // the chain only from a finished round on a play step
  const at4 = { ...r, step: 4, finished: [false, false, false, false] };
  assert.equal(continueAfterRound(at4), at4);
  assert.equal(continueAfterRound({ ...r, step: 3 }).step, 3);
});

test('the chain keeps a room already chosen, and picks the next one the road has not used', () => {
  // the living room first: the desk comes next, then the apartment
  let r = chooseRoom(giveConsent(newRoad()), 0, living);
  r = finishRound(startPlay(r), 0, won(1));
  r = continueAfterRound(r);
  assert.equal(r.step, 6);
  assert.deepEqual(r.rooms.slice(0, 3), [living, desk, null]);
  r = continueAfterRound(finishRound(startPlay(r), 1, won(1)));
  assert.equal(r.step, 9);
  assert.deepEqual(r.rooms.slice(0, 3), [living, desk, apartment]);
  assert.equal(nextSample({ rooms: [living, null, null, null] }, 1).id, 'desk');
  assert.equal(nextSample({ rooms: [desk, living, null, null] }, 2).id, 'apartment');
  // Forward onto a pick step chooses the next room there too
  let q = finishRound(startPlay(chooseRoom(giveConsent(newRoad()), 0, desk)), 0, won(1));
  q = forward(q);
  assert.equal(q.step, 5, 'Forward lands on the pick step');
  assert.deepEqual(q.rooms[1], living, 'with the next room chosen there');
  assert.ok(canForward(q).ok);
  // a room picked by hand there stays when the chain passes its step
  q = chooseRoom(q, 1, apartment);
  assert.equal(q.step, 6);
  assert.deepEqual(continueAfterRound({ ...q, step: 4 }).rooms[1], apartment, 'the chain keeps the room picked by hand');
});

test('a pick step can still choose any room: a room another step holds trades places, with its results', () => {
  const { r } = walkThePrimaries();
  const swapped = chooseRoom({ ...r, step: 2 }, 0, apartment);
  assert.equal(swapped.step, 3);
  assert.deepEqual(swapped.rooms.slice(0, 3), [apartment, living, desk]);
  assert.deepEqual(swapped.best.slice(0, 3), [1.4, null, 1.2], 'each room keeps its own results');
  assert.deepEqual(swapped.finished.slice(0, 3), [true, true, true]);
  // a photo in a sample slot (LIVE) takes no other room's place
  const photo = chooseRoom({ ...r, step: 5 }, 1, mine);
  assert.deepEqual(photo.rooms.slice(0, 3), [desk, mine, apartment]);
  assert.equal(photo.finished[1], false);
});

test('your own room: the fourth room, or passed by straight to what follows it', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(stepKind),
    ['welcome', 'pick', 'found', 'play', 'pick', 'found', 'play', 'pick', 'found', 'play', 'three', 'own', 'found', 'play', 'end', 'free']);
  assert.deepEqual([2, 4, 5, 7, 8, 10, 11, 12, 14, 15, 16].map(slotOf), [0, 0, 1, 1, 2, 2, -1, 3, 3, -1, -1]);
  assert.deepEqual([PICK_STEPS, OWN_STEP, OWN_SLOT, THREE_STEP], [[2, 5, 8, 12], 12, 3, 11]);
  assert.equal(AFTER_OWN, LAST_STEP, 'made or passed by, your own room leads to the closing screen');
  const { r, seen } = walkThePrimaries({ skip: true });
  assert.deepEqual(seen.slice(-3), [OWN_STEP, AFTER_OWN, FREE_PLAY], 'skipping goes straight past its reveal and play to the end');
  assert.equal(r.own, 'skipped');
  assert.equal(r.rooms[OWN_SLOT], null);
  // the arrows agree with the skip, both ways
  const at = { ...r, step: OWN_STEP };
  assert.equal(forward(at).step, AFTER_OWN);
  assert.equal(back(r).step, AFTER_OWN, 'Back from free play comes to the closing screen');
  assert.equal(back({ ...r, step: AFTER_OWN }).step, OWN_STEP);
  assert.equal(towardStep({ ...r, step: AFTER_OWN }, 13).step, OWN_STEP, 'Back never lands on a reveal that was never made');
  // the own room's step waits with a reason, and choosing a photo later undoes the skip
  const fresh = { ...walkThePrimaries({ skip: true }).r, step: OWN_STEP, own: null };
  assert.equal(canForward(fresh).why, 'Choose a photo, or continue to the end');
  const made = chooseRoom({ ...r, step: OWN_STEP }, OWN_SLOT, mine);
  assert.equal(made.step, OWN_STEP + 1);
  assert.equal(made.own, null);
  assert.equal(canForward({ ...made, step: OWN_STEP + 2 }).why, 'Finish a round, win or lose, to continue');
  assert.equal(skipOwnRoom(newRoad()).step, 1, 'only from its own step');
});

test('Continue to the end never unmakes your own room', () => {
  const { r } = walkThePrimaries();
  // made and won, then back to its step: passing on keeps it on the road
  const passed = passOwnRoom({ ...r, step: OWN_STEP });
  assert.equal(passed.step, LAST_STEP);
  assert.equal(passed.own, null, 'not marked as passed by');
  assert.deepEqual(passed.rooms[OWN_SLOT], mine);
  assert.equal(passed.finished[OWN_SLOT], true);
  assert.equal(passed.best[OWN_SLOT], 1.0);
  assert.equal(back(passed).step, OWN_STEP + 2, 'Back walks home through the room');
  assert.equal(sanitizeRoad(JSON.parse(JSON.stringify(passed))).step, LAST_STEP);
  // from its reveal and play steps too
  for (const s of [OWN_STEP + 1, OWN_STEP + 2]) {
    const p = passOwnRoom({ ...r, step: s });
    assert.equal(p.step, LAST_STEP, `from ${s}`);
    assert.deepEqual([p.rooms[OWN_SLOT], p.finished[OWN_SLOT], p.best[OWN_SLOT]], [mine, true, 1.0]);
  }
  // made but not played: passed by, and still made
  const q = passOwnRoom({ ...r, step: OWN_STEP + 1, finished: [true, true, true, false], best: [1.2, null, 1.4, null] });
  assert.equal(q.step, LAST_STEP);
  assert.equal(q.own, 'skipped');
  assert.ok(ownMade(q), 'a room passed by is still made');
  // nowhere else
  for (const s of [1, 2, 8, THREE_STEP, LAST_STEP, FREE_PLAY]) {
    const at = { ...r, step: s };
    assert.equal(passOwnRoom(at), at, `nothing from ${s}`);
  }
  // a road saved before this rule heals: skipped, yet made and played
  const old = sanitizeRoad({ ...r, step: LAST_STEP, own: 'skipped' });
  assert.equal(old.own, null);
  assert.equal(back(old).step, OWN_STEP + 2);
});

test('Back goes one left, Forward one right, and Forward waits with a reason', () => {
  let r = newRoad();
  assert.equal(back(r).step, 1);
  assert.equal(forward(r).step, 1);
  assert.equal(canForward(r).why, 'Agree on this screen to continue');
  r = giveConsent(r);
  assert.equal(r.step, 2);
  assert.equal(canForward(r).why, 'Pick a room to continue');
  r = chooseRoom(r, 0, desk);
  r = startPlay(r);
  assert.equal(r.step, 4);
  assert.equal(canForward(r).why, 'Finish a round, win or lose, to continue');
  assert.equal(forward(r).step, 4);
  r = back(r);
  assert.equal(r.step, 3);
  r = forward(r);
  assert.equal(r.step, 4);
  r = finishRound(r, 0, { status: 'lost' });
  assert.equal(forward(r).step, 5);
  assert.equal(canForward({ ...newRoad(), consent: true, step: 8 }).why, 'Pick a third room to continue');
  assert.equal(canForward({ ...newRoad(), consent: true, step: 10, rooms: [desk, living, apartment, null] }).why, 'Finish a round, win or lose, to continue');
  // every step: back then forward returns to the same step (no loops, no jumps)
  const { r: end } = walkThePrimaries();
  for (let s = 2; s <= FREE_PLAY; s++) {
    const at = { ...end, step: s };
    assert.equal(back(at).step, s - 1);
    if (s < FREE_PLAY) assert.equal(forward(back(at)).step, s);
  }
  // Back from the second and third rooms' reveals comes to their pick
  // steps, the room still chosen there
  for (const s of [6, 9]) {
    const b = back({ ...end, step: s });
    assert.equal(stepKind(b.step), 'pick');
    assert.ok(canForward(b).ok, `Step ${b.step} holds its room`);
  }
});

test('browser Back and Forward follow the road, never past what is allowed', () => {
  const { r: end } = walkThePrimaries();
  const at4 = { ...end, step: 4 };
  assert.equal(towardStep(at4, 2).step, 2);
  assert.equal(towardStep({ ...at4, step: 2 }, 4).step, 4);
  let r = chooseRoom(giveConsent(newRoad()), 0, desk);
  r = startPlay(r);
  assert.equal(towardStep(r, 8).step, 4, 'Forward stops where a round must be finished');
  assert.equal(towardStep(newRoad(), 3).step, 1, 'no skipping consent');
  // through a pick step: the browser's Forward chooses the next room there, as → does
  r = finishRound(r, 0, won(1));
  const fwd = towardStep(r, 6);
  assert.equal(fwd.step, 6);
  assert.deepEqual(fwd.rooms[1], living);
  assert.equal(towardStep({ ...end, step: FREE_PLAY }, 5).step, 5);
});

test('a primary from the wrong step does nothing', () => {
  const r = newRoad();
  assert.equal(chooseRoom(r, 0, desk), r);
  assert.equal(startPlay(r), r);
  assert.equal(startFreePlay(r), r);
  assert.equal(toOwnRoom(r), r);
});

test('choosing a different room clears that room’s finished round', () => {
  let r = chooseRoom(giveConsent(newRoad()), 0, desk);
  r = finishRound(startPlay(r), 0, won(1));
  r = { ...r, step: 2 };
  const again = chooseRoom(r, 0, desk);
  assert.equal(again.finished[0], true);
  const other = chooseRoom(r, 0, living);
  assert.equal(other.finished[0], false);
  assert.equal(other.best[0], null);
});

test('claims-12: a sample room drawn by code is never headed as what the AI found', () => {
  const ours = { kind: 'replay', id: 'kitchen' };
  const road = { ...newRoad(), rooms: [ours, living, apartment, mine] };
  assert.deepEqual([3, 6, 9, 13].map((step) => counterText({ ...road, step })), [
    'Step 3 of 15: What the AI found', 'Step 6 of 15: What is in this room', 'Step 9 of 15: What is in this room',
    'Step 13 of 15: What the AI found',
  ]);
  assert.equal(counterText({ ...road, rooms: [desk, living, apartment, null], step: 3 }), 'Step 3 of 15: What is in this room');
  assert.equal(counterText({ ...road, step: 4 }), 'Step 4 of 15: Play', 'only the reveal steps are named for their room');
});

test('counter, lap line and primary labels: Step N of 15', () => {
  const r = newRoad();
  assert.equal(primaryLabel(r), 'I am 18 or over and I understand. Continue');
  const names = [];
  for (let s = 1; s <= LAST_STEP; s++) names.push(counterText({ ...r, step: s }));
  assert.deepEqual(names, [
    'Step 1 of 15: Welcome', 'Step 2 of 15: Your room', 'Step 3 of 15: What the AI found', 'Step 4 of 15: Play',
    'Step 5 of 15: Another room', 'Step 6 of 15: What the AI found', 'Step 7 of 15: Play',
    'Step 8 of 15: A third room', 'Step 9 of 15: What the AI found', 'Step 10 of 15: Play',
    'Step 11 of 15: Your three rooms', 'Step 12 of 15: Your own room', 'Step 13 of 15: What the AI found', 'Step 14 of 15: Play',
    'Step 15 of 15: The end',
  ]);
  assert.deepEqual([4, 7, 10, 11, 12, 14, 15].map((s) => primaryLabel({ step: s })), [
    'Continue: the second room', 'Continue: the third room', 'Continue: your three rooms', 'Continue: your own room',
    'Continue to the end', 'Continue: the end', 'Free play',
  ]);
  assert.deepEqual([3, 6, 9, 13].map((s) => primaryLabel({ step: s })), Array(4).fill('Play this room'));
  assert.deepEqual([1, 4, 5, 8, 10, 11, 12, 15, 16].map((s) => lapText({ step: s })), [
    'One photo, one room', 'One photo, one room', 'A second room', 'A third room', 'A third room', 'Three rooms', 'Your own room', 'Circuit complete', 'Free play',
  ]);
  assert.equal(counterText({ ...r, step: FREE_PLAY }), 'Free play');
});

test('a road from the device: damaged or foreign is dropped; steps must be earned', () => {
  assert.equal(sanitizeRoad(null), null);
  assert.equal(sanitizeRoad({ v: 1, step: 3 }), null);
  assert.equal(sanitizeRoad({ v: 2, step: 42 }), null);
  assert.equal(sanitizeRoad({ v: 4, step: 17 }), null);
  const cheat = sanitizeRoad({ v: 4, step: 11, consent: true, rooms: [desk, null, null, null], finished: [false, false, false, false] });
  assert.equal(cheat.step, 4);
  const odd = sanitizeRoad({ v: 4, step: 3, consent: true, rooms: [{ kind: 'sample', id: '../../x' }, null, null, null] });
  assert.equal(odd.rooms[0], null);
  assert.equal(odd.step, 2);
  const skipped = { ...walkThePrimaries({ skip: true }).r, step: AFTER_OWN };
  assert.equal(sanitizeRoad(JSON.parse(JSON.stringify(skipped))).step, AFTER_OWN, 'a skip is kept');
  const noRoom = sanitizeRoad({ ...skipped, own: null, step: OWN_STEP + 2 });
  assert.equal(noRoom.step, OWN_STEP, 'no reveal or play without a room');
  const whole = walkThePrimaries().r;
  for (let s = 1; s <= FREE_PLAY; s++) assert.equal(sanitizeRoad(JSON.parse(JSON.stringify({ ...whole, step: s }))).step, s, `a whole road keeps Step ${s}`);
});

// Roads saved by earlier versions: 12 steps (v 3, with your own room) or the
// same steps without it (v 2). Each reads onto this road without a dead
// end: it goes on from the first room it has not played, The Apartment,
// already chosen on its step.
const V3 = (step, extra = {}) => ({
  v: 3, step, reached: step, consent: true, own: null,
  rooms: [desk, living, mine], finished: [true, true, true], best: [1.1, null, 1.3], ...extra,
});

test('an old road (12 steps, v 3) migrates: its rooms kept, The Apartment next, never a dead end', () => {
  const end = sanitizeRoad(V3(12));
  assert.equal(end.v, 4);
  assert.deepEqual(end.rooms, [desk, living, apartment, mine], 'its own room is your own room here; the third sample room is chosen for it');
  assert.deepEqual(end.finished, [true, true, false, true]);
  assert.deepEqual(end.best, [1.1, null, null, 1.3]);
  assert.equal(end.step, 10, 'it stops at the room it has not played: Play, The Apartment');
  assert.equal(counterText(end), 'Step 10 of 15: Play');
  // played, it goes on to the end: no step waits for anything it cannot do
  let r = continueAfterRound(finishRound(end, 2, won(1)));
  assert.equal(r.step, THREE_STEP);
  r = forward(forward(r));
  assert.equal(r.step, OWN_STEP + 1, 'its own room, still made');
  r = forward(forward(r));
  assert.equal(r.step, LAST_STEP);
  // every old step: kept where its road holds, else the first step it has not earned
  const want = [null, 1, 2, 3, 4, 5, 6, 7, 10, 10, 10, 10, 10, 10];
  for (let s = 1; s <= 13; s++) {
    const m = sanitizeRoad(V3(s));
    assert.equal(m.step, want[s], `old Step ${s}`);
  }
  // an old road part way: unchanged steps stay
  const early = sanitizeRoad(V3(4, { rooms: [desk, null, null], finished: [false, false, false] }));
  assert.equal(early.step, 4);
  assert.deepEqual(early.rooms, [desk, null, null, null]);
  // an old road at its own room, the third sample room played on this road
  // already: it is where it was
  const own = sanitizeRoad({ ...V3(9, { rooms: [desk, living, null], finished: [true, true, false] }) });
  assert.equal(own.step, 10);
  // skipped own room, at the old end
  const skipped = sanitizeRoad(V3(12, { own: 'skipped', rooms: [desk, living, null], finished: [true, true, false] }));
  assert.equal(skipped.own, 'skipped');
  assert.equal(skipped.step, 10);
  assert.equal(forward(forward(continueAfterRound(finishRound(skipped, 2, won(1))))).step, LAST_STEP, 'passed by, as it was');
  // a marked room stays in your own room's slot only
  const marked = { kind: 'marked', sha256: 'cd'.repeat(32), made: true };
  assert.deepEqual(sanitizeRoad(V3(11, { rooms: [desk, living, marked] })).rooms[OWN_SLOT], marked);
  assert.equal(sanitizeRoad(V3(11, { rooms: [marked, living, null] })).rooms[0], null);
  // damaged old steps
  assert.equal(sanitizeRoad(V3(14)), null);
});

test('an older road (v 2, before your own room) migrates too', () => {
  const old = sanitizeRoad({ v: 2, step: 8, consent: true, rooms: [desk, living], finished: [true, true], best: [1.1, null] });
  assert.equal(old.step, 10);
  assert.deepEqual(old.rooms, [desk, living, apartment, null]);
  assert.deepEqual(old.best, [1.1, null, null, null]);
  assert.equal(old.own, null);
  const cheat = sanitizeRoad({ v: 2, step: 8, consent: true, rooms: [desk, null], finished: [false, false] });
  assert.equal(cheat.step, 4);
});

test('layout statics: nothing fixed over content; only the spacing scale', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.ok(!/position\s*:\s*fixed/.test(css), 'position: fixed is not allowed');
  assert.ok(!/position\s*:\s*sticky/.test(css), 'position: sticky is not allowed (bars sit in flow; see tests/layout.test.js)');
  const allowed = new Set(['0', '1px', '2px', '3px', 'var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--gap)', 'var(--pad)', 'auto', '-1px']);
  const re = /(?:^|[;{\s])(gap|row-gap|column-gap|padding|padding-[a-z-]+|margin|margin-[a-z-]+)\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(css))) {
    for (const v of m[2].trim().split(/\s+/)) {
      if (v === '!important') continue;
      assert.ok(allowed.has(v), `${m[1]}: ${m[2]} uses ${v}, not on the spacing scale`);
    }
  }
});
