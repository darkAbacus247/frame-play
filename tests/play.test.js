import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRoom } from '../src/rooms.js';
import { buildLevel, inputFromRoom } from '../src/level.js';
import { sampleField } from '../src/distance.js';
import {
  createRound, stepRound, walkToObject, walkToPoint, moveWithCollision, nextGoal, routeRatio, objectAt, blockedWords,
} from '../src/play.js';
import { makeRng } from '../src/rng.js';

const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
const { level, rt } = buildLevel(inputFromRoom(room, '2026-10-26T17:00:00Z'));
const idx = (id) => level.objects.findIndex((o) => o.id === id);
const F = (x, y) => sampleField(rt.nav.field, rt.W, rt.H, x, y);

function runUntilIdle(state, max = 4000, log = []) {
  for (let t = 0; t < max && state.auto && state.status === 'playing'; t++) {
    for (const e of stepRound(state, level, rt, {})) log.push(e);
  }
  return log;
}

function playThrough() {
  const state = createRound(level, rt);
  const log = [];
  for (const id of level.proof.order) {
    const res = walkToObject(state, level, rt, idx(id));
    assert.ok(res.ok, res.reason);
    runUntilIdle(state, 4000, log);
    if (state.status !== 'playing') break;
  }
  return { state, log };
}

test('a scripted run collects every coin, unlocks the box and wins', () => {
  const { state, log } = playThrough();
  assert.equal(state.status, 'won');
  assert.equal(log.filter((e) => e.type === 'collect').length, 3);
  assert.equal(log.filter((e) => e.type === 'unlock').length, 1);
  assert.equal(log.filter((e) => e.type === 'win').length, 1);
  assert.equal(log.filter((e) => e.type === 'lose').length, 0);
  const ratio = state.travelled / level.proof.route_length;
  assert.ok(ratio > 0.85 && ratio < 1.3, `route ratio ${ratio}`);
  assert.ok(routeRatio(state, level) >= 1);
});

test('the same inputs always give the same run', () => {
  const a = playThrough().state, b = playThrough().state;
  assert.deepEqual([a.tick, a.pos, a.travelled, a.status], [b.tick, b.pos, b.travelled, b.status]);
});

test('steering never brings the explorer closer to a wall than its radius', () => {
  const rng = makeRng(99);
  let state = createRound(level, rt);
  let dir = [0, 0], rounds = 1;
  for (let t = 0; t < 8000; t++) {
    if (state.status !== 'playing') { state = createRound(level, rt); rounds++; }
    if (t % 25 === 0) {
      const a = rng() * Math.PI * 2;
      dir = [Math.cos(a), Math.sin(a)];
    }
    stepRound(state, level, rt, { dir });
    const [x, y] = state.pos;
    assert.ok(F(x, y) >= rt.p.radius - 1e-9, `tick ${t}: inside the clearance at ${x},${y}`);
    assert.equal(rt.walk[Math.floor(y) * rt.W + Math.floor(x)], 1, `tick ${t}: off the walk region`);
  }
});

test('no tunneling: a huge push stops at the wall', () => {
  const lamp = idx('lamp');
  const pos = [230, 386 + 16];
  assert.ok(F(pos[0], pos[1]) >= rt.p.radius);
  const res = moveWithCollision(rt, pos, 0, -300);
  assert.ok(res.blocked);
  assert.ok(pos[1] > 386, `went through the lamp base to ${pos}`);
  assert.ok(F(pos[0], pos[1]) >= rt.p.radius - 1e-9);
  // and steering into it names what blocked the way, once per contact
  const state = createRound(level, rt);
  state.pos = [230, 402];
  const bumps = [];
  for (let t = 0; t < 120; t++) for (const e of stepRound(state, level, rt, { dir: [0, -1] })) if (e.type === 'bump') bumps.push(e);
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].k, lamp);
  assert.equal(blockedWords(level, lamp, 'desk'), 'Blocked by the desk lamp');
});

test('the locked exit says how many are left; the hazard ends the round', () => {
  const state = createRound(level, rt);
  const log = [];
  assert.ok(walkToObject(state, level, rt, idx('box')).ok);
  runUntilIdle(state, 4000, log);
  const locked = log.find((e) => e.type === 'locked');
  assert.ok(locked && locked.left === 3);
  assert.equal(state.status, 'playing');
  // walk straight at the cactus pot
  const s2 = createRound(level, rt);
  s2.pos = [852, 580];
  let lose = null;
  for (let t = 0; t < 600 && s2.status === 'playing'; t++) {
    for (const e of stepRound(s2, level, rt, { dir: [0, -1] })) if (e.type === 'lose') lose = e;
  }
  assert.equal(s2.status, 'lost');
  assert.equal(lose.k, idx('cactus'));
  // a lost round takes no more steps
  assert.deepEqual(stepRound(s2, level, rt, { dir: [1, 0] }), []);
});

test('a path arrives, and steering cancels it', () => {
  const state = createRound(level, rt);
  const res = walkToPoint(state, level, rt, 520, 560);
  assert.ok(res.ok && !res.snapped);
  const log = runUntilIdle(state);
  assert.ok(log.some((e) => e.type === 'arrive'));
  assert.ok(Math.hypot(state.pos[0] - 520, state.pos[1] - 560) < 0.5);
  assert.ok(walkToPoint(state, level, rt, 300, 640).ok);
  stepRound(state, level, rt, {});
  const ev = stepRound(state, level, rt, { dir: [1, 0] });
  assert.ok(ev.some((e) => e.type === 'cancel'));
  assert.equal(state.auto, null);
});

test('taps: an object walks to it; the hazard is refused in words', () => {
  const state = createRound(level, rt);
  assert.equal(objectAt(level, rt, 600, 440), idx('mug'));
  assert.equal(objectAt(level, rt, 655, 436), -1, 'the mug handle hole is open');
  const r1 = walkToPoint(state, level, rt, 850, 400);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'Too close to the cactus');
  const r2 = walkToPoint(state, level, rt, 852, 520);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'Too close to the cactus');
  const r3 = walkToPoint(state, level, rt, 600, 440);
  assert.ok(r3.ok);
  assert.equal(r3.k, idx('mug'));
  assert.equal(nextGoal(state, level), idx(level.proof.order[0]));
});
