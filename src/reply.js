// Which server replies the page accepts, and how a reply becomes the input
// of the level builder. Pure logic: no page, no canvas.
import { LABELS } from './level.js';

export const REPLY_SCHEMA = 'frameplay.room.reply/2';
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
export const MAX_SIDE = 1024;

// Why a picked file cannot be used, in words, or null.
export function photoRefusal(file) {
  if (!file) return 'No photo was picked.';
  if (!PHOTO_TYPES.includes(file.type)) return 'Please pick a JPEG, PNG or WEBP photo.';
  if (file.size > MAX_PHOTO_BYTES) return 'That photo is larger than 40 MB. Please pick a smaller one.';
  if (file.size < 64) return 'That file is too small to be a photo.';
  return null;
}

// The size of the copy that is sent: at most 1024 px on the long side.
export function shrinkSize(w, h, max = MAX_SIDE) {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

const isBox = (b, W, H) => Array.isArray(b) && b.length === 4 && b.every((v) => Number.isFinite(v))
  && b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H && b[2] > b[0] && b[3] > b[1];

// A reply is accepted only from a server that said it is in the same mode
// (LIVE only from a live server, REHEARSAL only from a rehearsing one), for
// the very copy that was sent. Returns { ok, why }.
export function acceptReply(healthMode, reply, copy) {
  const no = (why) => ({ ok: false, why });
  if (!reply || typeof reply !== 'object' || reply.schema !== REPLY_SCHEMA) return no('The server answered in a shape this page does not know.');
  const mode = reply.provenance && reply.provenance.mode;
  if (mode !== 'live' && mode !== 'rehearsal') return no('The server did not say how it read the photo.');
  if (mode !== healthMode) return no(`The server said it was ${String(healthMode).toUpperCase()} but answered as ${mode.toUpperCase()}.`);
  if (reply.provenance.label !== LABELS[mode]) return no('The reply’s label does not match its mode.');
  if (mode === 'rehearsal' && (reply.provenance.models || []).length) return no('A rehearsal reply may not claim a model.');
  if (reply.status !== 'ok') return no(refusalWords(reply));
  const r = reply.received || {};
  if (r.width !== copy.width || r.height !== copy.height) return no('The reply is for a picture of a different size, so it is not used.');
  if (!Array.isArray(reply.objects) || !reply.objects.length) return no('The reply holds no objects.');
  for (const o of reply.objects) {
    if (!o || typeof o.name !== 'string' || !isBox(o.box, copy.width, copy.height)) return no('An object in the reply has no usable box.');
  }
  if (reply.surface && !isBox(reply.surface.box, copy.width, copy.height)) return no('The surface in the reply has no usable box.');
  return { ok: true, why: '' };
}

// A refusal or an error, in words.
export function refusalWords(reply) {
  const e = reply && reply.error;
  if (e && typeof e.message === 'string' && e.message) return e.message;
  return 'The photo could not be read. Please try another one, or play a sample room.';
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
    rehearsal: reply.provenance.mode === 'rehearsal',
  };
}
