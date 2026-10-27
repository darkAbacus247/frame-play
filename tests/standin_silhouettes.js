// The painter's exact silhouettes of every sample room, for the stand-in
// (server/standin.py), which codes them as SAM 3.1 codes a mask (one_bit),
// so a rehearsal runs the whole mask path. For each object: the part of it
// the picture shows (the painter's owner map: what stands in front of it is
// not it); for the floor (or the desk): each of its shapes as seen (the
// surface pixels no object covers). Each is cropped to its bounds as
// { x0, y0, w, h, runs }: runs alternate 0s and 1s in row-major order,
// starting with a run of 0s (which may be empty); an object the picture
// does not show at all is null.
//
//   node tests/standin_silhouettes.js   rewrites server/standin_masks/<room>.json
// (tests/standin_silhouettes.test.js checks the files still match the painter.)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRoom, shapeToRings } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { fillRings, maskBounds } from '../src/raster.js';

export const ROOMS = ['desk', 'living', 'apartment'];
export const fileFor = (id) => new URL(`../server/standin_masks/${id}.json`, import.meta.url);

function crop(mask, W, H) {
  const b = maskBounds(mask, W, H);
  if (!b) return null;
  const runs = [];
  let value = 0, run = 0;
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      const v = mask[y * W + x] ? 1 : 0;
      if (v !== value) { runs.push(run); run = 0; value = v; }
      run++;
    }
  }
  runs.push(run);
  return { x0: b.x0, y0: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0, runs };
}

export function standInSilhouettes(id) {
  const json = JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8'));
  const room = loadRoom(json);
  const W = room.width, H = room.height;
  const { owner } = paintRoom(room);
  const objects = {};
  room.objects.forEach((o, i) => {
    const vis = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) vis[k] = owner[k] === i ? 1 : 0;
    objects[o.id] = crop(vis, W, H);
  });
  // the surface as seen, shape by shape (a floor plan draws each room and
  // each doorway as a shape of its own); 'surface' is the whole of it
  const seen = (rings) => {
    const m = fillRings(rings, W, H);
    for (let k = 0; k < W * H; k++) if (owner[k] >= 0) m[k] = 0;
    return crop(m, W, H);
  };
  const surface = {};
  if (json.surface) {
    surface.surface = seen(room.surface.rings);
    (json.surface.shape.rings || []).forEach((s, k) => { surface[`surface${k}`] = seen(shapeToRings(s)); });
  }
  return {
    about: `Painter silhouettes of rooms/${id}.json, as the picture shows them; made by tests/standin_silhouettes.js.`,
    room: id, width: W, height: H, objects, surface,
  };
}

export function fileText(id) {
  return JSON.stringify(standInSilhouettes(id)) + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(new URL('../server/standin_masks/', import.meta.url), { recursive: true });
  for (const id of ROOMS) writeFileSync(fileFor(id), fileText(id));
}
