// Your marks (src/marks.js): the boxes and roles a player draws on a photo
// become the same reply shape the models would give, and go through the
// same tracer, level builder and proof. No page, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../src/marks.js';
import { ROLES, LABELS, ORIGINS, validateLevel } from '../src/level.js';
import { REPLY_SCHEMA } from '../src/reply.js';
import { rooms } from './replies.js';
import { fillRings } from '../src/raster.js';
import { snugBox } from '../src/trace_in_box.js';

const quick = () => Promise.resolve();
const SHA = 'ab'.repeat(32);
// the desk's objects as a player would mark them: each box 8 px
// loose around the object, flat things marked as obstacles
const deskMarks = (grow = 8) => rooms.desk.room.objects.filter((o) => o.on_surface).map((o) => ({
  role: o.role === 'flat' ? 'solid' : o.role,
  box: [o.bounds.x0 - grow, o.bounds.y0 - grow, o.bounds.x1 + grow, o.bounds.y1 + grow],
}));
// a plain grey picture
const grey = (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(128) });

test('the roles a box can take are a short set the level builder already knows', () => {
  assert.deepEqual(M.MARK_ROLES.map((r) => r.role), ['collect', 'solid', 'avoid', 'exit']);
  for (const r of M.MARK_ROLES) assert.ok(ROLES.includes(r.role), r.role);
  assert.deepEqual(M.MARK_ROLES.map((r) => r.words), ['a coin to collect', 'an obstacle to walk around', 'a hazard to avoid', 'the exit']);
  assert.deepEqual(M.MARK_ROLES.map((r) => r.key), ['1', '2', '3', '4']);
  assert.ok(ORIGINS.includes('marked'));
  assert.equal(LABELS.marked, 'MARKED BY YOU · outlines traced by code; no model was called');
});

test('boxes stay whole inside the picture, in order, never smaller than the least side', () => {
  assert.deepEqual(M.clampBox([50.4, 80.6, 10, -5], 100, 100), [10, 0, 50, 81]);
  assert.deepEqual(M.clampBox([-10, 20, 140, 30], 100, 50), [0, 20, 100, 30]);
  assert.equal(M.bigEnough([0, 0, 8, 8]), true);
  assert.equal(M.bigEnough([0, 0, 7, 40]), false);
  assert.deepEqual(M.moveBox([10, 10, 30, 20], 100, 0, 100, 100), [80, 10, 100, 20], 'moved to the edge, its size kept');
  assert.deepEqual(M.moveBox([10, 10, 30, 20], -50, -50, 100, 100), [0, 0, 20, 10]);
  assert.deepEqual(M.resizeBox([10, 10, 30, 20], -40, 5, 100, 100), [10, 10, 18, 25], 'never under 8 px');
  assert.deepEqual(M.resizeBox([10, 10, 30, 20], 500, 500, 100, 60), [10, 10, 100, 60], 'never past the picture');
});

test('the box under a point is the smallest that holds it; names are numbered within their kind', () => {
  const marks = [{ role: 'solid', box: [0, 0, 100, 100] }, { role: 'collect', box: [40, 40, 60, 60] }, { role: 'collect', box: [70, 70, 90, 90] }, { role: 'exit', box: [10, 10, 30, 30] }];
  assert.equal(M.markAt(marks, 50, 50), 1, 'the coin inside the obstacle stays reachable');
  assert.equal(M.markAt(marks, 5, 95), 0);
  assert.equal(M.markAt(marks, 150, 50), -1);
  assert.deepEqual(M.markNames(marks), ['obstacle', 'coin 1', 'coin 2', 'exit']);
});

