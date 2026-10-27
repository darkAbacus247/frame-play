// The particles (src/fx.js): capped, idle when nothing is alive, gone with
// reduced motion, and on their own layer that never sizes the board or the
// page. Then the real board (src/game.js) on tests/fakedom.js: the layer
// lies over the board at the board's size, and a round's coin sparkles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './fakedom.js';
import { Fx, FX_CAP, BURST, alongRings } from '../src/fx.js';

function board(doc) {
  const c = doc.createElement('canvas');
  c.style.width = '400px';
  c.style.height = '300px';
  c.width = 800;
  c.height = 600;
  return c;
}

function handFrames() {
  const q = [];
  let t = 0;
  return {
    raf: (f) => { q.push(f); return q.length; },
    caf: () => {},
    pending: () => q.length,
    pump(n = 1) { for (let i = 0; i < n; i++) { const run = q.splice(0); t += 1000 / 60; for (const f of run) f(t); } },
  };
}

test('the layer is laid over the board at its size and never sizes the board', () => {
  const doc = installFakeDocument();
  const b = board(doc);
  const before = JSON.stringify([b.style, b.width, b.height]);
  const fr = handFrames();
  const fx = new Fx(b, { width: 1000, height: 750 }, fr);
  fx.fit(400, 300, 2);
  assert.equal(fx.layer.tagName, 'CANVAS');
  assert.equal(fx.layer.className, 'fx-layer');
  assert.equal(fx.layer.getAttribute('aria-hidden'), 'true');
  assert.deepEqual([fx.layer.style.width, fx.layer.style.height, fx.layer.width, fx.layer.height], ['400px', '300px', 800, 600]);
  for (const k of ['coin', 'exit', 'hazard', 'dust', 'win']) fx.burst(k, 500, 400);
  fx.burst('trace', 0, 0, { rings: [[[0, 0], [1000, 0], [1000, 750], [0, 750]]] });
  fr.pump(200);
  assert.equal(JSON.stringify([b.style, b.width, b.height]), before, 'the board is untouched');
  assert.deepEqual(Object.keys(fx.layer.style).sort(), ['height', 'width'], 'the layer sets only its own size');
});

test('counts are capped and every burst is small', () => {
  installFakeDocument();
  const fr = handFrames();
  const fx = new Fx(board(document), { width: 1000, height: 750 }, fr);
  fx.fit(400, 300, 1);
  for (let i = 0; i < 10; i++) fx.burst('win');
  assert.equal(fx.parts.length, FX_CAP);
  assert.equal(fx.burst('coin', 1, 1), 0, 'full: nothing more');
  assert.ok(Object.values(BURST).every((n) => n <= FX_CAP / 2));
  assert.equal(fx.burst('nonsense', 1, 1), 0);
});

test('nothing runs while nothing is alive', () => {
  installFakeDocument();
  const fr = handFrames();
  const fx = new Fx(board(document), { width: 1000, height: 750 }, fr);
  fx.fit(400, 300, 1);
  assert.equal(fr.pending(), 0);
  fx.burst('coin', 500, 400);
  fx.burst('coin', 500, 400);
  assert.equal(fr.pending(), 1, 'one loop, however many bursts');
  fr.pump(120); // two seconds
  assert.equal(fx.parts.length, 0, 'the sparkles are spent');
  assert.equal(fr.pending(), 0, 'and the loop stopped');
  // a long stall moves particles a bounded step, not all at once
  fx.burst('dust', 500, 400);
  const p = fx.parts[0];
  const y0 = p.y;
  fx.step(30);
  assert.ok(Math.abs(p.y - y0) < 5);
});

test('reduced motion: no particles at all, and live ones go at once', () => {
  installFakeDocument();
  const fr = handFrames();
  let reduced = true;
  const fx = new Fx(board(document), { width: 1000, height: 750 }, { ...fr, reduced: () => reduced });
  fx.fit(400, 300, 1);
  for (const k of ['coin', 'exit', 'hazard', 'dust', 'win']) assert.equal(fx.burst(k, 10, 10), 0, k);
  assert.equal(fx.burst('trace', 0, 0, { rings: [[[0, 0], [10, 0], [10, 10]]] }), 0);
  assert.equal(fr.pending(), 0);
  reduced = false;
  assert.ok(fx.burst('win') > 0);
  reduced = true;
  fr.pump(1);
  assert.equal(fx.parts.length, 0);
  assert.equal(fr.pending(), 0);
});

