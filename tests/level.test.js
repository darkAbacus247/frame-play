import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRoom } from '../src/rooms.js';
import { buildLevel, validateLevel, inputFromRoom, prepare, LABELS } from '../src/level.js';
import { components } from '../src/raster.js';
import { findPath, cellCenter } from '../src/nav.js';

const CREATED = '2026-10-26T17:00:00Z';
const rect = (x, y, w, h) => [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];

function input(objects, surface) {
  return {
    origin: 'mock',
    picture: { kind: 'sample', id: 'test', width: 256, height: 192 },
    title: 'Test room',
    theme_line: '',
    surface: surface === undefined ? { name: 'floor', rings: rect(0, 60, 256, 132), source: 'exact' } : surface,
    objects: objects.map(([id, role, rings, extra]) => ({
      id, name: id, role, reason: 'test', outline: { source: 'exact', rings }, on_surface: true, ...(extra || {}),
    })),
    provenance: { created: CREATED },
  };
}

// A live-shaped room: boxes on a 1024 x 768 picture, the surface a box too.
const box = ([x0, y0, x1, y1]) => rect(x0, y0, x1 - x0, y1 - y0);
function liveInput(objects, surfaceBox = [0, 300, 1024, 768]) {
  return {
    origin: 'live',
    picture: { kind: 'photo', width: 1024, height: 768 },
    title: 'A photo',
    surface: surfaceBox ? { name: 'floor', rings: box(surfaceBox), source: 'box' } : null,
    objects: objects.map(([name, role, b], k) => ({
      id: `obj${k + 1}`, name, role, reason: 'test', box: b, outline: { source: 'box', rings: box(b) }, on_surface: true,
    })),
    provenance: { created: CREATED },
  };
}

function deskLevel() {
  const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
  return { room, built: buildLevel(inputFromRoom(room, CREATED)) };
}

test('the desk room can be won, untouched by repairs', () => {
  const { room, built } = deskLevel();
  assert.ok(!built.error, built.error);
  const { level } = built;
  assert.equal(level.schema, 'frameplay.level/2');
  assert.equal(level.label, LABELS.mock);
  assert.deepEqual(level.changes_by_code, []);
  assert.equal(level.proof.winnable, true);
  assert.deepEqual([...level.rules.collect].sort(), ['coin1', 'coin2', 'coin3']);
  assert.deepEqual(level.rules.avoid, ['cactus']);
  assert.equal(level.rules.exit, 'box');
  assert.equal(level.proof.order.length, 4);
  assert.equal(level.proof.order[3], 'box');
  assert.ok(level.proof.route_length > 500 && level.proof.route_length < 4000, `route ${level.proof.route_length}`);
  // start in the lowest fifth, near the middle
  assert.ok(level.start[1] > 600 && Math.abs(level.start[0] - room.width / 2) < 60, `start ${level.start}`);
  assert.equal(level.surface.horizon_y, 318);
  assert.deepEqual(level.provenance.outline_sources, { exact: room.objects.length, sam_mask: 0, traced_in_box: 0, box: 0 });
  // the frame hangs on the wall: no footprint; the notebook is flat: no footprint
  const byId = Object.fromEntries(level.objects.map((o) => [o.id, o]));
  assert.equal(byId.frame.footprint, null);
  assert.equal(byId.notebook.footprint, null);
  assert.equal(byId.lamp.baseline_y, 386);
  // the level outlines are the painted shapes, untouched
  room.objects.forEach((o, k) => assert.deepEqual(level.objects[k].outline.rings, o.rings));
  const v = validateLevel(JSON.parse(JSON.stringify(level)));
  assert.ok(v.ok, v.errors.join('; '));
  assert.equal(v.proof.route_length, level.proof.route_length);
});

