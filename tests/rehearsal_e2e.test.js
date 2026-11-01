// One REHEARSAL pass through everything merged: the real app.js (booted in
// Node by tests/apphost.js) talks to the app's real server and the local
// stand-in (never Meta), both on this machine's loopback, the stand-in
// speaking sam-3.1's real answer grammar. The page's canvas steps (decode,
// shrink, encode) are played by Node: the copy sent is the desk's own
// picture after a JPEG-like round trip, carried in a PNG (the server reads
// only its size). Three moments:
// - the saved desk sample picture becomes a winnable room of 9 objects;
// - a stand-in drill that makes SAM busy gives the honest busy words and
//   Try this photo again (never "found none"), and the same photo then reads;
// - a refused-key drill turns the picker off with Check again, and Mark your
//   room is still offered; nothing more is sent until Check again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootApp, photoFile, textOf, paintCanvases, until } from './apphost.js';
import { loadRoom } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { LABELS } from '../src/level.js';
import { KEY_WORDS } from '../src/reply.js';
import { jpegLike } from './jpegsim.js';
import { encodePNG } from './png.js';
import { roadAt, SAMPLE_ROOMS } from './roads.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const nodeFetch = globalThis.fetch;

const desk = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
const DESK = { width: desk.width, height: desk.height, data: jpegLike(paintRoom(desk).rgba, desk.width, desk.height, 90) };
const DESK_PNG = encodePNG(DESK.data, DESK.width, DESK.height);
const AT12 = roadAt(12, { rooms: [...SAMPLE_ROOMS, null], finished: [true, true, true, false], best: [1.24, 1.3, null, null] });

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
      if (nl >= 0) {
        clearTimeout(timer);
        const { port, standin_port: sp } = JSON.parse(out.slice(0, nl));
        resolve({ child, base: `http://127.0.0.1:${port}`, standin: `http://127.0.0.1:${sp}` });
      }
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

// The page's api/ addresses go to the real server; the rest (the sample
// rooms) to the app host's own fetch, kept through the setter.
function forward(base) {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  let inner = null;
  const posts = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    get: () => (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith('api/')) {
        if (opts.method === 'POST') posts.push(u);
        return nodeFetch(`${base}/${u}`, opts);
      }
      return inner(url, opts);
    },
    set: (f) => { inner = f; },
  });
  return { posts, restore: () => Object.defineProperty(globalThis, 'fetch', orig) };
}

// Step 12 of a fresh page, its canvases holding the desk's picture and
// encoding the copy the server receives.
async function pageAt9() {
  const app = await bootApp({ mode: 'rehearsal', road: AT12 });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  paintCanvases(app, DESK);
  const make = app.doc.createElement;
  app.doc.createElement = (tag) => {
    const e = make(tag);
    if (tag === 'canvas') e.toBlob = (cb, type = 'image/png') => cb(new Blob([DESK_PNG], { type }));
    return e;
  };
  return app;
}

