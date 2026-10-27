// W1a: the play area is the floor itself. Code grows it from Muse Spark's
// points on the open floor inside SAM's floor boxes; walls are everything
// that is not floor; doorways are where the floor runs on from one room to
// the next. Without a floor, the level keeps to the horizon and says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { levelFromReply } from '../src/own.js';
import { loadRoom } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { fillRings } from '../src/raster.js';
import { traceFloor, floorFromReply } from '../src/trace_in_box.js';
import { buildLevel, floorRooms, validateLevel } from '../src/level.js';
import { jpegLike } from './jpegsim.js';

const CREATED = '2026-10-27T12:00:00Z';
const rect = (x, y, w, h) => ({ rect: [x, y, w, h] });

// A small floor plan seen from above: three rooms (wood, tile, carpet)
// inside dark walls; the wood room opens to the tile room, the tile room to
// the carpet room, and the wood room and the carpet room share a wall with
// no doorway in it.
export const PLAN_ROOMS = { wood: [34, 34, 280, 200], tile: [328, 34, 258, 200], carpet: [34, 248, 552, 178] };
export const PLAN_DOORS = { woodTile: [314, 100, 14, 50], tileCarpet: [420, 234, 50, 14] };
export function planJson(objects = []) {
  const R = PLAN_ROOMS, D = PLAN_DOORS;
  return {
    schema: 'frameplay.room/1', id: 'plan', title: 'A plan', theme_line: '', width: 640, height: 480, seed: 7, view: 'top_down',
    background: [
      { shape: rect(0, 0, 640, 480), paint: '#efebe4', grain: 2 },
      { shape: rect(20, 20, 580, 420), paint: '#2f2b28', grain: 2 },
    ],
    surface: {
      name: 'floor',
      shape: { rings: [rect(...R.wood), rect(...R.tile), rect(...R.carpet), rect(...D.woodTile), rect(...D.tileCarpet)] },
      seeds: [[60, 60], [560, 60], [300, 400]],
      paint: { linear: [0, 34, 0, 234], stops: ['#c08a55', '#a87444'] }, grain: 5,
    },
    foreground: [
      { shape: { rings: [rect(...R.tile), rect(...D.tileCarpet)] }, paint: '#d6dadc', grain: 3 },
      { shape: rect(...R.carpet), paint: '#8597ad', grain: 4 },
    ],
    objects,
  };
}

const boxOf = ([x, y, w, h]) => [x, y, x + w, y + h];
const iou = (a, b) => {
  let i = 0, u = 0;
  for (let p = 0; p < a.length; p++) { if (a[p] && b[p]) i++; if (a[p] || b[p]) u++; }
  return u ? i / u : 1;
};

function plan(objects) {
  const json = planJson(objects);
  const room = loadRoom(json);
  return { json, room, pixels: { width: 640, height: 480, data: jpegLike(paintRoom(room).rgba, 640, 480, 90) } };
}

test('the floor of a floor plan: every room and doorway, never a wall', () => {
  const { json, room, pixels } = plan();
  const t = traceFloor(pixels, Object.values(PLAN_ROOMS).map(boxOf), json.surface.seeds);
  assert.equal(t.source, 'traced_floor', t.why);
  const truth = fillRings(room.surface.rings, 640, 480);
  assert.ok(iou(t.mask, truth) > 0.97, `IoU ${iou(t.mask, truth)}`);
  const at = (x, y) => t.mask[y * 640 + x];
  for (const [x, y] of [[321, 125], [445, 241]]) assert.equal(at(x, y), 1, `the doorway at ${x},${y} is floor`);
  for (const [x, y] of [[321, 60], [321, 200], [200, 241], [10, 10], [25, 300]]) assert.equal(at(x, y), 0, `the wall at ${x},${y} is not`);
  // the rooms and the doorways between them
  const f = floorRooms(t.mask, 640, 480);
  assert.equal(f.rooms, 3);
  assert.equal(f.doorways.length, 2);
  const near = (d, [x, y, w, h]) => Math.abs(d.x - (x + w / 2)) < 12 && Math.abs(d.y - (y + h / 2)) < 12;
  assert.ok(f.doorways.some((d) => near(d, PLAN_DOORS.woodTile)), JSON.stringify(f.doorways));
  assert.ok(f.doorways.some((d) => near(d, PLAN_DOORS.tileCarpet)), JSON.stringify(f.doorways));
  for (const d of f.doorways) assert.ok(d.width >= 40 && d.width <= 56, `width ${d.width}`);
});

