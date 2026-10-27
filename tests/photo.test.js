// The photo path on the device, with fetch, timers, createImageBitmap,
// Image and the canvas stubbed: no browser, no server, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendPhoto, retryAfterSeconds, WAITING_WORDS, BUSY_WAIT_MS, readPhoto, previewPhoto, READ_LIMIT_MS, TOO_LONG_WORDS, CANCELED_WORDS } from '../src/photo.js';
import { photoRefusal, undecodableWords, photoKind, HEIC_WORDS, TOO_LARGE_WORDS, NOT_PICTURE_WORDS, jpegFacts, stripJpegMetadata, orientationToApply } from '../src/reply.js';
import { copyCanvas } from '../src/photo.js';
import { photoInput } from '../src/screens.js';
import { installFakeDocument } from './fakedom.js';

// ---- a picture stand-in: anything with width, height and pixel(x, y) ----
const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], GREEN = [0, 255, 0, 255];
const picture = (width, height, pixel) => ({ width, height, pixel });

// A canvas that really draws: transform() and drawImage() with nearest
// sampling, so where each pixel lands can be checked. toBlob gives a small
// JPEG-shaped file (with a camera segment a careless encoder might leave)
// whose scan holds an id the stubbed decoder looks up.
const ENCODED = new Map();
class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; this.px = null; this.m = [1, 0, 0, 1, 0, 0]; }
  pixel(x, y) { const i = (y * this.width + x) * 4; return this.px ? Array.from(this.px.subarray(i, i + 4)) : [0, 0, 0, 0]; }
  getContext() {
    const c = this;
    return {
      set imageSmoothingEnabled(v) {}, set imageSmoothingQuality(v) {},
      setTransform(a, b, cc, d, e, f) { c.m = [a, b, cc, d, e, f]; },
      transform(a, b, cc, d, e, f) {
        const [A, B, C, D, E, F] = c.m;
        c.m = [A * a + C * b, B * a + D * b, A * cc + C * d, B * cc + D * d, A * e + C * f + E, B * e + D * f + F];
      },
      drawImage(src, dx, dy, dw = src.width, dh = src.height) {
        if (!c.px) c.px = new Uint8ClampedArray(c.width * c.height * 4);
        const [a, b, cc, d, e, f] = c.m;
        const det = a * d - b * cc;
        for (let Y = 0; Y < c.height; Y++) {
          for (let X = 0; X < c.width; X++) {
            const x = X + 0.5 - e, y = Y + 0.5 - f;
            const u = (d * x - cc * y) / det, v = (-b * x + a * y) / det;
            if (u < dx || v < dy || u >= dx + dw || v >= dy + dh) continue;
            const p = src.pixel(Math.floor(((u - dx) * src.width) / dw), Math.floor(((v - dy) * src.height) / dh));
            c.px.set(p, (Y * c.width + X) * 4);
          }
        }
      },
      getImageData() { return { width: c.width, height: c.height, data: c.px }; },
    };
  }
  toBlob(cb, type) {
    const id = ENCODED.size + 1;
    ENCODED.set(id, picture(this.width, this.height, (x, y) => this.pixel(x, y)));
    cb(new Blob([jpegBytes({ width: this.width, height: this.height, orientation: 1, camera: true, id })], { type }));
  }
}

