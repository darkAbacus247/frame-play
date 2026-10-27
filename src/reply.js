// Which server replies the page accepts, and how a reply becomes the input
// of the level builder. Pure logic: no page, no canvas.
import { LABELS } from './level.js';

export const REPLY_SCHEMA = 'frameplay.room.reply/2';
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
export const MAX_SIDE = 1024;

// Why a picked file cannot be used, in words, or null. The browser's own
// decoder decides what a photo is: HEIC, HEIF, AVIF and files whose type is
// empty or generic (some cloud pickers) are tried. Only a label that says
// the file is plainly not a still photo is refused here (a video, a text,
// an animated GIF, an SVG drawing).
export function photoRefusal(file) {
  if (!file) return 'No photo was picked.';
  const type = String(file.type || '').toLowerCase();
  const generic = !type || type === 'application/octet-stream';
  if (!generic && (!type.startsWith('image/') || type === 'image/gif' || type.startsWith('image/svg'))) return 'Please pick a JPEG, PNG or WEBP photo.';
  if (file.size > MAX_PHOTO_BYTES) return 'That photo is larger than 40 MB. Please pick a smaller one.';
  if (file.size < 64) return 'That file is too small to be a photo.';
  return null;
}

// Words for a file this browser could not decode, from its first bytes
// (and its label): HEIC gets its own way forward; a real JPEG, PNG or WEBP
// that would not open is too large for this device; anything else is not
// a picture here.
export const HEIC_WORDS = 'This browser cannot open HEIC photos. Take a screenshot of the photo and pick that, or set the camera to save ‘Most Compatible’ (JPEG), or open the page on your phone.';
export const TOO_LARGE_WORDS = 'This photo is too large for this device to open. Please pick a smaller copy or a screenshot of it.';
export const NOT_PICTURE_WORDS = 'This file could not be opened as a picture here. Please pick a JPEG or PNG photo.';
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
const ascii = (b, from, to) => String.fromCharCode(...Array.from(b.subarray(from, to)));
export function photoKind(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (HEIC_BRANDS.includes(brand)) return 'heic';
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}
export function undecodableWords(firstBytes, type = '') {
  const kind = photoKind(firstBytes);
  const t = String(type || '').toLowerCase();
  if (kind === 'heic' || (!kind && /^image\/hei[cf]/.test(t))) return HEIC_WORDS;
  if (kind === 'jpeg' || kind === 'png' || kind === 'webp' || (!kind && PHOTO_TYPES.includes(t))) return TOO_LARGE_WORDS;
  return NOT_PICTURE_WORDS;
}

// ---- JPEG headers: the stored size, the EXIF orientation, and a copy with
// every camera segment taken out. Pure byte work, no decoder.

// { width, height, orientation } of a JPEG as stored (before the EXIF
// orientation is applied), or null when the bytes are not a JPEG.
// orientation is 1 when the file names none.
export function jpegFacts(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (photoKind(b) !== 'jpeg') return null;
  const out = { width: 0, height: 0, orientation: 1 };
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return out.width ? out : null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) break;
    const seg = b.subarray(i + 4, Math.min(b.length, i + 2 + len));
    if (m === 0xe1 && seg.length > 14 && ascii(seg, 0, 6) === 'Exif\0\0') out.orientation = exifOrientation(seg.subarray(6)) || out.orientation;
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof && seg.length >= 5) {
      out.height = (seg[1] << 8) | seg[2];
      out.width = (seg[3] << 8) | seg[4];
    }
    i += 2 + len;
  }
  return out.width && out.height ? out : null;
}

// The orientation tag (0x0112) of IFD0 in a TIFF block, 1 to 8, or 0.
function exifOrientation(t) {
  if (t.length < 8) return 0;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return 0;
  const u16 = (o) => (o + 2 <= t.length ? (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]) : 0);
  const u32 = (o) => (o + 4 <= t.length ? (le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16)) + t[o + 3] * 2 ** 24 : t[o] * 2 ** 24 + ((t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3])) : 0);
  const ifd = u32(4);
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

// A JPEG with every APP1 to APP15 segment (EXIF, XMP, ICC, maker notes:
// camera, place and time) and every comment taken out. The JFIF header
// (APP0) and the picture itself are kept byte for byte. Bytes that are not
// a JPEG come back unchanged.
export function stripJpegMetadata(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (photoKind(b) !== 'jpeg') return b;
  const parts = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xda || m === 0xd9) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) break;
    const camera = (m >= 0xe1 && m <= 0xef) || m === 0xfe;
    if (!camera) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(b.subarray(i));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// The orientation the page must still apply to a decoded picture. A
