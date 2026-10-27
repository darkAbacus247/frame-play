// The floor you cannot see. The walkable region takes in the floor hidden
// behind and under the things standing on it, inferred from the floor that
// was seen (src/floor_mask.js hiddenFloor): the floor mask's holes and the
// slivers a mask leaves between a thing and the floor around it are filled,
// the floor's outer boundary away from things and the picture's edges stay
// walls, and only each thing's footprint is taken out (at eye level the band
// at its base; from above its outline). Proven on our kitchen's replay: a
// path runs around the whole island, and the explorer walks it by every
// input, hidden by the island while it is behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hiddenFloor, HIDDEN_SEAL } from '../src/floor_mask.js';
import { buildLevel, inputFromRoom, validateLevel } from '../src/level.js';
import { loadRoom } from '../src/rooms.js';
import { nearestPass, cellCenter, cellOf, findPath } from '../src/nav.js';
import { createRound, stepRound, walkToPoint, walkToObject } from '../src/play.js';
import { drawPlan } from '../src/render.js';
import { kitchenLevel } from './screenset.js';
import { replayApartment } from './golden_apartment.js';

// ---- the rule, on small pictures ----

const W = 60, H = 40;
const blank = () => new Uint8Array(W * H);
const rect = (m, x0, y0, x1, y1, v = 1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = v; return m; };

test('the floor’s holes are filled: floor hidden under a thing, or a thing no one named', () => {
  const floor = rect(rect(blank(), 2, 2, 58, 38), 20, 10, 30, 20, 0);
  const out = hiddenFloor(floor, blank(), W, H, false);
  assert.equal(out[15 * W + 25], 1, 'the hole is floor now');
  assert.equal(out[0], 0, 'the picture’s edge stays a wall');
  assert.equal(hiddenFloor(floor, blank(), W, H, true)[15 * W + 25], 1, 'from above too');
});

test('a sliver between a thing and the floor is closed; the floor’s outer boundary away from things stays a wall', () => {
  // the floor's top edge at y = 10; a thing standing on it from y = 4 to 22,
  // its mask leaving a 2 px sliver of nothing between it and the floor
  const floor = rect(rect(blank(), 0, 10, 60, 40), 18, 8, 34, 24, 0);
  const thing = rect(blank(), 20, 4, 32, 22);
  const out = hiddenFloor(floor, thing, W, H, false);
  assert.equal(out[15 * W + 18], 1, 'the sliver left of the thing');
  assert.equal(out[23 * W + 25], 1, 'the sliver under it');
  assert.equal(out[12 * W + 25], 1, 'the thing itself: the floor behind it');
  assert.equal(out[5 * W + 5], 0, 'above the floor, far from the thing: a wall');
  assert.equal(out[9 * W + 10], 0, 'just above the floor’s edge, away from the thing: a wall');
  assert.ok(HIDDEN_SEAL > 0 && HIDDEN_SEAL < 0.01, 'a seal of a few pixels, never a room’s width');
});

test('from above, a thing opens no wall: a rug over a wall stays a wall, and a wide gap is never closed', () => {
  // two rooms with a wall between (x 28 to 32) and a rug across it
  const floor = rect(rect(blank(), 2, 2, 28, 38), 32, 2, 58, 38);
  const rug = rect(blank(), 20, 15, 40, 25);
  const out = hiddenFloor(floor, rug, W, H, true);
  for (const x of [29, 30, 31]) assert.equal(out[5 * W + x], 0, `the wall at x ${x}, away from the rug`);
  // a thing in the middle of a wide opening: the opening is not filled beyond the seal
  const open = rect(blank(), 0, 20, 60, 40);
  const post = rect(blank(), 28, 10, 32, 30);
  const o2 = hiddenFloor(open, post, W, H, false);
  assert.equal(o2[2 * W + 5], 0);
});

// ---- the kitchen ----

const kitchen = kitchenLevel();
const v = validateLevel(JSON.parse(JSON.stringify(kitchen.level)));
const { level } = kitchen;
const rt = v.rt;
const island = level.objects.findIndex((o) => o.name === 'kitchen island');
const comp = rt.nav.comp[cellOf(rt.nav, ...level.start)];

