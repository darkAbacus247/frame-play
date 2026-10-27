// A round holds still while a card or the settings drawer is open: a walk
// under them never ends the round, so an end card can never take the place
// of the Start over card. The real board (src/game.js) on tests/fakedom.js,
// its frames pumped by hand; then the page's own wiring (tests/apphost.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './fakedom.js';
import { el } from '../src/ui.js';
import { loadRoom } from '../src/rooms.js';
import { buildLevel, inputFromRoom } from '../src/level.js';
import { nextGoal } from '../src/play.js';
import { Renderer } from '../src/render.js';

test('the board takes no step while paused, and goes on where it was after', async () => {
  const doc = installFakeDocument();
  doc.body.append(el('div', { id: 'tips' }));
  let frames = [];
  const saved = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, ResizeObserver: globalThis.ResizeObserver, Path2D: globalThis.Path2D };
  Object.assign(globalThis, {
    // a path that draws nothing, as the fake page's canvases do
    Path2D: class { constructor() { return new Proxy(this, { get: (o, k) => (k in o ? o[k] : () => {}) }); } },
    requestAnimationFrame: (f) => { frames.push(f); return frames.length; },
    cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  // the round is what is tested here, not its picture
  const draw = Renderer.prototype.draw;
  Renderer.prototype.draw = () => {};
  try {
    const { mountPlay } = await import('../src/game.js');
    const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
    const { level, rt } = buildLevel(inputFromRoom(room));
    let paused = false;
    const ends = [];
    const root = el('main', {});
    doc.body.append(root);
    const view = mountPlay(root, { level, rt, picture: doc.createElement('canvas'), say: () => {}, ui: () => ({}), paused: () => paused, onEnd: (r) => ends.push(r) });
    let t = 1000;
    const pump = (seconds) => {
      for (let i = 0; i < seconds * 60; i++) {
        const run = frames;
        frames = [];
        t += 1000 / 60;
        for (const f of run) f(t);
      }
    };
    pump(0.1);
    view.walkTo(nextGoal(view.state, level));
    pump(0.5);
    const moved = view.state.travelled;
    assert.ok(moved > 0, 'the walk is under way');
    paused = true;
    pump(60);
    assert.equal(view.state.travelled, moved, 'not one step while paused');
    assert.equal(ends.length, 0);
    assert.equal(view.state.status, 'playing');
    paused = false;
    pump(1);
    assert.ok(view.state.travelled > moved, 'the walk goes on once the card closes');
    view.destroy();
  } finally {
    Renderer.prototype.draw = draw;
    Object.assign(globalThis, saved);
  }
});

test('the page holds the round while a card or the settings drawer is open', async () => {
  const { bootApp } = await import('./apphost.js');
  const { played } = await import('./stub_game.js');
  const road = { v: 3, step: 4, reached: 4, consent: true, own: null, rooms: [{ kind: 'sample', id: 'desk' }, null, null], finished: [false, false, false], best: [null, null, null] };
  const app = await bootApp({ mode: 'mock', road });
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 4);
  const { paused } = played.last;
  assert.equal(paused(), false, 'playing');
  const dock = () => app.$('dock').querySelectorAll('button');
  dock()[0].click(); // Settings
  assert.equal(paused(), true, 'the settings drawer is open');
  app.$('drawer').querySelectorAll('button').find((b) => b.textContent === 'Start over from Step 1').click();
  assert.ok(app.cardOpen(), 'Start over?');
  dock()[0].click(); // the drawer closes; the card stays
  assert.equal(paused(), true, 'the Start over card is open');
  app.cardPrimary().click(); // Keep my road
  assert.equal(paused(), false, 'back to the round');
});
