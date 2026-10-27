// W1b: walls collide, doors connect. On a floor that fences the play area,
// no input (keys, the pad, a tap, a walk-to chip) puts the explorer on a
// wall or off the floor; a path to another room goes through its doorway;
// a goal behind walls with no doorway is not reachable, and the proof, the
// repairs and the tap say so. Show walls draws the floor and its doorways.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRoom } from '../src/rooms.js';
import { pointInShape } from '../src/geom.js';
import { buildLevel, inputFromRoom, validateLevel } from '../src/level.js';
import { sampleField } from '../src/distance.js';
import { findPath, cellOf } from '../src/nav.js';
import { createRound, stepRound, walkToPoint, walkToObject, blockedWords } from '../src/play.js';
import { drawPlan } from '../src/render.js';
import { makeRng } from '../src/rng.js';
import { PLAN_DOORS, planJson, roomAt } from './plan.js';

const CREATED = '2026-10-27T12:00:00Z';
const OBJECTS = [
  { id: 'gem', name: 'gem', role: 'collect', reason: 'Shiny', shape: { ellipse: [90, 90, 9, 9] }, paint: '#e9c23a' },
  { id: 'coin', name: 'coin', role: 'collect', reason: 'Shiny', shape: { ellipse: [500, 150, 9, 9] }, paint: '#e9c23a' },
  { id: 'table', name: 'table', role: 'solid', reason: 'In the way', shape: { rect: [150, 120, 80, 50] }, paint: '#5b3b22' },
  { id: 'door', name: 'door', role: 'exit', reason: 'Out', shape: { rect: [60, 400, 60, 20] }, paint: '#3f7a4c' },
];

function planLevel(objects = OBJECTS, doors) {
  const room = loadRoom(planJson(objects, doors));
  return buildLevel(inputFromRoom(room, CREATED));
}

const onFloor = (pos, doors) => roomAt(pos[0], pos[1], doors) !== null;

test('the plan is winnable from a start on the floor, through both doorways', () => {
  const { level, rt, error } = planLevel();
  assert.ok(!error, error);
  assert.deepEqual(level.changes_by_code, []);
  assert.equal(level.view, 'top_down');
  assert.equal(level.surface.rooms, 3);
  assert.equal(level.surface.doorways.length, 2);
  assert.ok(onFloor(level.start), `start ${level.start}`);
  assert.equal(rt.nav.pass[cellOf(rt.nav, ...level.start)], 1);
  assert.ok(level.proof.winnable);
  // the route visits the wood room, so it passes both doorways
  const rooms = new Set(level.proof.route.map(([x, y]) => roomAt(x, y)));
  for (const r of ['wood', 'tile', 'carpet']) assert.ok(rooms.has(r), `the route reaches the ${r} room`);
});

test('no input puts the explorer on a wall or off the floor', () => {
  const { level, rt } = planLevel();
  const rnd = makeRng(1027);
  let state = createRound(level, rt);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let dir = [0, 0];
  let prev = roomAt(...state.pos), door = null;
  const JOINS = { woodTile: ['wood', 'tile'], tileCarpet: ['tile', 'carpet'] };
  const seen = new Set([prev]);
  const crossings = new Set();
  let taps = 0, refused = 0;
  for (let t = 0; t < 12000; t++) {
    if (state.status !== 'playing') {
      // a new round starts back at the start
      state = createRound(level, rt);
      prev = roomAt(...state.pos);
      door = null;
    }
    const roll = rnd();
    if (t % 25 === 0) {
      if (roll < 0.55) dir = DIRS[Math.floor(rnd() * 8)];
      else if (roll < 0.85) {
        // a tap anywhere in the picture: on a wall, outside, in any room
        dir = [0, 0];
        taps++;
        if (!walkToPoint(state, level, rt, rnd() * 640, rnd() * 480).ok) refused++;
      } else {
        dir = [0, 0];
        walkToObject(state, level, rt, Math.floor(rnd() * level.objects.length));
      }
    }
    stepRound(state, level, rt, { dir });
    const [x, y] = state.pos;
    assert.ok(sampleField(rt.nav.field, rt.W, rt.H, x, y) >= rt.p.radius - 1e-6, `tick ${t}: inside a wall's clearance at ${x},${y}`);
    const here = roomAt(x, y);
    assert.ok(here !== null, `tick ${t}: off the floor at ${x},${y}`);
    if (here === 'door') {
      door = x < 330 && y < 240 ? 'woodTile' : 'tileCarpet';
      crossings.add(door);
    } else {
      if (here !== prev) {
        // a new room: only through a doorway, and only one that joins them
        assert.ok(door && JOINS[door].includes(prev) && JOINS[door].includes(here), `tick ${t}: from the ${prev} room to the ${here} room through ${door || 'no doorway'}`);
      }
      prev = here;
      door = null;
    }
    seen.add(here);
  }
  assert.ok(seen.has('wood') && seen.has('tile') && seen.has('carpet'), `the explorer got around: ${[...seen]}`);
  assert.deepEqual([...crossings].sort(), ['tileCarpet', 'woodTile']);
  assert.ok(taps > 50 && refused < taps);
});

test('at eye level too: holding any direction never walks off the desk top', () => {
  const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
  const { level, rt } = buildLevel(inputFromRoom(room, CREATED));
  for (const dir of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const state = createRound(level, rt);
    for (let t = 0; t < 600 && state.status === 'playing'; t++) {
      stepRound(state, level, rt, { dir });
      assert.ok(pointInShape(state.pos[0], state.pos[1], room.surface.rings), `${dir}: off the desk at ${state.pos}`);
    }
  }
});