test('the live line says what the room still needs to be winnable', () => {
  const coin = { role: 'collect', box: [0, 0, 10, 10] };
  const exit = { role: 'exit', box: [20, 0, 30, 10] };
  const wall = { role: 'solid', box: [40, 0, 50, 10] };
  assert.match(M.needs([]).line, /^Draw a box over an object to mark it\. The room needs at least one coin and an exit\.$/);
  assert.equal(M.needs([wall]).line, 'Add at least one coin and an exit.');
  assert.equal(M.needs([coin]).line, 'Add an exit.');
  assert.equal(M.needs([exit, wall]).line, 'Add at least one coin.');
  assert.equal(M.needs([coin, exit, exit]).line, 'Keep one exit: change or remove 1 of the 2.');
  assert.deepEqual(M.needs([coin, exit, wall]), { ready: true, line: 'Ready: 1 coin, the exit and 1 other box. Make the room, and code checks it can be won.' });
  for (const m of [[], [wall], [coin], [exit], [coin, exit, exit]]) assert.equal(M.needs(m).ready, false);
  // no exit, but another box to make it from: the level builder repairs it
  assert.deepEqual(M.needs([coin, coin, coin]), { ready: true, line: 'Ready: 3 coins, but no exit: code makes one box the exit and says which. Make the room, and code checks it can be won.' });
  assert.match(M.needs([coin, wall]).line, /^Ready: 1 coin and 1 other box, but no exit:/);
});

test('a marked room with only coins and no exit is repaired: the farthest coin becomes the exit, in words', async () => {
  const coins = [
    { role: 'collect', box: [40, 180, 60, 200] },
    { role: 'collect', box: [150, 120, 170, 140] },
    { role: 'collect', box: [260, 60, 280, 80] },
  ];
  const r = await M.makeMarkedRoom({ marks: coins, picture: null, pixels: grey(320, 240), sha256: SHA, yieldNow: quick });
  assert.equal(r.ok, true, r.words);
  const { level } = r.entry.built;
  // the start is at the bottom; coin 3, top right, is the farthest
  assert.deepEqual(level.objects.map((o) => o.role), ['collect', 'collect', 'exit']);
  assert.deepEqual(level.changes_by_code, [{ what: 'The coin 3 became the exit', why: 'No exit was found' }]);
  assert.ok(level.proof.winnable);
  assert.ok(validateLevel(JSON.parse(JSON.stringify(level))).ok);
});

test('marks read back from the device: only known roles and boxes big enough inside the photo', () => {
  assert.equal(M.sanitizeMarks('nope', 100, 100), null);
  const kept = M.sanitizeMarks([
    { role: 'collect', box: [1, 2, 30, 40] },
    { role: 'flat', box: [1, 2, 30, 40] },
    { role: 'exit', box: [1, 2, 4, 40] },
    { role: 'exit', box: [1, 2, 'x', 40] },
    { role: 'avoid', box: [-20, -20, 500, 500] },
    null,
  ], 100, 100);
  assert.deepEqual(kept, [{ role: 'collect', box: [1, 2, 30, 40] }, { role: 'avoid', box: [0, 0, 100, 100] }]);
  assert.equal(M.sanitizeMarks(Array.from({ length: 40 }, () => ({ role: 'solid', box: [0, 0, 20, 20] })), 100, 100).length, M.MAX_MARKS);
});

test('the marks make the very reply shape the models give: names and roles from the set, the player’s boxes', () => {
  const marks = deskMarks();
  const reply = M.markedReply(marks, 1024, 768);
  assert.equal(reply.schema, REPLY_SCHEMA);
  assert.equal(reply.status, 'ok');
  assert.deepEqual(reply.provenance, { mode: 'marked', label: LABELS.marked, models: [] }, 'no model named');
  assert.deepEqual(reply.received, { width: 1024, height: 768 });
  assert.equal(reply.objects.length, marks.length);
  reply.objects.forEach((o, k) => {
    assert.equal(o.role, marks[k].role);
    assert.equal(o.name, M.roleOf(marks[k].role).name);
    assert.deepEqual(o.box, M.clampBox(marks[k].box, 1024, 768));
    assert.equal(o.confidence, null);
    assert.match(o.reason, /^You marked (it|\w+ \d) as /);
  });
  assert.deepEqual(reply.objects.filter((o) => o.name === 'coin').map((o) => o.instance), [1, 2, 3]);
});

