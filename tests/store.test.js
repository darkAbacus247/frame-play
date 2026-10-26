import test from 'node:test';
import assert from 'node:assert/strict';
import {
  soundOn, setSound, reducedMotion, setMotion, highContrast, setContrast,
  outlinesWhilePlaying, setOutlinesWhilePlaying,
} from '../src/store.js';
import { Synth } from '../src/audio.js';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}
function fresh() {
  const s = memoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
  return s;
}

test('sound: on for a fresh device; a changed device keeps the change', () => {
  const s = fresh();
  assert.equal(soundOn(), true);
  const synth = new Synth();
  synth.setOn(soundOn());
  assert.equal(synth.on, true, 'the synth starts on');
  assert.deepEqual(s.keys(), [], 'nothing is stored until the person changes it');
  setSound(false);
  assert.equal(soundOn(), false, 'a stored choice wins');
  assert.deepEqual(s.keys(), ['frameplay.sound']);
});

test('the synth is silent and safe before the first gesture', () => {
  const synth = new Synth();
  for (const n of ['step', 'bump', 'collect', 'unlock', 'locked', 'hazard', 'win', 'loss', 'start', 'tick', 'refuse']) synth.play(n);
  assert.equal(synth.ctx, null, 'no audio context until a gesture unlocks it');
});

test('Motion and High contrast follow the system until the switch is flipped', () => {
  fresh();
  assert.equal(reducedMotion(false), false);
  assert.equal(reducedMotion(true), true);
  assert.equal(highContrast(false), false);
  assert.equal(highContrast(true), true);
  setMotion(true);
  assert.equal(reducedMotion(true), false, 'Motion switched on wins over the system');
  setMotion(false);
  assert.equal(reducedMotion(false), true);
  setContrast(false);
  assert.equal(highContrast(true), false);
  setContrast(true);
  assert.equal(highContrast(false), true);
});

test('Show outlines while playing is on by default and kept', () => {
  fresh();
  assert.equal(outlinesWhilePlaying(), true);
  setOutlinesWhilePlaying(false);
  assert.equal(outlinesWhilePlaying(), false);
});
