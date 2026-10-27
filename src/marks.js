// Your marks: when this copy cannot read a photo with Meta's models (MOCK,
// or a LIVE or REHEARSAL read that was refused or failed), the player marks
// the objects in it: a box over each, and what it is. Code then does what
// it does with SAM's boxes: the same reply shape goes through the same
// tracer (each outline traced inside its box, or the box kept when the
// trace is not tight), the same level builder and the same proof. No model
// is called and nothing is sent. Pure logic: no page, no canvas.
import { REPLY_SCHEMA, inputFromReply, boxRings } from './reply.js';
import { buildLevel, validateLevel, LABELS, LEVEL_SCHEMA } from './level.js';
import { outlinesFor } from './own.js';
import { snugBox } from './trace_in_box.js';

// The short set of roles a box can take, each one the level builder
// already knows. `key` is its keyboard shortcut on the marking board.
export const MARK_ROLES = [
  { role: 'collect', name: 'coin', button: 'Coin', words: 'a coin to collect', key: '1' },
  { role: 'solid', name: 'obstacle', button: 'Obstacle', words: 'an obstacle to walk around', key: '2' },
  { role: 'avoid', name: 'hazard', button: 'Hazard', words: 'a hazard to avoid', key: '3' },
  { role: 'exit', name: 'exit', button: 'Exit', words: 'the exit', key: '4' },
];
export const roleOf = (role) => MARK_ROLES.find((r) => r.role === role) || null;

// A box smaller than this on either side (picture pixels) is not a mark.
export const MIN_SIDE = 8;
// At most this many marks in one room.
export const MAX_MARKS = 24;
export const MARKED_TITLE = 'Your marked room';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// A box [x0, y0, x1, y1] in whole picture pixels, its corners in order and
// inside the picture.
export function clampBox(b, W, H) {
  const xs = [b[0], b[2]].map((v) => clamp(Math.round(v), 0, W)).sort((p, q) => p - q);
  const ys = [b[1], b[3]].map((v) => clamp(Math.round(v), 0, H)).sort((p, q) => p - q);
  return [xs[0], ys[0], xs[1], ys[1]];
}

export const bigEnough = (b) => b[2] - b[0] >= MIN_SIDE && b[3] - b[1] >= MIN_SIDE;

// The same box moved by dx, dy, kept whole inside the picture.
export function moveBox(b, dx, dy, W, H) {
  const w = b[2] - b[0], h = b[3] - b[1];
  const x0 = clamp(Math.round(b[0] + dx), 0, W - w), y0 = clamp(Math.round(b[1] + dy), 0, H - h);
  return [x0, y0, x0 + w, y0 + h];
}

// The same box with its right and bottom edges moved by dw, dh: never
// smaller than MIN_SIDE, never past the picture.
export function resizeBox(b, dw, dh, W, H) {
  return [b[0], b[1], clamp(Math.round(b[2] + dw), b[0] + MIN_SIDE, W), clamp(Math.round(b[3] + dh), b[1] + MIN_SIDE, H)];
}

// The mark under a point: the smallest box holding it (so a box drawn
// inside another stays reachable), or -1.
export function markAt(marks, x, y) {
  let best = -1, area = Infinity;
  marks.forEach((m, k) => {
    const [x0, y0, x1, y1] = m.box;
    if (x < x0 || x > x1 || y < y0 || y > y1) return;
    const a = (x1 - x0) * (y1 - y0);
    if (a < area) { area = a; best = k; }
  });
  return best;
}

// Each mark's name, numbered when there are several of its kind: "coin 2".
export function markNames(marks) {
  const count = {};
  for (const m of marks) count[m.role] = (count[m.role] || 0) + 1;
  const seen = {};
  return marks.map((m) => {
    const r = roleOf(m.role);
    seen[m.role] = (seen[m.role] || 0) + 1;
    return count[m.role] > 1 ? `${r.name} ${seen[m.role]}` : r.name;
  });
}

const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

// What the marks still need before the room can be made, in words: a coin
// at least, and exactly one exit. { ready, line }
export function needs(marks) {
  const coins = marks.filter((m) => m.role === 'collect').length;
  const exits = marks.filter((m) => m.role === 'exit').length;
  if (exits > 1) return { ready: false, line: `Keep one exit: change or remove ${exits - 1} of the ${exits}.` };
  if (!coins && !exits) return { ready: false, line: marks.length ? 'Add at least one coin and an exit.' : 'Draw a box over an object to mark it. The room needs at least one coin and an exit.' };
  if (!exits) return { ready: false, line: 'Add an exit.' };
  if (!coins) return { ready: false, line: 'Add at least one coin.' };
  return { ready: true, line: `Ready: ${plural(coins, 'coin', 'coins')}, the exit and ${plural(marks.length - coins - 1, 'other box', 'other boxes')}. Make the room, and code checks it can be won.` };
}