test('the desk, marked by hand: traced inside the boxes on the very pixels, built and proved, no model', async () => {
  const marks = deskMarks();
  const r = await M.makeMarkedRoom({ marks, picture: 'the photo', pixels: rooms.desk.pixels, sha256: SHA, yieldNow: quick });
  assert.equal(r.ok, true, r.words);
  const { level } = r.entry.built;
  assert.equal(level.origin, 'marked');
  assert.equal(level.label, LABELS.marked);
  assert.deepEqual(level.provenance.models, []);
  assert.deepEqual(level.picture, { kind: 'marked', sha256: SHA, width: 1024, height: 768 });
  assert.equal(level.objects.length, marks.length);
  assert.ok(level.proof.winnable);
  assert.ok(validateLevel(level).ok, 'and it validates again, as a kept level must');
  const c = level.provenance.outline_sources;
  assert.equal((c.traced_in_box || 0) + (c.box || 0), marks.length, 'each box traced, or kept as a box');
  assert.ok(c.traced_in_box >= 6, `most of the snug boxes trace tight (${c.traced_in_box})`);
  assert.equal(M.markedWords(level), `You marked 9 objects; code traced ${c.traced_in_box} ${c.traced_in_box === 1 ? 'outline' : 'outlines'} inside your boxes and kept ${c.box} ${c.box === 1 ? 'as a box' : 'as boxes'}; no model was called.`);
  // aligned: each traced outline sits on its painted object, though the box was loose
  const onSurface = rooms.desk.room.objects.filter((o) => o.on_surface);
  level.objects.forEach((o, k) => {
    if (o.outline.source !== 'traced_in_box') return;
    const got = fillRings(o.outline.rings, 1024, 768), want = fillRings(onSurface[k].rings, 1024, 768);
    let i = 0, u = 0;
    for (let p = 0; p < got.length; p++) { if (got[p] && want[p]) i++; if (got[p] || want[p]) u++; }
    assert.ok(i / u >= 0.85, `${o.name} ${o.instance}: IoU ${(i / u).toFixed(3)}`);
  });
  assert.equal(r.entry.picture, 'the photo');
  assert.deepEqual(r.entry.marks, marks.map((m) => ({ role: m.role, box: M.clampBox(m.box, 1024, 768) })));
});

test('a box the trace cannot fit is kept as a box, and said so', async () => {
  // a plain grey photo holds no edges to trace on
  const marks = [{ role: 'collect', box: [100, 300, 160, 340] }, { role: 'exit', box: [400, 300, 500, 380] }, { role: 'solid', box: [250, 280, 330, 360] }];
  const r = await M.makeMarkedRoom({ marks, picture: null, pixels: grey(640, 480), sha256: SHA, yieldNow: quick });
  assert.equal(r.ok, true, r.words);
  const level = r.entry.built.level;
  assert.deepEqual(level.objects.map((o) => o.outline.source), ['box', 'box', 'box']);
  assert.match(M.markedWords(level), /^You marked 3 objects; code traced 0 outlines inside your boxes and kept 3 as boxes; no model was called\.$/);
});