test('a path to another room goes through its doorway', () => {
  const { rt } = planLevel();
  // from the carpet room's far left to the wood room: no doorway between them
  const res = findPath(rt.nav, 60, 300, 60, 200);
  assert.ok(res && !res.snapped);
  const through = new Set();
  for (let i = 1; i < res.points.length; i++) {
    const [ax, ay] = res.points[i - 1], [bx, by] = res.points[i];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let s = 0; s <= n; s++) {
      const x = ax + ((bx - ax) * s) / n, y = ay + ((by - ay) * s) / n;
      assert.ok(roomAt(x, y) !== null, `the path leaves the floor at ${x},${y}`);
      for (const [d, [dx, dy, w, h]] of Object.entries(PLAN_DOORS)) if (x >= dx && x < dx + w && y >= dy && y < dy + h) through.add(d);
    }
  }
  assert.deepEqual([...through].sort(), ['tileCarpet', 'woodTile'], 'through the tile room: both doorways');
  // the long way round: much longer than the straight line through the wall
  assert.ok(res.length > 600, `length ${res.length}`);
});

test('a goal behind walls with no doorway is not reachable, and every word says so', () => {
  // the tile room's doorway to the carpet room is walled up: the carpet
  // room (with the start's lowest fifth and the exit) is sealed off
  const sealed = [...OBJECTS.slice(0, 3), { ...OBJECTS[3], shape: { rect: [500, 150, 40, 30] } }, { id: 'ring', name: 'ring', role: 'collect', reason: 'Lost', shape: { ellipse: [300, 380, 9, 9] }, paint: '#e9c23a' }];
  const { level, rt, error } = planLevel(sealed, ['woodTile']);
  assert.ok(!error, error);
  assert.ok(level.changes_by_code.some((c) => c.what === 'The ring is solid' && c.why === 'Out of reach: behind walls with no doorway'), JSON.stringify(level.changes_by_code));
  assert.notEqual(roomAt(...level.start, ['woodTile']), 'carpet', 'the start is where the goals are');
  const state = createRound(level, rt);
  assert.deepEqual(walkToPoint(state, level, rt, 300, 330), { ok: false, reason: 'No doorway leads there' });
  const k = level.objects.findIndex((o) => o.id === 'ring');
  assert.deepEqual(walkToObject(state, level, rt, k), { ok: false, reason: 'No doorway leads to the ring' });
  // a tap on the wall itself still walks to the nearest point this side
  assert.equal(walkToPoint(state, level, rt, 321, 60).ok, true);
  // the proof, recomputed from a level that still asks for the ring
  const asked = JSON.parse(JSON.stringify(level));
  asked.objects[k].role = 'collect';
  const v = validateLevel(asked);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0], 'Out of reach: ring (behind walls with no doorway)');
});

test('an exit behind walls hands over, and says why; a room with every goal walled off is no level', () => {
  const exitSealed = planLevel([...OBJECTS.slice(0, 3), OBJECTS[3]], ['woodTile']);
  assert.ok(!exitSealed.error, exitSealed.error);
  assert.ok(exitSealed.level.changes_by_code.some((c) => c.why === 'The door is behind walls with no doorway'), JSON.stringify(exitSealed.level.changes_by_code));
  // the exit (carpet), the coin (tile) and a vase (wood), each in a room of its own
  const none = planLevel([OBJECTS[3], OBJECTS[1], { id: 'vase', name: 'vase', role: 'solid', reason: 'x', shape: { ellipse: [100, 100, 9, 9] }, paint: '#2255aa' }], []);
  assert.match(none.error, /walls with no doorway stand in the way/);
});

test('a bump against a wall seen from above says a wall', () => {
  const { level, rt } = planLevel();
  const state = createRound(level, rt);
  state.pos = [60, 60];
  const events = [];
  for (let t = 0; t < 60; t++) events.push(...stepRound(state, level, rt, { dir: [-1, -1] }));
  const bump = events.find((e) => e.type === 'bump');
  assert.deepEqual(bump, { type: 'bump', k: -1, wall: true });
  assert.equal(blockedWords(level, -1, 'floor', bump.wall), 'Blocked by a wall');
  assert.equal(blockedWords(level, -1, 'floor'), 'Blocked by the edge of the floor');
});

test('Show walls draws the floor’s outline and its doorways where the floor fences the play area', () => {
  const { level } = planLevel();
  const ops = drawPlan(level, level.start, { walls: true }).map((s) => s.op);
  assert.deepEqual(ops.slice(0, 3), ['picture', 'walls', 'floor']);
  assert.ok(!drawPlan(level, level.start, {}).some((s) => s.op === 'floor'), 'only with Show walls on');
  assert.ok(drawPlan(level, level.start, { walls: true, explorer: false }).some((s) => s.op === 'floor'), 'on the reveal too');
  // a live room with a surface box only keeps to the horizon: no floor drawn
  const live = buildLevel({
    origin: 'live', picture: { kind: 'photo', sha256: 'x', width: 640, height: 480 }, title: 'x',
    surface: { name: 'floor', rings: [[[0, 200], [640, 200], [640, 480], [0, 480]]], source: 'box' },
    objects: [['coin', 'collect', [300, 400, 320, 420]], ['box', 'exit', [100, 300, 160, 360]]].map(([name, role, b], k) => ({
      id: `o${k}`, name, role, reason: 'x', box: b, outline: { source: 'box', rings: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]] }, on_surface: true,
    })),
    provenance: { created: CREATED },
  });
  assert.ok(!live.error, live.error);
  assert.equal(live.level.surface.doorways, undefined);
  assert.ok(!drawPlan(live.level, live.level.start, { walls: true }).some((s) => s.op === 'floor'));
});
