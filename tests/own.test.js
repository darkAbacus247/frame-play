import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRoom } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { fillRings, maskBounds } from '../src/raster.js';
import { REPLY_SCHEMA } from '../src/reply.js';
import { LABELS } from '../src/level.js';
import { makeOwnRoom, signature, matchSample, rehearsalVerdict, MOCK_WORDS } from '../src/own.js';
import { jpegLike } from './jpegsim.js';

const rooms = {};
for (const id of ['desk', 'living']) {
  const room = loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
  const rgba = paintRoom(room).rgba;
  rooms[id] = { room, pixels: { width: room.width, height: room.height, data: rgba } };
}
const SAMPLES = Object.entries(rooms).map(([id, r]) => ({ id, title: r.room.title, sig: signature(r.pixels) }));
const sent = (id) => ({ ...rooms[id].pixels, data: jpegLike(rooms[id].pixels.data, rooms[id].pixels.width, rooms[id].pixels.height, 90) });

function noise(width, height, seed = 11) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  for (let i = 0; i < data.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; data[i] = i % 4 === 3 ? 255 : (s >> 16) & 255; }
  return { width, height, data };
}
function gradient(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = 4 * (y * width + x);
    data[i] = (x * 255) / width; data[i + 1] = (y * 255) / height; data[i + 2] = 128; data[i + 3] = 255;
  }
  return { width, height, data };
}
function half({ width, height, data }) {
  const w = width >> 1, h = height >> 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) {
    const at = (dx, dy) => data[4 * ((2 * y + dy) * width + 2 * x + dx) + k];
    out[4 * (y * w + x) + k] = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4;
  }
  return { width: w, height: h, data: out };
}

// A picked file as these tests see it: its type and size, and the pixels the
// page would hold after shrinking and re-encoding it.
const file = (pixels, type = 'image/jpeg') => ({ type, size: 300000, pixels });

// The server's reply for a sample room's picture, in a mode, with SAM's
// exact boxes from the room's own shapes.
function replyFor(id, mode, { room = id, status = 'ok', error = null } = {}) {
  const r = rooms[id].room;
  const objects = r.objects.filter((o) => o.on_surface).map((o, k) => {
    const b = maskBounds(fillRings(o.rings, r.width, r.height), r.width, r.height);
    return { id: `o${k + 1}`, name: o.name, instance: o.instance, role: o.role, reason: o.reason, on_surface: true,
      box: [b.x0, b.y0, b.x1, b.y1], confidence: 0.9, seeds: [[(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]] };
  });
  return {
    schema: REPLY_SCHEMA, request_id: 'r1', status,
    provenance: { mode, label: LABELS[mode], models: mode === 'live' ? ['muse-spark-1.3', 'sam-3.1'] : [], calls: [], ...(mode === 'rehearsal' ? { rehearsal: { room } } : {}) },
    received: { width: r.width, height: r.height },
    scene: { title: r.title, theme_line: r.theme_line, people_present: status !== 'ok', scenery: [] },
    surface: null,
    objects: status === 'ok' ? objects : [],
    warnings: [],
    error,
  };
}

function deps(reply) {
  const calls = { preview: 0, read: 0, send: 0 };
  return {
    calls,
    deps: {
      samples: SAMPLES,
      preview: async () => { calls.preview++; return { picture: 'the photo, shown here' }; },
      readPhoto: async (f) => { calls.read++; return { sha256: 'cd'.repeat(32), blob: 'the copy', picture: 'the copy, shown', pixels: f.pixels, width: f.pixels.width, height: f.pixels.height }; },
      send: async () => { calls.send++; return reply; },
    },
  };
}
const quick = () => Promise.resolve();

test('the MOCK words are the plain sentence the owner asked for', () => {
  assert.equal(MOCK_WORDS, 'Reading a real photo needs the live AI (Meta’s models). This copy is running without it, so your photo stays on your device and nothing is invented.');
});

test('MOCK never builds a level from a real photo: shown on the device, nothing read or sent', async () => {
  for (const mode of ['mock', undefined, 'something else']) {
    // even the sample room's own picture, and even with a reply at hand
    const { calls, deps: d } = deps(replyFor('desk', 'live'));
    const r = await makeOwnRoom({ mode, rehearsalRoom: 'desk', file: file(sent('desk')), deps: d, yieldNow: quick });
    assert.equal(r.kind, 'kept', String(mode));
    assert.equal(r.words, MOCK_WORDS);
    assert.equal(r.picture, 'the photo, shown here');
    assert.ok(!('entry' in r) && !('ref' in r), 'no level, no room on the road');
    assert.deepEqual(calls, { preview: 1, read: 0, send: 0 }, 'never fingerprinted, never sent');
  }
});

test('a file the page cannot take is refused in words, in every mode, before anything runs', async () => {
  for (const mode of ['mock', 'live', 'rehearsal']) {
    const { calls, deps: d } = deps(null);
    const r = await makeOwnRoom({ mode, rehearsalRoom: 'desk', file: file(sent('desk'), 'image/gif'), deps: d });
    assert.equal(r.kind, 'refused');
    assert.match(r.words, /JPEG, PNG or WEBP/);
    assert.deepEqual(calls, { preview: 0, read: 0, send: 0 });
  }
});

test('the sample pictures are known through JPEG and shrinking; other pictures are not', () => {
  assert.equal(matchSample(signature(sent('desk')), SAMPLES), 'desk');
  assert.equal(matchSample(signature(sent('living')), SAMPLES), 'living');
  assert.equal(matchSample(signature(half(rooms.desk.pixels)), SAMPLES), 'desk', 'a smaller copy of the same picture');
  assert.equal(matchSample(signature(noise(1024, 768)), SAMPLES), null);
  assert.equal(matchSample(signature(gradient(1024, 768)), SAMPLES), null);
  assert.equal(matchSample(signature(noise(768, 1024)), SAMPLES), null, 'another shape is never a sample');
  // half of the desk with the other half from the living room: not either
  const mix = { ...rooms.desk.pixels, data: rooms.desk.pixels.data.slice() };
  mix.data.set(rooms.living.pixels.data.subarray(0, mix.data.length / 2));
  assert.equal(matchSample(signature(mix), SAMPLES), null);
  assert.deepEqual(rehearsalVerdict('desk', 'desk'), { ok: true, why: '' });
});

test('REHEARSAL refuses any photo the stand-in does not know, and sends nothing', async () => {
  const cases = [
    { name: 'a real-looking photo', pixels: noise(1024, 768), want: /only knows the sample rooms’ own pictures, and this photo is not one of them/ },
    { name: 'a plain gradient', pixels: gradient(800, 600), want: /not one of them/ },
    { name: 'the other sample room', pixels: sent('living'), want: /^This is the sample picture of The Living Room, but the local stand-in was started for The Desk Top, so it would answer for the wrong room\./ },
  ];
  for (const c of cases) {
    const { calls, deps: d } = deps(replyFor('desk', 'rehearsal'));
    const r = await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: 'desk', file: file(c.pixels), deps: d });
    assert.equal(r.kind, 'refused', c.name);
    assert.match(r.words, c.want, `${c.name}: ${r.words}`);
    assert.match(r.words, /Nothing was sent, and no level is made from it\./);
    assert.equal(calls.send, 0, `${c.name}: never sent`);
    assert.ok(!r.entry);
  }
});