// ---- JPEG bytes by hand: SOI, JFIF, (EXIF with orientation and a GPS
// block, XMP, a comment), the frame header, a scan holding an id, EOI ----
const seg = (marker, body) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
const text = (s) => Array.from(s, (ch) => ch.charCodeAt(0));
function exif(orientation) {
  // big-endian TIFF: IFD0 with the orientation and a GPS IFD pointer
  const tiff = [...text('MM'), 0, 42, 0, 0, 0, 8, 0, 2,
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0,
    0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 38, 0, 0, 0, 0,
    ...text('GPS 51.5007N 0.1246W; Camera: PhoneCam 12; 2026:10:27 09:41')];
  return seg(0xe1, [...text('Exif'), 0, 0, ...tiff]);
}
function jpegBytes({ width, height, orientation = 1, camera = false, id = 0 }) {
  return new Uint8Array([0xff, 0xd8,
    ...seg(0xe0, [...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(camera ? [...exif(orientation), ...seg(0xe1, text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS</x:xmpmeta>')), ...seg(0xfe, text('shot on PhoneCam'))] : []),
    ...seg(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]), id >> 8, id & 255, 0xff, 0xd9]);
}
function scanId(bytes) {
  for (let i = 2; i < bytes.length - 1; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0xda) { const at = i + 2 + ((bytes[i + 2] << 8) | bytes[i + 3]); return (bytes[at] << 8) | bytes[at + 1]; }
  return 0;
}

// the page's globals for one test: document, createImageBitmap, Image, URL
async function withPage({ bitmap, image }, f) {
  const saved = { cib: globalThis.createImageBitmap, mk: URL.createObjectURL, rv: URL.revokeObjectURL, doc: globalThis.document };
  const urls = new Map();
  const revoked = [];
  const doc = installFakeDocument();
  const make = doc.createElement.bind(doc);
  const sources = [];
  class FakeImg {
    set src(u) { sources.push(u); this.file = urls.get(u); }
    async decode() { const p = await image(this.file); this.naturalWidth = p.width; this.naturalHeight = p.height; this.width = p.width; this.height = p.height; this.pixel = p.pixel; }
  }
  doc.createElement = (tag) => (tag === 'canvas' ? new FakeCanvas() : tag === 'img' ? new FakeImg() : make(tag));
  globalThis.createImageBitmap = async (src, opts) => {
    if (src instanceof Blob && !(src instanceof File)) {
      const pic = ENCODED.get(scanId(new Uint8Array(await src.arrayBuffer())));
      if (pic) return { ...pic, close() {} };
    }
    return bitmap(src, opts);
  };
  URL.createObjectURL = (b) => { const u = `blob:test/${urls.size + 1}`; urls.set(u, b); return u; };
  URL.revokeObjectURL = (u) => revoked.push(u);
  try {
    return await f({ revoked, sources, urls });
  } finally {
    globalThis.createImageBitmap = saved.cib;
    URL.createObjectURL = saved.mk;
    URL.revokeObjectURL = saved.rv;
    globalThis.document = saved.doc;
  }
}
const cannot = async () => { throw new Error('cannot decode'); };
const fileOf = (bytes, type, name = 'photo') => new File([bytes], name, { type });
const padded = (bytes, size) => { const b = new Uint8Array(size); b.set(bytes); return b; };

const ndjson = (lines) => new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(''), { headers: { 'Content-Type': 'application/x-ndjson' } });
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const busy = (after) => json(429, { error: { code: 'busy', message: 'Every reader on this server is busy with other photos. Please try again in a few seconds.' } }, after == null ? {} : { 'Retry-After': String(after) });
const OK = () => ndjson([{ type: 'progress', words: 'Reading your room' }, { type: 'reply', reply: { ok: 1 } }]);

// fetch answers from a list, one per call; records each call
async function withFetch(answers, f) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return typeof a === 'function' ? a(init) : a.clone(); // the list's own copy is never read
  };
  try {
    return await f(calls);
  } finally {
    globalThis.fetch = real;
  }
}

// a timer that only counts
function clock() {
  const slept = [];
  return { slept, sleep: async (ms) => { slept.push(ms); } };
}

test('D1: a busy server is waited for and the same copy sent again, with a countdown', async () => {
  const blob = new Blob(['the copy'], { type: 'image/jpeg' });
  const c = clock();
  const words = [];
  await withFetch([busy(1), OK()], async (calls) => {
    const reply = await sendPhoto(blob, (m) => words.push(m.words), 'api/room', { sleep: c.sleep });
    assert.deepEqual(reply, { ok: 1 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.body, blob);
    assert.equal(calls[1].init.body, blob, 'the very same copy, not read again');
  });
  assert.deepEqual(words, [`${WAITING_WORDS}: trying again in 1 s`, 'Reading your room'], 'one waiting line, then the read');
  assert.deepEqual(c.slept, [1000]);
});

test('D1: Retry-After is honored (5 s from the server, 5 s when none), with a line each second', async () => {
  for (const after of [5, null]) {
    const c = clock();
    const words = [];
    await withFetch([busy(after), OK()], () => sendPhoto(new Blob(['x']), (m) => words.push(m), 'u', { sleep: c.sleep }));
    assert.deepEqual(c.slept, [1000, 1000, 1000, 1000, 1000]);
    assert.deepEqual(words.slice(0, 5).map((m) => m.seconds), [5, 4, 3, 2, 1]);
    assert.ok(words.slice(0, 5).every((m) => m.type === 'progress' && m.stage === 'waiting'));
  }
});

test('D1: three busy answers in a row give the busy words; never more than 30 s of waiting', async () => {
  const c = clock();
  await withFetch([busy(5)], async (calls) => {
    await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { sleep: c.sleep }), { message: 'Every reader on this server is busy with other photos. Please try again in a few seconds.' });
    assert.equal(calls.length, 3);
  });
  assert.equal(c.slept.length, 10, 'two waits of 5 s');
  // a long Retry-After is cut to what is left of the 30 s
  const d = clock();
  await withFetch([busy(25)], async (calls) => {
    await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { sleep: d.sleep }), /busy with other photos/);
    assert.equal(calls.length, 3);
  });
  assert.equal(d.slept.reduce((s, ms) => s + ms, 0), BUSY_WAIT_MS);
  // past the 30 s, no third send
  const e = clock();
  await withFetch([busy(3600)], async (calls) => {
    await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { sleep: e.sleep }), /busy with other photos/);
    assert.equal(calls.length, 2);
  });
  assert.equal(e.slept.length, 30);
});

