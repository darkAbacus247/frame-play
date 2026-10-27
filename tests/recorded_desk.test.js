// The first live answers (10-27) for the desk sample picture, end to end:
// the recorded Muse Spark read and sam-3.1 answers are played back through
// the server's real pipeline by a test double (server/tests/recorded.py;
// nothing is sent anywhere), the server decodes SAM 3.1's masks into exact
// outlines, and the page builds the level from them on the desk picture. It
// must be the right room, every outline SAM's own mask lying on the
// painter's silhouette (IoU 0.95 or more for each thing nothing covers), and
// winnable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRoom } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { fillRings } from '../src/raster.js';
import { acceptReply } from '../src/reply.js';
import { levelFromReply } from '../src/own.js';
import { foundWords, fromPoints, maskWords, summaryLine } from '../src/screens.js';
import { jpegLike } from './jpegsim.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

export function recordedReply(args = []) {
  const out = execFileSync(PYTHON, ['-B', '-m', 'server.tests.recorded', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  return JSON.parse(out);
}

const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
const W = room.width, H = room.height;
const painted = paintRoom(room);
export const deskPixels = { width: W, height: H, data: jpegLike(painted.rgba, W, H, 90) };

const iou = (a, b) => {
  let i = 0, u = 0;
  for (let p = 0; p < a.length; p++) { if (a[p] && b[p]) i++; if (a[p] || b[p]) u++; }
  return u ? i / u : 1;
};

// Each painted object as the picture shows it (the painter's owner map:
// what stands in front of it is not it), and how much of it is covered.
const seen = room.objects.map((o, i) => {
  const own = fillRings(o.rings, W, H);
  const vis = new Uint8Array(W * H);
  let n = 0, v = 0;
  for (let k = 0; k < W * H; k++) {
    if (painted.owner[k] === i) { vis[k] = 1; v++; }
    if (own[k]) n++;
  }
  return { id: o.id, vis, hidden: 1 - v / n };
});
const HIDDEN = 0.05;
export const GOLDEN_IOU = 0.95;

// The golden replay's table: for each object, the painted thing it lies on,
// how much of that is covered, and the IoU of the outline with what the
// picture shows of it.
export function iouTable(level) {
  return level.objects.map((o) => {
    const got = fillRings(o.outline.rings, W, H);
    const best = seen.map((p) => ({ p, v: iou(got, p.vis) })).sort((a, b) => b.v - a.v)[0];
    return { object: `${o.name} ${o.instance}`, painted: best.p.id, source: o.outline.source, hidden: best.p.hidden, iou: best.v };
  });
}

test('the recorded desk answers become the right nine objects, outlined by SAM 3.1’s own masks, and a winnable room', { timeout: 120000 }, async () => {
  const reply = recordedReply();
  assert.equal(reply.status, 'ok', reply.error && reply.error.message);
  assert.ok(acceptReply(reply.provenance.mode, reply, { width: W, height: H }).ok);
  const entry = await levelFromReply(reply, { width: W, height: H }, deskPixels, { kind: 'photo', sha256: 'recorded' }, () => Promise.resolve());
  assert.equal(entry.built.error, undefined, entry.built.error);
  const { level } = entry.built;
  assert.ok(level.proof.winnable, 'code proved the room can be won');
  assert.ok(level.proof.route_length > 0);
  const names = level.objects.map((o) => o.name).sort();
  assert.deepEqual(names, ['blue notebook', 'book stack', 'cardboard box', 'coffee mug', 'desk lamp', 'gold coin', 'gold coin', 'gold coin', 'potted cactus']);
  const byId = Object.fromEntries(level.objects.map((o) => [o.id, o]));
  assert.equal(byId[level.rules.exit].name, 'cardboard box', 'the cardboard box is the exit');
  assert.deepEqual(level.rules.collect.map((id) => byId[id].name).sort(), ['blue notebook', 'gold coin', 'gold coin', 'gold coin']);
  assert.deepEqual(level.rules.avoid.map((id) => byId[id].name), ['potted cactus']);
  assert.deepEqual(level.changes_by_code, [], 'the room could be won as read');
  assert.equal(level.provenance.outline_sources.sam_mask, 9, 'every outline is SAM 3.1’s own mask');
  assert.equal(level.provenance.outline_sources.traced_in_box, 0, 'code traced none');
  // every outline sits on one painted object, no two on the same one, and
  // each thing nothing covers is outlined exactly
  const rows = iouTable(level);
  console.log(['', 'Golden replay: the recorded desk, outlines from SAM 3.1’s masks vs the painter',
    `${'object'.padEnd(16)} ${'painted'.padEnd(9)} ${'hidden'.padStart(7)} ${'IoU'.padStart(6)}  bar`,
    ...rows.map((r) => `${r.object.padEnd(16)} ${r.painted.padEnd(9)} ${(r.hidden * 100).toFixed(1).padStart(6)}% ${r.iou.toFixed(3).padStart(6)}  ${r.hidden > HIDDEN ? 'n/a (covered)' : r.iou >= GOLDEN_IOU ? 'ok' : 'FAIL'}`)].join('\n'));
  const used = new Set();
  for (const r of rows) {
    assert.equal(r.source, 'sam_mask', r.object);
    assert.ok(r.iou >= 0.85, `${r.object}: IoU ${r.iou.toFixed(3)}`);
    if (r.hidden <= HIDDEN) assert.ok(r.iou >= GOLDEN_IOU, `${r.object}: IoU ${r.iou.toFixed(3)} with what the picture shows of ${r.painted}`);
    assert.ok(!used.has(r.painted), `${r.object} sits on ${r.painted} twice`);
    used.add(r.painted);
  }
  assert.ok(rows.filter((r) => r.hidden <= HIDDEN).length >= 8, 'most things are uncovered, and held to the bar');
  // the mug's handle is open: a hole in its outline
  const mug = level.objects.find((o) => o.name === 'coffee mug');
  assert.equal(mug.outline.rings.length, 2, 'the mug and the hole in its handle');
  assert.equal(foundWords(level), 'SAM 3.1 found 9');
  assert.equal(maskWords(level), 'SAM 3.1’s masks gave 9 exact outlines; code traced 0');
  assert.match(summaryLine(level, entry.summary), /The stand-in for SAM 3\.1 found 9 of them\. The stand-in for SAM 3\.1’s masks gave 9 exact outlines; code traced 0\. Code then proved the room can be won\.$/);
  assert.equal(reply.provenance.found.words, 'The stand-in for SAM 3.1 found 9; its masks give 9 exact outlines.');
});

test('a mask that does not decode: that one thing is traced inside its box, and the words say so', { timeout: 120000 }, async () => {
  const reply = recordedReply(['--spoil-mask', 'coffee mug']);
  assert.equal(reply.status, 'ok');
  const mug = reply.objects.find((o) => o.name === 'coffee mug');
  assert.equal(mug.mask.decoded, false);
  assert.equal(mug.mask.rings, undefined, 'no outline is made up for it');
  const call = reply.provenance.calls.find((c) => c.noun === 'coffee mug');
  assert.deepEqual(call.diagnostics, ['mask_undecodable']);
  const entry = await levelFromReply(reply, { width: W, height: H }, deskPixels, { kind: 'photo', sha256: 'recorded' }, () => Promise.resolve());
  const { level } = entry.built;
  assert.ok(level.proof.winnable);
  const got = level.objects.find((o) => o.name === 'coffee mug');
  assert.ok(['traced_in_box', 'box'].includes(got.outline.source), got.outline.source);
  assert.equal(level.provenance.outline_sources.sam_mask, 8);
  assert.match(maskWords(level), /^SAM 3\.1’s masks gave 8 exact outlines; code traced 1 inside SAM’s box|^SAM 3\.1’s masks gave 8 exact outlines; code traced 0 and kept 1 as a box/);
  assert.equal(reply.provenance.found.words, 'The stand-in for SAM 3.1 found 9; its masks give 8 exact outlines, and code traces 1 inside its box.');
});

// Where SAM finds nothing for a thing, code traces around Muse Spark's own
// points for it: honest, smaller regions, said so in the reply and on the
// reveal. Each shape must lie on a real thing of the picture (most of it
// inside one painted object): no outline is invented on the bare desk.
async function levelWithout(args) {
  const reply = recordedReply(args);
  assert.equal(reply.status, 'ok', reply.error && reply.error.message);
  const entry = await levelFromReply(reply, { width: W, height: H }, deskPixels, { kind: 'photo', sha256: 'recorded' }, () => Promise.resolve());
  assert.equal(entry.built.error, undefined, entry.built.error);
  const { level } = entry.built;
  assert.ok(level.proof.winnable, 'code proved the room can be won');
  const painted = room.objects.filter((o) => o.on_surface).map((o) => fillRings(o.rings, W, H));
  for (const o of level.objects.filter((x) => /points/.test(x.outline.source))) {
    const got = fillRings(o.outline.rings, W, H);
    let area = 0;
    for (const v of got) area += v;
    const inside = Math.max(...painted.map((p) => { let i = 0; for (let k = 0; k < got.length; k++) if (got[k] && p[k]) i++; return i / area; }));
    if (o.outline.source === 'traced_at_points') assert.ok(inside >= 0.75, `${o.name} ${o.instance}: only ${inside.toFixed(2)} on a painted object`);
    assert.equal(o.confidence, null, 'no confidence is made up');
  }
  return { reply, level, entry };
}

test('SAM finds some: the rest are traced around Muse Spark’s points, and the reveal says so', { timeout: 120000 }, async () => {
  const { reply, level, entry } = await levelWithout(['--none-for', 'coffee mug,gold coin']);
  assert.deepEqual(reply.provenance.found, { sam: 5, masks: 5, points: 4, words: 'The stand-in for SAM 3.1 found 5; its masks give 5 exact outlines; for 4 more, code traces around Muse Spark’s points.' });
  assert.equal(level.objects.length, 9);
  assert.equal(fromPoints(level), 4);
  assert.equal(level.provenance.outline_sources.sam_mask, 5);
  assert.deepEqual(level.objects.filter((o) => /points/.test(o.outline.source)).map((o) => o.name).sort(), ['coffee mug', 'gold coin', 'gold coin', 'gold coin']);
  assert.match(summaryLine(level, entry.summary), /The stand-in for SAM 3\.1 found 5; for 4 more, code traced around Muse Spark’s points\. The stand-in for SAM 3\.1’s masks gave 5 exact outlines; code traced 0\./);
  assert.ok(entry.summary.warnings.includes('not found by SAM 3.1: coffee mug; code traces around Muse Spark’s points for it instead'));
});

test('SAM finds none: every thing is traced around Muse Spark’s points, and the room is still won', { timeout: 120000 }, async () => {
  const { reply, level } = await levelWithout(['--sam', 'none']);
  assert.equal(reply.provenance.found.sam, 0);
  assert.equal(reply.provenance.found.points, 9);
  assert.equal(fromPoints(level), 9);
  assert.equal(level.objects[level.objects.findIndex((o) => o.id === level.rules.exit)].name, 'cardboard box');
  assert.match(foundWords(level), /^SAM 3\.1 found 0; for 9 more, code traced around Muse Spark’s points/);
});

test('neither SAM nor the points make a room: it says so in words', async () => {
  // one point, on bare desk far from everything: a single object cannot be
  // a room (it would have to be the exit and the thing to collect)
  const reply = recordedReply(['--sam', 'none']);
  reply.objects = reply.objects.filter((o) => o.name === 'coffee mug');
  const entry = await levelFromReply(reply, { width: W, height: H }, deskPixels, { kind: 'photo', sha256: 'recorded' }, () => Promise.resolve());
  assert.match(entry.built.error, /^SAM 3\.1 found none of the things Muse Spark named, and code traced around Muse Spark’s points for 1 more, but together they do not make a room that can be won\. Only one thing was found standing on the .+ \(the coffee mug\)\. A game needs an exit and at least one thing to collect\. Try a photo with three or more separate objects on a floor or desk\.$/);
});
