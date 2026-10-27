import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acceptReply, inputFromReply, readSummary, photoRefusal, shrinkSize, boxRings, refusalWords, REPLY_SCHEMA } from '../src/reply.js';
import { buildLevel, validateLevel, LABELS } from '../src/level.js';
import { loadRoom } from '../src/rooms.js';
import { saveLevel, loadLevel, storedLevelCount, LEVEL_STORE_SIZE } from '../src/store.js';

// A reply in schema 2 for a sample room, with boxes from its own shapes:
// what the stand-in sends in a rehearsal.
function replyFor(id, mode = 'rehearsal') {
  const room = loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
  const box = (b) => [Math.max(0, Math.round(b.x0)), Math.max(0, Math.round(b.y0)), Math.min(room.width, Math.round(b.x1)), Math.min(room.height, Math.round(b.y1))];
  const on = room.objects.filter((o) => o.on_surface);
  const sb = room.surface.rings.flat();
  return {
    schema: REPLY_SCHEMA,
    request_id: 'abc123',
    status: 'ok',
    provenance: { mode, label: LABELS[mode], models: mode === 'live' ? ['muse-spark-1.3', 'sam-3.1'] : [], calls: [] },
    received: { bytes: 1000, type: 'image/jpeg', width: room.width, height: room.height, metadata_bytes_removed: 0, retained: false },
    scene: { title: room.title, theme_line: room.theme_line, people_present: false, scenery: room.objects.filter((o) => !o.on_surface).map((o) => ({ name: o.name, reason: o.reason })) },
    surface: { name: room.surface.name, box: [0, Math.min(...sb.map((p) => p[1])), room.width, room.height], confidence: 0.97 },
    objects: on.map((o, k) => ({ id: `o${k + 1}`, name: o.name, instance: o.instance, role: o.role, reason: o.reason, on_surface: true, box: box(o.bounds), confidence: 0.9, seeds: [] })),
    usage: { calls: 1 },
    warnings: ['not found: teapot'],
    error: null,
  };
}

test('a reply is accepted only from a server in the same mode, for the copy sent', () => {
  const r = replyFor('desk');
  const copy = { width: 1024, height: 768 };
  assert.deepEqual(acceptReply('rehearsal', r, copy), { ok: true, why: '', dropped: 0, words: '' });
  assert.equal(acceptReply('live', r, copy).ok, false, 'a REHEARSAL reply is refused from a live server');
  const live = replyFor('desk', 'live');
  assert.equal(acceptReply('live', live, copy).ok, true);
  assert.equal(acceptReply('rehearsal', live, copy).ok, false, 'a LIVE reply is refused from a rehearsing server');
  assert.equal(acceptReply('mock', live, copy).ok, false);
  assert.match(acceptReply('rehearsal', r, { width: 1000, height: 768 }).why, /different size/);
  assert.equal(acceptReply('rehearsal', { ...r, provenance: { ...r.provenance, models: ['sam-3.1'] } }, copy).ok, false, 'a rehearsal claims no model');
  assert.equal(acceptReply('rehearsal', { ...r, provenance: { ...r.provenance, label: LABELS.live } }, copy).ok, false);
  assert.equal(acceptReply('rehearsal', { ...r, schema: 'other' }, copy).ok, false);
  const people = { ...r, status: 'refused', error: { code: 'people_present', message: 'This photo seems to show a person. Please use one with no people.' } };
  assert.equal(acceptReply('rehearsal', people, copy).why, 'This photo seems to show a person. Please use one with no people.');
  assert.match(refusalWords({}), /could not be read/);
});

test('a bad box is left out and said, not the whole reply refused (D2)', () => {
  const copy = { width: 1024, height: 768 };
  const r = replyFor('desk', 'live');
  const n = r.objects.length;
  const [a, b, c] = r.objects.map((o) => o.name);
  r.objects[0].box = [0, 0, 1025, 10]; // one past the right edge
  r.objects[1].box = [100, 100, 100, 140]; // empty
  r.objects[2].box = [10, NaN, 40, 60]; // not a number
  const ok = acceptReply('live', r, copy);
  assert.equal(ok.ok, true);
  assert.equal(ok.dropped, 3);
  assert.equal(ok.words, '3 objects in the reply had a box outside the picture or an empty one, so they were left out.');
  assert.equal(r.objects.length, n - 3, 'the reply is cleaned in place: the page goes on with the same object');
  assert.deepEqual(r.dropped, { objects: 3, surface: false });
  for (const name of [a, b, c]) assert.ok(r.warnings.includes(`not used: ${name} (its box lay outside the picture or was empty)`), name);
  assert.equal(readSummary(r).found, n - 3, 'the reveal counts what is left');
  assert.equal(readSummary(r).leftOut, ok.words, 'and says what was left out');
  assert.equal(readSummary(replyFor('desk', 'live')).leftOut, '', 'nothing left out: no words');
  // and what is left still builds
  const built = buildLevel(inputFromReply(r, { kind: 'photo', sha256: 'ab'.repeat(32) }, undefined, '2026-10-27T10:00:00Z'));
  assert.ok(!built.error, built.error);

  // one good and one bad box: one object
  const one = replyFor('desk', 'live');
  one.objects = [one.objects[0], { ...one.objects[1], box: [0, 0, 1025, 10] }];
  const o1 = acceptReply('live', one, copy);
  assert.equal(o1.ok, true);
  assert.equal(one.objects.length, 1);
  assert.equal(o1.words, '1 object in the reply had a box outside the picture or an empty one, so it was left out.');

  // a bad surface: dropped, the reply kept
  const s = replyFor('desk', 'live');
  s.surface.box = [0, 300, 1024, 900];
  const os = acceptReply('live', s, copy);
  assert.equal(os.ok, true);
  assert.equal(os.dropped, 0);
  assert.equal(s.surface, null);
  assert.equal(os.words, 'The surface’s box was not usable, so it was left out.');
  assert.equal(readSummary(s).leftOut, os.words);
  assert.ok(s.warnings.some((w) => /^not used: .*the play surface/.test(w)));
  assert.equal(inputFromReply(s, { kind: 'photo', sha256: 'ab'.repeat(32) }).surface, null);

  // a nameless object and a bad surface together
  const t = replyFor('desk', 'live');
  t.objects.push({ box: [1, 1, 5, 5] });
  t.surface.box = 'nope';
  assert.equal(acceptReply('live', t, copy).words, '1 object in the reply had a box outside the picture or an empty one, and the surface’s box was not usable, so they were left out.');
  assert.ok(t.warnings.includes('not used: an unnamed object (its box lay outside the picture or was empty)'));

  // refused only when nothing is left
  const none = replyFor('desk', 'live');
  for (const o of none.objects) o.box = [-5, 0, 10, 10];
  const z = acceptReply('live', none, copy);
  assert.equal(z.ok, false);
  assert.match(z.why, /^No object in the reply has a usable box \(9 boxes lay outside the picture or were empty\)/);
  assert.equal(none.objects.length, 9, 'a refused reply is left as it came');
});

