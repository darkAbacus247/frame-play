// The first live answers (10-27) for the desk sample picture, end to end:
// the recorded Muse Spark read and sam-3.1 answers are played back through
// the server's real pipeline by a test double (server/tests/recorded.py;
// nothing is sent anywhere), and the page's own code traces the outlines on
// the desk picture and builds the level. It must be the right room, and
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
import { foundWords, fromPoints, summaryLine } from '../src/screens.js';
import { jpegLike } from './jpegsim.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

export function recordedReply(args = []) {
  const out = execFileSync(PYTHON, ['-B', '-m', 'server.tests.recorded', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  return JSON.parse(out);
}

const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
const W = room.width, H = room.height;
export const deskPixels = { width: W, height: H, data: jpegLike(paintRoom(room).rgba, W, H, 90) };

const iou = (a, b) => {
  let i = 0, u = 0;
  for (let p = 0; p < a.length; p++) { if (a[p] && b[p]) i++; if (a[p] || b[p]) u++; }
  return u ? i / u : 1;
};

test('the recorded desk answers become the right nine objects and a winnable room', { timeout: 120000 }, async () => {
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
  assert.equal(level.provenance.outline_sources.traced_in_box, 9, 'every outline traced inside SAM’s box');
  // every outline sits on one painted object, and no two on the same one
  const painted = room.objects.filter((o) => o.on_surface).map((o) => ({ id: o.id, mask: fillRings(o.rings, W, H) }));
  const used = new Set();
  for (const o of level.objects) {
    const got = fillRings(o.outline.rings, W, H);
    const best = painted.map((p) => ({ id: p.id, v: iou(got, p.mask) })).sort((a, b) => b.v - a.v)[0];
    assert.ok(best.v >= 0.85, `${o.name} ${o.instance}: IoU ${best.v.toFixed(3)} (${o.outline.source})`);
    assert.ok(!used.has(best.id), `${o.name} ${o.instance} sits on ${best.id} twice`);
    used.add(best.id);
  }
  assert.equal(foundWords(level), 'SAM 3.1 found 9');
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
  assert.deepEqual(reply.provenance.found, { sam: 5, points: 4, words: 'The stand-in for SAM 3.1 found 5; for 4 more, code traces around Muse Spark’s points.' });
  assert.equal(level.objects.length, 9);
  assert.equal(fromPoints(level), 4);
  assert.equal(level.provenance.outline_sources.traced_in_box, 5);
  assert.deepEqual(level.objects.filter((o) => /points/.test(o.outline.source)).map((o) => o.name).sort(), ['coffee mug', 'gold coin', 'gold coin', 'gold coin']);
  assert.match(summaryLine(level, entry.summary), /The stand-in for SAM 3\.1 found 5; for 4 more, code traced around Muse Spark’s points/);
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
  assert.match(entry.built.error, /^SAM 3\.1 found none of the things Muse Spark named, and code traced around Muse Spark’s points for 1 more, but together they do not make a room that can be won \(/);
});
