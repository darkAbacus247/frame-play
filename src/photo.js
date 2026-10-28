// The photo path on the device: decode the picked file, shrink it to at most
// 1024 px on its long side, re-encode it as JPEG at quality 0.9 (so camera,
// place and time data never leave the device), take the sha256 of the
// file's own bytes, and send the copy with progress lines (waiting out a
// busy server, stopped after 120 s or by the page's Cancel). The browser's
// decoder decides what a photo is, never the file's label. Touches the page.
import { shrinkSize, photoRefusal, undecodableWords, jpegFacts, orientationToApply, stripJpegMetadata } from './reply.js';

export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('This browser cannot fingerprint the photo here (it needs a secure page).');
  const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// A canvas holding the copy: the exact pixels that are sent. `orientation`
// is the EXIF turn (1 to 8) still to apply to a source of w × h, so a
// portrait phone photo is shown and sent upright; 5 to 8 swap the sides.
export function copyCanvas(source, w, h, orientation = 1) {
  const o = orientation >= 2 && orientation <= 8 ? orientation : 1;
  const swap = o >= 5;
  const size = swap ? shrinkSize(h, w) : shrinkSize(w, h);
  const W = size.width, H = size.height;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  const turn = { 2: [-1, 0, 0, 1, W, 0], 3: [-1, 0, 0, -1, W, H], 4: [1, 0, 0, -1, 0, H], 5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, W, 0], 7: [0, -1, -1, 0, W, H], 8: [0, -1, 1, 0, 0, H] }[o];
  if (turn) g.transform(...turn);
  g.drawImage(source, 0, 0, swap ? H : W, swap ? W : H);
  return c;
}

// The copy as JPEG, with every camera segment taken out of the encoder's
// output too (src/reply.js stripJpegMetadata), so no camera, place or time
// data can leave the device whatever the browser's encoder writes.
export function canvasJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The photo could not be re-encoded.'))), 'image/jpeg', 0.9);
  }).then(async (b) => new Blob([stripJpegMetadata(new Uint8Array(await b.arrayBuffer()))], { type: 'image/jpeg' }));
}

// The JPEG copy decoded again, so the page traces the very pixels the
// server sent on (JPEG changes them a little).
export async function decodeToCanvas(blob, width, height) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, width, height);
  if (bmp.close) bmp.close();
  return c;
}

export function pixelsOf(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

// The browser's decoder decides what a photo is, whatever its label says.
// First createImageBitmap; when that fails (a full-size decode of a big
// phone photo can), an Image, which phone browsers decode more frugally.
// When both fail, the words come from the file's first bytes: HEIC this
// browser cannot open, a photo too large for this device, or not a picture.
// Gives { source, width, height, done() }; done() frees it.
export async function decodePhoto(file, head = null) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bmp, width: bmp.width, height: bmp.height, done: () => { if (bmp.close) bmp.close(); } };
  } catch { /* try an Image */ }
  try {
    return await decodeWithImage(file);
  } catch { /* neither could */ }
  let first = head;
  try { first = first || new Uint8Array(await file.slice(0, 64).arrayBuffer()); } catch { /* the label alone */ }
  throw new Error(undecodableWords(first, file.type));
}

// The picture element only ever gets a blob: URL of the picked file itself,
// made here: it loads nothing from the network and sends nothing.
async function decodeWithImage(file) {
  if (typeof document === 'undefined' || !globalThis.URL || !URL.createObjectURL) throw new Error('no picture element here');
  const url = URL.createObjectURL(file);
  const done = () => URL.revokeObjectURL(url);
  try {
    const img = document.createElement('img');
    img.decoding = 'async';
    const loaded = img.decode ? null : new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
    img.src = url;
    await (loaded || img.decode());
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty picture');
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done };
  } catch (e) {
    done();
    throw e;
  }
}

