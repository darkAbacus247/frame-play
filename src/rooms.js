// Sample rooms: data files of shapes. The loader turns every shape into
// rings, deterministically, so the painter and the level read the very same
// geometry: the outlines are the painted shapes, exactly.
import { ellipseRing, sinCosDeg, bounds, boxesOverlap } from './geom.js';

export const ROOM_SCHEMA = 'frameplay.room/1';
export const STAMP_LINES = ['MOCK · SAMPLE ROOM', 'DRAWN BY CODE'];

function arcSteps(rx, ry, span) {
  const perQuarter = Math.max(4, Math.min(40, Math.ceil(Math.sqrt(Math.max(rx, ry)) * 2.2)));
  return Math.max(2, Math.ceil((Math.abs(span) / 90) * perQuarter));
}

function pushPoint(ring, x, y) {
  const last = ring[ring.length - 1];
  if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) return;
  ring.push([x, y]);
}

// Path commands: ["M", x, y], ["L", x, y], ["A", cx, cy, rx, ry, a0, a1].
// Angles are degrees in screen space: 0 points right, 90 points down.
function pathRing(cmds) {
  const ring = [];
  for (const c of cmds) {
    if (c[0] === 'M' || c[0] === 'L') {
      pushPoint(ring, c[1], c[2]);
    } else if (c[0] === 'A') {
      const [, cx, cy, rx, ry, a0, a1] = c;
      const n = arcSteps(rx, ry, a1 - a0);
      for (let i = 0; i <= n; i++) {
        const [s, co] = sinCosDeg(a0 + ((a1 - a0) * i) / n);
        pushPoint(ring, cx + rx * co, cy + ry * s);
      }
    } else {
      throw new Error(`unknown path command ${c[0]}`);
    }
  }
  const f = ring[0], l = ring[ring.length - 1];
  if (ring.length > 1 && Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) ring.pop();
  return ring;
}

function roundRectRing(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  return pathRing([
    ['M', x + rr, y], ['L', x + w - rr, y],
    ['A', x + w - rr, y + rr, rr, rr, -90, 0],
    ['L', x + w, y + h - rr],
    ['A', x + w - rr, y + h - rr, rr, rr, 0, 90],
    ['L', x + rr, y + h],
    ['A', x + rr, y + h - rr, rr, rr, 90, 180],
    ['L', x, y + rr],
    ['A', x + rr, y + rr, rr, rr, 180, 270],
  ]);
}

// A shape is one of: {poly}, {rect, r?}, {ellipse}, {path}, or {rings: [shape...]}
// combined by the even-odd rule. Returns an array of rings.
export function shapeToRings(shape) {
  if (shape.rings) return shape.rings.flatMap(shapeToRings);
  if (shape.poly) return [shape.poly.map(([x, y]) => [x, y])];
  if (shape.rect) {
    const [x, y, w, h] = shape.rect;
    if (shape.r) return [roundRectRing(x, y, w, h, shape.r)];
    return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
  }
  if (shape.ellipse) {
    const [cx, cy, rx, ry] = shape.ellipse;
    return [ellipseRing(cx, cy, rx, ry)];
  }
  if (shape.path) return [pathRing(shape.path)];
  throw new Error('unknown shape');
}

const ROLES = new Set(['collect', 'avoid', 'exit', 'solid', 'flat']);

// Turn the room file into the model the painter and the level builder read.
export function loadRoom(json) {
  if (!json || json.schema !== ROOM_SCHEMA) throw new Error('not a sample room file');
  const width = json.width | 0, height = json.height | 0;
  if (width < 64 || height < 64 || width > 4096 || height > 4096) throw new Error('bad room size');
  const background = (json.background || []).map((b) => ({
    rings: shapeToRings(b.shape), paint: b.paint, grain: b.grain ?? 3,
  }));
  const shades = (json.shades || []).map((s) => ({ ellipse: s.ellipse, alpha: s.alpha ?? 0.3 }));
  const seen = new Set();
  const counts = {};
  const objects = json.objects.map((o) => {
    if (seen.has(o.id)) throw new Error(`duplicate object id ${o.id}`);
    seen.add(o.id);
    if (!ROLES.has(o.role)) throw new Error(`unknown role ${o.role}`);
    counts[o.name] = (counts[o.name] || 0) + 1;
    const rings = shapeToRings(o.shape);
    return {
      id: o.id,
      name: o.name,
      instance: counts[o.name],
      role: o.role,
      reason: o.reason,
      on_surface: o.on_surface !== false,
      rings,
      bounds: bounds(rings),
      paint: o.paint,
      grain: o.grain ?? 3,
      details: (o.details || []).map((d) => ({ rings: shapeToRings(d.shape), paint: d.paint, grain: d.grain ?? 2 })),
    };
  });
  const surface = json.surface ? { name: json.surface.name, rings: shapeToRings(json.surface.shape) } : null;
  return {
    id: json.id,
    title: json.title,
    theme_line: json.theme_line,
    width,
    height,
    seed: json.seed | 0,
    surface,
    surfacePaint: json.surface ? { paint: json.surface.paint, grain: json.surface.grain ?? 4 } : null,
    background,
    foreground: (json.foreground || []).map((b) => ({ rings: shapeToRings(b.shape), paint: b.paint, grain: b.grain ?? 3 })),
    shades,
    objects,
  };
}

// The order objects are painted in: flat things first (they are part of the
// floor), then the rest from far to near (by their lowest point).
export function paintOrder(room) {
  const idx = room.objects.map((o, i) => i);
  return idx.sort((a, b) => {
    const A = room.objects[a], B = room.objects[b];
    const fa = A.role === 'flat' ? 0 : 1, fb = B.role === 'flat' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    if (A.bounds.y1 !== B.bounds.y1) return A.bounds.y1 - B.bounds.y1;
    return a - b;
  });
}

// Where the MOCK stamp goes: the first picture corner that no object's
// outline comes near. Returns a box in picture pixels, or null.
export function stampRect(room) {
  const L = Math.max(room.width, room.height);
  const font = Math.round(0.02 * L);
  const w = Math.round(0.26 * L), h = Math.round(font * 2.5 + font);
  const m = Math.round(0.016 * L);
  const corners = [
    [m, m], [room.width - m - w, m], [m, room.height - m - h], [room.width - m - w, room.height - m - h],
  ];
  const pad = 8;
  for (const [x, y] of corners) {
    const box = { x0: x - pad, y0: y - pad, x1: x + w + pad, y1: y + h + pad };
    if (!room.objects.some((o) => boxesOverlap(box, o.bounds))) {
      return { x, y, w, h, font, lines: STAMP_LINES };
    }
  }
  return null;
}
