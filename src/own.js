// Your own room: the third room on the road, made from a photo of the
// player's own. What happens depends on the server's mode, and each mode
// says plainly what it does:
// - LIVE: the photo goes through the real pipeline (Muse Spark, then SAM
//   3.1), and the room is built from what the models found in it.
// - MOCK: no model can read it, so nothing is sent and no level is made.
//   The photo is shown on this device only.
// - REHEARSAL: the local stand-in only knows the sample rooms' own
//   pictures, so only the picture of the room it was started for is sent,
//   or a faithful copy of it (re-encoded, resized). Any other photo, or a
//   copy edited enough for these checks to see (an object erased, pasted
//   or moved by 8 px or more, a crop), is refused in words before anything
//   is sent, and no level is made from it. An edit of a few pixels (a coin
//   nudged by 4 px, a small mark) can pass; the stand-in then answers with
//   its sample's own places.
// No page here: the page hands in its photo, send and save helpers, so the
// gating is tested in Node.
import { photoRefusal, acceptReply, inputFromReply, readSummary, boxRings } from './reply.js';
import { buildLevel } from './level.js';
import { traceInBox } from './trace_in_box.js';

export const MOCK_WORDS = 'Reading a real photo needs the live AI (Meta’s models). This copy is running without it, so your photo stays on your device and nothing is invented.';

// A small fingerprint of how a picture looks: its shape, and the mean
// colour of each cell of a 32 by 24 grid (32 px cells at 1024x768). JPEG
// and shrinking barely move it; a different picture, or a large edit, moves
// it a lot, at least in the cells it touches. A small edit inside one cell
// can stay under its limits (the object boxes below look more finely).
const GW = 32, GH = 24;
// The mean colour of each cell of a gw by gh grid, 3 values per cell.
function cellMeans({ width, height, data }, gw, gh) {
  const sums = new Float64Array(gw * gh * 3);
  const counts = new Float64Array(gw * gh);
  for (let y = 0; y < height; y++) {
    const row = Math.min(gh - 1, Math.floor((y * gh) / height)) * gw;
    for (let x = 0; x < width; x++) {
      const c = row + Math.min(gw - 1, Math.floor((x * gw) / width));
      const i = 4 * (y * width + x);
      sums[3 * c] += data[i];
      sums[3 * c + 1] += data[i + 1];
      sums[3 * c + 2] += data[i + 2];
      counts[c]++;
    }
  }
  const cells = new Float32Array(gw * gh * 3);
  for (let c = 0; c < gw * gh; c++) for (let k = 0; k < 3; k++) cells[3 * c + k] = counts[c] ? sums[3 * c + k] / counts[c] : 0;
  return cells;
}
export function signature(pixels) {
  return { aspect: pixels.width / pixels.height, cells: cellMeans(pixels, GW, GH) };
}

// A finer look, for the places of the sample's objects: a 256 by 192 grid
// (4 px blocks at 1024x768).
export const FW = 256, FH = 192;
export function fineGrid(pixels) {
  return cellMeans(pixels, FW, FH);
}

// Where each object on the sample's surface sits, as cells of the fine
// grid: its bounds grown by 6 px, and 8 px more below for its shade.
export function objectBoxes(room) {
  const cx = (x) => Math.min(FW - 1, Math.max(0, Math.floor((x * FW) / room.width)));
  const cy = (y) => Math.min(FH - 1, Math.max(0, Math.floor((y * FH) / room.height)));
  return room.objects.filter((o) => o.on_surface).map((o) => ({
    id: o.id, x0: cx(o.bounds.x0 - 6), y0: cy(o.bounds.y0 - 6), x1: cx(o.bounds.x1 + 6), y1: cy(o.bounds.y1 + 6 + 8),
  }));
}

// The largest mean colour difference over any one object's box, all three
// channels: a faithful copy stays low there (a JPEG at quality 40 reaches
// 4.0, an 800x600 copy 4.7); an object moved by 8 px leaves its box and
// reaches 7 or more.
export const MATCH_BOX = 6.5;
export function worstBox(fine, ref, boxes) {
  let worst = 0;
  for (const b of boxes) {
    let sum = 0, n = 0;
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        for (let k = 0; k < 3; k++) sum += Math.abs(fine[3 * (y * FW + x) + k] - ref[3 * (y * FW + x) + k]);
        n += 3;
      }
    }
    if (n && sum / n > worst) worst = sum / n;
  }
  return worst;
}

