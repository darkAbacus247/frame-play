// SAM 3.1's floor mask as the play area (src/floor_mask.js): pieces a crack
// apart (a corner, or a gap of one or two nav squares) are joined so no coin
// is cut off; a real wall, wider than that, never is; the exit is a doorway
// where the floor meets its outline; the proof runs on this floor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { joinFloor, floorFromMask, floorMaskRings, exitDoorway, JOIN_SQUARES } from '../src/floor_mask.js';
import { floorFromReply } from '../src/trace_in_box.js';
import { buildLevel } from '../src/level.js';
import { components, traceMask, fillRings } from '../src/raster.js';
import { navParams } from '../src/nav.js';

const W = 1024, H = 768;
const CELL = navParams(W, H).cell;

function rects(...rs) {
  const m = new Uint8Array(W * H);
  for (const [x0, y0, x1, y1] of rs) for (let y = y0; y < y1; y++) m.fill(1, y * W + x0, y * W + x1);
  return m;
}
const pieces = (m) => components(m, W, H, 8).count;

test('two pieces a crack apart are joined; a wall wider than two squares is not', () => {
  assert.equal(CELL, 4);
  for (const gap of [1, 2 * CELL]) {
    const m = rects([100, 100, 400, 600], [400 + gap, 100, 900, 600]);
    const { mask, joins } = joinFloor(m, W, H);
    assert.equal(joins, 1, `gap ${gap}`);
    assert.equal(pieces(mask), 1);
    for (let y = 100; y < 600; y++) for (let x = 400; x < 400 + gap; x++) assert.equal(mask[y * W + x], 1, `the crack is floor at ${x}, ${y}`);
  }
  for (const gap of [2 * CELL + 1, 14]) {
    const m = rects([100, 100, 400, 600], [400 + gap, 100, 900, 600]);
    const { mask, joins } = joinFloor(m, W, H);
    assert.equal(joins, 0, `a wall ${gap} px thick stays`);
    assert.equal(mask, m);
  }
  assert.equal(JOIN_SQUARES, 2);
});

test('pieces that meet only near a corner are joined, with a passage the explorer fits through', () => {
  const m = rects([100, 100, 400, 400], [405, 405, 800, 700]);
  const { mask, joins } = joinFloor(m, W, H);
  assert.equal(joins, 1);
  assert.equal(pieces(mask), 1);
  // the passage is as wide as the explorer at the corner
  const p = navParams(W, H);
  const r = Math.floor(p.radius + p.planExtra);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy <= r * r) assert.equal(mask[(402 + dy) * W + 402 + dx], 1);
  }
});

test('a lone piece and specks are left as they are', () => {
  const one = rects([100, 100, 400, 600]);
  assert.equal(joinFloor(one, W, H).joins, 0);
  const speck = rects([100, 100, 400, 600], [403, 300, 410, 307]);
  assert.equal(joinFloor(speck, W, H).joins, 0, 'a speck is not a piece of floor to join');
});

test('the floor mask’s rings are checked before they are used', () => {
  const ring = [[10, 10], [100, 10], [100, 100], [10, 100]];
  assert.deepEqual(floorMaskRings({ mask: { rings: [ring] } }, W, H), [ring]);
  assert.equal(floorMaskRings({ mask: { rings: [[[10, 10], [2000, 10], [20, 20]]] } }, W, H), null);
  assert.equal(floorMaskRings({ mask: { rings: [] } }, W, H), null);
  assert.equal(floorMaskRings({ mask: { rings: [[[1, 1], [2, 2]]] } }, W, H), null);
  assert.equal(floorMaskRings({}, W, H), null);
  assert.equal(floorFromMask({ mask: { rings: [ring] } }, W, H).joins, 0);
});

// A floor plan seen from above whose floor SAM drew in two pieces, a 6 px
// crack between them (a seam in its mask), the coin on the far piece.
function crackedReply(gap) {
  const floor = rects([60, 60, 500, 700], [500 + gap, 60, 960, 700]);
  return {
    received: { width: W, height: H },
    provenance: { mode: 'live' },
    surface: { name: 'floor', box: [60, 60, 960, 700] },
    floor: { view: 'top_down', seeds: [], boxes: [], mask: { rings: traceMask(floor, W, H) } },
  };
}
const square = (x, y, s) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s]]];
function levelOn(reply) {
  const f = floorFromReply(reply, { width: W, height: H });
  return buildLevel({
    origin: 'live',
    picture: { kind: 'photo', sha256: 'x', width: W, height: H },
    objects: [
      { id: 'exit', name: 'door', role: 'exit', outline: { source: 'sam_mask', rings: square(200, 600, 60) } },
      { id: 'coin', name: 'coin', role: 'collect', outline: { source: 'sam_mask', rings: square(800, 200, 20) } },
    ],
    ...f,
  });
}

test('a coin across a crack in SAM’s floor can be reached, and the words say a gap was joined', () => {
  const reply = crackedReply(6);
  const f = floorFromReply(reply, { width: W, height: H });
  assert.equal(f.surface.source, 'sam_mask');
  assert.equal(f.floor.words, 'SAM 3.1’s mask of the floor is the play area; code joined one gap of one or two squares between its pieces; everything else is wall.');
  const built = levelOn(reply);
  assert.equal(built.error, undefined, built.error);
  assert.ok(built.level.proof.winnable);
  assert.deepEqual(built.level.changes_by_code, [], 'the coin stays a coin');
  assert.equal(built.level.surface.source, 'sam_mask');
  assert.equal(built.level.view, 'top_down');
});

test('a coin behind a real wall in SAM’s floor stays out of reach, and says so', () => {
  const built = levelOn(crackedReply(16));
  // the only coin is walled off: no room can be won from it
  assert.ok(built.error, 'no level');
  assert.match(built.error, /No level from this picture/);
});

test('on SAM’s own floor the exit is a doorway where the floor meets its outline', () => {
  const built = levelOn(crackedReply(6));
  const doors = built.level.surface.doorways.filter((d) => d.exit);
  assert.equal(doors.length, 1);
  const [d] = doors;
  // beside the door's square, on the floor
  assert.ok(d.x >= 199 && d.x <= 261 && d.y >= 599 && d.y <= 661, JSON.stringify(d));
  assert.ok(d.width >= 60, JSON.stringify(d));
  // only SAM's floor says so: a floor drawn or grown by code keeps its rooms' doorways only
  const walk = rects([0, 0, 50, 50]);
  const exit = fillRings(square(60, 10, 10), W, H);
  assert.equal(exitDoorway(walk, exit, W, H), null, 'a floor that never touches the exit has no doorway to it');
});
