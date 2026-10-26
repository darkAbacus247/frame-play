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

// Send the copy. Progress lines arrive first, then the reply. Throws an
// Error in words for a refusal the server sends as its own status.
export async function sendPhoto(blob, onProgress, url = 'api/room') {
  let res;
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
  if (!res.ok || !type.startsWith('application/x-ndjson')) {
    let words = `The server answered ${res.status}.`;
    try {
      const j = await res.json();
      if (j && j.error && j.error.message) words = j.error.message;
      if (res.ok && j && j.schema) return j;
    } catch { /* not JSON */ }
    throw new Error(words);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let reply = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'progress' && onProgress) onProgress(msg);
      else if (msg.type === 'reply') reply = msg.reply;
    }
    if (done) break;
  }
  if (!reply) throw new Error('The server stopped before it answered. Please try again.');
  return reply;
}