// How far a picture's fingerprint is from a sample's: the mean and the
// largest difference of any one cell's colour value, or null for another
// shape (more than 1% apart).
export function sigDistance(sig, ref) {
  if (Math.abs(sig.aspect - ref.aspect) > 0.01 * ref.aspect) return null;
  if (sig.cells.length !== ref.cells.length) return null;
  let sum = 0, max = 0;
  for (let i = 0; i < sig.cells.length; i++) {
    const d = Math.abs(sig.cells[i] - ref.cells[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / sig.cells.length, max };
}

// A faithful copy (re-encoded, resized) stays within these; a large edit
// (an object erased or pasted, every object moved, a crop, a shift, a
// colour change) does not: a faithful JPEG at quality 40 reaches 0.6 and
// 2.5, one coin erased reaches 15.9 in its cell. One coin moved a few px
// inside its 32 px cell stays under them.
export const MATCH_MEAN = 1.5;
export const MATCH_CELL = 8;

// Which sample room's own picture this is, or null: the same shape, and
// every cell close to the sample's, not only the average.
export function matchSample(sig, samples) {
  let best = null, bestD = Infinity;
  for (const s of samples) {
    const d = sigDistance(sig, s.sig);
    if (!d || d.mean > MATCH_MEAN || d.max > MATCH_CELL) continue;
    if (d.mean < bestD) { bestD = d.mean; best = s.id; }
  }
  return best;
}

// In REHEARSAL: may this picture go to the stand-in? Only the picture of
// the very room the stand-in was started for.
export function rehearsalVerdict(id, room, titleOf = (x) => x) {
  if (id && id === room) return { ok: true, why: '' };
  if (id) {
    return { ok: false, why: `This is the sample picture of ${titleOf(id)}, but the local stand-in was started for ${titleOf(room)}, so it would answer for the wrong room. Nothing was sent, and no level is made from it.` };
  }
  return { ok: false, why: 'In REHEARSAL the local stand-in (not Meta) only knows the sample rooms’ own pictures, and this photo is not one of them. Nothing was sent, and no level is made from it.' };
}

// In REHEARSAL, after a send: the stand-in's answer is used only when it
// says it answered for the very room asked about. Its words, or null. (The
// picture was sent by then, so they never say nothing was sent.) Shared by
// your own room and a sample room rehearsed again, so the two always agree.
export const OTHER_ROOM_WORDS = 'The stand-in answered for a different room than this picture shows, so its answer is not used.';
export function standInReplyRefusal(reply, room) {
  const r = reply && reply.provenance && reply.provenance.rehearsal;
  return room && r && r.room === room ? null : OTHER_ROOM_WORDS;
}

// A level kept on this device for a photo, if it may be used here: made in
// this very mode, for a copy of the same size. Otherwise null.
export function keptLevel(kept, photo, mode) {
  if (!kept || !kept.level || kept.level.origin !== mode) return null;
  const p = kept.level.picture;
  if (!p || p.width !== photo.width || p.height !== photo.height) return null;
  return kept.level;
}

// Each object's outline: traced inside SAM's exact box, or the box itself
// when the trace is not tight enough. Yields between objects, so the page's
// progress words stay live.
export async function outlinesFor(reply, pixels, yieldNow = () => new Promise((r) => setTimeout(r, 0))) {
  const out = [];
  for (const o of reply.objects) {
    try {
      const t = traceInBox(pixels, o.box, o.seeds || []);
      out.push({ source: t.source, rings: t.rings });
    } catch {
      out.push({ source: 'box', rings: boxRings(o.box) });
    }
    await yieldNow();
  }
  return out;
}

// A level from an accepted reply, traced on the very pixels that were sent.
export async function levelFromReply(reply, picture, pixels, pictureRef, yieldNow) {
  const outlines = await outlinesFor(reply, pixels, yieldNow);
  const built = buildLevel(inputFromReply(reply, pictureRef, (o, k) => outlines[k]));
  return { picture, built, summary: readSummary(reply) };
}

// Make your own room from a picked file. deps:
//   preview(file) -> { picture }: decoded and shrunk on the device, never sent
//   readPhoto(file) -> { sha256, blob, picture, pixels, width, height }
//   send(blob, onWords) -> the server's reply
//   samples: [{ id, title, sig, fine, boxes }], the sample pictures'
//     fingerprints, fine grids and object boxes
//   stored(photo) -> a level kept on this device for this photo, or null
// Returns one of:
//   { kind: 'kept', picture, words }     MOCK: shown here, nothing sent
//   { kind: 'refused', picture, words }  not made, and why
//   { kind: 'built', ref, entry }        a playable room
export async function makeOwnRoom({ mode, rehearsalRoom, file, deps, onWords = () => {}, yieldNow }) {
  const why = photoRefusal(file);
  if (why) return { kind: 'refused', picture: null, words: why };
  if (mode !== 'live' && mode !== 'rehearsal') {
    const p = await deps.preview(file);
    return { kind: 'kept', picture: p.picture, words: MOCK_WORDS };
  }
  const photo = await deps.readPhoto(file);
  let matched = null;
  if (mode === 'rehearsal') {
    matched = matchSample(signature(photo.pixels), deps.samples || []);
    const titleOf = (id) => ((deps.samples || []).find((s) => s.id === id) || { title: id }).title;
    const v = rehearsalVerdict(matched, rehearsalRoom, titleOf);
    if (!v.ok) return { kind: 'refused', picture: photo.picture, words: v.why };
    // and every object where the sample has it, looked at more finely
    const s = deps.samples.find((x) => x.id === matched);
    if (!s.fine || !s.boxes || worstBox(fineGrid(photo.pixels), s.fine, s.boxes) > MATCH_BOX) {
      return { kind: 'refused', picture: photo.picture, words: `This is an edited copy of the sample picture of ${titleOf(matched)}: an object in it is not where the sample has it. Nothing was sent, and no level is made from it.` };
    }
  }
  const ref = { kind: 'photo', sha256: photo.sha256 };
  const kept = deps.stored ? deps.stored(photo) : null;
  if (kept && kept.built.level.origin === mode) return { kind: 'built', ref, entry: kept };
  const reply = await deps.send(photo.blob, onWords);
  const ok = acceptReply(mode, reply, photo);
  if (!ok.ok) return { kind: 'refused', picture: photo.picture, words: ok.why };
  const other = mode === 'rehearsal' ? standInReplyRefusal(reply, matched) : null;
  if (other) return { kind: 'refused', picture: photo.picture, words: other };
  onWords('Tracing the outlines');
  const entry = await levelFromReply(reply, photo.picture, photo.pixels, ref, yieldNow);
  if (entry.built.error) return { kind: 'refused', picture: photo.picture, words: entry.built.error };
  return { kind: 'built', ref, entry };
}
