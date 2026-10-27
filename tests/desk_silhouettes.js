// The painter's exact silhouettes of the desk sample room, for the Python
// tests of server/sam_mask.py (SAM's decoded masks are compared with them).
// For each object: its pixel-centre silhouette ('own', as if nothing stood in
// front of it) and the part of it the picture shows ('vis', the painter's
// owner map), both cropped to the silhouette's bounds; and the desk surface,
// whole and as seen (the surface pixels no object covers).
// A crop is { x0, y0, w, h, runs }: runs alternate 0s and 1s in row-major
// order, starting with a run of 0s (which may be empty).
//
//   node tests/desk_silhouettes.js   rewrites server/tests/fixtures/desk_silhouettes.json
// (tests/desk_silhouettes.test.js checks the file still matches the painter.)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRoom } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { fillRings, maskBounds } from '../src/raster.js';

export const FIXTURE = new URL('../server/tests/fixtures/desk_silhouettes.json', import.meta.url);

function crop(mask, W, b) {
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

export function deskSilhouettes() {
  const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
  const W = room.width, H = room.height;
  const { owner } = paintRoom(room);
  const objects = room.objects.map((o, i) => {
    const own = fillRings(o.rings, W, H);
    const vis = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) vis[k] = owner[k] === i ? 1 : 0;
    const b = maskBounds(own, W, H);
    return { id: o.id, name: o.name, own: crop(own, W, b), vis: crop(vis, W, b) };
  });
  const surface = fillRings(room.surface.rings, W, H);
  const seen = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) seen[k] = surface[k] && owner[k] < 0 ? 1 : 0;
  const b = maskBounds(surface, W, H);
  return {
    about: 'Painter silhouettes of rooms/desk.json; made by tests/desk_silhouettes.js.',
    width: W, height: H, objects,
    surface: { name: room.surface.name, own: crop(surface, W, b), vis: crop(seen, W, b) },
  };
}

export function fixtureText() {
  return JSON.stringify(deskSilhouettes()) + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(FIXTURE, fixtureText());
}
