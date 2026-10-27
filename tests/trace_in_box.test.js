import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRoom } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { fillRings, maskBounds } from '../src/raster.js';
import { pointInShape } from '../src/geom.js';
import { traceInBox, FlowGraph } from '../src/trace_in_box.js';
import { buildLevel } from '../src/level.js';
import { inputFromReply } from '../src/reply.js';
import { jpegLike } from './jpegsim.js';
import { decodePNG } from './png.js';

const painted = new Map();
function room(id) {
  if (painted.has(id)) return painted.get(id);
  const r = loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
  const out = paintRoom(r);
  // rendered, then JPEG-compressed like the copy the page sends (quality 0.9)
  const entry = { room: r, pixels: { width: r.width, height: r.height, data: jpegLike(out.rgba, r.width, r.height, 90) } };
  painted.set(id, entry);
  return entry;
}

function iou(a, b) {
  let i = 0, u = 0;
  for (let p = 0; p < a.length; p++) { if (a[p] && b[p]) i++; if (a[p] || b[p]) u++; }
  return u ? i / u : 1;
}

// SAM's exact box of an object, and one seed point at its centre (what the
// stand-in sends for each match)
function samBox(o, W, H) {
  const b = maskBounds(fillRings(o.rings, W, H), W, H);
  return { box: [b.x0, b.y0, b.x1, b.y1], seeds: [[(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]] };
}

for (const id of ['desk', 'living']) {
  test(`${id}: every traced outline has IoU of at least 0.9 against the exact outline`, () => {
    const { room: r, pixels } = room(id);
    const W = r.width, H = r.height;
    for (const o of r.objects) {
      if (!o.on_surface) continue; // scenery is never sent to SAM
      const { box, seeds } = samBox(o, W, H);
      const res = traceInBox(pixels, box, seeds);
      assert.equal(res.source, 'traced_in_box', `${o.id}: ${res.why}`);
      const score = iou(fillRings(res.rings, W, H), fillRings(o.rings, W, H));
      assert.ok(score >= 0.9, `${o.id}: IoU ${score.toFixed(3)}`);
      const again = traceInBox(pixels, box, seeds);
      assert.deepEqual(again.rings, res.rings, `${o.id}: the same answer every run`);
    }
  });
}

test('traced outlines from a rehearsal reply build winnable levels', () => {
  for (const id of ['desk', 'living']) {
    const { room: r, pixels } = room(id);
    const objects = r.objects.filter((o) => o.on_surface).map((o, k) => {
      const { box, seeds } = samBox(o, r.width, r.height);
      return { id: `o${k + 1}`, name: o.name, instance: o.instance, role: o.role, reason: o.reason, on_surface: true, box, confidence: 0.9, seeds };
    });
    const reply = {
      request_id: 'r1',
      provenance: { mode: 'rehearsal', models: [] },
      received: { width: r.width, height: r.height },
      scene: { title: r.title, theme_line: r.theme_line },
      surface: null,
      objects,
    };
    const outlines = objects.map((o) => traceInBox(pixels, o.box, o.seeds));
    const built = buildLevel(inputFromReply(reply, { kind: 'sample', id }, (o, k) => ({ source: outlines[k].source, rings: outlines[k].rings })));
    assert.ok(!built.error, `${id}: ${built.error}`);
    assert.equal(built.level.provenance.outline_sources.traced_in_box, objects.length);
    assert.ok(built.level.proof.winnable);
  }
});

test('the mug’s handle hole stays open; the chair keeps its legs apart', () => {
  const desk = room('desk');
  const mug = desk.room.objects.find((o) => o.id === 'mug');
  const m = samBox(mug, 1024, 768);
  const res = traceInBox(desk.pixels, m.box, m.seeds);
  assert.ok(res.rings.length >= 2, 'an outer ring and the handle hole');
  // the middle of the handle's hole: inside the outer ring, outside the shape
  const hole = [648.5, 436.5];
  assert.ok(pointInShape(hole[0], hole[1], [mug.rings[0]]) && !pointInShape(hole[0], hole[1], mug.rings), 'the sample mug has a handle hole');
  assert.equal(pointInShape(hole[0], hole[1], res.rings), false, 'the hole is not filled');
  const living = room('living');
  const chair = living.room.objects.find((o) => o.id === 'chair');
  const c = samBox(chair, 1024, 768);
  const cr = traceInBox(living.pixels, c.box, c.seeds);
  assert.equal(pointInShape(440.5, 500.5, cr.rings), false, 'the floor between the legs is not chair');
  assert.equal(pointInShape(388.5, 505.5, cr.rings), true, 'a leg is chair');
});

test('an object the same colour as its background falls back to its box', () => {
  const W = 200, H = 150;
  const data = new Uint8ClampedArray(W * H * 4);
  let s = 7;
  for (let i = 0; i < W * H; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const g = (s >> 16) % 7 - 3;
    data[4 * i] = 150 + g; data[4 * i + 1] = 120 + g; data[4 * i + 2] = 90 + g; data[4 * i + 3] = 255;
  }
  const box = [60, 40, 130, 110];
  const res = traceInBox({ width: W, height: H, data }, box, [[95, 75]]);
  assert.equal(res.source, 'box');
  assert.ok(res.why && res.why.length > 10, 'the reason in words');
  assert.deepEqual(res.rings, [[[60, 40], [130, 40], [130, 110], [60, 110]]]);
});

test('a box with no background around it falls back too', () => {
  const W = 40, H = 30;
  const data = new Uint8ClampedArray(W * H * 4).fill(200);
  const res = traceInBox({ width: W, height: H, data }, [0, 0, W, H], []);
  assert.equal(res.source, 'box');
});

test('the max-flow solver finds the minimum cut', () => {
  // the textbook example: max flow 23
  const g = new FlowGraph(4);
  const S = g.s, T = g.t;
  g.edge(S, 0, 16); g.edge(S, 1, 13); g.edge(0, 2, 12); g.edge(1, 0, 4);
  g.edge(1, 3, 14); g.edge(2, 1, 9); g.edge(2, T, 20); g.edge(3, 2, 7); g.edge(3, T, 4);
  assert.equal(g.maxflow(), 23);
  const side = g.sourceSide();
  assert.equal(side[S], 1);
  assert.equal(side[T], 0);
  // random graphs: the flow equals the capacity of the cut it reports
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let trial = 0; trial < 30; trial++) {
    const n = 6 + Math.floor(rnd() * 10);
    const fg = new FlowGraph(n);
    const edges = [];
    for (let k = 0; k < n * 3; k++) {
      const a = Math.floor(rnd() * (n + 2)), b = Math.floor(rnd() * (n + 2));
      if (a === b || a === fg.t || b === fg.s) continue;
      const c = Math.round(rnd() * 20);
      fg.edge(a, b, c);
      edges.push([a, b, c]);
    }
    const flow = fg.maxflow();
    const ss = fg.sourceSide();
    const cut = edges.reduce((sum, [a, b, c]) => sum + (ss[a] && !ss[b] ? c : 0), 0);
    assert.ok(Math.abs(flow - cut) < 1e-6, `trial ${trial}: flow ${flow} cut ${cut}`);
  }
});