test('the living room can be won, untouched by repairs; walk between the chair legs', () => {
  const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/living.json', import.meta.url), 'utf8')));
  const built = buildLevel(inputFromRoom(room, CREATED));
  assert.ok(!built.error, built.error);
  const { level, rt } = built;
  assert.deepEqual(level.changes_by_code, []);
  assert.equal(level.proof.winnable, true);
  assert.deepEqual([...level.rules.collect].sort(), ['ball', 'slipper1', 'slipper2']);
  assert.deepEqual(level.rules.avoid, ['plant']);
  assert.equal(level.rules.exit, 'door');
  const byId = Object.fromEntries(level.objects.map((o) => [o.id, o]));
  assert.equal(byId.window.footprint, null, 'the window hangs on the wall');
  assert.equal(byId.rug.footprint, null, 'the rug is flat');
  // the chair stands on four leg tips: the floor between them is walkable
  const at = (x, y) => rt.walk[y * rt.W + x];
  assert.equal(at(440, 500), 1, 'between the inner legs');
  assert.equal(at(388, 505), 0, 'a leg tip');
  assert.equal(at(440, 470), 1, 'under the seat, behind the legs');
  const c = (x, y) => Math.floor(y / rt.nav.cell) * rt.nav.gw + Math.floor(x / rt.nav.cell);
  assert.equal(rt.nav.pass[c(440, 500)], 1, 'the explorer fits between the legs');
  const under = findPath(rt.nav, 440, 640, 440, 470);
  const end = under && under.points[under.points.length - 1];
  assert.ok(end && Math.hypot(end[0] - 440, end[1] - 470) < rt.nav.cell, 'a path under the chair');
  const v = validateLevel(JSON.parse(JSON.stringify(level)));
  assert.ok(v.ok, v.errors.join('; '));
});

test('the walk region: below the horizon, behind objects, never on footprints', () => {
  const { built } = deskLevel();
  const { level, rt } = built;
  const W = rt.W;
  const at = (x, y) => rt.walk[y * W + x];
  assert.equal(at(500, 300), 0, 'above the horizon');
  assert.equal(at(500, 600), 1, 'open desk');
  assert.equal(at(600, 420), 1, 'behind the mug, above its footprint');
  assert.equal(at(600, 478), 0, 'the mug footprint');
  assert.equal(at(380, 470), 1, 'over the flat notebook');
  assert.equal(at(500, 720), 0, 'the desk front');
  const mug = level.objects.find((o) => o.id === 'mug');
  assert.ok(mug.footprint.depth > 20 && mug.footprint.depth < 30);
});

test('footprints keep separate legs separate (walk between a chair’s legs)', () => {
  // one outline: a seat with two legs below it, as non-overlapping rings
  const seat = rect(96, 100, 54, 20)[0];
  const rings = [seat, [[100, 120], [106, 120], [106, 160], [100, 160]], [[140, 120], [146, 120], [146, 160], [140, 160]]];
  const res = buildLevel(input([
    ['chair', 'solid', rings],
    ['ball', 'collect', rect(200, 150, 10, 10)],
    ['door', 'exit', rect(20, 70, 20, 30)],
  ]));
  assert.ok(!res.error, res.error);
  const t = res.rt.objs[0];
  const comps = components(t.footprint.mask, 256, 192, 8);
  assert.equal(comps.count, 2, 'two separate leg tips');
  assert.equal(res.level.objects[0].baseline_y, 160);
  // the floor between the legs, under the seat, is walkable
  assert.equal(res.rt.walk[150 * 256 + 123], 1);
});

test('repair 1: with no exit, the farthest reachable solid object becomes the exit', () => {
  const res = buildLevel(input([
    ['near', 'solid', rect(120, 150, 16, 16)],
    ['far', 'solid', rect(30, 70, 16, 16)],
    ['coin', 'collect', rect(200, 140, 8, 8)],
  ]));
  assert.ok(!res.error, res.error);
  assert.equal(res.level.rules.exit, 'far');
  assert.equal(res.level.changes_by_code.length, 1);
  assert.match(res.level.changes_by_code[0].what, /far became the exit/);
  assert.equal(res.level.changes_by_code[0].why, 'No exit was found');
});

test('repair 2: an exit out of reach hands over to the farthest reachable object', () => {
  const res = buildLevel(input([
    ['door', 'exit', rect(100, 10, 20, 30)], // above the horizon: nothing can touch it
    ['shelf', 'solid', rect(40, 80, 20, 20)],
    ['coin', 'collect', rect(200, 140, 8, 8)],
  ]));
  assert.ok(!res.error, res.error);
  assert.equal(res.level.rules.exit, 'shelf');
  assert.ok(res.level.changes_by_code.some((c) => /shelf became the exit/.test(c.what) && /door cannot be reached/.test(c.why)));
});

