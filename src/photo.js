// The photo path on the device: decode the picked file, shrink it to at most
// 1024 px on its long side, re-encode it as JPEG at quality 0.9 (so camera,
// place and time data never leave the device), take the sha256 of the
// file's own bytes, and send the copy with progress lines. Touches the page.
import { shrinkSize, photoRefusal } from './reply.js';

export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('This browser cannot fingerprint the photo here (it needs a secure page).');
  const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// A canvas holding the copy: the exact pixels that are sent.
export function copyCanvas(source, w, h) {
  const size = shrinkSize(w, h);
  const c = document.createElement('canvas');
  c.width = size.width;
  c.height = size.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, size.width, size.height);
  return c;
}

export function canvasJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The photo could not be re-encoded.'))), 'image/jpeg', 0.9);
  });
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

// Read a picked file: { sha256, blob, picture (canvas), width, height }.
export async function readPhoto(file) {
  const why = photoRefusal(file);
  if (why) throw new Error(why);
  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This photo could not be opened. Please try a JPEG, PNG or WEBP photo.');
  }
  const copy = copyCanvas(bmp, bmp.width, bmp.height);
  if (bmp.close) bmp.close();
  const blob = await canvasJpeg(copy);
  const picture = await decodeToCanvas(blob, copy.width, copy.height);
  return { sha256, blob, picture, width: copy.width, height: copy.height };
}

// A picked photo to show on this device only (MOCK): decoded and shrunk
// here, never fingerprinted, encoded or sent.
export async function previewPhoto(file) {
  const why = photoRefusal(file);
  if (why) throw new Error(why);
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This photo could not be opened. Please try a JPEG, PNG or WEBP photo.');
  }
  const picture = copyCanvas(bmp, bmp.width, bmp.height);
  if (bmp.close) bmp.close();
  return { picture, width: picture.width, height: picture.height };
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

// Send the copy. Progress lines arrive first, then the reply. Throws an
// Error in words for a refusal the server sends as its own status.
// opts.sleep(ms) stands in for the timer in tests.
export async function sendPhoto(blob, onProgress, url = 'api/room', opts = {}) {
  const sleep = opts.sleep || pause;
  let waited = 0;
  let res;
  for (let send = 1; ; send++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'X-FramePlay-Request': '1', 'Content-Type': blob.type || 'image/jpeg', Accept: 'application/x-ndjson' },
        body: blob,
        credentials: 'same-origin',
        cache: 'no-store',
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
    if (res.status !== 429 || code !== 'busy' || send >= BUSY_TRIES || left < 1000) throw new Error(words);
    const asked = retryAfterSeconds(res.headers.get('Retry-After'));
    let s = Math.max(1, Math.min(Math.floor(left / 1000), asked == null ? BUSY_DEFAULT_S : asked));
    waited += s * 1000;
    for (; s > 0; s--) {
      if (onProgress) onProgress({ type: 'progress', stage: 'waiting', words: `${WAITING_WORDS}: trying again in ${s} s`, seconds: s });
      await sleep(1000);
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
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      const nl = buf.lastIndexOf('\n');
      if (nl >= 0) {
        each(buf.slice(0, nl), (msg) => { if (msg.type === 'progress' && onProgress) onProgress(msg); });
        buf = buf.slice(nl + 1);
      }
      if (done) break;
    }
  } catch {
    throw new Error(STOPPED);
  }
  let reply = null;
  each((await whole) || '', (msg) => { if (msg.type === 'reply') reply = msg.reply; });
  if (!reply) throw new Error(STOPPED);
  return reply;
}