// The desk's cactus corner exactly as a real browser decoded the page's own
// JPEG (tests/fixtures, 150x250 from (780, 290)), with the stand-in's box
// and seed for it. On the 96-cell grid its terracotta pot, close to the
// desk's colour, is cut off, so the trace is not tight; the second look
// keeps the whole cactus, pot and all.
test('the cactus traces whole through a real browser’s JPEG, by a second look', () => {
  const crop = decodePNG(readFileSync(new URL('./fixtures/desk_cactus_edge.png', import.meta.url)));
  const [ox, oy] = [780, 290];
  const box = [806 - ox, 330 - oy, 898 - ox, 508 - oy];
  const seeds = [[852 - ox, 419.3 - oy]];
  assert.equal(traceInBox(crop, box, seeds, { maxCells: 96 }).source, 'box', 'the first look alone falls back (the case this guards)');
  const t = traceInBox(crop, box, seeds);
  assert.equal(t.source, 'traced_in_box', t.why);
  const desk = room('desk').room;
  const cactus = desk.objects.find((o) => o.id === 'cactus');
  const truth = fillRings(cactus.rings.map((r) => r.map(([x, y]) => [x - ox, y - oy])), crop.width, crop.height);
  const v = iou(fillRings(t.rings, crop.width, crop.height), truth);
  assert.ok(v >= 0.9, `IoU ${v.toFixed(3)} against the painted cactus`);
  // and a shape that is not tight still falls back after every look
  const blank = { width: crop.width, height: crop.height, data: new Uint8ClampedArray(crop.data.length).fill(128) };
  assert.equal(traceInBox(blank, box, seeds).source, 'box');
});
