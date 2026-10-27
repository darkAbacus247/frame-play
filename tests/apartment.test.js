// W1d: The Apartment, a floor plan drawn by code: four rooms joined by
// three doorways, walls between them, a coin in each of three rooms, the
// exit in yet another, obstacles and a hazard. MOCK shows its walls and
// doorways; the stand-in answers for it in SAM's own grammar, so REHEARSAL
// rehearses it; the golden replay pins what the page makes of that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLevel, inputFromRoom, validateLevel } from '../src/level.js';
import { findPath, cellOf } from '../src/nav.js';
import { sampleField } from '../src/distance.js';
import { createRound, stepRound, walkToPoint } from '../src/play.js';
import { drawPlan } from '../src/render.js';
import { fillRings } from '../src/raster.js';
import { makeRng } from '../src/rng.js';
import { GOLDEN, apartment, levelSummary, replayApartment } from './golden_apartment.js';

const CREATED = '2026-10-27T12:00:00Z';
// the room file's rooms and doorways, as rectangles [x, y, w, h]
const ROOMS = { living: [54, 54, 466, 366], kitchen: [534, 54, 436, 326], bedroom: [534, 394, 436, 320], hall: [54, 434, 466, 280] };
const DOORS = { livingKitchen: [520, 180, 14, 64], kitchenBedroom: [700, 380, 64, 14], livingHall: [200, 420, 64, 14] };
const inRect = (x, y, [rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h;
const roomOf = (x, y) => Object.keys(ROOMS).find((r) => inRect(x, y, ROOMS[r])) || (Object.keys(DOORS).some((d) => inRect(x, y, DOORS[d])) ? 'door' : null);

const room = apartment();
const mock = buildLevel(inputFromRoom(room, CREATED));

test('The Apartment can be won as drawn: four rooms, three doorways, walls between', () => {
  assert.ok(!mock.error, mock.error);
  const { level, rt } = mock;
  assert.equal(level.title, 'The Apartment');
  assert.equal(level.view, 'top_down');
  assert.deepEqual(level.changes_by_code, []);
  assert.ok(level.proof.winnable);
  assert.equal(level.surface.rooms, 4);
  assert.equal(level.surface.doorways.length, 3);
  for (const [name, [x, y, w, h]] of Object.entries(DOORS)) {
    assert.ok(level.surface.doorways.some((d) => Math.abs(d.x - (x + w / 2)) < 8 && Math.abs(d.y - (y + h / 2)) < 8 && d.width === 64), `${name}: ${JSON.stringify(level.surface.doorways)}`);
  }
  // the walls between the rooms, and the outside, are never walked
  const at = (x, y) => rt.walk[y * rt.W + x];
  for (const [x, y] of [[527, 100], [527, 300], [600, 387], [400, 427], [527, 600], [20, 20], [47, 300], [1000, 760]]) assert.equal(at(x, y), 0, `wall at ${x},${y}`);
  for (const [name, [x, y, w, h]] of Object.entries(DOORS)) assert.equal(at(x + (w >> 1), y + (h >> 1)), 1, `${name} is open`);
  // seen from above, every thing blocks its whole outline; the rug is walked over
  assert.equal(at(260, 225), 0, 'the coffee table');
  assert.equal(at(205, 160), 1, 'the rug');
  assert.equal(level.provenance.floor.words, 'The play area is the floor as code drew it; everything else is wall.');
  room.objects.forEach((o, k) => assert.deepEqual(level.objects[k].outline.rings, o.rings), 'outlines are the painted shapes');
  assert.ok(validateLevel(JSON.parse(JSON.stringify(level))).ok);
});

test('coins in three rooms, the exit in a fourth from the start, an obstacle or two and a hazard', () => {
  const { level } = mock;
  const where = (id) => {
    const b = level.objects.find((o) => o.id === id).box;
    return roomOf((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
  };
  assert.deepEqual(level.rules.collect.map(where).sort(), ['bedroom', 'kitchen', 'living']);
  assert.equal(where(level.rules.exit), 'bedroom');
  assert.equal(roomOf(...level.start), 'hall', 'the start is in the hall');
  assert.deepEqual(level.rules.avoid, ['cactus']);
  assert.ok(level.objects.filter((o) => o.role === 'solid').length >= 2);
  assert.equal(level.objects.filter((o) => o.name === 'chair').length, 2);
  // the shortest route goes hall, living room, kitchen, bedroom: every doorway
  const seen = [];
  for (const [x, y] of level.proof.route) {
    const r = roomOf(x, y);
    if (r && r !== 'door' && r !== seen[seen.length - 1]) seen.push(r);
  }
  assert.deepEqual(seen, ['hall', 'living', 'kitchen', 'bedroom']);
});

test('in the apartment no input crosses a wall: the bedroom is reached through the kitchen only', () => {
  const { level, rt } = mock;
  // from the hall straight to the bedroom, beside it through the wall: the long way round
  const res = findPath(rt.nav, 480, 600, 580, 600);
  assert.ok(res && !res.snapped);
  const through = new Set();
  for (const [x, y] of res.points) through.add(roomOf(x, y));
  assert.ok(res.length > 900, `length ${res.length}: through the living room and the kitchen`);
  const rnd = makeRng(2710);
  let state = createRound(level, rt);
  let prev = roomOf(...state.pos), door = false;
  const ok = new Set(['hall|living', 'living|hall', 'living|kitchen', 'kitchen|living', 'kitchen|bedroom', 'bedroom|kitchen']);
  for (let t = 0; t < 6000; t++) {
    if (state.status !== 'playing') { state = createRound(level, rt); prev = roomOf(...state.pos); door = false; }
    if (t % 30 === 0) walkToPoint(state, level, rt, rnd() * 1024, rnd() * 768);
    const dir = t % 30 < 15 ? [0, 0] : [Math.round(rnd() * 2 - 1), Math.round(rnd() * 2 - 1)];
    stepRound(state, level, rt, { dir });
    const [x, y] = state.pos;
    assert.ok(sampleField(rt.nav.field, rt.W, rt.H, x, y) >= rt.p.radius - 1e-6, `tick ${t}: in a wall at ${x},${y}`);
    const here = roomOf(x, y);
    assert.ok(here, `tick ${t}: off the floor at ${x},${y}`);
    if (here === 'door') { door = true; continue; }
    if (here !== prev) assert.ok(door && ok.has(`${prev}|${here}`), `tick ${t}: ${prev} to ${here}`);
    prev = here;
    door = false;
  }
  assert.equal(rt.nav.pass[cellOf(rt.nav, ...level.start)], 1);
});

test('MOCK shows the apartment’s walls and doorways', () => {
  const ops = drawPlan(mock.level, mock.level.start, { walls: true }).map((s) => s.op);
  assert.ok(ops.includes('walls') && ops.includes('floor'));
  assert.ok(ops.includes('stamp'), 'labelled MOCK');
});

test('golden replay: the apartment through the stand-in, in SAM’s own grammar, makes this room', { timeout: 120000 }, async () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const { reply, entry } = await replayApartment();
  assert.deepEqual(reply, golden.reply, 'the pipeline’s reply to the stand-in’s answers');
  assert.equal(entry.built.error, undefined, entry.built.error);
  const { level } = entry.built;
  assert.deepEqual(levelSummary(level), golden.level, 'the level the page made of it');
  // and what that golden says, in plain checks
  assert.equal(reply.provenance.mode, 'rehearsal');
  assert.deepEqual(reply.provenance.models, [], 'a rehearsal claims no model');
  assert.equal(reply.floor.view, 'top_down');
  assert.equal(reply.floor.boxes.length, 4, 'SAM’s floor: one match a room');
  assert.equal(reply.usage.sam_calls, 11, 'the floor and ten kinds of things: more than the old ceiling of 9');
  assert.equal(level.origin, 'rehearsal');
  assert.equal(level.surface.source, 'sam_mask', 'the stand-in’s floor mask is the play area');
  assert.equal(level.provenance.floor.words, 'The stand-in for SAM 3.1’s mask of the floor is the play area; everything else is wall.');
  assert.equal(level.surface.rooms, 4);
  assert.equal(level.surface.doorways.filter((d) => !d.exit).length, 3, 'three doorways between rooms');
  assert.equal(level.surface.doorways.filter((d) => d.exit).length, 1, 'and one where the floor meets the exit');
  assert.equal(level.objects.length, 13);
  assert.ok(level.objects.every((o) => o.outline.source === 'sam_mask'), 'every outline is the stand-in’s mask');
  assert.ok(reply.objects.every((o) => o.mask.decoded && o.mask.encoding === 'one_bit'));
  assert.equal(level.objects.filter((o) => o.name === 'chair').length, 2, 'both chairs');
  assert.deepEqual(level.changes_by_code, []);
  assert.ok(level.proof.winnable);
  assert.ok(Math.abs(level.proof.route_length - mock.level.proof.route_length) < 0.05 * mock.level.proof.route_length, `${level.proof.route_length} against MOCK ${mock.level.proof.route_length}`);
});

test('REHEARSAL: the apartment walks only on the stand-in’s floor mask, from room to room only through its doorways', { timeout: 120000 }, async () => {
  const { reply, entry } = await replayApartment();
  const { level, rt } = entry.built;
  const W = rt.W, H = rt.H;
  assert.equal(reply.floor.mask.matches, 4, 'the masks of four floor matches, one a room');
  const floor = fillRings(reply.floor.mask.rings, W, H);
  const rug = fillRings(level.objects.find((o) => o.name === 'rug').outline.rings, W, H);
  // nowhere off the floor mask (the rug, flat on the floor, is walked over)
  let off = 0;
  for (let i = 0; i < W * H; i++) if (rt.walk[i] && !floor[i] && !rug[i]) off++;
  assert.equal(off, 0, 'no walkable pixel off the floor mask');
  // the walls between rooms are walls: the floor mask is empty there
  for (const [x, y] of [[527, 100], [527, 300], [600, 387], [900, 387], [100, 427], [400, 427]]) {
    assert.equal(floor[y * W + x], 0, `a wall at ${x}, ${y}`);
    assert.equal(rt.walk[y * W + x], 0);
  }
  // and every doorway is open
  for (const [name, [x, y, w, h]] of Object.entries(DOORS)) {
    assert.equal(floor[Math.floor(y + h / 2) * W + Math.floor(x + w / 2)], 1, `${name} is floor`);
  }
  // the proof's route stays on the floor, and leaves a room only through a doorway
  const route = level.proof.route;
  assert.ok(route.length > 2);
  let prev = roomOf(...route[0]), door = false, crossings = 0;
  for (let k = 1; k < route.length; k++) {
    const [ax, ay] = route[k - 1], [bx, by] = route[k];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let t = 1; t <= n; t++) {
      const x = ax + ((bx - ax) * t) / n, y = ay + ((by - ay) * t) / n;
      const i = Math.floor(y) * W + Math.floor(x);
      assert.ok(floor[i] || rug[i], `the route leaves the floor mask at ${x.toFixed(1)}, ${y.toFixed(1)}`);
      const here = roomOf(x, y);
      assert.ok(here, `the route is in no room and no doorway at ${x.toFixed(1)}, ${y.toFixed(1)}`);
      if (here === 'door') { door = true; continue; }
      if (here !== prev) {
        assert.ok(door, `from the ${prev} to the ${here} without a doorway`);
        crossings++;
      }
      prev = here;
      door = false;
    }
  }
  assert.ok(crossings >= 3, 'the route goes through the rooms: coins in three of them, the exit in the bedroom');
  assert.equal(floor[Math.floor(level.start[1]) * W + Math.floor(level.start[0])], 1, 'the start is on the floor mask');
});
