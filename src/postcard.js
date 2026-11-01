// The room postcard: the round's own shrunk photo sent to Muse Image one
// more time, only when the player asks, behind the server's postcard switch
// (health.postcard, off by default: FRAMEPLAY_IMAGE=yes turns it on).
// makePostcard posts { photo, room } to /api/postcard; postcardCard shows
// the answer with its honest label. Touches the page only through el.
import { el } from './ui.js';

export const POSTCARD_LABEL = 'Made by Muse Image (AI)';
export const POSTCARD_BUTTON = 'Make a postcard (Muse Image)';
export const POSTCARD_TIP = 'Sends this round’s shrunk photo to Muse Image one more time, about one cent, for a postcard picture of this room';
export const POSTCARD_TITLE = 'Your postcard';
export const POSTCARD_BUSY = 'Making your postcard: the round’s shrunk photo is sent to Muse Image one more time.';
export const POSTCARD_READY = 'Your postcard is ready.';
export const POSTCARD_SAVE = 'Save the postcard';
export const POSTCARD_FAILED = 'The postcard could not be made. The round itself still works.';
export const POSTCARD_NO_SERVER = 'The postcard could not be made: the server did not answer. The round itself still works.';
export const POSTCARD_FILE = 'postcard.jpg';

const DATA_JPEG = 'data:image/jpeg;base64,';

// A blob (the shrunk JPEG just sent) as a data URL, for the postcard's later
// send. FileReader in browsers; arrayBuffer where there is none (tests).
export function blobToDataUrl(blob) {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('The photo could not be read again for a postcard.'));
      fr.readAsDataURL(blob);
    });
  }
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64 = typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bytes).toString('base64');
    return `data:${blob.type || 'image/jpeg'};base64,${b64}`;
  });
}

// The round's shrunk photo kept with its level in memory only: the property
// is not enumerable, so saving the level (src/store.js, JSON) never writes
// the photo to the device, and a level loaded from the device has none.
export function keepPostcardPhoto(level, dataUrl) {
  if (!level || typeof dataUrl !== 'string' || !dataUrl.startsWith(DATA_JPEG)) return false;
  Object.defineProperty(level, 'postcardPhoto', { value: dataUrl, enumerable: false, writable: true, configurable: true });
  return true;
}

// Whether the postcard switch is on, from the health answer.
export function postcardOn(health) {
  return !!health && health.postcard === 'on';
}

// Whether this level may offer a postcard: the switch on, and a LIVE read of
// a photo (never a sample room, a replay, a rehearsal or a marked room)
// whose own shrunk photo is still in memory.
export function postcardEligible(health, level) {
  if (!postcardOn(health)) return false;
  if (!level || level.origin !== 'live') return false;
  return typeof level.postcardPhoto === 'string' && level.postcardPhoto.startsWith(DATA_JPEG);
}

// The read-back in one line: what Muse Spark read on the postcard, and a
// match or the named difference (server/postcard.py compare_readback).
export function readbackLine(readback) {
  const lines = readback && Array.isArray(readback.lines) ? readback.lines.map((l) => String(l).trim()).filter(Boolean) : [];
  const shown = lines.length ? `“${lines.join(' / ')}”` : 'no printed text';
  if (readback && readback.match === true) return `Read back from the picture: ${shown}. It matches.`;
  const diff = readback && typeof readback.difference === 'string' && readback.difference.trim() ? readback.difference.trim() : 'it does not match the room’s name';
  return `Read back from the picture: ${shown}. It does not match: ${/[.!?]$/.test(diff) ? diff : `${diff}.`}`;
}

// POST /api/postcard with the round's shrunk photo data URL and the room's
// name, the way the page's other sends go (same origin, the request header,
// never cached). Returns the answer { image, label, mode, readback }, or
// throws an Error in words (the server's own, or this page's).
export async function makePostcard(photoDataUrl, roomName) {
  let res;
  try {
    res = await fetch('api/postcard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-FramePlay-Request': '1', Accept: 'application/json' },
      body: JSON.stringify({ photo: photoDataUrl, room: roomName }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new Error(POSTCARD_NO_SERVER);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body && typeof body.image === 'string' && body.image) return body;
  const words = body && body.error && typeof body.error.message === 'string' && body.error.message.trim()
    ? body.error.message.trim()
    : res.ok ? POSTCARD_FAILED : `${POSTCARD_FAILED.replace(/\.$/, '')} (the server answered ${res.status}).`;
  throw new Error(words);
}

// The postcard's own card: the picture, the honest label with the mode it
// was made in, the read-back in one line, and Save, a link that downloads
// the JPEG (keyboard reachable like any link).
export function postcardCard(answer, fileName = POSTCARD_FILE) {
  const mode = answer && typeof answer.mode === 'string' && answer.mode ? answer.mode : 'live';
  const label = answer && typeof answer.label === 'string' && answer.label ? answer.label : POSTCARD_LABEL;
  const src = `${DATA_JPEG}${answer.image}`;
  const img = el('img', { class: 'postcard-pic', src, alt: 'Your postcard: a picture of this room made by Muse Image' });
  const labelLine = el('p', { class: 'label postcard-label', text: `${label} · ${mode.toUpperCase()}` });
  const readLine = el('p', { class: 'postcard-read', text: readbackLine(answer.readback) });
  const save = el('a', {
    class: 'btn postcard-save', href: src, download: fileName,
    text: POSTCARD_SAVE, tip: 'Downloads the postcard picture as a JPEG to this device',
  });
  return el('div', { class: 'postcard-card' }, [img, labelLine, readLine, el('div', { class: 'actions' }, [save])]);
}
