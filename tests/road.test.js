import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  newRoad, forward, back, canForward, giveConsent, chooseRoom, startPlay, finishRound, continueAfterRound,
  startFreePlay, towardStep, counterText, lapText, sanitizeRoad, primaryLabel, LAST_STEP, FREE_PLAY,
  toOwnRoom, skipOwnRoom, passOwnRoom, ownMade, stepKind, slotOf, OWN_STEP, AFTER_OWN,
} from '../src/road.js';

const desk = { kind: 'sample', id: 'desk' };
const living = { kind: 'sample', id: 'living' };
const mine = { kind: 'photo', sha256: 'ab'.repeat(32) };

function walkThePrimaries({ skip = false } = {}) {
  const seen = [];
  let r = newRoad();
  const push = () => seen.push(r.step);
  push();
  r = giveConsent(r); push();
  r = chooseRoom(r, 0, desk); push();
  r = startPlay(r); push();
  r = finishRound(r, 0, { status: 'won', ratio: 1.2 });
  r = continueAfterRound(r); push();
  r = chooseRoom(r, 1, living); push();
  r = startPlay(r); push();
  r = finishRound(r, 1, { status: 'lost', ratio: null });
  r = continueAfterRound(r); push();
  r = toOwnRoom(r); push();
  if (skip) {
    r = skipOwnRoom(r); push();
  } else {
    r = chooseRoom(r, 2, mine); push();
    r = startPlay(r); push();
    r = finishRound(r, 2, { status: 'won', ratio: 1.0 });
    r = continueAfterRound(r); push();
  }
  if (r.step === LAST_STEP) { r = startFreePlay(r); push(); }
  return { r, seen };
}

test('primaries only move forward, one step at a time, never to a step already left', () => {
  const { r, seen } = walkThePrimaries();
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(r.step, FREE_PLAY);
  assert.deepEqual(r.best, [1.2, null, 1.0]);
  assert.deepEqual(r.rooms, [desk, living, mine]);
});

test('your own room: the third room, or passed by straight to what follows it', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(stepKind),
    ['welcome', 'pick', 'found', 'play', 'pick', 'found', 'play', 'two', 'own', 'found', 'play', 'end', 'free']);
  assert.deepEqual([2, 4, 5, 7, 8, 9, 11, 12, 13].map(slotOf), [0, 0, 1, 1, -1, 2, 2, -1, -1]);
  assert.equal(AFTER_OWN, LAST_STEP, 'made or passed by, your own room leads to the closing screen');
  const { r, seen } = walkThePrimaries({ skip: true });
  assert.deepEqual(seen.slice(-3), [OWN_STEP, AFTER_OWN, FREE_PLAY], 'skipping goes straight past its reveal and play to the end');
  assert.equal(r.own, 'skipped');
  assert.equal(r.rooms[2], null);
  // the arrows agree with the skip, both ways
  const at = { ...r, step: OWN_STEP };
  assert.equal(forward(at).step, AFTER_OWN);
  assert.equal(back(r).step, AFTER_OWN, 'Back from free play comes to the closing screen');
  assert.equal(back({ ...r, step: AFTER_OWN }).step, OWN_STEP);
  assert.equal(towardStep({ ...r, step: AFTER_OWN }, 10).step, OWN_STEP, 'Back never lands on a reveal that was never made');
  // the own room's step waits with a reason, and choosing a photo later undoes the skip
  const fresh = { ...walkThePrimaries({ skip: true }).r, step: OWN_STEP, own: null };
  assert.equal(canForward(fresh).why, 'Choose a photo, or continue to the end');
  const made = chooseRoom({ ...r, step: OWN_STEP }, 2, mine);
  assert.equal(made.step, OWN_STEP + 1);
  assert.equal(made.own, null);
  assert.equal(canForward({ ...made, step: OWN_STEP + 2 }).why, 'Finish a round, win or lose, to continue');
  assert.equal(skipOwnRoom(newRoad()).step, 1, 'only from its own step');
});