test('D1: the hourly, daily and spending stops and other refusals are not sent again', async () => {
  for (const [status, code] of [[429, 'hour_cap'], [429, 'day_cap'], [429, 'spend_stop'], [503, 'live_unavailable'], [400, 'bad_photo']]) {
    const c = clock();
    await withFetch([json(status, { error: { code, message: `Stopped: ${code}.` } }, { 'Retry-After': '5' })], async (calls) => {
      await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { sleep: c.sleep }), { message: `Stopped: ${code}.` });
      assert.equal(calls.length, 1, code);
    });
    assert.deepEqual(c.slept, []);
  }
  // a 429 that is not JSON is not retried either
  await withFetch([new Response('slow down', { status: 429 })], async (calls) => {
    await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { sleep: async () => {} }), { message: 'The server answered 429.' });
    assert.equal(calls.length, 1);
  });
});

test('D1: Retry-After read as seconds or as a date', () => {
  assert.equal(retryAfterSeconds('5'), 5);
  assert.equal(retryAfterSeconds(null), null);
  assert.equal(retryAfterSeconds('soon'), null);
  const now = Date.parse('2026-10-27T10:00:00Z');
  assert.equal(retryAfterSeconds('Tue, 27 Oct 2026 10:00:07 GMT', now), 7);
  assert.equal(retryAfterSeconds('Tue, 27 Oct 2026 09:00:00 GMT', now), 0);
});

// ---- D3: the decoder decides; HEIC and too-large words; a 120 s limit and Cancel ----

test('D3: the label does not decide: HEIC, empty and generic types are tried; plain non-photos are refused', () => {
  for (const type of ['', 'application/octet-stream', 'image/heic', 'image/heif', 'image/avif', 'image/jpeg', 'image/png', 'image/webp', 'IMAGE/JPEG']) {
    assert.equal(photoRefusal({ type, size: 2e6 }), null, `"${type}" is tried`);
  }
  for (const type of ['video/quicktime', 'text/plain', 'application/pdf', 'image/gif', 'image/svg+xml']) {
    assert.match(photoRefusal({ type, size: 2e6 }), /JPEG, PNG or WEBP/, type);
  }
  assert.match(photoRefusal({ type: '', size: 41 * 1024 * 1024 }), /40 MB/, 'the size still counts');
  assert.match(photoRefusal({ type: 'image/heic', size: 10 }), /too small/);
});

test('D3: the picker offers any picture, so desktop dialogs show HEIC files', () => {
  installFakeDocument();
  const input = photoInput(() => {});
  assert.equal(input.getAttribute('accept'), 'image/*');
});

test('D3: words for a file that would not open come from its first bytes', () => {
  const ftyp = (brand) => new Uint8Array([0, 0, 0, 24, ...text('ftyp'), ...text(brand), 0, 0, 0, 0]);
  for (const brand of ['heic', 'heix', 'hevc', 'mif1']) {
    assert.equal(photoKind(ftyp(brand)), 'heic');
    assert.equal(undecodableWords(ftyp(brand), ''), HEIC_WORDS, brand);
  }
  assert.equal(photoKind(ftyp('avif')), 'avif');
  assert.equal(undecodableWords(ftyp('avif'), 'image/avif'), NOT_PICTURE_WORDS);
  assert.equal(undecodableWords(jpegBytes({ width: 9, height: 9 }), ''), TOO_LARGE_WORDS, 'a real JPEG with no label');
  assert.equal(undecodableWords(new Uint8Array([0x89, ...text('PNG'), 13, 10, 26, 10]), 'application/octet-stream'), TOO_LARGE_WORDS);
  assert.equal(undecodableWords(new Uint8Array([...text('RIFF'), 0, 0, 0, 0, ...text('WEBP')]), ''), TOO_LARGE_WORDS);
  assert.equal(undecodableWords(new Uint8Array(16), 'image/jpeg'), TOO_LARGE_WORDS, 'labelled JPEG, bytes unknown');
  assert.equal(undecodableWords(new Uint8Array(16), 'image/heic'), HEIC_WORDS);
  assert.equal(undecodableWords(new Uint8Array(text('hello there, this is text')), ''), NOT_PICTURE_WORDS);
  assert.match(HEIC_WORDS, /screenshot/);
  assert.match(TOO_LARGE_WORDS, /too large for this device/);
});

