// The sample rooms as the page paints them, and the server's reply for a
// sample room's picture in a mode, with SAM's exact boxes from the room's own
// shapes. Shared by the own-room tests and the booted page (tests/apphost.js).
import { readFileSync } from 'node:fs';
import { loadRoom } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { fillRings, maskBounds } from '../src/raster.js';
import { REPLY_SCHEMA } from '../src/reply.js';
import { LABELS } from '../src/level.js';

export const rooms = {};
for (const id of ['desk', 'living']) {
  const room = loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
  const rgba = paintRoom(room).rgba;
  rooms[id] = { room, pixels: { width: room.width, height: room.height, data: rgba } };
}

// room: the room the stand-in says it answered for (REHEARSAL)
export function replyFor(id, mode, { room = id, status = 'ok', error = null } = {}) {
  const r = rooms[id].room;
  const objects = r.objects.filter((o) => o.on_surface).map((o, k) => {
    const b = maskBounds(fillRings(o.rings, r.width, r.height), r.width, r.height);
    return { id: `o${k + 1}`, name: o.name, instance: o.instance, role: o.role, reason: o.reason, on_surface: true,
      box: [b.x0, b.y0, b.x1, b.y1], confidence: 0.9, seeds: [[(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]] };
  });
  return {
    schema: REPLY_SCHEMA, request_id: 'r1', status,
    provenance: { mode, label: LABELS[mode], models: mode === 'live' ? ['muse-spark-1.3', 'sam-3.1'] : [], calls: [], ...(mode === 'rehearsal' ? { rehearsal: { room } } : {}) },
    received: { width: r.width, height: r.height },
    scene: { title: r.title, theme_line: r.theme_line, people_present: status !== 'ok', scenery: [] },
    surface: null,
    objects: status === 'ok' ? objects : [],
    warnings: [],
    error,
  };
}
