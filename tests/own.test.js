import test from 'node:test';
import assert from 'node:assert/strict';
import { LABELS } from '../src/level.js';
import { makeOwnRoom, signature, matchSample, sigDistance, rehearsalVerdict, keptLevel, standInReplyRefusal, fineGrid, objectBoxes, worstBox, MATCH_BOX, OTHER_ROOM_WORDS, MOCK_WORDS } from '../src/own.js';
import { paintRoom } from '../src/painter.js';
import { rooms, replyFor } from './replies.js';
import { readFileSync } from 'node:fs';
import { jpegLike } from './jpegsim.js';

const SAMPLES = Object.entries(rooms).map(([id, r]) => ({ id, title: r.room.title, sig: signature(r.pixels), fine: fineGrid(r.pixels), boxes: objectBoxes(r.room) }));
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

// Edited copies of the desk's own picture, painted by the page's own
// painter: the stand-in would answer each with its desk, so a level would
// sit on a picture that no longer shows it.
function deskWith(edit) {
  const room = structuredClone(rooms.desk.room);
  edit(room);
  return { width: room.width, height: room.height, data: paintRoom(room).rgba };
}
const shadeOf = (o) => (s) => s.ellipse[0] >= o.bounds.x0 && s.ellipse[0] <= o.bounds.x1 && Math.abs(s.ellipse[1] - o.bounds.y1) < 20;
function erase(...ids) {
  return (room) => {
    const gone = room.objects.filter((o) => ids.includes(o.id));
    room.objects = room.objects.filter((o) => !ids.includes(o.id));
    room.shades = room.shades.filter((s) => !gone.some((o) => shadeOf(o)(s)));
  };
}
function moveAll(dx) {
  const shift = (rings) => rings.map((r) => r.map(([x, y]) => [x + dx, y]));
  return (room) => {
    for (const o of room.objects) {
      o.rings = shift(o.rings);
      for (const d of o.details) d.rings = shift(d.rings);
      o.bounds = { ...o.bounds, x0: o.bounds.x0 + dx, x1: o.bounds.x1 + dx };
    }
    for (const s of room.shades) s.ellipse = [s.ellipse[0] + dx, ...s.ellipse.slice(1)];
  };
}
function pixelEdit(f) {
  const { width, height, data } = rooms.desk.pixels;
  return f({ width, height, data: data.slice() });
}
function paste(share) {
  return pixelEdit((p) => {
    const w = Math.round(Math.sqrt(share * p.width * p.height * (4 / 3))), h = Math.round((w * 3) / 4);
    const x0 = (p.width - w) >> 1, y0 = (p.height - h) >> 1;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) p.data.set([128, 128, 128, 255], 4 * (y * p.width + x));
    return p;
  });
}
function crop(share) {
  const { width, height, data } = rooms.desk.pixels;
  const dx = Math.round((width * share) / 2), dy = Math.round((height * share) / 2);
  const w = width - 2 * dx, h = height - 2 * dy;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray(4 * ((y + dy) * width + dx), 4 * ((y + dy) * width + dx + w)), 4 * y * w);
  return { width: w, height: h, data: out };
}
const shifted = (n) => pixelEdit((p) => {
  const src = rooms.desk.pixels.data;
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const from = 4 * (y * p.width + Math.max(0, x - n));
    p.data.set(src.subarray(from, from + 4), 4 * (y * p.width + x));
  }
  return p;
});
const brighter = (k) => pixelEdit((p) => { for (let i = 0; i < p.data.length; i++) if (i % 4 !== 3) p.data[i] += k; return p; });
const jpeg = (p, q = 90) => ({ ...p, data: jpegLike(p.data, p.width, p.height, q) });