test('the floor of an eye-level room: the painted floor, not the wall above it', () => {
  const json = JSON.parse(readFileSync(new URL('../rooms/living.json', import.meta.url), 'utf8'));
  const room = loadRoom(json);
  const W = room.width, H = room.height;
  const pixels = { width: W, height: H, data: jpegLike(paintRoom(room).rgba, W, H, 90) };
  const t = traceFloor(pixels, [[0, 332, 1024, 768]], json.surface.seeds);
  assert.equal(t.source, 'traced_floor', t.why);
  const floor = fillRings(room.surface.rings, W, H);
  let missed = 0, above = 0, all = 0;
  const things = new Uint8Array(W * H);
  for (const o of room.objects) if (o.on_surface) { const m = fillRings(o.rings, W, H); for (let i = 0; i < m.length; i++) if (m[i]) things[i] = 1; }
  for (let i = 0; i < floor.length; i++) {
    if (floor[i] && !things[i]) { all++; if (!t.mask[i]) missed++; }
    if (!floor[i] && t.mask[i]) above++;
  }
  assert.ok(missed < 0.01 * all, `missed ${missed} of ${all} px of bare floor`);
  assert.ok(above < 0.01 * all, `${above} px above the floor`);
  // the sofa (another colour) is not floor
  const sofa = fillRings(room.objects.find((o) => o.id === 'sofa').rings, W, H);
  let onSofa = 0;
  for (let i = 0; i < sofa.length; i++) if (sofa[i] && t.mask[i]) onSofa++;
  assert.equal(onSofa, 0);
});

test('no floor: the level keeps to the horizon, and says why in words', () => {
  const pixels = plan().pixels;
  const live = (floor) => ({ provenance: { mode: 'live' }, surface: { name: 'floor' }, floor });
  assert.deepEqual(floorFromReply(live(undefined), pixels), { view: null, floor: { source: 'horizon', words: 'The read said nothing of the floor, so the play area is everything below the horizon.' } });
  assert.equal(floorFromReply(live({ view: 'eye_level', seeds: [], boxes: [[0, 0, 9, 9]] }), pixels).floor.words,
    'Muse Spark gave no points on the floor, so the play area is everything below the horizon.');
  assert.equal(floorFromReply(live({ view: 'top_down', seeds: [[60, 60]], boxes: [] }), pixels).floor.words,
    'SAM 3.1 found no floor, so the whole picture is the play area.');
  assert.equal(floorFromReply(live({ view: 'top_down', seeds: [[5, 470]], boxes: [[34, 34, 314, 234]] }), pixels).floor.words,
    'Muse Spark’s points on the floor fell outside SAM 3.1’s floor boxes, so the whole picture is the play area.');
  const rehearsal = { ...live({ view: 'eye_level', seeds: [], boxes: [] }), provenance: { mode: 'rehearsal' } };
  assert.match(floorFromReply(rehearsal, pixels).floor.words, /^The stand-in for Muse Spark gave no points/);
  // junk is never traced
  assert.equal(floorFromReply(live({ view: 'up', seeds: [['a', 1]], boxes: [[0, 0, 'x', 1]] }), pixels).view, null);
});

