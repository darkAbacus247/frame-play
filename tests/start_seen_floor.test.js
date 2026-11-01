// The explorer starts on the floor the camera saw. Seen at eye level, the
// floor inferred behind a low thing (src/floor_mask.js hiddenFloor) takes in
// its top: a coffee table whose base meets the picture's bottom edge becomes
// walkable above its footprint, and the start rule (the lowest fifth of the
// walk region, nearest the middle) could put the explorer on the table top
// (the judge walk of 11-01, a living-room photo). The start is now chosen on
// SAM's seen floor when a seen-floor cell with room reaches the goals, and
// falls back to the inferred floor only when none does. The hidden-floor rule
// itself stays: the table top is still walked over. The start is chosen
// before the proof, so the proof covers it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLevel, chooseStart, validateLevel } from '../src/level.js';
import { fillRings } from '../src/raster.js';
import { cellCenter } from '../src/nav.js';

const CREATED = '2026-11-01T12:00:00Z';
const W = 400, H = 300;
const rect = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
// the coffee table: its outline reaches the picture's bottom edge
const TABLE = [160, 200, 240, 300];

function input(floorRings, objects) {
  return {
    origin: 'live',
    picture: { kind: 'photo', width: W, height: H },
    title: 'A living room',
    surface: { name: 'floor', rings: floorRings, source: 'sam_mask' },
    objects: objects.map(([name, role, b], k) => ({
      id: `o${k + 1}`, name, role, reason: 'test', box: b, confidence: 0.9, outline: { source: 'sam_mask', rings: rect(...b) }, on_surface: true,
    })),
    provenance: { created: CREATED },
  };
}

const inTable = ([x, y]) => x >= TABLE[0] && x < TABLE[2] && y >= TABLE[1] && y < TABLE[3];
const onMask = (mask, [x, y]) => mask[Math.floor(y) * W + Math.floor(x)] === 1;

test('a table top in the lowest fifth: the explorer starts on the seen floor beside it, and the table top stays walkable', () => {
  // SAM's floor: a U around the table (the table hides the floor under it)
  const seenRings = [[[20, 150], [380, 150], [380, 300], [240, 300], [240, 200], [160, 200], [160, 300], [20, 300]]];
  const built = buildLevel(input(seenRings, [
    ['coffee table', 'solid', TABLE],
    ['coin', 'collect', [60, 230, 80, 250]],
    ['door', 'exit', [330, 170, 360, 220]],
  ]));
  assert.ok(!built.error, built.error);
  const { level, rt } = built;
  assert.ok(level.proof.winnable);
  const seen = fillRings(seenRings, W, H);
  // the hidden-floor rule stays: the table top, above its footprint, is walkable
  assert.equal(rt.walk[240 * W + 200], 1, 'the table top is inferred floor');
  assert.equal(seen[240 * W + 200], 0, 'and no camera saw it');
  assert.equal(rt.walk[295 * W + 200], 0, 'the table’s footprint is solid');
  // the start: on the floor SAM saw, not on the table
  assert.ok(onMask(seen, level.start), `the start ${level.start} is on the seen floor`);
  assert.ok(!inTable(level.start), `the start ${level.start} is not on the table`);
  // still low and near the middle: the lowest fifth, beside the table
  assert.ok(level.start[1] > 260 && Math.abs(level.start[0] - W / 2) < 60, `start ${level.start}`);
  // the proof is of this start: a kept level reads back with the same one
  const v = validateLevel(JSON.parse(JSON.stringify(level)));
  assert.ok(v.ok, v.errors.join('; '));
  assert.deepEqual(cellCenter(v.rt.nav, v.start), level.start);
  assert.equal(v.proof.route_length, level.proof.route_length);
  // the table top would have been the start by the old rule: nearer the middle
  const [tx, ty] = cellCenter(rt.nav, chooseStart(level, { ...rt, floor: null }));
  assert.ok(inTable([tx, ty]), `with no seen floor to prefer, the start would be on the table (${tx}, ${ty})`);
});

test('no seen-floor cell with room: the start falls back to the inferred floor', () => {
  // SAM saw only two thin strips of floor (6 px, under the body's width)
  // either side of the table; the things on the table are the goals
  const seenRings = [...rect(100, 170, 106, 300), ...rect(294, 170, 300, 300)];
  const built = buildLevel(input(seenRings, [
    ['coffee table', 'solid', TABLE],
    ['coin', 'collect', [168, 208, 180, 220]],
    ['book', 'exit', [222, 204, 236, 226]],
  ]));
  assert.ok(!built.error, built.error);
  const { level, rt } = built;
  assert.ok(level.proof.winnable);
  const seen = fillRings(seenRings, W, H);
  for (let c = 0; c < rt.nav.pass.length; c++) {
    if (rt.nav.pass[c]) assert.ok(!onMask(seen, cellCenter(rt.nav, c)), 'no free cell lies on the seen floor');
  }
  assert.ok(inTable(level.start), `the start ${level.start} is on the inferred floor, the table top`);
});