test('Continue to the end never unmakes your own room', () => {
  const { r } = walkThePrimaries();
  // made and won, then back to its step: passing on keeps it on the road
  const at9 = { ...r, step: OWN_STEP };
  const passed = passOwnRoom(at9);
  assert.equal(passed.step, LAST_STEP);
  assert.equal(passed.own, null, 'not marked as passed by');
  assert.deepEqual(passed.rooms[2], mine);
  assert.equal(passed.finished[2], true);
  assert.equal(passed.best[2], 1.0);
  assert.equal(back(passed).step, OWN_STEP + 2, 'Back walks home through the room');
  assert.equal(sanitizeRoad(JSON.parse(JSON.stringify(passed))).step, LAST_STEP);
  // from its reveal and play steps too
  for (const s of [OWN_STEP + 1, OWN_STEP + 2]) {
    const p = passOwnRoom({ ...r, step: s });
    assert.equal(p.step, LAST_STEP, `from ${s}`);
    assert.deepEqual([p.rooms[2], p.finished[2], p.best[2]], [mine, true, 1.0]);
  }
  // made but not played: passed by, and still made
  const unplayed = { ...r, step: OWN_STEP + 1, finished: [true, true, false], best: [1.2, null, null] };
  const q = passOwnRoom(unplayed);
  assert.equal(q.step, LAST_STEP);
  assert.equal(q.own, 'skipped');
  assert.ok(ownMade(q), 'a room passed by is still made');
  // nowhere else
  for (const s of [1, 2, 8, LAST_STEP, FREE_PLAY]) {
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
  // every step: back then forward returns to the same step (no loops, no jumps)
  const { r: end } = walkThePrimaries();
  for (let s = 2; s <= FREE_PLAY; s++) {
    const at = { ...end, step: s };
    assert.equal(back(at).step, s - 1);
    if (s < FREE_PLAY) assert.equal(forward(back(at)).step, s);
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
});

test('a primary from the wrong step does nothing', () => {
  const r = newRoad();
  assert.equal(chooseRoom(r, 0, desk), r);
  assert.equal(startPlay(r), r);
  assert.equal(startFreePlay(r), r);
});

test('choosing a different room clears that room’s finished round', () => {
  let r = chooseRoom(giveConsent(newRoad()), 0, desk);
  r = finishRound(startPlay(r), 0, { status: 'won', ratio: 1 });
  r = { ...r, step: 2 };
  const again = chooseRoom(r, 0, desk);
  assert.equal(again.finished[0], true);
  const other = chooseRoom(r, 0, living);
  assert.equal(other.finished[0], false);
  assert.equal(other.best[0], null);
});

test('counter, lap line and primary labels', () => {
  let r = newRoad();
  assert.equal(counterText(r), 'Step 1 of 12: Welcome');
  assert.equal(lapText(r), 'One photo, one room');
  assert.equal(primaryLabel(r), 'I am 18 or over and I understand. Continue');
  r = { ...r, step: 5 };
  assert.equal(counterText(r), 'Step 5 of 12: Another room');
  assert.equal(lapText(r), 'A second room');
  r = { ...r, step: 8 };
  assert.equal(lapText(r), 'Two rooms');
  assert.equal(primaryLabel(r), 'Continue: your own room');
  r = { ...r, step: OWN_STEP };
  assert.equal(counterText(r), 'Step 9 of 12: Your own room');
  assert.equal(lapText(r), 'Your own room');
  assert.equal(primaryLabel(r), 'Continue to the end');
  assert.equal(primaryLabel({ ...r, step: OWN_STEP + 2 }), 'Continue: the end');
  r = { ...r, step: LAST_STEP };
  assert.equal(counterText(r), 'Step 12 of 12: The end', 'the closing screen is the last step');
  assert.equal(lapText(r), 'Circuit complete');
  assert.equal(primaryLabel(r), 'Free play');
  assert.equal(counterText({ ...r, step: FREE_PLAY }), 'Free play');
});

test('a road from the device: damaged or foreign is dropped; steps must be earned', () => {
  assert.equal(sanitizeRoad(null), null);
  assert.equal(sanitizeRoad({ v: 1, step: 3 }), null);
  assert.equal(sanitizeRoad({ v: 2, step: 42 }), null);
  const cheat = sanitizeRoad({ v: 2, step: 8, consent: true, rooms: [desk, null], finished: [false, false] });
  assert.equal(cheat.step, 4);
  const odd = sanitizeRoad({ v: 2, step: 3, consent: true, rooms: [{ kind: 'sample', id: '../../x' }, null] });
  assert.equal(odd.rooms[0], null);
  assert.equal(odd.step, 2);
  // a road from before your own room reads with that room not yet made
  const old = sanitizeRoad({ v: 2, step: 8, consent: true, rooms: [desk, living], finished: [true, true], best: [1.1, null] });
  assert.equal(old.step, 8);
  assert.deepEqual(old.rooms, [desk, living, null]);
  assert.deepEqual(old.best, [1.1, null, null]);
  const skipped = { ...walkThePrimaries({ skip: true }).r, step: AFTER_OWN };
  assert.equal(sanitizeRoad(JSON.parse(JSON.stringify(skipped))).step, AFTER_OWN, 'a skip is kept');
  const noRoom = sanitizeRoad({ ...skipped, own: null, step: OWN_STEP + 2 });
  assert.equal(noRoom.step, OWN_STEP, 'no reveal or play without a room');
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
