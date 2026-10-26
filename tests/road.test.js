import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  newRoad, forward, back, canForward, giveConsent, chooseRoom, startPlay, finishRound, continueAfterRound,
  startFreePlay, towardStep, counterText, lapText, sanitizeRoad, primaryLabel, LAST_STEP, FREE_PLAY,
} from '../src/road.js';

const desk = { kind: 'sample', id: 'desk' };
const living = { kind: 'sample', id: 'living' };

function walkThePrimaries() {
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
  r = startFreePlay(r); push();
  return { r, seen };
}

test('primaries only move forward, one step at a time, never to a step already left', () => {
  const { r, seen } = walkThePrimaries();
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(r.step, FREE_PLAY);
  assert.equal(r.best[0], 1.2);
  assert.equal(r.best[1], null);
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
  assert.equal(counterText(r), 'Step 1 of 8: Welcome');
  assert.equal(lapText(r), 'One photo, one room');
  assert.equal(primaryLabel(r), 'I am 18 or over and I understand. Continue');
  r = { ...r, step: 5 };
  assert.equal(counterText(r), 'Step 5 of 8: Another room');
  assert.equal(lapText(r), 'A second room');
  r = { ...r, step: LAST_STEP };
  assert.equal(lapText(r), 'Two rooms');
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
