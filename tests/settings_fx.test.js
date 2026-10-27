// Music, effects and motion (src/settings_fx.js) on tests/fakedom.js: the
// defaults on a fresh device, nothing stored until a change, saved and
// restored, the block in the drawer, and the synth following it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument } from './fakedom.js';
import { installAudio } from './audio_stub.js';
import {
  mountFxSettings, musicOn, musicVolume, effectsOn, fxSettings, setMusicOn, setMusicVolume, setEffectsOn, motionReduced,
} from '../src/settings_fx.js';
import { MUSIC_DEFAULT_VOLUME } from '../src/music.js';
import { on, clearListeners } from '../src/events.js';
import { Synth } from '../src/audio.js';
import { soundOn } from '../src/store.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, keys: () => [...m.keys()] };
}
function fresh({ systemReduced = false } = {}) {
  const s = memoryStorage();
  globalThis.localStorage = s;
  globalThis.matchMedia = (q) => ({ matches: q.includes('reduced-motion') && systemReduced });
  return s;
}
function page() {
  const doc = installFakeDocument();
  doc.body.append(doc.createElement('div'));
  doc.body.children[0].id = 'tips';
  const box = doc.createElement('div');
  doc.body.append(box);
  return { doc, box };
}
const switchOf = (block, label) => block.querySelectorAll('button').find((b) => b.children[0].textContent === label);

test('a fresh device: music and effects on, the music gentle, motion as the system asks, nothing stored', () => {
  const s = fresh();
  assert.deepEqual(fxSettings(), { music: true, volume: MUSIC_DEFAULT_VOLUME, effects: true, reducedMotion: false });
  assert.ok(MUSIC_DEFAULT_VOLUME > 0 && MUSIC_DEFAULT_VOLUME < 0.5);
  assert.equal(soundOn(), true, 'Sound stays on by default');
  fresh({ systemReduced: true });
  assert.equal(motionReduced(), true, 'the system asks for less motion');
  assert.deepEqual(s.keys(), []);
  assert.deepEqual(globalThis.localStorage.keys(), [], 'reading stores nothing');
});

test('saved on the device and read back, and damaged values fall back', () => {
  const s = fresh();
  setMusicOn(false);
  setMusicVolume(0.73);
  setEffectsOn(false);
  assert.deepEqual(s.keys().sort(), ['frameplay.effects', 'frameplay.music', 'frameplay.musicVolume']);
  assert.equal(musicOn(), false);
  assert.equal(musicVolume(), 0.73);
  assert.equal(effectsOn(), false);
  setMusicVolume(9);
  assert.equal(musicVolume(), 1, 'clamped');
  s.setItem('frameplay.musicVolume', '"loud"');
  assert.equal(musicVolume(), MUSIC_DEFAULT_VOLUME);
  s.setItem('frameplay.musicVolume', '{bad json');
  assert.equal(musicVolume(), MUSIC_DEFAULT_VOLUME);
  // blocked storage: the defaults, and no throw
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(fxSettings(), { music: true, volume: MUSIC_DEFAULT_VOLUME, effects: true, reducedMotion: false });
  assert.equal(setMusicOn(false), false);
});

test('the block: Music with its volume, Effects and Reduce motion, flipped in place and saved', () => {
  const s = fresh();
  const { doc, box } = page();
  clearListeners();
  const told = [];
  on('settings', (d) => told.push(d));
  const { el: block } = mountFxSettings(box);
  assert.equal(box.children.at(-1), block, 'appended to the container');
  assert.equal(block.getAttribute('role'), 'group');
  const music = switchOf(block, 'Music');
  const effects = switchOf(block, 'Effects');
  const motion = switchOf(block, 'Reduce motion');
  const slider = block.querySelector('input');
  assert.deepEqual([music, effects, motion].map((b) => [b.getAttribute('role'), b.getAttribute('aria-checked')]), [['switch', 'true'], ['switch', 'true'], ['switch', 'false']]);
  assert.equal(slider.getAttribute('type'), 'range');
  assert.equal(slider.value, String(Math.round(MUSIC_DEFAULT_VOLUME * 100)));
  assert.equal(block.querySelector('label').getAttribute('for'), slider.id, 'the slider has its name');
  assert.deepEqual(s.keys(), [], 'showing the block stores nothing');

  music.focus();
  music.click();
  assert.equal(music.getAttribute('aria-checked'), 'false');
  assert.equal(music.children[1].textContent, 'Off');
  assert.equal(doc.activeElement, music, 'focus stays on the switch');
  assert.equal(slider.disabled, true, 'no volume while the music is off');
  assert.equal(musicOn(), false);
  music.click();
  assert.equal(slider.disabled, false);

  slider.value = '80';
  slider.dispatch('input');
  slider.dispatch('change');
  assert.equal(musicVolume(), 0.8);
  assert.equal(slider.getAttribute('aria-valuetext'), '80 percent');

  effects.click();
  assert.equal(effectsOn(), false);

  motion.click();
  assert.equal(motion.getAttribute('aria-checked'), 'true');
  assert.equal(motionReduced(), true);
  assert.equal(doc.documentElement.classList.contains('rm'), true, 'the page follows at once');
  assert.equal(JSON.parse(s.getItem('frameplay.motion')), 'off', 'the same choice as the Motion switch');
  motion.click();
  assert.equal(doc.documentElement.classList.contains('rm'), false);

  assert.ok(told.length >= 6, 'every change is told');
  assert.deepEqual(told.at(-1), { music: true, volume: 0.8, effects: false, reducedMotion: false });

  // a reload: a new block shows what was saved
  const again = mountFxSettings(page().box).el;
  assert.equal(switchOf(again, 'Effects').getAttribute('aria-checked'), 'false');
  assert.equal(again.querySelector('input').value, '80');
  clearListeners();
});

test('the synth starts from the saved choices and follows a change', () => {
  const undo = installAudio();
  try {
    fresh();
    setMusicOn(false);
    setMusicVolume(0.6);
    setEffectsOn(false);
    clearListeners();
    const synth = new Synth();
    assert.equal(synth.musicOn, false);
    assert.equal(synth.musicVolume, 0.6);
    assert.equal(synth.effects, false);
    synth.unlock();
    assert.equal(synth.music.playing, false, 'saved Music off: the gesture starts none');
    const { box } = page();
    const block = mountFxSettings(box).el;
    switchOf(block, 'Music').click();
    assert.equal(synth.music.playing, true, 'Music on, at once');
    assert.equal(synth.music.volume, 0.6);
    switchOf(block, 'Effects').click();
    assert.equal(synth.effects, true);
    const slider = block.querySelector('input');
    slider.value = '20';
    slider.dispatch('input');
    assert.equal(synth.music.volume, 0.2, 'the volume follows the slider as it moves');
    synth.setOn(false);
    assert.equal(synth.music.playing, false, 'and the Sound switch still silences everything');
  } finally {
    undo();
    clearListeners();
  }
});
