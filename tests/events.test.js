// The event bus (src/events.js), and the play screen telling it what
// happens: the real board (src/game.js) on tests/fakedom.js, a round walked
// to its coins and the exit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { on, off, emit, listenerCount, clearListeners, EVENTS } from '../src/events.js';
import { installFakeDocument } from './fakedom.js';

test('the bus: on, emit with detail, off, and the count heard', () => {
  clearListeners();
  const got = [];
  const fn = (d, type) => got.push([type, d.k]);
  const stop = on('coin', fn);
  assert.equal(listenerCount('coin'), 1);
  assert.equal(emit('coin', { k: 3 }), 1);
  assert.equal(emit('step'), 0, 'nobody listens');
  stop();
  assert.equal(emit('coin', { k: 4 }), 0);
  on('coin', fn);
  off('coin', fn);
  assert.equal(listenerCount('coin'), 0);
  assert.deepEqual(got, [['coin', 3]]);
  assert.equal(emit('coin'), 0);
});

test('one failing listener never stops the others or the game', () => {
  clearListeners();
  const got = [];
  on('win', () => { throw new Error('broken'); });
  on('win', () => got.push('second'));
  assert.doesNotThrow(() => emit('win'));
  assert.deepEqual(got, ['second']);
  assert.equal(emit('win'), 1, 'only the listener that ran counts');
  clearListeners();
  assert.equal(listenerCount('win'), 0);
});

test('a listener added during an emit hears the next one, not this one', () => {
  clearListeners();
  const got = [];
  on('step', () => { got.push('a'); on('step', () => got.push('b')); });
  emit('step');
  assert.deepEqual(got, ['a']);
  clearListeners();
});

test('the game events are emitted from src/game.js and nowhere else', () => {
  for (const e of ['step', 'coin', 'hazard', 'exit', 'win', 'lose', 'reveal']) assert.ok(EVENTS.includes(e), e);
  const game = readFileSync(new URL('../src/game.js', import.meta.url), 'utf8');
  for (const e of ['step', 'coin', 'hazard', 'exit', 'win', 'lose', 'reveal']) assert.match(game, new RegExp(`emit\\('${e}'`), e);
  const files = ['app.js', ...readdirSync(new URL('../src/', import.meta.url)).map((f) => `src/${f}`)];
  for (const f of files) {
    if (f === 'src/game.js') continue;
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /emit\('(step|coin|hazard|exit|win|lose|reveal)'/, f);
  }
  // the rules stay where they were: play.js and level.js know nothing of it
  for (const f of ['src/play.js', 'src/level.js']) assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /events\.js/);
});

test('a round tells the bus its steps, each coin, the exit opening and the win', async () => {
  const doc = installFakeDocument();
  const { el } = await import('../src/ui.js');
  const { loadRoom } = await import('../src/rooms.js');
  const { buildLevel, inputFromRoom } = await import('../src/level.js');
  const { Renderer } = await import('../src/render.js');
  doc.body.append(el('div', { id: 'tips' }));
  let frames = [];
  const saved = {};
  for (const k of ['requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'Path2D']) saved[k] = globalThis[k];
  Object.assign(globalThis, {
    Path2D: class { constructor() { return new Proxy(this, { get: (o, k) => (k in o ? o[k] : () => {}) }); } },
    requestAnimationFrame: (f) => { frames.push(f); return frames.length; },
    cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  const draw = Renderer.prototype.draw;
  Renderer.prototype.draw = () => {};
  clearListeners();
  const heard = [];
  for (const e of ['step', 'coin', 'hazard', 'exit', 'win', 'lose']) on(e, (d, type) => heard.push([type, d]));
  try {
    const { mountPlay } = await import('../src/game.js');
    const { nextGoal } = await import('../src/play.js');
    const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
    const { level, rt } = buildLevel(inputFromRoom(room));
    const root = el('main', {});
    doc.body.append(root);
    const modes = [];
    const audio = { play() {}, musicMode: (m) => modes.push(m) };
    const ends = [];
    const view = mountPlay(root, { level, rt, picture: doc.createElement('canvas'), audio, say: () => {}, ui: () => ({ reducedMotion: true }), onEnd: (r) => ends.push(r) });
    assert.deepEqual(modes, ['play'], 'the music turns softer for the round');
    let t = 1000;
    for (let i = 0; i < 60 * 120 && !ends.length; i++) {
      if (!view.state.auto) view.walkTo(nextGoal(view.state, level));
      const run = frames; frames = []; t += 1000 / 60;
      for (const f of run) f(t);
    }
    assert.equal(ends.length, 1);
    assert.equal(ends[0].status, 'won');
    const types = heard.map(([type]) => type);
    const coins = level.objects.filter((o) => o.role === 'collect').length;
    assert.equal(types.filter((x) => x === 'coin').length, coins, 'every coin');
    assert.ok(types.filter((x) => x === 'step').length > 5, 'the steps');
    assert.equal(types.filter((x) => x === 'exit').length, 1);
    assert.equal(types.at(-1), 'win');
    assert.ok(!types.includes('lose') && !types.includes('hazard'));
    assert.ok(types.indexOf('exit') > types.lastIndexOf('coin'), 'the exit opens after the last coin');
    const coin = heard.find(([type]) => type === 'coin')[1];
    assert.equal(level.objects[coin.k].role, 'collect');
    assert.equal(modes.at(-1), 'calm', 'and calm again once it ends');
    view.destroy();
  } finally {
    Renderer.prototype.draw = draw;
    Object.assign(globalThis, saved);
    clearListeners();
  }
});