test('particles follow the board when it is resized, and go with it', () => {
  const doc = installFakeDocument();
  const fr = handFrames();
  const b = board(doc);
  const host = doc.createElement('div');
  const fx = new Fx(b, { width: 1000, height: 750 }, fr);
  host.append(b, fx.layer);
  fx.fit(400, 300, 1);
  fx.burst('dust', 500, 375);
  assert.equal(Math.round(fx.parts[0].y), 150, 'picture pixels to CSS pixels');
  fx.fit(800, 600, 1);
  assert.equal(Math.round(fx.parts[0].y), 300);
  fx.destroy();
  assert.equal(host.children.length, 1, 'the layer leaves with the board');
  assert.equal(fx.burst('coin', 1, 1), 0);
});

test('a trace runs evenly along an outline', () => {
  const pts = alongRings([[[0, 0], [100, 0], [100, 100], [0, 100]]], 8);
  assert.equal(pts.length, 8);
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[2], [100, 0]);
  assert.deepEqual(pts[4], [100, 100]);
  assert.deepEqual(alongRings([], 5), []);
});

test('the stylesheet keeps the layer out of the flow and under no pointer', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const rule = (sel) => { const m = new RegExp(`(^|\\n)${sel.replace(/[.*]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css); return m ? m[2] : ''; };
  assert.match(rule('.fx-layer'), /position:\s*absolute/);
  assert.match(rule('.fx-layer'), /pointer-events:\s*none/);
  assert.doesNotMatch(rule('.fx-layer'), /width|height|margin|padding/, 'its size comes from the board, in code');
  assert.match(rule('.fx-host'), /position:\s*relative/);
  assert.match(rule('.rm .fx-layer'), /display:\s*none/);
  assert.match(css, /\.game \{ position: relative;/, 'the play board already holds it');
});

test('the real board: the layer lies over it at its size, a coin sparkles, and reduced motion keeps it still', async () => {
  const doc = installFakeDocument();
  const { el } = await import('../src/ui.js');
  doc.body.append(el('div', { id: 'tips' }));
  const { loadRoom } = await import('../src/rooms.js');
  const { buildLevel, inputFromRoom } = await import('../src/level.js');
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
  try {
    const { mountPlay } = await import('../src/game.js');
    const { nextGoal } = await import('../src/play.js');
    const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
    const { level, rt } = buildLevel(inputFromRoom(room));
    for (const reduced of [false, true]) {
      frames = [];
      const root = el('main', {});
      doc.body.replaceChildren(el('div', { id: 'tips' }), root);
      const view = mountPlay(root, { level, rt, picture: doc.createElement('canvas'), say: () => {}, ui: () => ({ reducedMotion: reduced }), onEnd: () => {} });
      const game = root.querySelector('.game');
      const [canvas, layer] = game.children;
      assert.equal(layer, view.fx.layer);
      assert.equal(layer.className, 'fx-layer');
      observers.at(-1).cb();
      assert.match(canvas.style.width, /^\d+px$/, 'the board was sized');
      assert.deepEqual([layer.style.width, layer.style.height], [canvas.style.width, canvas.style.height], 'the layer matches it');
      let t = 1000, seen = 0;
      const pump = (n) => {
        for (let i = 0; i < n; i++) {
          const run = frames; frames = []; t += 1000 / 60;
          for (const f of run) f(t);
          seen = Math.max(seen, view.fx.parts.length);
        }
      };
      pump(2);
      const got = () => view.state.collected.filter(Boolean).length;
      view.walkTo(nextGoal(view.state, level));
      for (let i = 0; i < 40 && got() === 0; i++) pump(30);
      assert.equal(got(), 1, 'a coin was collected');
      if (reduced) assert.equal(seen, 0, 'no particles with reduced motion');
      else assert.ok(seen >= BURST.coin, `the coin sparkled (${seen})`);
      view.destroy();
      assert.equal(layer.parentNode, null);
    }
  } finally {
    Renderer.prototype.draw = draw;
    Object.assign(globalThis, saved);
  }
});