// Read a picked file: { sha256, blob, picture (canvas), width, height }.
export async function readPhoto(file) {
  const why = photoRefusal(file);
  if (why) throw new Error(why);
  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const pic = await decodePhoto(file, new Uint8Array(bytes, 0, Math.min(64, bytes.byteLength)));
  const copy = copyCanvas(pic.source, pic.width, pic.height, orientationToApply(jpegFacts(bytes), pic.width, pic.height));
  pic.done();
  const blob = await canvasJpeg(copy);
  const picture = await decodeToCanvas(blob, copy.width, copy.height);
  return { sha256, blob, picture, width: copy.width, height: copy.height };
}

// A picked photo to show on this device only (MOCK): decoded and shrunk
// here, never fingerprinted, encoded or sent. Upright like the sent copy.
export async function previewPhoto(file) {
  const why = photoRefusal(file);
  if (why) throw new Error(why);
  const pic = await decodePhoto(file);
  const picture = copyCanvas(pic.source, pic.width, pic.height, orientationToApply(await headerFacts(file), pic.width, pic.height));
  pic.done();
  return { picture, width: picture.width, height: picture.height };
}
// The JPEG facts from the start of a file (enough to hold its EXIF block,
// at most 64 KB, and its frame header), or null when it cannot be read.
const HEADER_BYTES = 256 * 1024;
async function headerFacts(file) {
  try {
    return jpegFacts(await file.slice(0, HEADER_BYTES).arrayBuffer());
  } catch {
    return null;
  }
}

// When every reader on the server is busy (429, code 'busy'), the same copy
// is sent again after the server's Retry-After (5 s when it names none),
// at most 3 sends and 30 s of waiting in all, with a countdown line each
// second. The hourly, daily and spending stops are never sent again.
export const BUSY_TRIES = 3;
export const BUSY_WAIT_MS = 30000;
export const BUSY_DEFAULT_S = 5;
export const WAITING_WORDS = 'Waiting for a free reader (another photo is being read)';

// Seconds from a Retry-After header (seconds or a date), or null.
export function retryAfterSeconds(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : null;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// A send is stopped after 120 s in all (waits included), or at once when
// the page's own signal aborts (its Cancel button). Either way the request
// itself is aborted, and the send rejects with an Error whose `code` says
// which: 'too_long' or 'canceled'. Both may pass, so both carry retrySame:
// the page offers the same photo again.
export const READ_LIMIT_MS = 120000;
export const TOO_LONG_WORDS = 'The read took too long, so this page stopped it after 120 seconds.';
export const CANCELED_WORDS = 'The read was canceled, so nothing was made from this photo.';
function stopped(code) {
  const e = new Error(code === 'canceled' ? CANCELED_WORDS : TOO_LONG_WORDS);
  e.code = code;
  e.retrySame = true;
  return e;
}

// A refusal the server sends as its own status (503 live_unavailable, 429
// busy, the hourly and daily stops): its words, and what the page acts on,
// `code` (null when the body names none), the HTTP `status`, `retryAfter`
// in seconds (or null), and `retrySame` for the one that may pass on the
// same photo (every reader busy, after the waits here).
export const RETRY_SAME_CODES = new Set(['busy']);
function refused(words, code, res) {
  return Object.assign(new Error(words), {
    code: code || null,
    status: res.status,
    retryAfter: retryAfterSeconds(res.headers.get('Retry-After')),
    retrySame: RETRY_SAME_CODES.has(code),
  });
}

// Send the copy. Progress lines arrive first, then the reply. Throws an
// Error in words, carrying its code, for a refusal the server sends as its
// own status (refused, above).
// opts.signal: an AbortSignal for the page's Cancel; opts.timeoutMs: the
// limit (120 s); opts.sleep(ms) stands in for the timer in tests.
export async function sendPhoto(blob, onProgress, url = 'api/room', opts = {}) {
  const outer = opts.signal || null;
  if (outer && outer.aborted) throw stopped('canceled');
  const ctl = new AbortController();
  let why = null;
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  const stop = (code) => { if (why) return; why = code; ctl.abort(); fail(stopped(code)); };
  const onCancel = () => stop('canceled');
  if (outer) outer.addEventListener('abort', onCancel, { once: true });
  const timer = setTimeout(() => stop('too_long'), opts.timeoutMs ?? READ_LIMIT_MS);
  const run = readThrough(blob, onProgress, url, opts.sleep || pause, ctl.signal, opts.onRiddles);
  run.catch(() => {}); // once stopped, what the read throws later is not news
  try {
    return await Promise.race([run, failed]);
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onCancel);
  }
}