test('repair 3 and 4: unreachable collectibles become solid; then the two smallest solids are collected', () => {
  const res = buildLevel(input([
    ['kite', 'collect', rect(30, 10, 10, 10)], // out of reach
    ['big', 'solid', rect(40, 100, 30, 30)],
    ['tiny', 'solid', rect(120, 120, 6, 6)],
    ['small', 'solid', rect(180, 90, 10, 10)],
    ['door', 'exit', rect(210, 150, 20, 20)],
  ]));
  assert.ok(!res.error, res.error);
  const w = res.level.changes_by_code.map((c) => `${c.what} | ${c.why}`);
  assert.ok(w.some((s) => /kite is solid \| Out of reach/.test(s)), w.join('\n'));
  assert.deepEqual([...res.level.rules.collect].sort(), ['small', 'tiny']);
});

test('repair 5: a hazard halo that cuts the only way loses its margin', () => {
  const res = buildLevel(input([
    ['wallL', 'solid', rect(0, 120, 110, 10)],
    ['wallR', 'solid', rect(146, 120, 110, 10)],
    ['spikes', 'avoid', rect(120, 120, 16, 10)],
    ['door', 'exit', rect(100, 70, 20, 20)],
    ['gem', 'collect', rect(160, 160, 10, 10)],
  ]));
  assert.ok(!res.error, res.error);
  assert.equal(res.level.nav.hazard_margin, 0);
  assert.ok(res.level.changes_by_code.some((c) => /spikes danger zone shrank/.test(c.what)));
  assert.deepEqual(res.level.rules.avoid, ['spikes']);
});

test('repair 6: a room that cannot be won gives no level, in words', () => {
  const res = buildLevel(input([
    ['kite', 'collect', rect(30, 10, 10, 10)],
    ['door', 'exit', rect(100, 10, 20, 30)],
  ]));
  assert.ok(res.error);
  assert.match(res.error, /^No level from this picture: The explorer cannot walk to the kite and the door on the floor\./);
  const half = buildLevel(input([
    ['kite', 'collect', rect(30, 10, 10, 10)],
    ['door', 'exit', rect(100, 100, 20, 30)],
  ]));
  assert.match(half.error, /cannot walk to the kite on the floor, and the door alone cannot be both the exit and a thing to collect/);
});

test('a sparse room: coins and no exit, so the farthest coin becomes the exit', () => {
  const res = buildLevel(liveInput([
    ['coin', 'collect', [480, 640, 520, 680]],
    ['coin', 'collect', [200, 500, 240, 540]],
    ['coin', 'collect', [800, 380, 840, 420]],
  ]));
  assert.ok(!res.error, res.error);
  const { level } = res;
  assert.equal(level.proof.winnable, true);
  assert.equal(level.rules.collect.length, 2);
  assert.equal(level.changes_by_code.length, 1);
  assert.match(level.changes_by_code[0].what, /^The coin \d became the exit$/);
  assert.equal(level.changes_by_code[0].why, 'No exit was found');
  assert.ok(validateLevel(JSON.parse(JSON.stringify(level))).ok);
});

test('a sparse room: two coins make an exit and one collectible', () => {
  const res = buildLevel(liveInput([['coin', 'collect', [480, 600, 520, 640]], ['coin', 'collect', [200, 400, 240, 440]]]));
  assert.ok(!res.error, res.error);
  assert.equal(res.level.rules.collect.length, 1);
});

test('a sparse room: an exit and a hazard, so the hazard becomes the collectible', () => {
  const res = buildLevel(liveInput([
    ['door', 'exit', [100, 320, 180, 480]],
    ['cactus', 'avoid', [600, 550, 660, 640]],
  ]));
  assert.ok(!res.error, res.error);
  const { level, rt } = res;
  assert.equal(level.proof.winnable, true);
  assert.deepEqual(level.rules.collect, ['obj2']);
  assert.deepEqual(level.rules.avoid, []);
  assert.equal(rt.hazard, null, 'the hazard mask was made again');
  assert.ok(level.changes_by_code.some((c) => c.what === 'The cactus became a collectible'));
  assert.ok(validateLevel(JSON.parse(JSON.stringify(level))).ok);
});

test('a sparse room: a hazard can also become the exit', () => {
  const res = buildLevel(liveInput([
    ['coin', 'collect', [480, 640, 520, 680]],
    ['cactus', 'avoid', [600, 400, 660, 480]],
  ]));
  assert.ok(!res.error, res.error);
  assert.equal(res.level.rules.exit, 'obj2');
  assert.equal(res.rt.hazard, null);
});