// decoder asked for 'from-image' usually turns the picture itself; when the
// EXIF orientation swaps the sides (5 to 8, a portrait phone photo) and the
// decoded picture still has the stored sides, the decoder ignored it, and
// the page turns it. Otherwise (no turn named, the decoder turned it, or a
// square picture or a turn that keeps the sides, where it cannot be told)
// the decoder is trusted: 1.
export function orientationToApply(facts, decodedWidth, decodedHeight) {
  const o = facts && facts.orientation;
  if (!(o >= 5 && o <= 8)) return 1;
  if (facts.width === facts.height) return 1;
  return decodedWidth === facts.width && decodedHeight === facts.height ? o : 1;
}

// The size of the copy that is sent: at most 1024 px on the long side.
export function shrinkSize(w, h, max = MAX_SIDE) {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

const isBox = (b, W, H) => Array.isArray(b) && b.length === 4 && b.every((v) => Number.isFinite(v))
  && b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H && b[2] > b[0] && b[3] > b[1];

// A reply is accepted only from a server that said it is in the same mode
// (LIVE only from a live server, REHEARSAL only from a rehearsing one; a
// replay of the sample kitchen photo's recorded answers only when a replay
// was asked for), for the very copy that was sent. Returns { ok, why,
// dropped, words }.
// An object whose box is not usable (outside the picture, empty, not
// numbers) is left out rather than sinking the whole reply, and so is an
// unusable surface: the reply is cleaned in place (the page goes on with
// the same object), `reply.dropped` says how many objects went and whether
// the surface did, each one gets a `not used:` warning, and `words` says
// so in one sentence ('' when nothing was left out). The reply is refused
// only when no object is left.
export function acceptReply(healthMode, reply, copy) {
  const no = (why) => ({ ok: false, why });
  if (!reply || typeof reply !== 'object' || reply.schema !== REPLY_SCHEMA) return no('The server answered in a shape this page does not know.');
  const mode = reply.provenance && reply.provenance.mode;
  if (mode !== 'live' && mode !== 'rehearsal' && mode !== 'replay') return no('The server did not say how it read the photo.');
  if (mode !== healthMode) {
    if (mode === 'replay' || healthMode === 'replay') return no(healthMode === 'replay' ? 'The server was asked to replay the recorded answer but answered as a fresh read.' : 'The server answered with a replay where a fresh read was asked for.');
    return no(`The server said it was ${String(healthMode).toUpperCase()} but answered as ${mode.toUpperCase()}.`);
  }
  if (reply.provenance.label !== LABELS[mode]) return no('The reply’s label does not match its mode.');
  if (mode === 'rehearsal' && (reply.provenance.models || []).length) return no('A rehearsal reply may not claim a model.');
  if (mode === 'replay' && ((reply.provenance.models || []).length || !reply.provenance.replay)) return no('A replay may not claim a model called now, and must say what it replays.');
  if (reply.status !== 'ok') return no(refusalWords(reply));
  const r = reply.received || {};
  if (r.width !== copy.width || r.height !== copy.height) return no('The reply is for a picture of a different size, so it is not used.');
  if (!Array.isArray(reply.objects) || !reply.objects.length) return no('The reply holds no objects.');
  const usable = (o) => !!o && typeof o.name === 'string' && isBox(o.box, copy.width, copy.height);
  const good = reply.objects.filter(usable);
  const lost = reply.objects.filter((o) => !usable(o));
  if (!good.length) return no(`No object in the reply has a usable box (${plural(lost.length, 'box', 'boxes')} lay outside the picture or were empty), so nothing could be made from it.`);
  const surfaceLost = !!reply.surface && !isBox(reply.surface.box, copy.width, copy.height);
  if (!lost.length && !surfaceLost) return { ok: true, why: '', dropped: 0, words: '' };
  const warnings = Array.isArray(reply.warnings) ? reply.warnings : (reply.warnings = []);
  for (const o of lost) warnings.push(`not used: ${o && typeof o.name === 'string' ? o.name : 'an unnamed object'} (its box lay outside the picture or was empty)`);
  if (surfaceLost) warnings.push(`not used: ${String(reply.surface.name || 'the surface')} (the play surface; its box lay outside the picture or was empty)`);
  reply.objects = good;
  if (surfaceLost) reply.surface = null;
  reply.dropped = { objects: lost.length, surface: surfaceLost };
  return { ok: true, why: '', dropped: lost.length, words: leftOutWords(reply.dropped) };
}

// What acceptReply left out, in one sentence ('' for nothing), from the
// reply's `dropped`: said on the reveal, so nothing goes silently.
export function leftOutWords(dropped) {
  const n = dropped && Number.isInteger(dropped.objects) && dropped.objects > 0 ? dropped.objects : 0;
  const surface = !!(dropped && dropped.surface);
  if (!n && !surface) return '';
  const said = [];
  if (n) said.push(`${plural(n, 'object', 'objects')} in the reply had a box outside the picture or an empty one`);
  if (surface) said.push(`${n ? 'the' : 'The'} surface’s box was not usable`);
  const words = `${said.join(', and ')}, so ${n + (surface ? 1 : 0) > 1 ? 'they were' : 'it was'} left out.`;
  return words[0].toUpperCase() + words.slice(1);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A refusal or an error, in words, ending as a sentence ends (the server's
// own words may not), so the words after it read on.
export function refusalWords(reply) {
  const e = reply && reply.error;
  if (keyRefused(reply)) return KEY_WORDS[reply.provenance && reply.provenance.mode] || KEY_WORDS.live;
  if (e && typeof e.message === 'string' && e.message) return /[.!?]$/.test(e.message) ? e.message : `${e.message}.`;
  return 'The photo could not be read. Please try another one, or play a sample room.';
}

// The key the server holds was refused (the answer was 401): whose key it
// is, said plainly. In LIVE it is the operator's key for Meta's Model API,
// never anything of the player's; in REHEARSAL, the stand-in's drill.
export const KEY_WORDS = {
  live: 'Meta’s Model API refused the key that whoever runs this copy set for it (not anything of yours), so Meta’s models cannot read your photo here right now. Nothing was made from it.',
  rehearsal: 'The local stand-in (not Meta) refused this server’s key, as a rehearsal of a refused key, so nothing read your photo. Nothing was made from it.',
};
export function keyRefused(reply) {
  const e = reply && reply.error;
  return !!e && e.status === 401;
}

// A box as one rectangular ring.
export function boxRings(b) {
  const [x0, y0, x1, y1] = b;
  return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
}

// The level builder's input from an accepted reply. `picture` is
// { kind: 'photo', sha256 } or { kind: 'sample', id } (a rehearsal sends
// the sample's own picture); `outline(o)` gives each object's outline
// { source, rings } (S13: the box; S14: traced inside the box).
export function inputFromReply(reply, picture, outline = (o) => ({ source: 'box', rings: boxRings(o.box) }), created) {
  const W = reply.received.width, H = reply.received.height;
  return {
    origin: reply.provenance.mode,
    picture: { ...picture, width: W, height: H },
    title: (reply.scene && reply.scene.title) || 'Your room',
    theme_line: (reply.scene && reply.scene.theme_line) || '',
    surface: reply.surface ? { name: reply.surface.name, rings: boxRings(reply.surface.box), source: 'box' } : null,
    objects: reply.objects.map((o, k) => ({
      id: String(o.id || `o${k + 1}`),
      name: o.name,
      instance: o.instance || 1,
      role: o.role,
      reason: o.reason || '',
      box: o.box,
      confidence: typeof o.confidence === 'number' ? o.confidence : null,
      outline: outline(o, k),
      on_surface: true,
    })),
    provenance: {
      models: reply.provenance.models || [],
      request_id: reply.request_id || null,
      created: created || new Date().toISOString(),
    },
  };
}

// What the reveal says about the read, from the reply.
export function readSummary(reply) {
  const scenery = (reply.scene && reply.scene.scenery) || [];
  const found = reply.objects.length;
  const nouns = new Set(reply.objects.map((o) => o.name));
  const notFound = (reply.warnings || []).filter((w) => /^not found: /.test(w) && !w.includes('(the play surface)')).map((w) => w.replace(/^not found: /, '').replace(/ \(.*$/, ''));
  return {
    named: nouns.size + notFound.filter((n) => !nouns.has(n)).length + scenery.length,
    found,
    scenery: scenery.map((s) => s.name),
    warnings: reply.warnings || [],
    leftOut: leftOutWords(reply.dropped),
    rehearsal: reply.provenance.mode === 'rehearsal',
  };
}