// The explorer's free cells; the island's footprint is enclosed by them when
// no cell of it can be reached from the grid's border without crossing one
// (8-connected outside a 4-connected loop): then a loop of free cells runs
// around the whole island.
function enclosedByWalk(nav, compId, cells) {
  const { gw, gh } = nav;
  const seen = new Uint8Array(gw * gh);
  const stack = [];
  for (let i = 0; i < gw; i++) for (const j of [0, gh - 1]) stack.push(j * gw + i);
  for (let j = 0; j < gh; j++) for (const i of [0, gw - 1]) stack.push(j * gw + i);
  while (stack.length) {
    const c = stack.pop();
    if (seen[c] || nav.comp[c] === compId) continue;
    seen[c] = 1;
    const i = c % gw, j = (c - i) / gw;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ni = i + di, nj = j + dj;
      if ((di || dj) && ni >= 0 && nj >= 0 && ni < gw && nj < gh) stack.push(nj * gw + ni);
    }
  }
  return cells.every((c) => !seen[c]);
}

function footprintCells(k) {
  const fp = rt.objs[k].footprint;
  const out = new Set();
  for (let y = fp.bounds.y0; y < fp.bounds.y1; y++) for (let x = fp.bounds.x0; x < fp.bounds.x1; x++) if (fp.mask[y * rt.W + x]) out.add(cellOf(rt.nav, x + 0.5, y + 0.5));
  return [...out];
}

// four places around the island: in front, to its left, behind it, to its right
const spot = (x, y) => cellCenter(rt.nav, nearestPass(rt.nav, x, y, comp));
const AROUND = { front: spot(520, 345), left: spot(425, 262), behind: spot(520, 232), right: spot(640, 250) };
const LOOP = ['front', 'left', 'behind', 'right', 'front'];

test('the kitchen: the floor behind the island is walkable, and a loop of it runs around the whole island', () => {
  assert.ok(v.ok, 'the replayed kitchen is still won');
  assert.equal(level.surface.source, 'sam_mask');
  // the floor SAM could not see behind the island is floor now
  const [bx, by] = AROUND.behind;
  assert.ok(Math.hypot(bx - 520, by - 232) < 2 * rt.nav.cell, `the free cell behind the island is where it was asked for (${bx}, ${by})`);
  assert.ok(by < level.objects[island].baseline_y - rt.objs[island].footprint.depth, 'behind the island, above its footprint');
  assert.equal(rt.nav.comp[cellOf(rt.nav, bx, by)], comp, 'and reached from the start');
  for (const [name, [x, y]] of Object.entries(AROUND)) assert.equal(rt.nav.comp[cellOf(rt.nav, x, y)], comp, `${name} of the island is reached`);
  assert.ok(enclosedByWalk(rt.nav, comp, footprintCells(island)), 'the island’s footprint is ringed by floor the explorer reaches');
  // the island's footprint is still solid
  const fp = rt.objs[island].footprint;
  const mid = Math.floor((fp.bounds.y0 + fp.bounds.y1) / 2) * rt.W + Math.floor((fp.bounds.x0 + fp.bounds.x1) / 2);
  assert.equal(rt.walk[mid], 0);
});

// Steering as a player does: along the planned path, by the arrow keys (8
// directions), the on-screen pad (4 directions) or a stick (any direction).
function steerTo(state, target, quantize, maxSteps = 3000) {
  let steps = 0, stall = 0, best = Infinity, alt = false;
  while (steps++ < maxSteps) {
    const d = Math.hypot(target[0] - state.pos[0], target[1] - state.pos[1]);
    if (d < rt.nav.cell) return true;
    if (d < best - 0.5) { best = d; stall = 0; } else if (++stall > 40) { alt = !alt; stall = 0; }
    // the next corner of the shortest path from here
    const r = findPath(rt.nav, state.pos[0], state.pos[1], ...target);
    assert.ok(r, `a way on to ${target}`);
    const next = r.points.find((p) => Math.hypot(p[0] - state.pos[0], p[1] - state.pos[1]) > 1) || target;
    const dir = quantize([next[0] - state.pos[0], next[1] - state.pos[1]], alt);
    const ev = stepRound(state, level, rt, { dir });
    assert.ok(!ev.some((e) => e.type === 'lose'), 'never into the stove');
    assert.equal(state.status, 'playing');
  }
  return false;
}
const keys = ([x, y], alt) => {
  const a = Math.atan2(y, x) + (alt ? Math.PI / 8 : 0);
  const k = Math.round(a / (Math.PI / 4));
  return [Math.round(Math.cos(k * Math.PI / 4)), Math.round(Math.sin(k * Math.PI / 4))];
};
const pad = ([x, y], alt) => ((Math.abs(x) >= Math.abs(y)) !== alt ? [Math.sign(x) || 1, 0] : [0, Math.sign(y) || 1]);
const stick = ([x, y]) => [x, y];