test('a room that truly cannot be made says what was found and what is missing', () => {
  const one = buildLevel(liveInput([['mug', 'collect', [480, 500, 540, 580]]]));
  assert.match(one.error, /^No level from this picture: /);
  assert.match(one.error, /Only one thing was found standing on the floor \(the mug\)/);
  assert.match(one.error, /three or more/);
  assert.doesNotMatch(one.error, /exactly one exit/);
  const exitOnly = buildLevel(liveInput([['door', 'exit', [100, 320, 180, 480]]]));
  assert.match(exitOnly.error, /\(the door\).*three or more/);
  const none = buildLevel(liveInput([['rug', 'flat', [100, 500, 400, 600]]]));
  assert.match(none.error, /Nothing was found standing on the floor\. Also found, but not standing on it: the rug\./);
});

const ROOM = [
  ['box', 'exit', [150, 600, 250, 700]],
  ['coin', 'collect', [480, 640, 520, 680]],
  ['mug', 'solid', [700, 610, 780, 700]],
];

test('a surface box above the objects sets the horizon and fences nothing', () => {
  const res = buildLevel(liveInput(ROOM, [0, 100, 1024, 300]));
  assert.ok(!res.error, res.error);
  const { level, rt } = res;
  assert.deepEqual(level.changes_by_code, []);
  assert.equal(level.surface.horizon_y, 100);
  const at = (x, y) => rt.walk[y * rt.W + x];
  assert.equal(at(500, 50), 0, 'above the horizon');
  assert.equal(at(500, 400), 1, 'below the box, still the floor');
  assert.equal(at(900, 740), 1, 'below and beside the box');
  assert.ok(validateLevel(JSON.parse(JSON.stringify(level))).ok);
});

test('a surface box below the objects never puts their feet above the horizon', () => {
  const res = buildLevel(liveInput(ROOM.map(([n, r, [x0, y0, x1, y1]]) => [n, r, [x0, y0 - 250, x1, y1 - 250]]), [0, 600, 1024, 768]));
  assert.ok(!res.error, res.error);
  assert.deepEqual(res.level.changes_by_code, []);
  const feet = Math.min(...res.rt.objs.map((t) => t.footprint.top));
  assert.ok(res.level.surface.horizon_y < feet - 20, `horizon ${res.level.surface.horizon_y}, feet ${feet}`);
  assert.equal(res.level.proof.winnable, true);
});

test('a surface box made of several matches (a union) is just a wider box', () => {
  const res = buildLevel(liveInput(ROOM, [0, 380, 1024, 768]));
  assert.ok(!res.error, res.error);
  assert.equal(res.level.surface.horizon_y, 380);
  assert.equal(res.rt.walk[740 * 1024 + 900], 1);
});

test('validation refuses a foreign origin, a ring outside, two exits and no collectible', () => {
  const { built } = deskLevel();
  const good = JSON.stringify(built.level);
  const mutate = (fn) => { const l = JSON.parse(good); fn(l); return validateLevel(l); };
  assert.equal(mutate(() => {}).ok, true);
  assert.equal(mutate((l) => { l.origin = 'dream'; }).ok, false);
  assert.equal(mutate((l) => { l.label = LABELS.live; }).ok, false);
  assert.equal(mutate((l) => { l.objects[1].outline.rings[0][0] = [2000, 10]; }).ok, false);
  assert.equal(mutate((l) => { l.objects.find((o) => o.id === 'lamp').role = 'exit'; }).ok, false);
  assert.equal(mutate((l) => { for (const o of l.objects) if (o.role === 'collect') o.role = 'solid'; }).ok, false);
  assert.equal(mutate((l) => { l.objects[2].id = l.objects[1].id; }).ok, false);
  assert.equal(mutate((l) => { l.objects[0].role = 'boss'; }).ok, false);
});

test('the proof agrees with the planner', () => {
  const { built } = deskLevel();
  const { level, rt } = built;
  const [sx, sy] = level.start;
  for (const id of level.proof.order) {
    const k = level.objects.findIndex((o) => o.id === id);
    const ring = rt.rings[k];
    assert.ok(ring.length > 0);
    const res = findPath(rt.nav, sx, sy, ...cellCenter(rt.nav, ring[0]));
    assert.ok(res && !res.snapped, `no path to ${id}`);
  }
  // prepare is pure: the same level gives the same field
  const again = prepare(level);
  assert.deepEqual(again.nav.pass, rt.nav.pass);
});