test('box outlines from a rehearsal reply build winnable levels in both rooms', () => {
  for (const id of ['desk', 'living']) {
    const r = replyFor(id);
    const input = inputFromReply(r, { kind: 'sample', id }, undefined, '2026-10-27T10:00:00Z');
    assert.equal(input.origin, 'rehearsal');
    assert.deepEqual(input.picture, { kind: 'sample', id, width: 1024, height: 768 });
    assert.equal(input.surface.source, 'box');
    const built = buildLevel(input);
    assert.ok(!built.error, `${id}: ${built.error}`);
    const { level } = built;
    assert.equal(level.label, 'REHEARSAL · local stand-in, not Meta');
    assert.equal(level.provenance.outline_sources.box, r.objects.length);
    assert.deepEqual(level.provenance.models, []);
    assert.ok(level.proof.winnable);
    assert.ok(validateLevel(JSON.parse(JSON.stringify(level))).ok);
  }
});

test('the read summary for the reveal', () => {
  const s = readSummary(replyFor('desk'));
  assert.equal(s.found, 9);
  assert.deepEqual(s.scenery, ['picture frame']);
  assert.equal(s.named, 7 + 1 + 1, 'distinct nouns found, the one not found, and the scenery');
  assert.equal(s.rehearsal, true);
});

test('the photo the page takes, and the copy it sends', () => {
  assert.equal(photoRefusal({ type: 'image/jpeg', size: 3_000_000 }), null);
  assert.match(photoRefusal({ type: 'image/gif', size: 1000 }), /JPEG, PNG or WEBP/);
  assert.match(photoRefusal({ type: 'image/png', size: 41 * 1024 * 1024 }), /40 MB/);
  assert.deepEqual(shrinkSize(4032, 3024), { width: 1024, height: 768 });
  assert.deepEqual(shrinkSize(3024, 4032), { width: 768, height: 1024 });
  assert.deepEqual(shrinkSize(800, 600), { width: 800, height: 600 }, 'never enlarged');
  assert.deepEqual(boxRings([1, 2, 3, 4]), [[[1, 2], [3, 2], [3, 4], [1, 4]]]);
});

function memoryStorage(limit = Infinity) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (String(v).length > limit) throw new Error('quota'); m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    raw: m,
  };
}

test('the level store: last 12 by photo sha256, damaged or foreign entries dropped', () => {
  const s = memoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
  const sha = (n) => n.toString(16).padStart(64, '0');
  const level = (n) => ({ schema: 'frameplay.level/2', origin: 'live', picture: { kind: 'photo', sha256: sha(n), width: 10, height: 10 }, objects: [] });
  for (let n = 1; n <= 15; n++) assert.equal(saveLevel(sha(n), level(n), { summary: { named: n } }), true);
  assert.equal(storedLevelCount(), LEVEL_STORE_SIZE);
  assert.equal(loadLevel(sha(1)), null, 'the oldest went');
  assert.equal(loadLevel(sha(15)).summary.named, 15);
  assert.equal(saveLevel('not-a-sha', level(1)), false);
  const list = JSON.parse(s.raw.get('frameplay.levels'));
  list.push({ sha256: sha(99), level: { schema: 'frameplay.level/2', origin: 'mock', picture: { sha256: sha(99) } } });
  list.push({ sha256: sha(98), level: { schema: 'other' } });
  list.push('junk');
  s.raw.set('frameplay.levels', JSON.stringify(list));
  assert.equal(loadLevel(sha(99)), null, 'a MOCK level is never filed under a photo');
  assert.equal(storedLevelCount(), LEVEL_STORE_SIZE);
  s.raw.set('frameplay.levels', '{not json');
  assert.equal(storedLevelCount(), 0, 'a damaged store reads as empty');
  const tight = memoryStorage(900);
  Object.defineProperty(globalThis, 'localStorage', { value: tight, configurable: true, writable: true });
  for (let n = 1; n <= 6; n++) saveLevel(sha(n), level(n));
  assert.ok(storedLevelCount() >= 1 && loadLevel(sha(6)), 'a full device keeps the newest');
});
