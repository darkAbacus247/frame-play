// The explorer starts with room from any hazard. The start rule (the lowest
// fifth of the walk region, nearest the middle, on the seen floor, reaching
// the goals) could put the explorer right beside a hazard's halo, so a judge
// holding the arrow keys lost in a few steps (the judge walk of 11-01, the
// kitchen's stove). Among the cells that reach every goal, one whose nearest
// pixel is a body-width-and-a-half (three body radii) from any hazard pixel
// is preferred when such a cell exists; the seen-floor rule and the fallback
// to the nearest cell stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLevel, chooseStart, validateLevel, START_HAZARD_ROOM } from '../src/level.js';
import { inputFromReply } from '../src/reply.js';
import { floorFromReply } from '../src/trace_in_box.js';
import { cellCenter, cellOf } from '../src/nav.js';
import { replayReply, KITCHEN_PIXELS } from './kitchen.js';

const CREATED = '2026-11-01T12:00:00Z';
const W = 1024, H = 768;
const rect = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
// a low hot plate on the floor in the middle, its footprint at the bottom
// of the lowest fifth: the start would otherwise be right behind it
const PLATE = [480, 736, 544, 760];

function input(objects) {
  return {
    origin: 'live',
    picture: { kind: 'photo', width: W, height: H },
    title: 'A room with a hot plate',
    surface: { name: 'floor', rings: rect(0, 300, W, H), source: 'sam_mask' },
    objects: objects.map(([name, role, b], k) => ({
      id: `o${k + 1}`, name, role, reason: 'test', box: b, confidence: 0.9, outline: { source: 'sam_mask', rings: rect(...b) }, on_surface: true,
    })),
    provenance: { created: CREATED },
  };
}

// the distance from a point to the nearest pixel of a mask (pixel centres)
function maskDistance(mask, w, h, [x, y]) {
  let best = Infinity;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!mask[j * w + i]) continue;
      const d = Math.hypot(i + 0.5 - x, j + 0.5 - y);
      if (d < best) best = d;
    }
  }
  return best;
}

// the room, with the plate in the role given
const room = (plate) => [
  ['coin', 'collect', [120, 420, 160, 460]],
  ['door', 'exit', [880, 320, 940, 480]],
  ['hot plate', plate, PLATE],
];

test('a hazard beside the old start: the explorer starts a body-width-and-a-half from it', () => {
  // the same room with the plate as a plain obstacle: the old start, right beside it
  const solid = buildLevel(input(room('solid')));
  assert.ok(!solid.error, solid.error);
  const plateMask = solid.rt.objs[2].footprint.mask;
  const oldStart = solid.level.start;
  const r = solid.rt.p.radius;
  assert.equal(START_HAZARD_ROOM, 3, 'three body radii: a body-width-and-a-half');
  assert.ok(maskDistance(plateMask, W, H, oldStart) < START_HAZARD_ROOM * r, `the old start ${oldStart} is within ${(3 * r).toFixed(1)} px of the plate`);
  // the plate as a hazard: the start moves to where there is room
  const built = buildLevel(input(room('avoid')));
  assert.ok(!built.error, built.error);
  const { level, rt } = built;
  assert.ok(level.proof.winnable);
  assert.ok(rt.hazard, 'the plate is a hazard');
  const far = maskDistance(rt.hazard, W, H, level.start);
  assert.ok(far >= START_HAZARD_ROOM * r, `the start ${level.start} is ${far.toFixed(1)} px from the plate, at least ${(3 * r).toFixed(1)}`);
  assert.ok(far > maskDistance(rt.hazard, W, H, oldStart), 'farther than the old start');
  // still low and near the middle, behind the plate
  assert.ok(level.start[1] > 700 && Math.abs(level.start[0] - W / 2) < 120, `start ${level.start}`);
  // the rule, not the hazard's halo, moved it: a free cell that reaches the
  // goals comes before the start in the old order (nearer the middle, or as
  // near and lower), under a body-width-and-a-half from the plate
  const c = cellOf(rt.nav, ...level.start);
  const key = ([x, y]) => [Math.abs(x - W / 2), -y];
  const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  let passedOver = 0;
  for (let k = 0; k < rt.nav.pass.length; k++) {
    if (!rt.nav.pass[k] || rt.nav.comp[k] !== rt.nav.comp[c]) continue;
    const at = cellCenter(rt.nav, k);
    if (at[1] > 700 && before(key(at), key(level.start)) && rt.nav.hclear[k] < START_HAZARD_ROOM * r) passedOver++;
  }
  assert.ok(passedOver > 0, 'a free cell the old rule would have taken, within the distance, was passed over');
  // the proof is of this start: a kept level reads back with the same one
  const v = validateLevel(JSON.parse(JSON.stringify(level)));
  assert.ok(v.ok, v.errors.join('; '));
  assert.deepEqual(cellCenter(v.rt.nav, v.start), level.start);
  assert.equal(v.proof.route_length, level.proof.route_length);
});

test('no hazard: the start is where it was, lowest and nearest the middle', () => {
  const built = buildLevel(input(room('solid')));
  const { level, rt } = built;
  assert.ok(!rt.hazard);
  const c = cellOf(rt.nav, ...level.start);
  assert.equal(chooseStart(level, rt), c);
  assert.ok(Math.abs(level.start[0] - W / 2) <= rt.p.cell && level.start[1] > 720, `start ${level.start}`);
  // right behind the plate: nearer than a body-width-and-a-half
  assert.ok(maskDistance(rt.objs[2].footprint.mask, W, H, level.start) < START_HAZARD_ROOM * rt.p.radius);
});

test('our kitchen (the replay): the start is not within a body-width-and-a-half of the stove', () => {
  const reply = replayReply();
  const input = inputFromReply(reply, { kind: 'replay', id: 'kitchen' }, (o) => ({ source: 'sam_mask', rings: o.mask.rings }), '2026-10-27T15:00:00Z');
  const { level, rt } = buildLevel({ ...input, ...floorFromReply(reply, KITCHEN_PIXELS) });
  const stove = level.objects.findIndex((o) => o.name === 'stove');
  assert.ok(stove >= 0 && level.objects[stove].role === 'avoid', 'the stove is the hazard');
  assert.ok(rt.hazard, 'its footprint is on the hazard mask');
  const r = rt.p.radius;
  const d = maskDistance(rt.hazard, rt.W, rt.H, level.start);
  assert.ok(d >= START_HAZARD_ROOM * r, `the start ${level.start} is ${d.toFixed(1)} px from the stove, at least ${(3 * r).toFixed(1)}`);
  const c = cellOf(rt.nav, ...level.start);
  assert.ok(rt.nav.hclear[c] >= START_HAZARD_ROOM * r, 'measured by the clearance grid too');
});