test('a traced floor: the play area is the floor, the words say how it was found', () => {
  const objs = [
    { id: 'coin', name: 'coin', role: 'collect', reason: 'Shiny', shape: { ellipse: [500, 150, 9, 9] }, paint: '#e9c23a' },
    { id: 'table', name: 'table', role: 'solid', reason: 'In the way', shape: rect(120, 300, 80, 60), paint: '#5b3b22' },
    { id: 'door', name: 'door', role: 'exit', reason: 'Out', shape: rect(500, 395, 60, 20), paint: '#3f7a4c' },
  ];
  const { json, pixels } = plan(objs);
  const reply = {
    schema: 'frameplay.room.reply/2', request_id: 'r1', status: 'ok',
    provenance: { mode: 'live', label: 'LIVE · Meta Model API · muse-spark-1.3 and sam-3.1', models: ['muse-spark-1.3', 'sam-3.1'] },
    received: { width: 640, height: 480 },
    scene: { title: 'Plan', theme_line: '', view: 'top_down' },
    surface: { name: 'floor', box: [34, 34, 586, 426], confidence: 0.9 },
    floor: { view: 'top_down', seeds: json.surface.seeds, boxes: Object.values(PLAN_ROOMS).map(boxOf) },
    objects: objs.map((o, k) => {
      const r = loadRoom({ ...json, objects: [o] }).objects[0].bounds;
      return { id: `o${k + 1}`, name: o.name, role: o.role, reason: o.reason, box: [r.x0, r.y0, r.x1, r.y1].map(Math.round), confidence: 0.9 };
    }),
  };
  const f = floorFromReply(reply, pixels);
  assert.equal(f.view, 'top_down');
  assert.equal(f.surface.source, 'traced_floor');
  assert.equal(f.floor.words, 'Code grew the floor from Muse Spark’s 3 points on it inside SAM 3.1’s 3 boxes for it; everything else is wall.');
  const input = {
    origin: 'live', picture: { kind: 'photo', sha256: 'x', width: 640, height: 480 }, title: 'Plan',
    objects: reply.objects.map((o) => ({ ...o, outline: { source: 'box', rings: [[[o.box[0], o.box[1]], [o.box[2], o.box[1]], [o.box[2], o.box[3]], [o.box[0], o.box[3]]]] } })),
    provenance: { created: CREATED }, ...f,
  };
  const built = buildLevel(input);
  assert.ok(!built.error, built.error);
  const { level, rt } = built;
  assert.equal(level.view, 'top_down');
  assert.equal(level.provenance.floor.source, 'traced_floor');
  assert.equal(level.surface.rooms, 3);
  assert.equal(level.surface.doorways.length, 2);
  const at = (x, y) => rt.walk[y * 640 + x];
  assert.equal(at(321, 60), 0, 'a wall');
  assert.equal(at(10, 10), 0, 'outside the walls');
  assert.equal(at(321, 125), 1, 'a doorway');
  assert.equal(at(160, 330), 0, 'seen from above, the whole table blocks');
  assert.equal(at(160, 290), 1, 'beside the table');
  assert.equal(level.surface.horizon_y, 0, 'seen from above there is no horizon');
  assert.ok(validateLevel(JSON.parse(JSON.stringify(level))).ok);
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
// A sample room's answers from the stand-in through the real pipeline, in
// one process with no socket (server/tests/standin_replay.py).
export function standInReply(room, golden = false) {
  const out = execFileSync(PYTHON, ['-B', '-m', 'server.tests.standin_replay', '--room', room, ...(golden ? ['--golden'] : [])], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  return JSON.parse(out);
}
// The first live desk answers (10-27) through the pipeline (server/tests/recorded.py).
const recordedReply = () => JSON.parse(execFileSync(PYTHON, ['-B', '-m', 'server.tests.recorded'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 }));

test('REHEARSAL: both old rooms through the stand-in get a traced floor and stay winnable', { timeout: 120000 }, async () => {
  for (const id of ['desk', 'living']) {
    const reply = standInReply(id);
    assert.equal(reply.status, 'ok');
    const room = loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
    const W = room.width, H = room.height;
    const pixels = { width: W, height: H, data: jpegLike(paintRoom(room).rgba, W, H, 90) };
    const entry = await levelFromReply(reply, { width: W, height: H }, pixels, { kind: 'sample', id }, () => Promise.resolve());
    assert.equal(entry.built.error, undefined, `${id}: ${entry.built.error}`);
    const { level, rt } = entry.built;
    assert.equal(level.origin, 'rehearsal');
    assert.equal(level.surface.source, 'traced_floor', id);
    assert.match(level.provenance.floor.words, /^Code grew the (desk|floor) from the stand-in for Muse Spark’s/);
    assert.ok(level.proof.winnable, id);
    // off the surface is a wall: above it, and (the desk) past its front edge
    assert.equal(rt.walk[300 * W + 512], 0, `${id}: above the surface`);
    if (id === 'desk') assert.equal(rt.walk[740 * W + 512], 0, 'below the desk’s front edge');
  }
});

test('the recorded desk read (from before floor points) keeps the horizon, said in words', { timeout: 120000 }, async () => {
  const reply = recordedReply();
  const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
  const pixels = { width: room.width, height: room.height, data: jpegLike(paintRoom(room).rgba, room.width, room.height, 90) };
  const entry = await levelFromReply(reply, { width: room.width, height: room.height }, pixels, { kind: 'photo', sha256: 'recorded' }, () => Promise.resolve());
  const { level } = entry.built;
  assert.ok(level.proof.winnable);
  assert.equal(level.view, 'eye_level');
  // played back under a rehearsal's settings, so the words name the stand-in
  assert.deepEqual(level.provenance.floor, { source: 'horizon', words: 'The stand-in for Muse Spark gave no points on the floor, so the play area is everything below the horizon.' });
  assert.equal(level.surface.source, 'box');
});

test('a sample room’s own floor is the play area; one room, no doorways', () => {
  for (const id of ['desk', 'living']) {
    const room = loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
    assert.equal(room.view, 'eye_level');
    const f = floorRooms(fillRings(room.surface.rings, room.width, room.height), room.width, room.height);
    assert.deepEqual(f, { rooms: 1, doorways: [] }, id);
  }
});
