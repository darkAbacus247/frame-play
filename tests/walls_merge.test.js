// M5: what W1's walls and floors meet on the page. A bump into a wall says
// a wall and plays the plain bump (never the hazard's thud, its puff or its
// event); the reveal says where the play area came from, honest by mode;
// and on The Apartment (walls, doorways, a picture seen from above) the
// particle layer lies over the board at its size and places a burst where
// the explorer is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './fakedom.js';
import { loadRoom } from '../src/rooms.js';
import { buildLevel, inputFromRoom } from '../src/level.js';
import { announce } from '../src/words.js';
import { createRound, stepRound } from '../src/play.js';
import { on, clearListeners } from '../src/events.js';

const roomOf = (id) => loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
const apartment = () => buildLevel(inputFromRoom(roomOf('apartment'), '2026-10-27T12:00:00Z'));

test('a bump says a wall where the event says wall: true, else the floor’s edge or the thing', () => {
  const { level } = apartment();
  assert.equal(announce(level, { type: 'bump', k: -1, wall: true }, 'floor'), 'Blocked by a wall');
  assert.equal(announce(level, { type: 'bump', k: -1 }, 'floor'), 'Blocked by the edge of the floor');
  const sofa = level.objects.findIndex((o) => o.name === 'sofa');
  assert.ok(sofa >= 0);
  assert.equal(announce(level, { type: 'bump', k: sofa, wall: true }), 'Blocked by the sofa', 'a thing is named, wall or not');
});

test('walking into The Apartment’s west wall is a wall bump', () => {
  const { level, rt } = apartment();
  const state = createRound(level, rt);
  state.pos = [300, 380];
  const events = [];
  for (let t = 0; t < 600 && !events.some((e) => e.type === 'bump'); t++) events.push(...stepRound(state, level, rt, { dir: [-1, 0] }));
  assert.deepEqual(events.find((e) => e.type === 'bump'), { type: 'bump', k: -1, wall: true });
  assert.ok(!events.some((e) => e.type === 'lose'));
});

test('the reveal says where the play area came from, by mode', async () => {
  installFakeDocument();
  const { foundView, floorLine } = await import('../src/screens.js');
  const { level } = apartment();
  assert.equal(level.origin, 'mock');
  assert.match(floorLine(level), /as code drew it; everything else is wall\./);
  assert.doesNotMatch(floorLine(level), /Muse Spark|SAM|stand-in/, 'a sample room calls no model');
  const view = foundView({ level, summary: null, fromDevice: false, actions: { play() {}, describe() {}, walls() {} } });
  const p = view.section.querySelector('.floor-words');
  assert.equal(p.textContent, level.provenance.floor.words);
  // a live or rehearsal read carries its own words (src/trace_in_box.js), shown as they are
  const live = { ...level, provenance: { ...level.provenance, floor: { source: 'traced_floor', words: 'Code grew the floor from the stand-in for Muse Spark’s 4 points on it inside the stand-in for SAM 3.1’s 4 boxes for it; everything else is wall.' } } };
  assert.equal(floorLine(live), live.provenance.floor.words);
  // a level kept before floors claims nothing
  const old = { ...level, provenance: { ...level.provenance, floor: undefined } };
  assert.match(floorLine(old), /kept on this device before floors were traced/);
});

test('The Apartment on the real board: the layer matches it, a wall bump plays the bump and no hazard', async () => {
  const doc = installFakeDocument();
  const { el } = await import('../src/ui.js');
  const { Renderer } = await import('../src/render.js');
  let frames = [];
  const observers = [];
  const saved = {};
  for (const k of ['requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'Path2D', 'getComputedStyle']) saved[k] = globalThis[k];
  Object.assign(globalThis, {
    Path2D: class { constructor() { return new Proxy(this, { get: (o, k) => (k in o ? o[k] : () => {}) }); } },
    requestAnimationFrame: (f) => { frames.push(f); return frames.length; },
    cancelAnimationFrame: () => {},
    ResizeObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} },
    getComputedStyle: () => ({ paddingTop: '0', paddingBottom: '0', rowGap: '0', columnGap: '0', gridTemplateAreas: '', getPropertyValue: () => '', fontSize: '16px' }),
  });
  doc.documentElement.getBoundingClientRect = () => ({ width: 0, height: 0 });
  const draw = Renderer.prototype.draw;
  Renderer.prototype.draw = () => {};
  const hazards = [];
  clearListeners();
  on('hazard', (d) => hazards.push(d));
  try {
    const { mountPlay } = await import('../src/game.js');
    const { level, rt } = apartment();
    assert.equal(level.view, 'top_down');
    assert.equal(level.surface.doorways.length, 3);
    const root = el('main', {});
    doc.body.replaceChildren(el('div', { id: 'tips' }), root);
    const played = [], said = [];
    const view = mountPlay(root, {
      level, rt, picture: doc.createElement('canvas'), audio: { play: (n) => played.push(n) },
      say: (t) => said.push(t), ui: () => ({ reducedMotion: false }), onEnd: () => {},
    });
    const game = root.querySelector('.game');
    const [canvas, layer] = game.children;
    assert.equal(layer, view.fx.layer);
    observers.at(-1).cb();
    assert.match(canvas.style.width, /^\d+px$/, 'the board was sized');
    assert.deepEqual([layer.style.width, layer.style.height], [canvas.style.width, canvas.style.height], 'the layer matches it');
    assert.deepEqual([layer.width, layer.height], [canvas.width, canvas.height]);
    // the picture's aspect is kept, so picture pixels map evenly onto the layer
    const cssW = parseFloat(canvas.style.width), cssH = parseFloat(canvas.style.height);
    assert.ok(Math.abs(cssW / cssH - level.picture.width / level.picture.height) < 0.02, `${cssW}x${cssH}`);

    let t = 1000;
    const pump = (n) => { for (let i = 0; i < n; i++) { const run = frames; frames = []; t += 1000 / 60; for (const f of run) f(t); } };
    pump(2);
    view.state.pos = [300, 380];
    view.fx.clear();
    played.length = 0;
    game.dispatch('keydown', { key: 'ArrowLeft' });
    for (let i = 0; i < 60 && !said.includes('Blocked by a wall'); i++) pump(10);
    game.dispatch('keyup', { key: 'ArrowLeft' });
    assert.ok(said.includes('Blocked by a wall'), said.join(' | '));
    assert.ok(played.includes('bump'), played.join(','));
    assert.ok(!played.includes('hazard'), 'never the hazard’s thud');
    assert.deepEqual(hazards, [], 'no hazard event');
    assert.equal(view.state.status, 'playing');
    // the step dust lies where the explorer is, in the layer's CSS pixels
    const s = cssW / level.picture.width;
    view.fx.clear();
    view.fx.burst('dust', ...view.state.pos);
    const p = view.fx.parts[0];
    assert.ok(Math.abs(p.x - view.state.pos[0] * s) < 6 && Math.abs(p.y - view.state.pos[1] * s) < 6, `${p.x},${p.y} for ${view.state.pos}`);
    view.destroy();
    assert.equal(layer.parentNode, null);
  } finally {
    clearListeners();
    Renderer.prototype.draw = draw;
    Object.assign(globalThis, saved);
  }
});