test('REHEARSAL refuses edited copies of its sample picture, and sends nothing', async () => {
  const edited = {
    'one coin erased (with its shade)': deskWith(erase('coin1')),
    'the other coin erased': deskWith(erase('coin2')),
    'the mug erased': deskWith(erase('mug')),
    'every on-surface object removed': deskWith((room) => { room.objects = room.objects.filter((o) => !o.on_surface); room.shades = []; }),
    'every object moved 8 px': deskWith(moveAll(8)),
    'every object moved 40 px': deskWith(moveAll(40)),
    'a 1% block pasted': paste(0.01),
    'an 8% block pasted': paste(0.08),
    'a 1% centre crop': crop(0.01),
    'a 3% centre crop': crop(0.03),
    'the whole picture shifted 8 px': shifted(8),
    'every channel +6': brighter(6),
  };
  for (const [name, pixels] of Object.entries(edited)) {
    const { calls, deps: d } = deps(replyFor('desk', 'rehearsal'));
    const r = await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: 'desk', file: file(jpeg(pixels)), deps: d, yieldNow: quick });
    assert.equal(r.kind, 'refused', `${name}: ${JSON.stringify(sigDistance(signature(jpeg(pixels)), SAMPLES[0].sig))}`);
    assert.match(r.words, /Nothing was sent, and no level is made from it\./);
    assert.equal(calls.send, 0, `${name}: never sent`);
    assert.ok(!r.entry && !r.ref, `${name}: no level, no room`);
  }
  // faithful copies still go through: re-encoded, shrunk (the stand-in's
  // reply here is for 1024x768, so only the full-size copies build)
  for (const [name, pixels] of [['the true sample at quality 90', jpeg(rooms.desk.pixels)], ['a quality 40 copy', jpeg(rooms.desk.pixels, 40)], ['a half-size copy', half(rooms.desk.pixels)]]) {
    assert.equal(matchSample(signature(pixels), SAMPLES), 'desk', name);
    const { calls, deps: d } = deps(replyFor('desk', 'rehearsal'));
    const r = await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: 'desk', file: file(pixels), deps: d, yieldNow: quick });
    assert.equal(calls.send, 1, `${name}: sent`);
    if (pixels.width === 1024) assert.equal(r.kind, 'built', `${name}: ${r.words}`);
  }
});

// A copy of another size, each pixel the area mean of what it covers.
function resize({ width, height, data }, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = (x * width) / w, x1 = ((x + 1) * width) / w, y0 = (y * height) / h, y1 = ((y + 1) * height) / h;
    const sum = [0, 0, 0, 0];
    let n = 0;
    for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
      const a = (Math.min(xx + 1, x1) - Math.max(xx, x0)) * (Math.min(yy + 1, y1) - Math.max(yy, y0));
      for (let k = 0; k < 4; k++) sum[k] += a * data[4 * (yy * width + xx) + k];
      n += a;
    }
    for (let k = 0; k < 4; k++) out[4 * (y * w + x) + k] = sum[k] / n;
  }
  return { width: w, height: h, data: out };
}
// One object (with its shade and details) moved by dx, dy, in a room
// painted by the page's own painter.
function oneMoved(id, oid, dx, dy) {
  const room = structuredClone(rooms[id].room);
  const o = room.objects.find((x) => x.id === oid);
  const shift = (rings) => rings.map((r) => r.map(([x, y]) => [x + dx, y + dy]));
  for (const s of room.shades.filter(shadeOf(o))) s.ellipse = [s.ellipse[0] + dx, s.ellipse[1] + dy, ...s.ellipse.slice(2)];
  o.rings = shift(o.rings);
  for (const d of o.details) d.rings = shift(d.rings);
  o.bounds = { x0: o.bounds.x0 + dx, y0: o.bounds.y0 + dy, x1: o.bounds.x1 + dx, y1: o.bounds.y1 + dy };
  return jpeg({ width: room.width, height: room.height, data: paintRoom(room).rgba });
}

