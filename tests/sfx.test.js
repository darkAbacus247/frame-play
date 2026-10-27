// The game's sounds, built against a stand-in AudioContext: none louder than
// the loudest sound the game already had, the new ones quiet, the steps
// spaced out, the reveal's shimmer, the primary buttons' click and the
// closing sting reached through the event bus (src/events.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { StubAudioContext, installAudio } from './audio_stub.js';
import { Synth, STEP_GAP } from '../src/audio.js';
import { emit, on, clearListeners } from '../src/events.js';
import { fakeDocument } from './fakedom.js';
import { STING } from '../src/music.js';

const SOUNDS = ['step', 'bump', 'collect', 'unlock', 'locked', 'hazard', 'win', 'loss', 'start', 'tick', 'refuse', 'shimmer', 'click'];

function unlocked({ music = false } = {}) {
  const s = new Synth();
  s.setMusic(music);
  s.unlock();
  return s;
}

// the peak of every voice one sound makes
function peaksOf(name) {
  const s = unlocked();
  const before = new Set(s.ctx.nodes);
  s.ctx.currentTime += 1;
  s.play(name);
  const fresh = s.ctx.nodes.filter((n) => !before.has(n));
  const gains = fresh.filter((n) => n.kind === 'gain');
  return { voices: fresh.filter((n) => n.kind === 'osc' || n.kind === 'source').length, peaks: gains.map((g) => g.gain.peak) };
}

test('every sound is synthesised, and no voice is louder than the loudest the game had (0.18)', () => {
  const undo = installAudio();
  try {
    for (const name of SOUNDS) {
      const { voices, peaks } = peaksOf(name);
      assert.ok(voices > 0, `${name} makes a sound`);
      assert.ok(Math.max(...peaks) <= 0.18, `${name}: ${Math.max(...peaks)}`);
    }
    for (const name of ['step', 'shimmer', 'click']) {
      assert.ok(Math.max(...peaksOf(name).peaks) <= 0.05, `${name} is quiet`);
    }
  } finally { undo(); }
});

test('the steps are soft and spaced, never one a frame', () => {
  const undo = installAudio();
  try {
    const s = unlocked();
    const sources = () => s.ctx.of('source').length;
    s.ctx.currentTime = 5;
    for (let i = 0; i < 10; i++) { s.play('step'); s.ctx.currentTime += 1 / 60; }
    assert.equal(sources(), 1, 'ten frames, one step');
    s.ctx.currentTime = 5 + STEP_GAP + 0.01;
    s.play('step');
    assert.equal(sources(), 2);
  } finally { undo(); }
});

test('Effects off silences the game sounds and leaves the music', () => {
  const undo = installAudio();
  try {
    const s = unlocked({ music: true });
    s.effects = false;
    const n = s.ctx.nodes.length;
    for (const name of SOUNDS) s.play(name);
    assert.equal(s.ctx.nodes.length, n);
    assert.equal(s.music.playing, true);
    s.setMusic(false);
  } finally { undo(); }
});

test('before a gesture every sound is silent and makes no context', () => {
  const undo = installAudio();
  try {
    const s = new Synth();
    for (const name of SOUNDS) s.play(name);
    emit('reveal', { k: 1 });
    emit('ui');
    emit('closing');
    assert.equal(StubAudioContext.made.length, 0);
  } finally { undo(); }
});

test('the bus brings the shimmer, the click and the sting', () => {
  const undo = installAudio();
  try {
    clearListeners();
    const s = unlocked({ music: true });
    const oscs = () => s.ctx.of('osc').length;
    let n = oscs();
    emit('reveal', { k: 2, of: 5 });
    assert.ok(oscs() > n, 'an outline shimmers');
    n = oscs();
    emit('ui', { kind: 'primary' });
    assert.ok(oscs() > n, 'a primary button clicks');
    n = oscs();
    emit('closing');
    assert.equal(oscs(), n + STING.length, 'the closing sting');
    s.setMusic(false);
    n = oscs();
    emit('closing');
    assert.equal(oscs(), n, 'no sting with the music off');
    clearListeners();
  } finally { undo(); }
});

test('the page watcher: primary buttons click, the closing screen stings once', async () => {
  clearListeners();
  const heard = [];
  on('ui', () => heard.push('ui'));
  on('closing', () => heard.push('closing'));
  const observers = [];
  const savedMO = globalThis.MutationObserver;
  globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe(t, o) { this.target = t; this.opts = o; } };
  const savedDoc = globalThis.document;
  try {
    // imported with no page, so the module's own install does nothing
    delete globalThis.document;
    const { watchPage } = await import('../src/game.js');
    const doc = fakeDocument();
    globalThis.document = doc;
    assert.equal(watchPage(doc), true);
    assert.equal(watchPage(doc), false, 'once per page');
    const { el } = await import('../src/ui.js');
    const primary = el('button', { 'data-primary': 'true' }, [el('span', { text: 'Go' })]);
    const other = el('button', { text: 'Back' });
    doc.body.append(primary, other);
    const click = (target) => { for (const l of doc.listeners.get('click')) l.fn({ target }); };
    click(primary.children[0]);
    click(other);
    assert.deepEqual(heard, ['ui']);
    const mo = observers.at(-1);
    assert.equal(mo.target, doc.body);
    assert.deepEqual(mo.opts, { childList: true, subtree: true });
    mo.cb();
    assert.deepEqual(heard, ['ui'], 'not yet');
    doc.body.append(el('section', { class: 'screen closing' }));
    mo.cb();
    mo.cb();
    assert.deepEqual(heard, ['ui', 'closing'], 'once while it shows');
    doc.body.replaceChildren();
    mo.cb();
    doc.body.append(el('section', { class: 'screen closing' }));
    mo.cb();
    assert.deepEqual(heard, ['ui', 'closing', 'closing'], 'again when it comes back');
  } finally {
    globalThis.MutationObserver = savedMO;
    if (savedDoc === undefined) delete globalThis.document; else globalThis.document = savedDoc;
    clearListeners();
  }
});
