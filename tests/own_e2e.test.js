// End to end, in REHEARSAL: the sample room's own picture is uploaded as a
// file, goes through the app's real server and the local stand-in (never
// Meta) on this machine's loopback, and comes back as a winnable room whose
// outlines sit on the picture's objects. The page's canvas steps (decode,
// shrink, JPEG) are played by Node twins; everything after them is the
// page's own code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRoom } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { fillRings } from '../src/raster.js';
import { shrinkSize } from '../src/reply.js';
import { sha256Hex, sendPhoto } from '../src/photo.js';
import { makeOwnRoom, signature, fineGrid, objectBoxes } from '../src/own.js';
import { jpegLike } from './jpegsim.js';
import { encodePNG, decodePNG } from './png.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

const rooms = {};
for (const id of ['desk', 'living']) {
  const room = loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
  rooms[id] = { room, rgba: paintRoom(room).rgba };
}
const SAMPLES = Object.entries(rooms).map(([id, r]) => {
  const pixels = { width: r.room.width, height: r.room.height, data: r.rgba };
  return { id, title: r.room.title, sig: signature(pixels), fine: fineGrid(pixels), boxes: objectBoxes(r.room) };
});

function startPair(room) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-B', '-m', 'server.tests.rehearsal_pair', '--room', room], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('the rehearsal pair did not start')); }, 30000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the rehearsal pair stopped (${code})`)); });
    child.stdout.on('data', (d) => {
      out += d;
      const nl = out.indexOf('\n');
      if (nl >= 0) { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${JSON.parse(out.slice(0, nl)).port}` }); }
    });
  });
}

function stopPair(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    const t = setTimeout(() => child.kill(), 5000);
    child.on('exit', () => { clearTimeout(t); resolve(); });
    child.stdin.end();
  });
}

// The page's readPhoto, with Node playing the canvas: decode the file,
// shrink it to at most 1024 px, re-encode it lossily (the JPEG at quality
// 0.9; carried here in a PNG, since the server only reads its size), and
// take the sha256 of the file's own bytes.
async function readPhotoInNode(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const { width, height, data } = decodePNG(bytes);
  const size = shrinkSize(width, height);
  assert.deepEqual(size, { width, height }, 'the sample picture is already at most 1024 px');
  const copy = jpegLike(data, width, height, 90);
  const blob = new Blob([encodePNG(copy, width, height)], { type: 'image/png' });
  return { sha256, blob, picture: { width, height }, pixels: { width, height, data: copy }, width, height };
}

const iou = (a, b) => {
  let i = 0, u = 0;
  for (let p = 0; p < a.length; p++) { if (a[p] && b[p]) i++; if (a[p] || b[p]) u++; }
  return u ? i / u : 1;
};

test('REHEARSAL end to end: the desk’s own picture, uploaded as a file, becomes a winnable, aligned room', { timeout: 120000 }, async () => {
  const { child, base } = await startPair('desk');
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.mode, 'rehearsal');
    assert.equal(health.rehearsal.room, 'desk');
    assert.deepEqual(health.models_called, [], 'a rehearsal calls no model');
    const deps = {
      samples: SAMPLES,
      preview: () => assert.fail('a rehearsal reads the photo; it is not a MOCK preview'),
      readPhoto: readPhotoInNode,
      send: (blob, onWords) => sendPhoto(blob, (m) => onWords(m.words), `${base}/api/room`),
    };
    const { room, rgba } = rooms.desk;
    const png = encodePNG(rgba, room.width, room.height);
    const file = new File([png], 'desk-sample-room.png', { type: 'image/png' });
    const words = [];
    const r = await makeOwnRoom({ mode: health.mode, rehearsalRoom: health.rehearsal.room, file, deps, onWords: (w) => words.push(w), yieldNow: () => Promise.resolve() });
    assert.equal(r.kind, 'built', r.words);
    assert.deepEqual(words, ['Reading your room', 'Finding every object', 'Tracing the outlines'], 'the three progress lines, in order');
    const sha = (await import('node:crypto')).createHash('sha256').update(png).digest('hex');
    assert.deepEqual(r.ref, { kind: 'photo', sha256: sha }, 'keyed by the picked file’s own bytes');
    const { level } = r.entry.built;
    assert.equal(level.origin, 'rehearsal');
    assert.equal(level.label, 'REHEARSAL · local stand-in, not Meta');
    assert.deepEqual(level.provenance.models, [], 'the stand-in is never named as a model');
    assert.ok(level.proof.winnable, 'code proved the room can be won');
    assert.ok(level.proof.route_length > 0);
    // aligned: every outline sits on its object in the picture
    const W = room.width, H = room.height;
    const onSurface = room.objects.filter((o) => o.on_surface);
    assert.equal(level.objects.length, onSurface.length, 'every object on the desk was found');
    for (const o of level.objects) {
      assert.equal(o.outline.source, 'traced_in_box', `${o.name}: traced inside SAM’s box`);
      const got = fillRings(o.outline.rings, W, H);
      const best = Math.max(...onSurface.filter((x) => x.name === o.name).map((x) => iou(got, fillRings(x.rings, W, H))));
      assert.ok(best >= 0.9, `${o.name} ${o.instance}: IoU ${best.toFixed(3)} against the painted shape`);
    }
    // and a photo the stand-in does not know is refused before anything is sent
    const before = (await (await fetch(`${base}/api/health`)).json()).counters;
    const noise = new Uint8ClampedArray(W * H * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 2654435761) >>> 24));
    const other = new File([encodePNG(noise, W, H)], 'my-room.png', { type: 'image/png' });
    const refused = await makeOwnRoom({ mode: 'rehearsal', rehearsalRoom: 'desk', file: other, deps });
    assert.equal(refused.kind, 'refused');
    assert.match(refused.words, /not one of them/);
    const after = (await (await fetch(`${base}/api/health`)).json()).counters;
    assert.deepEqual(after, before, 'the server never saw it');
    assert.equal(after.photos_answered, 1, 'only the sample picture was read');
  } finally {
    await stopPair(child);
  }
});