test('REHEARSAL builds from the stand-in’s own picture, and never from an answer for another room', async () => {
  const { calls, deps: d } = deps(replyFor('desk', 'rehearsal'));
  const words = [];
  const r = await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: 'desk', file: file(sent('desk')), deps: d, onWords: (w) => words.push(w), yieldNow: quick });
  assert.equal(r.kind, 'built');
  assert.equal(calls.send, 1);
  assert.deepEqual(r.ref, { kind: 'photo', sha256: 'cd'.repeat(32) });
  const { level } = r.entry.built;
  assert.equal(level.origin, 'rehearsal');
  assert.equal(level.label, LABELS.rehearsal);
  assert.ok(level.proof.winnable);
  assert.deepEqual(words, ['Tracing the outlines']);
  const wrong = deps(replyFor('desk', 'rehearsal', { room: 'living' }));
  const w = await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: 'desk', file: file(sent('desk')), deps: wrong.deps, yieldNow: quick });
  assert.equal(w.kind, 'refused');
  assert.match(w.words, /different room/);
});

test('LIVE builds the room from the models’ reply for this photo', async () => {
  const { calls, deps: d } = deps(replyFor('desk', 'live'));
  const r = await makeOwnRoom({ mode: 'live', file: file(sent('desk')), deps: d, yieldNow: quick });
  assert.equal(r.kind, 'built');
  assert.deepEqual(calls, { preview: 0, read: 1, send: 1 });
  const { level } = r.entry.built;
  assert.equal(level.origin, 'live');
  assert.equal(level.label, LABELS.live);
  assert.deepEqual(level.provenance.models, ['muse-spark-1.3', 'sam-3.1']);
  assert.deepEqual(level.picture, { kind: 'photo', sha256: 'cd'.repeat(32), width: 1024, height: 768 });
  assert.equal(level.objects.length, replyFor('desk', 'live').objects.length, 'one object per match the models found');
  assert.ok(level.objects.every((o) => o.outline.source === 'traced_in_box'), 'outlines traced on the very pixels sent');
  assert.ok(level.proof.winnable);
  // LIVE takes any photo: no sample check stands between the player and the models
  const other = deps(replyFor('desk', 'live'));
  await makeOwnRoom({ mode: 'live', file: file(noise(1024, 768)), deps: other.deps, yieldNow: quick });
  assert.equal(other.calls.send, 1);
});

test('LIVE: the people refusal and a reply from the wrong mode make no level', async () => {
  const people = { code: 'people_present', message: 'This photo seems to show a person. Please use one with no people.' };
  const p = deps(replyFor('desk', 'live', { status: 'refused', error: people }));
  const r = await makeOwnRoom({ mode: 'live', file: file(sent('desk')), deps: p.deps });
  assert.equal(r.kind, 'refused');
  assert.equal(r.words, people.message);
  assert.ok(!r.entry);
  const m = deps(replyFor('desk', 'rehearsal'));
  const r2 = await makeOwnRoom({ mode: 'live', file: file(sent('desk')), deps: m.deps });
  assert.equal(r2.kind, 'refused');
  assert.match(r2.words, /LIVE but answered as REHEARSAL/);
});

test('a level kept on this device is used only when it was made in this mode', async () => {
  const kept = { built: { level: { origin: 'live' } }, fromDevice: true };
  const live = deps(null);
  const r = await makeOwnRoom({ mode: 'live', file: file(sent('desk')), deps: { ...live.deps, stored: () => kept } });
  assert.equal(r.entry, kept);
  assert.equal(live.calls.send, 0, 'no model call for a photo already made');
  const reh = deps(replyFor('desk', 'rehearsal'));
  const r2 = await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: 'desk', file: file(sent('desk')), deps: { ...reh.deps, stored: () => kept }, yieldNow: quick });
  assert.notEqual(r2.entry, kept, 'a LIVE level is never passed off as a rehearsal');
  assert.equal(reh.calls.send, 1);
});