for (const [name, quantize] of [['the arrow keys', keys], ['the on-screen pad', pad], ['a stick', stick]]) {
  test(`the kitchen: the explorer walks all the way around the island by ${name}`, () => {
    const state = createRound(level, rt);
    state.pos = [...AROUND.front];
    for (const to of LOOP.slice(1)) assert.ok(steerTo(state, AROUND[to], quantize), `${name}: reached ${to} of the island (at ${state.pos.map(Math.round)})`);
  });
}

test('the kitchen: taps walk around the island too: a tap on its far part walks behind it, where it hides the explorer', () => {
  const state = createRound(level, rt);
  state.pos = [...AROUND.front];
  const fp = rt.objs[island].footprint;
  for (const to of LOOP.slice(1)) {
    const [x, y] = AROUND[to];
    const r = walkToPoint(state, level, rt, x, y);
    assert.ok(r.ok, `${to}: ${r.reason}`);
    for (let i = 0; i < 4000 && state.auto; i++) stepRound(state, level, rt, {});
    assert.equal(state.status, 'playing');
    if (to === 'behind') {
      // the point behind the island is on the island's outline: the tap is
      // a walk to the island, on the side tapped, behind it
      assert.equal(r.k, island, 'a tap on the island walks to the island');
      assert.ok(state.pos[1] < fp.top, `behind the island’s footprint (at ${state.pos.map(Math.round)})`);
      assert.ok(Math.hypot(state.pos[0] - x, state.pos[1] - y) < rt.p.touch + rt.nav.cell, `on the side tapped (at ${state.pos.map(Math.round)})`);
      // while it stands there, the island is drawn over it
      const ops = drawPlan(level, state.pos);
      assert.ok(ops.some((o) => o.op === 'repaint' && o.k === island), 'the island hides the explorer behind it');
    } else {
      assert.equal(r.k, -1, `${to}: a point on the floor is walked to`);
      assert.ok(Math.hypot(state.pos[0] - x, state.pos[1] - y) < rt.nav.cell, `${to}: arrived (at ${state.pos.map(Math.round)})`);
    }
  }
  // the walk-to chip, from in front, walks to the island's nearest side
  const s2 = createRound(level, rt);
  s2.pos = [...AROUND.front];
  assert.equal(walkToObject(s2, level, rt, island).ok, true);
  for (let i = 0; i < 4000 && s2.auto; i++) stepRound(s2, level, rt, {});
  assert.ok(s2.pos[1] > fp.top, 'in front of it');
});

// ---- the sample rooms and the apartment ----

const room = (id) => loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));

test('the three sample rooms stay winnable, on the very same routes (their floors, drawn by code, hide nothing)', () => {
  const routes = {};
  for (const id of ['desk', 'living', 'apartment']) {
    const b = buildLevel(inputFromRoom(room(id), '2026-10-27T10:00:00Z'));
    assert.ok(b.level && b.level.proof.winnable, id);
    assert.deepEqual(b.level.changes_by_code, [], `${id}: no change by code`);
    routes[id] = b.level.proof.route_length;
  }
  assert.deepEqual(routes, { desk: 851, living: 922, apartment: 1692 });
});

test('the apartment, rehearsed on its floor mask: its walls still block, and its route is the same', async () => {
  const { entry } = await replayApartment();
  const { level: apt, rt: art } = entry.built;
  assert.ok(apt.proof.winnable);
  assert.equal(apt.proof.route_length, 1692);
  // a wall between rooms, away from any doorway, is never walkable
  for (const [x, y] of [[527, 100], [527, 300], [600, 387], [900, 387], [100, 427], [400, 427]]) assert.equal(art.walk[y * art.W + x], 0, `a wall at ${x}, ${y}`);
  assert.equal(apt.surface.rooms, 4);
  assert.equal(apt.surface.doorways.filter((d) => !d.exit).length, 3);
});