test('D3: a photo createImageBitmap refuses is opened through an Image, shrunk to 1024 px', async () => {
  const big = picture(4032, 3024, () => RED);
  await withPage({ bitmap: cannot, image: async () => big }, async ({ revoked, sources, urls }) => {
    const file = fileOf(padded(jpegBytes({ width: 4032, height: 3024 }), 4096), 'image/jpeg');
    const p = await readPhoto(file);
    assert.equal(p.width, 1024);
    assert.equal(p.height, 768);
    assert.match(p.sha256, /^[0-9a-f]{64}$/);
    assert.equal(revoked.length, 1, 'the object URL is let go');
    assert.deepEqual(sources, revoked, 'the picture element only ever loads the blob: URL of the picked file');
    assert.ok(sources.every((u) => u.startsWith('blob:') && urls.get(u) === file));
    const v = await previewPhoto(file);
    assert.deepEqual([v.width, v.height], [1024, 768]);
  });
});

test('D3: an empty label is no bar: the decoder opens it', async () => {
  await withPage({ bitmap: async () => picture(800, 600, () => BLUE), image: cannot }, async () => {
    const p = await readPhoto(fileOf(padded(jpegBytes({ width: 800, height: 600 }), 4096), ''));
    assert.deepEqual([p.width, p.height], [800, 600]);
  });
});

test('D3: when nothing here can decode it: HEIC words for a HEIC, too-large words for a JPEG', async () => {
  await withPage({ bitmap: cannot, image: cannot }, async ({ revoked }) => {
    const heic = fileOf(padded(new Uint8Array([0, 0, 0, 24, ...text('ftypheic')]), 4096), 'image/heic', 'IMG_0001.HEIC');
    await assert.rejects(readPhoto(heic), { message: HEIC_WORDS });
    await assert.rejects(previewPhoto(heic), { message: HEIC_WORDS });
    const jpeg = fileOf(padded(jpegBytes({ width: 8000, height: 6000 }), 4096), 'image/jpeg');
    await assert.rejects(readPhoto(jpeg), { message: TOO_LARGE_WORDS });
    await assert.rejects(previewPhoto(fileOf(padded(new Uint8Array(text('just some text, really')), 4096), '')), { message: NOT_PICTURE_WORDS });
    assert.equal(revoked.length, 4, 'every object URL is let go, even when the Image fails');
  });
});

test('D3: a read that never answers is stopped at the limit, in the page’s words', async () => {
  assert.equal(READ_LIMIT_MS, 120000);
  await withFetch([() => new Promise(() => {})], async (calls) => {
    const t0 = Date.now();
    await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { timeoutMs: 30 }), (e) => e.message === TOO_LONG_WORDS && e.code === 'too_long' && e.retrySame === true);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(calls[0].init.signal.aborted, true, 'the request itself is aborted');
  });
});