// Marks read back from this device: each a role from the set and a box big
// enough inside a picture of this size; anything else is dropped. Null when
// the list itself is not a list.
export function sanitizeMarks(list, W, H) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const m of list.slice(0, MAX_MARKS)) {
    if (!m || typeof m !== 'object' || !roleOf(m.role) || !Array.isArray(m.box) || m.box.length !== 4) continue;
    if (!m.box.every((v) => Number.isFinite(v))) continue;
    const box = clampBox(m.box, W, H);
    if (bigEnough(box)) out.push({ role: m.role, box });
  }
  return out;
}

// The reply the models would give for this picture, from the marks: names
// and roles from the set, the player's boxes, no confidence and no seeds.
export function markedReply(marks, W, H) {
  const names = markNames(marks);
  const count = {};
  return {
    schema: REPLY_SCHEMA, request_id: null, status: 'ok',
    provenance: { mode: 'marked', label: LABELS.marked, models: [] },
    received: { width: W, height: H },
    scene: { title: MARKED_TITLE, theme_line: '', people_present: false, scenery: [] },
    surface: null,
    objects: marks.map((m, k) => {
      const r = roleOf(m.role);
      count[m.role] = (count[m.role] || 0) + 1;
      return {
        id: `m${k + 1}`, name: r.name, instance: count[m.role], role: m.role,
        reason: `You marked ${names[k] === r.name ? 'it' : names[k]} as ${r.words}.`,
        box: clampBox(m.box, W, H), confidence: null, seeds: [], on_surface: true,
      };
    }),
    warnings: [],
  };
}

// What became of the marks, in one sentence, from the level's own counts.
export function markedWords(level) {
  const c = level.provenance.outline_sources || {};
  return `You marked ${plural(level.objects.length, 'object', 'objects')}; code traced ${plural(c.traced_in_box || 0, 'outline', 'outlines')} inside your boxes and kept ${plural(c.box || 0, 'as a box', 'as boxes')}; no model was called.`;
}

// Each outline: a box drawn by hand is looser than SAM's, so code first
// finds the object's own bounds inside it (src/trace_in_box.js snugBox);
// then the very tracer SAM's boxes go through (src/own.js outlinesFor)
// traces inside those bounds, with its tightness test. Where the trace is
// not tight, the box is kept as the player drew it.
export async function markedOutlines(reply, pixels, yieldNow) {
  const snug = { ...reply, objects: reply.objects.map((o) => ({ ...o, box: snugBox(pixels, o.box) || o.box })) };
  const out = await outlinesFor(snug, pixels, yieldNow);
  return out.map((t, k) => (t.source === 'box' ? { source: 'box', rings: boxRings(reply.objects[k].box) } : t));
}

// Make the room from the marks, on the very pixels shown. Returns
// { ok: true, entry } with entry { picture, built, summary: null, marks },
// or { ok: false, words } saying exactly why, and nothing is made.
export async function makeMarkedRoom({ marks, picture, pixels, sha256, yieldNow }) {
  const W = pixels.width, H = pixels.height;
  const clean = sanitizeMarks(marks, W, H) || [];
  if (clean.length !== marks.length) return { ok: false, words: `A box is smaller than ${MIN_SIDE} px or outside the photo. Draw it again, then make the room.` };
  const need = needs(clean);
  if (!need.ready) return { ok: false, words: `Not yet: ${need.line}` };
  const reply = markedReply(clean, W, H);
  const outlines = await markedOutlines(reply, pixels, yieldNow);
  const built = buildLevel(inputFromReply(reply, { kind: 'marked', sha256 }, (o, k) => outlines[k]));
  if (built.error) {
    return { ok: false, words: `These marks do not make a room that can be won: ${(built.why || built.error).replace(/\.$/, '')}. Move, change or remove a box, then make the room again.` };
  }
  return { ok: true, entry: { picture, built, summary: null, marks: clean } };
}

// A marked level kept on this device, if it is for this photo and a
// picture of this size and still proves winnable (a stored proof is never
// trusted). The entry, or null.
export function keptMarkedEntry(kept, sha256, picture) {
  const level = kept && kept.level;
  if (!level || level.schema !== LEVEL_SCHEMA || level.origin !== 'marked') return null;
  const p = level.picture;
  if (!p || p.kind !== 'marked' || p.sha256 !== sha256 || p.width !== picture.width || p.height !== picture.height) return null;
  const v = validateLevel(level);
  if (!v.ok) return null;
  level.proof = v.proof;
  return { picture, built: { level, rt: v.rt }, summary: null, marks: sanitizeMarks(kept.marks, p.width, p.height) || [], fromDevice: true };
}
