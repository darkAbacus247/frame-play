// Your own room marked by hand on the road (src/road.js) and on the device
// (src/store.js): one road and one counter, forward always forward, and
// the marks kept with their level, never the photo.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/road.js';
import { saveMarks, loadMarks } from '../src/store.js';
import { LABELS } from '../src/level.js';
import { tourStep } from '../src/tour.js';

const SHA = 'ab'.repeat(32);
const desk = { kind: 'sample', id: 'desk' };
const living = { kind: 'sample', id: 'living' };
const apartment = { kind: 'sample', id: 'apartment' };
const OWN = R.OWN_SLOT;
const atOwn = () => ({ ...R.newRoad(), step: 12, reached: 12, consent: true, rooms: [desk, living, apartment, null], finished: [true, true, true, false], best: [1.2, null, null, null] });
const marked = (made) => ({ kind: 'marked', sha256: SHA, made });

test('marking a photo puts it on the road unmade; Forward waits on Your marks until the room is made', () => {
  let r = R.chooseRoom(atOwn(), OWN, marked(false));
  assert.equal(r.step, 13);
  assert.equal(R.counterText(r), 'Step 13 of 15: Your marks');
  assert.equal(R.marking(r), true);
  assert.equal(R.ownMade(r), false, 'marks are not a room yet');
  assert.deepEqual(R.canForward(r), { ok: false, why: 'Make the room from your marks to go on' });
  assert.equal(R.forward(r), r);
  r = R.makeMarked(r);
  assert.equal(r.step, 13, 'making the room keeps the step');
  assert.deepEqual(r.rooms[OWN], marked(true));
  assert.equal(R.ownMade(r), true);
  assert.equal(R.canForward(r).ok, true);
  assert.equal(R.forward(r).step, 14);
  assert.equal(R.counterText({ ...r, rooms: [desk, living, apartment, { kind: 'photo', sha256: SHA }] }), 'Step 13 of 15: What the AI found', 'a read room keeps its name');
});

test('making the room again starts its results again; marking the same photo again keeps a made room', () => {
  let r = R.makeMarked(R.chooseRoom(atOwn(), OWN, marked(false)));
  r = R.finishRound(R.forward(r), OWN, { status: 'won', ratio: 1.3 });
  assert.deepEqual([r.finished[OWN], r.best[OWN]], [true, 1.3]);
  const again = R.makeMarked({ ...r, step: 13 });
  assert.deepEqual([again.finished[OWN], again.best[OWN]], [false, null]);
  const back12 = { ...r, step: 12 };
  assert.deepEqual(R.chooseRoom(back12, OWN, marked(true)).best, r.best, 'the same room, restored');
  assert.deepEqual(R.chooseRoom(back12, OWN, marked(false)).best[OWN], null, 'marked afresh');
  const end = { ...r, step: 15 };
  assert.equal(R.makeMarked(end), end, 'only on its own steps');
  const twelve = atOwn();
  assert.equal(R.makeMarked(twelve), twelve, 'and only for a marked room');
});

test('passing by: unmade marks are passed by; a made and played room stays made', () => {
  const unmade = R.chooseRoom(atOwn(), OWN, marked(false));
  const passed = R.passOwnRoom(unmade);
  assert.equal(passed.step, 15);
  assert.equal(passed.own, 'skipped');
  assert.equal(R.ownMade(passed), false);
  let made = R.finishRound(R.forward(R.makeMarked(unmade)), OWN, { status: 'lost' });
  made = R.passOwnRoom({ ...made, step: 12 });
  assert.equal(made.own, null);
  assert.equal(R.ownMade(made), true);
});

test('a saved road keeps a marked room only in its own slot, and a step only where its road holds', () => {
  const saved = (rooms, step, finished = [true, true, true, false]) => R.sanitizeRoad({ v: 4, step, reached: step, consent: true, own: null, rooms, finished, best: [null, null, null, null] });
  assert.deepEqual(saved([desk, living, apartment, marked(true)], 14).rooms[OWN], marked(true));
  assert.equal(saved([desk, living, apartment, marked(true)], 14).step, 14);
  assert.equal(saved([desk, living, apartment, marked(false)], 14).step, 13, 'unmade marks hold the road on Your marks');
  assert.deepEqual(saved([desk, living, apartment, { kind: 'marked', sha256: SHA, made: 'yes' }], 13).rooms[OWN], marked(false));
  assert.equal(saved([desk, living, apartment, { kind: 'marked', sha256: 'not a sha' }], 13).rooms[OWN], null);
  assert.equal(saved([marked(true), living, apartment, null], 3).rooms[0], null, 'never a sample room’s slot');
  assert.deepEqual(saved([desk, living, marked(true), null], 9).rooms[2], apartment, 'nor the third: the road chooses its sample room there again');
  assert.ok(R.sameRef(marked(true), marked(false)));
  assert.ok(!R.sameRef(marked(true), { kind: 'photo', sha256: SHA }));
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, raw: m };
}

test('marks are kept on this device by the photo’s fingerprint, with their level, never the photo', () => {
  const s = memoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
  const marks = [{ role: 'collect', box: [1, 2, 30, 40], picture: 'no' }];
  assert.equal(saveMarks(SHA, marks), true);
  assert.deepEqual(loadMarks(SHA).marks, [{ role: 'collect', box: [1, 2, 30, 40] }], 'only the role and the box');
  assert.equal(loadMarks(SHA).level, null);
  const level = { schema: 'frameplay.level/2', origin: 'marked', label: LABELS.marked, picture: { kind: 'marked', sha256: SHA, width: 64, height: 48 } };
  saveMarks(SHA, marks, level);
  assert.deepEqual(loadMarks(SHA).level, level);
  assert.deepEqual(Object.keys(loadMarks(SHA)).sort(), ['level', 'marks', 'saved', 'sha256']);
  assert.equal(saveMarks('nope', marks), false);
  // a foreign or damaged entry is dropped
  s.setItem('frameplay.marked', JSON.stringify([{ sha256: SHA, marks: [], level: { ...level, origin: 'live' } }]));
  assert.equal(loadMarks(SHA), null);
  for (let k = 0; k < 15; k++) saveMarks(k.toString(16).padStart(2, '0').repeat(32), marks);
  assert.equal(JSON.parse(s.getItem('frameplay.marked')).length, 12, 'the last 12');
  delete globalThis.localStorage;
});

test('the tour has its own line for Your marks, and for the room made from them', () => {
  assert.deepEqual(tourStep(13, 'marking'), { target: 'primary', line: 'Pick what a box is, drag one over each object, then press Make the room.' });
  assert.match(tourStep(13, 'made').line, /^Code traced these outlines inside your boxes\. Press Play this room\.$/);
  assert.equal(tourStep(13), tourStep(13, null), 'a read room keeps its line');
  assert.match(tourStep(13).line, /a photo of a real room/);
});