test('D3: Cancel stops a read at once, before, during the request, while waiting, or mid-stream', async () => {
  const canceled = (e) => e.message === CANCELED_WORDS && e.code === 'canceled';
  // already canceled: nothing is sent
  await withFetch([OK()], async (calls) => {
    await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { signal: AbortSignal.abort() }), canceled);
    assert.equal(calls.length, 0);
  });
  // during the request
  await withFetch([() => new Promise(() => {})], async (calls) => {
    const ctl = new AbortController();
    const p = sendPhoto(new Blob(['x']), () => {}, 'u', { signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    await assert.rejects(p, canceled);
    assert.equal(calls[0].init.signal.aborted, true);
  });
  // while waiting for a free reader: no second send
  await withFetch([busy(5), OK()], async (calls) => {
    const ctl = new AbortController();
    let ticks = 0;
    const sleep = async () => { if (++ticks === 2) ctl.abort(); };
    await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { signal: ctl.signal, sleep }), canceled);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls.length, 1);
  });
  // mid-stream: the progress came, the reply never does
  const stalled = (init) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"type":"progress","words":"Reading your room"}\n'));
      init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
    },
  }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  await withFetch([stalled], async () => {
    const ctl = new AbortController();
    const words = [];
    const p = sendPhoto(new Blob(['x']), (m) => { words.push(m.words); ctl.abort(); }, 'u', { signal: ctl.signal });
    await assert.rejects(p, canceled);
    assert.deepEqual(words, ['Reading your room']);
  });
  // a finished read is not touched by a later Cancel, and leaves no timer
  await withFetch([OK()], async () => {
    const ctl = new AbortController();
    assert.deepEqual(await sendPhoto(new Blob(['x']), () => {}, 'u', { signal: ctl.signal }), { ok: 1 });
    ctl.abort();
  });
});

// ---- D4: EXIF orientation honored, camera data stripped ----

// Where each stored pixel shows, by EXIF orientation (the EXIF definition,
// written out independently of the page's transforms): the upright
// picture's pixel (x, y) is the stored picture's pixel at.
const STORED_AT = {
  1: (x, y) => [x, y],
  2: (x, y, w) => [w - 1 - x, y],
  3: (x, y, w, h) => [w - 1 - x, h - 1 - y],
  4: (x, y, w, h) => [x, h - 1 - y],
  5: (x, y) => [y, x],
  6: (x, y, w) => [y, w - 1 - x],
  7: (x, y, w, h) => [h - 1 - y, w - 1 - x],
  8: (x, y, w, h) => [h - 1 - y, x],
};
const tag = (x, y) => [x * 30, y * 30, 7, 255]; // every stored pixel its own colour
const pixelsOfCanvas = (c) => { const out = []; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) out.push(c.pixel(x, y).join()); return out; };

test('D4: every EXIF orientation is turned upright, pixel for pixel', async () => {
  await withPage({ bitmap: cannot, image: cannot }, async () => {
    const sw = 5, sh = 3; // as stored
    const stored = picture(sw, sh, tag);
    for (let o = 1; o <= 8; o++) {
      const c = copyCanvas(stored, sw, sh, o);
      const [w, h] = o >= 5 ? [sh, sw] : [sw, sh];
      assert.deepEqual([c.width, c.height], [w, h], `orientation ${o}: sides`);
      const want = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) want.push(tag(...STORED_AT[o](x, y, w, h)).join());
      assert.deepEqual(pixelsOfCanvas(c), want, `orientation ${o}: pixels`);
    }
    // and a big turned photo is shrunk on its upright long side
    const c = copyCanvas(picture(4032, 3024, () => RED), 4032, 3024, 6);
    assert.deepEqual([c.width, c.height], [768, 1024]);
  });
});

test('D4: the stored size and EXIF orientation are read from the JPEG header', () => {
  assert.deepEqual(jpegFacts(jpegBytes({ width: 4032, height: 3024, orientation: 6, camera: true })), { width: 4032, height: 3024, orientation: 6 });
  assert.deepEqual(jpegFacts(jpegBytes({ width: 640, height: 480 })), { width: 640, height: 480, orientation: 1 }, 'no EXIF: as stored');
  assert.equal(jpegFacts(new Uint8Array(text('not a jpeg at all'))), null);
  // a little-endian EXIF block (as many cameras write it) with orientation 8
  const le = [...text('II'), 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0];
  const bytes = new Uint8Array([0xff, 0xd8, ...seg(0xe1, [...text('Exif'), 0, 0, ...le]), ...seg(0xc2, [8, 0, 10, 0, 20, 1, 1, 0x11, 0]), 0xff, 0xd9]);
  assert.deepEqual(jpegFacts(bytes), { width: 20, height: 10, orientation: 8 });
  // whether the page still has to turn what the decoder gave
  const facts = { width: 4032, height: 3024, orientation: 6 };
  assert.equal(orientationToApply(facts, 4032, 3024), 6, 'the decoder ignored it');
  assert.equal(orientationToApply(facts, 3024, 4032), 1, 'the decoder turned it already');
  assert.equal(orientationToApply({ ...facts, orientation: 1 }, 4032, 3024), 1);
  assert.equal(orientationToApply({ width: 900, height: 900, orientation: 6 }, 900, 900), 1, 'a square cannot be told: the decoder is trusted');
  assert.equal(orientationToApply(null, 10, 10), 1);
});