async function readThrough(blob, onProgress, url, sleep, signal, onRiddles) {
  let waited = 0;
  let res;
  for (let send = 1; ; send++) {
    if (signal.aborted) return null;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'X-FramePlay-Request': '1', 'Content-Type': blob.type || 'image/jpeg', Accept: 'application/x-ndjson' },
        body: blob,
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      });
    } catch {
      throw new Error('The server could not be reached. Please check the connection and try again.');
    }
    const type = res.headers.get('Content-Type') || '';
    if (res.ok && type.startsWith('application/x-ndjson')) break;
    let words = `The server answered ${res.status}.`;
    let code = null;
    try {
      const j = await res.json();
      if (j && j.error && j.error.message) words = j.error.message;
      if (j && j.error) code = j.error.code;
      if (res.ok && j && j.schema) return j;
    } catch { /* not JSON */ }
    const left = BUSY_WAIT_MS - waited;
    if (res.status !== 429 || code !== 'busy' || send >= BUSY_TRIES || left < 1000) throw refused(words, code, res);
    const asked = retryAfterSeconds(res.headers.get('Retry-After'));
    let s = Math.max(1, Math.min(Math.floor(left / 1000), asked == null ? BUSY_DEFAULT_S : asked));
    waited += s * 1000;
    for (; s > 0; s--) {
      if (onProgress) onProgress({ type: 'progress', stage: 'waiting', words: `${WAITING_WORDS}: trying again in ${s} s`, seconds: s });
      await sleep(1000);
      if (signal.aborted) return null;
    }
  }
  // The progress lines are read as they come from a copy of the body, while
  // the body itself is read whole: a browser records a body read only by a
  // stream reader as canceled, even when every byte arrived; read whole,
  // the request finishes cleanly. The reply is taken from the whole body.
  const copy = res.clone();
  const whole = res.text().catch(() => null);
  const reader = copy.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const each = (text, f) => {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      f(msg);
    }
  };
  // a stream cut mid-way says so in the page's own words, never the
  // browser's ('network error')
  const STOPPED = 'The server stopped before it answered. Please try again.';
  // Ask the room: the reply is handed on the moment its line arrives, and
  // the stream is read on behind the room for the riddles line, which
  // comes after one more Muse Spark call. A stream cut after the reply
  // keeps the room; its riddles are then an error, said to onRiddles.
  let reply = null, riddles = null, cut = false, got;
  const gotReply = new Promise((r) => { got = r; });
  const take = (msg) => {
    if (msg.type === 'progress' && onProgress) onProgress(msg);
    else if (msg.type === 'reply' && !reply) { reply = msg.reply; got(reply); }
    else if (msg.type === 'riddles' && !riddles) riddles = msg.riddles;
  };
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        const nl = buf.lastIndexOf('\n');
        if (nl >= 0) {
          each(buf.slice(0, nl), take);
          buf = buf.slice(nl + 1);
        }
        if (done) break;
      }
    } catch {
      cut = true;
    }
  })();
  const early = await Promise.race([gotReply, pump.then(() => null)]);
  const riddlesAfter = () => {
    if (!onRiddles) return;
    Promise.all([pump, whole]).then(([, text]) => {
      if (!riddles && text) each(text, (msg) => { if (msg.type === 'riddles' && !riddles) riddles = msg.riddles; });
      onRiddles(riddles || { status: 'error', error: { code: 'cut_off', message: 'The riddles did not arrive.' } });
    });
  };
  if (early) {
    riddlesAfter();
    return early;
  }
  if (cut) throw new Error(STOPPED);
  // the reader ended with no reply line: the reply is taken from the whole body
  each((await whole) || '', (msg) => { if (msg.type === 'reply' && !reply) reply = msg.reply; });
  if (!reply) throw new Error(STOPPED);
  riddlesAfter();
  return reply;
}