test('REHEARSAL looks at each object’s place before sending: faithful copies go, an object moved 8 px does not', async () => {
  for (const id of ['desk', 'living']) {
    const P = rooms[id].pixels;
    const faithful = { 'quality 90': jpeg(P), 'quality 40': jpeg(P, 40), 'half size': half(P), '800x600': jpeg(resize(P, 800, 600)) };
    for (const [name, pixels] of Object.entries(faithful)) {
      const { calls, deps: d } = deps(replyFor(id, 'rehearsal'));
      const r = await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: id, file: file(pixels), deps: d, yieldNow: quick });
      assert.equal(calls.send, 1, `${id}, ${name}: sent (${worstBox(fineGrid(pixels), SAMPLES.find((s) => s.id === id).fine, objectBoxes(rooms[id].room)).toFixed(2)})`);
      if (pixels.width === 1024) assert.equal(r.kind, 'built', `${id}, ${name}: ${r.words}`);
    }
    // every object on the surface, moved 8 px each way: the coarse check
    // or the boxes refuse it
    for (const o of rooms[id].room.objects.filter((x) => x.on_surface)) {
      for (const [dx, dy] of [[8, 0], [-8, 0], [0, 8], [0, -8]]) {
        const { calls, deps: d } = deps(replyFor(id, 'rehearsal'));
        const r = await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: id, file: file(oneMoved(id, o.id, dx, dy)), deps: d, yieldNow: quick });
        assert.equal(r.kind, 'refused', `${id}: ${o.id} moved ${dx},${dy}`);
        assert.match(r.words, /Nothing was sent, and no level is made from it\./);
        assert.equal(calls.send, 0, `${id}: ${o.id} moved ${dx},${dy}: never sent`);
      }
    }
  }
  // the coin moved 8 px that the coarse grid alone let through
  const coin = oneMoved('desk', 'coin1', 8, 0);
  assert.equal(matchSample(signature(coin), SAMPLES), 'desk');
  assert.ok(worstBox(fineGrid(coin), SAMPLES[0].fine, SAMPLES[0].boxes) > MATCH_BOX);
  const { deps: d } = deps(replyFor('desk', 'rehearsal'));
  const r = await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: 'desk', file: file(coin), deps: d, yieldNow: quick });
  assert.match(r.words, /^This is an edited copy of the sample picture of The Desk Top/);
});

test('the limit is said as it is: a coin nudged 4 px can pass, and the words say so', async () => {
  const nudged = oneMoved('desk', 'coin1', 4, 0);
  const { calls, deps: d } = deps(replyFor('desk', 'rehearsal'));
  await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: 'desk', file: file(nudged), deps: d, yieldNow: quick });
  assert.equal(calls.send, 1, 'too small for the checks to see');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(readme, /An edit of a few pixels \(a coin nudged by 4 px, a small mark\) can pass/);
  assert.doesNotMatch(readme, /an object erased, moved or pasted/);
  const screens = readFileSync(new URL('../src/screens.js', import.meta.url), 'utf8');
  assert.match(screens, /an edit of a few pixels can pass/);
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

test('one check of the stand-in’s room serves both rehearsal paths, and never says nothing was sent', async () => {
  assert.equal(standInReplyRefusal(replyFor('desk', 'rehearsal'), 'desk'), null);
  assert.equal(standInReplyRefusal(replyFor('desk', 'rehearsal', { room: 'living' }), 'desk'), OTHER_ROOM_WORDS);
  const silent = replyFor('desk', 'rehearsal');
  delete silent.provenance.rehearsal;
  assert.equal(standInReplyRefusal(silent, 'desk'), OTHER_ROOM_WORDS, 'a reply that names no room is not used');
  assert.equal(standInReplyRefusal(replyFor('desk', 'rehearsal'), null), OTHER_ROOM_WORDS, 'nor one with no room to compare');
  assert.doesNotMatch(OTHER_ROOM_WORDS, /Nothing was sent/);
  const own = deps(silent);
  const r = await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: 'desk', file: file(sent('desk')), deps: own.deps, yieldNow: quick });
  assert.equal(r.kind, 'refused');
  assert.equal(r.words, OTHER_ROOM_WORDS);
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

test('a kept level is only for the mode that made it, and the same size', () => {
  const kept = (origin) => ({ level: { origin, picture: { width: 1024, height: 768 } } });
  const photo = { width: 1024, height: 768 };
  assert.ok(keptLevel(kept('live'), photo, 'live'));
  assert.equal(keptLevel(kept('rehearsal'), photo, 'live'), null, 'a REHEARSAL level is never used in LIVE');
  assert.equal(keptLevel(kept('live'), photo, 'rehearsal'), null);
  assert.equal(keptLevel(kept('live'), { width: 512, height: 384 }, 'live'), null);
  assert.equal(keptLevel(null, photo, 'live'), null);
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