const drill = (standin, name) => nodeFetch(`${standin}/drill`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then((r) => r.json());
const primaries = (app) => app.$('main').querySelectorAll('[data-primary]').map(textOf);

test('REHEARSAL through the merged pipeline and page: a winnable desk, an honest SAM busy, a refused key', { timeout: 300000 }, async () => {
  const { child, base, standin } = await startPair('desk');
  const s = forward(base);
  try {
    // ---- the saved desk sample picture: a winnable room of 9 objects ----
    const health = await (await nodeFetch(`${base}/api/health`)).json();
    assert.equal(health.mode, 'rehearsal');
    assert.equal(health.live_state, 'ok');
    const onSurface = desk.objects.filter((o) => o.on_surface).length;
    assert.equal(onSurface, 9, 'the desk has 9 things on it');
    let app = await pageAt9();
    assert.equal(app.button('Check again'), null, 'the stand-in is answering');
    app.choose(photoFile(61));
    await until(app, () => app.h1() === 'What the AI found', 'the reveal', 180000);
    assert.equal(s.posts.length, 1);
    assert.equal(app.step(), 13);
    const kept = app.levels();
    assert.equal(kept.length, 1, 'a clean read is kept on this device');
    const level = kept[0].level;
    assert.equal(level.origin, 'rehearsal');
    assert.equal(level.label, LABELS.rehearsal);
    assert.equal(level.objects.length, 9, 'every thing on the desk is in the room');
    assert.ok(level.proof.winnable, 'code proved the room can be won');
    const c = level.provenance.outline_sources;
    assert.equal(c.sam_mask, 9, 'all 9 from the masks the stand-in for SAM gave, read in its real grammar and decoded');
    assert.equal(level.surface.source, 'sam_mask', 'the stand-in’s mask of the desk is the play area');
    assert.match(textOf(app.$('main').querySelector('.summary')), /The stand-in for SAM 3\.1’s masks gave 9 exact outlines; code traced 0\./);
    assert.doesNotMatch(app.main(), /left out/, 'no box was bad');

    // ---- Ask the room: the stand-in's riddles come after the reply, on the same stream, and are kept with the level ----
    await until(app, () => (((app.levels()[0] || {}).level || {}).riddles || []).length === 3, 'the riddles, kept with the level', 60000);
    const riddles = app.levels()[0].level.riddles;
    assert.deepEqual(riddles.map((r) => r.origin), ['rehearsal', 'rehearsal', 'rehearsal'], 'from the stand-in, never Meta');
    assert.ok(riddles.every((r) => r.answers.length && r.answers.every((id) => /^o\d+$/.test(id))), 'under the reply’s own ids');
    assert.deepEqual(riddles.map((r) => r.n), [1, 3, 1], 'the count from SAM’s records: three coins');
    assert.equal(s.posts.length, 1, 'no second request: the riddles rode the same stream');

    // ---- SAM busy on every call: the busy words and Try this photo again ----
    assert.deepEqual(await drill(standin, 'sam_busy'), { drill: 'sam_busy' });
    app = await pageAt9();
    app.choose(photoFile(62));
    await until(app, () => app.button('Try this photo again'), 'Try this photo again', 120000);
    assert.equal(s.posts.length, 2);
    const busyWords = textOf(app.$('main').querySelector('.own-result .error'));
    assert.match(busyWords, /busy/i);
    assert.doesNotMatch(busyWords, /found none|clearer edges/, 'never blamed on the photo');
    assert.match(busyWords, /You can try this photo again, mark the room yourself instead, try another photo, or continue to the end\.$/);
    assert.deepEqual(primaries(app), ['Try this photo again']);
    assert.ok(app.button('Mark your room'), 'Mark your room beside it');
    assert.equal(app.button('Check again'), null, 'a busy SAM does not turn the picker off');
    assert.deepEqual(app.levels(), [], 'nothing kept');
    // the drill ends; the same photo, again, with no new pick
    await drill(standin, null);
    app.button('Try this photo again').click();
    await until(app, () => app.h1() === 'What the AI found', 'the reveal after trying again', 180000);
    assert.equal(s.posts.length, 3);
    assert.equal(app.levels()[0].level.objects.length, 9);

    // ---- a refused key: the picker off, Check again, Mark your room ----
    assert.deepEqual(await drill(standin, '401'), { drill: '401' });
    app = await pageAt9();
    app.choose(photoFile(63));
    await until(app, () => app.button('Check again'), 'Check again', 120000);
    assert.equal(s.posts.length, 4, 'the one read the stand-in refused');
    assert.equal(textOf(app.$('main').querySelector('.own-result .error')), `${KEY_WORDS.rehearsal} You can mark the room yourself instead, try another photo, or continue to the end.`);
    assert.deepEqual(primaries(app), ['Mark your room'], 'Mark your room is still the way on');
    assert.equal(app.button('Try this photo again'), null, 'a refused key is not a passing fault');
    assert.match(textOf(app.$('main').querySelector('.notice')), /^REHEARSAL, but the local stand-in answered as the live AI does for an account or model problem\. The local stand-in refused this server’s key/);
    // the picker is off: another photo stays on this device and can be marked
    app.choose(photoFile(64));
    await until(app, () => /Nothing was sent/.test(app.main()) && app.button('Mark your room'), 'the photo shown here', 60000);
    assert.equal(s.posts.length, 4, 'nothing more was sent');
    // the drill ends; Check again turns the picker back on
    await drill(standin, null);
    app.button('Check again').click();
    await until(app, () => !app.button('Check again') && !app.button('Checking…'), 'the picker on again', 30000);
    assert.doesNotMatch(textOf(app.$('main').querySelector('.notice')), /but the local stand-in answered/);
    // say() clears the live region and fills it on the next frame: wait for the words
    await until(app, () => app.$('live').textContent !== '', 'the live region', 10000);
    assert.equal(app.$('live').textContent, 'The stand-in is answering again: you can send its picture.');
    app.choose(photoFile(65));
    await until(app, () => app.h1() === 'What the AI found', 'the reveal after Check again', 180000);
    assert.equal(s.posts.length, 5);
  } finally {
    s.restore();
    delete globalThis.createImageBitmap;
    await stopPair(child);
  }
});