test('marks that cannot make a winnable room say exactly why, and nothing is made', async () => {
  const notYet = await M.makeMarkedRoom({ marks: [{ role: 'collect', box: [10, 10, 40, 40] }], picture: null, pixels: grey(320, 240), sha256: SHA, yieldNow: quick });
  assert.deepEqual(notYet, { ok: false, words: 'Not yet: Add an exit.' });
  const tiny = await M.makeMarkedRoom({ marks: [{ role: 'collect', box: [10, 10, 12, 40] }], picture: null, pixels: grey(320, 240), sha256: SHA, yieldNow: quick });
  assert.match(tiny.words, /smaller than 8 px or outside the photo/);
  // the only coin behind a hazard that spans the photo, the exit in front:
  // the room is repaired (the hazard is collected instead), and says so
  const walled = [
    { role: 'collect', box: [150, 20, 170, 60] },
    { role: 'avoid', box: [0, 120, 320, 200] },
    { role: 'exit', box: [140, 205, 180, 236] },
  ];
  const fixed = await M.makeMarkedRoom({ marks: walled, picture: null, pixels: grey(320, 240), sha256: SHA, yieldNow: quick });
  assert.equal(fixed.ok, true, fixed.words);
  assert.deepEqual(fixed.entry.built.level.changes_by_code, [
    { what: 'The coin is solid', why: 'Out of reach' },
    { what: 'The hazard became a collectible', why: 'Nothing else could be collected' },
  ]);
  // the only coin drawn inside the exit's own footprint: nothing can repair it
  const inside = [
    { role: 'collect', box: [150, 180, 170, 198] },
    { role: 'exit', box: [100, 120, 220, 200] },
  ];
  const r = await M.makeMarkedRoom({ marks: inside, picture: null, pixels: grey(320, 240), sha256: SHA, yieldNow: quick });
  assert.equal(r.ok, false);
  assert.equal(r.words, 'These marks do not make a room that can be won: The explorer cannot walk to the coin on the floor, and the exit alone cannot be both the exit and a thing to collect. Move, change or remove a box, then make the room again.');
  assert.doesNotMatch(r.words, /Try a sample room or another photo/, 'only the ways this screen offers');
  assert.ok(!('entry' in r));
});

test('a kept marked level is used only for its own photo and size, and its proof is checked again', async () => {
  const r = await M.makeMarkedRoom({ marks: deskMarks(), picture: 'p', pixels: rooms.desk.pixels, sha256: SHA, yieldNow: quick });
  const level = JSON.parse(JSON.stringify(r.entry.built.level));
  const kept = { sha256: SHA, marks: deskMarks(), level };
  const pic = { width: 1024, height: 768 };
  const e = M.keptMarkedEntry(kept, SHA, pic);
  assert.ok(e && e.fromDevice && e.built.level.proof.winnable);
  assert.equal(e.marks.length, 9);
  assert.equal(M.keptMarkedEntry(kept, 'cd'.repeat(32), pic), null, 'another photo');
  assert.equal(M.keptMarkedEntry(kept, SHA, { width: 512, height: 384 }), null, 'another size');
  assert.equal(M.keptMarkedEntry({ ...kept, level: null }, SHA, pic), null, 'marks not made into a room yet');
  assert.equal(M.keptMarkedEntry({ ...kept, level: { ...level, origin: 'live', label: LABELS.live } }, SHA, pic), null, 'only a marked level');
  const broken = JSON.parse(JSON.stringify(level));
  for (const o of broken.objects) if (o.role === 'exit') o.role = 'solid';
  assert.equal(M.keptMarkedEntry({ ...kept, level: broken }, SHA, pic), null, 'a stored level that no longer proves winnable');
});

test('marks.js is pure: no page, no network, and it never names a model', () => {
  const src = readFileSync(new URL('../src/marks.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|document|window)\b/);
  assert.doesNotMatch(src, /muse|sam-3/i);
});

test('a loose box is first made snug around what stands out in it; nothing stands out in a plain one', () => {
  const coin = rooms.desk.room.objects.find((o) => o.id === 'coin1').bounds;
  const loose = [coin.x0 - 20, coin.y0 - 20, coin.x1 + 20, coin.y1 + 20];
  const snug = snugBox(rooms.desk.pixels, loose);
  assert.ok(snug, 'found');
  for (const [k, v] of [coin.x0, coin.y0, coin.x1, coin.y1].entries()) assert.ok(Math.abs(snug[k] - v) <= 4, `side ${k}: ${snug[k]} for ${v}`);
  assert.equal(snugBox(grey(320, 240), [40, 40, 120, 120]), null);
});