test('D4: every camera segment is taken out; the picture itself is kept byte for byte', () => {
  const src = jpegBytes({ width: 64, height: 48, orientation: 6, camera: true, id: 77 });
  const raw = new TextDecoder('latin1').decode(src);
  for (const s of ['Exif', 'GPS', 'PhoneCam', 'xmpmeta']) assert.ok(raw.includes(s), `the test file has ${s}`);
  const out = stripJpegMetadata(src);
  const kept = new TextDecoder('latin1').decode(out);
  for (const s of ['Exif', 'GPS', 'PhoneCam', 'xmpmeta', '2026:10:27']) assert.ok(!kept.includes(s), `${s} is gone`);
  assert.ok(kept.includes('JFIF'), 'the JFIF header stays');
  assert.deepEqual(jpegFacts(out), { width: 64, height: 48, orientation: 1 });
  assert.equal(scanId(out), 77, 'the scan is untouched');
  assert.deepEqual(Array.from(out.subarray(-4)), Array.from(src.subarray(-4)));
  assert.deepEqual(stripJpegMetadata(out), out, 'stripping twice changes nothing');
  const png = new Uint8Array([0x89, ...text('PNG'), 13, 10, 26, 10, 1, 2, 3]);
  assert.deepEqual(stripJpegMetadata(png), png, 'not a JPEG: unchanged');
});

// A portrait phone photo as phones store it: landscape pixels, EXIF 6.
// Upright, the top half is red, the bottom half blue, the top-left pixel
// green (so a mirror image would show).
const PW = 8, PH = 4; // stored
const uprightOf = (x, y) => (x === 0 && y === 0 ? GREEN : y < PW / 2 ? RED : BLUE); // upright is PH wide, PW high
const storedPortrait = picture(PW, PH, (sx, sy) => {
  // the inverse of STORED_AT[6]: stored (sx, sy) shows at upright (PH - 1 - sy, sx)
  return uprightOf(PH - 1 - sy, sx);
});
const uprightPortrait = picture(PH, PW, uprightOf);
function assertUpright(c, what) {
  assert.deepEqual([c.width, c.height], [PH, PW], `${what}: portrait sides`);
  for (let y = 0; y < PW; y++) for (let x = 0; x < PH; x++) assert.deepEqual(c.pixel(x, y), uprightOf(x, y), `${what}: pixel ${x},${y}`);
}
const phoneFile = () => fileOf(padded(jpegBytes({ width: PW, height: PH, orientation: 6, camera: true }), 4096), 'image/jpeg', 'IMG_0002.JPG');

test('D4: a portrait phone photo is shown and sent upright, and the copy sent holds no camera data', async () => {
  const cases = [
    ['a decoder that ignores EXIF', { bitmap: async () => storedPortrait, image: cannot }],
    ['a decoder that applies EXIF', { bitmap: async (src, opts) => { assert.equal(opts.imageOrientation, 'from-image'); return uprightPortrait; }, image: cannot }],
    ['the picture-element fallback (it applies EXIF)', { bitmap: cannot, image: async () => uprightPortrait }],
    ['a picture-element fallback that ignores EXIF', { bitmap: cannot, image: async () => storedPortrait }],
  ];
  for (const [what, page] of cases) {
    await withPage(page, async () => {
      const file = phoneFile();
      const p = await readPhoto(file);
      assert.deepEqual([p.width, p.height], [PH, PW], what);
      assertUpright(p.picture, `${what}, shown`);
      // the very bytes that are sent
      const sent = new Uint8Array(await p.blob.arrayBuffer());
      assert.equal(p.blob.type, 'image/jpeg');
      const words = new TextDecoder('latin1').decode(sent);
      for (const s of ['Exif', 'GPS', 'PhoneCam', 'xmpmeta', '2026:10:27']) assert.ok(!words.includes(s), `${what}: no ${s} in the copy sent`);
      assert.deepEqual(jpegFacts(sent), { width: PH, height: PW, orientation: 1 }, `${what}: sent upright, with no turn left for the server to apply`);
      const enc = ENCODED.get(scanId(sent));
      for (let y = 0; y < PW; y++) for (let x = 0; x < PH; x++) assert.deepEqual(enc.pixel(x, y), uprightOf(x, y), `${what}: sent pixel ${x},${y}`);
      // the MOCK preview is upright too
      assertUpright((await previewPhoto(file)).picture, `${what}, preview`);
    });
  }
});
