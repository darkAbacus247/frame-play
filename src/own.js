// Your own room: the third room on the road, made from a photo of the
// player's own. What happens depends on the server's mode, and each mode
// says plainly what it does:
// - LIVE: the photo goes through the real pipeline (Muse Spark, then SAM
//   3.1), and the room is built from what the models found in it.
// - MOCK: no model can read it, so nothing is sent and no level is made.
//   The photo is shown on this device only.
// - REHEARSAL: the local stand-in only knows the sample rooms' own
//   pictures, so only the picture of the room it was started for is sent,
//   or a faithful copy of it (re-encoded, resized). Any other photo, or an
//   edited copy, is refused in words, and no level is made from it.
// No page here: the page hands in its photo, send and save helpers, so the
// gating is tested in Node.
import { photoRefusal, acceptReply, inputFromReply, readSummary, boxRings } from './reply.js';
import { buildLevel } from './level.js';
import { traceInBox } from './trace_in_box.js';

export const MOCK_WORDS = 'Reading a real photo needs the live AI (Meta’s models). This copy is running without it, so your photo stays on your device and nothing is invented.';

// A small fingerprint of how a picture looks: its shape, and the mean
// colour of each cell of a 32 by 24 grid (32 px cells at 1024x768). JPEG
// and shrinking barely move it; a different or edited picture moves it a
// lot, at least in the cells it touches.
const GW = 32, GH = 24;
export function signature({ width, height, data }) {
  const sums = new Float64Array(GW * GH * 3);
  const counts = new Float64Array(GW * GH);
  for (let y = 0; y < height; y++) {
    const row = Math.min(GH - 1, Math.floor((y * GH) / height)) * GW;
    for (let x = 0; x < width; x++) {
      const c = row + Math.min(GW - 1, Math.floor((x * GW) / width));
      const i = 4 * (y * width + x);
      sums[3 * c] += data[i];
      sums[3 * c + 1] += data[i + 1];
      sums[3 * c + 2] += data[i + 2];
      counts[c]++;
    }
  }
  const cells = new Float32Array(GW * GH * 3);
  for (let c = 0; c < GW * GH; c++) for (let k = 0; k < 3; k++) cells[3 * c + k] = counts[c] ? sums[3 * c + k] / counts[c] : 0;
  return { aspect: width / height, cells };
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

// A faithful copy (re-encoded, resized) stays within these; an edited copy
// (an object erased, moved or pasted, a crop, a shift, a colour change)
// does not: a faithful JPEG at quality 40 reaches 0.6 and 2.5, one coin
// erased reaches 15.9 in its cell.
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
//   samples: [{ id, title, sig }], the sample pictures' fingerprints
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
