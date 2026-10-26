// The software painter: fills a sample room's shapes at twice the size and
// averages down. The result is anti-aliased and identical on every device
// (only + - * / sqrt and integer hashing are used), and it needs no canvas.
// It also records which object owns each pixel, at the pixel centre (owner)
// and at every sub-sample (owner2), so alignment can be tested exactly.
import { scanRings, fillRingsInto } from './raster.js';
import { hash2 } from './rng.js';
import { paintOrder } from './rooms.js';

export function parseColor(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Returns fn(x, y, out) writing r, g, b (floats) for a point in picture space.
export function makePaint(spec) {
  if (typeof spec === 'string') {
    const c = parseColor(spec);
    return (x, y, out) => { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; };
  }
  const stops = spec.stops.map(parseColor);
  const n = stops.length - 1;
  const lerp = (t, out) => {
    if (t <= 0) t = 0; else if (t >= 1) t = 1;
    const f = t * n;
    let i = Math.floor(f);
    if (i >= n) i = n - 1;
    const u = f - i;
    const a = stops[i], b = stops[i + 1];
    out[0] = a[0] + (b[0] - a[0]) * u;
    out[1] = a[1] + (b[1] - a[1]) * u;
    out[2] = a[2] + (b[2] - a[2]) * u;
  };
  if (spec.linear) {
    const [x0, y0, x1, y1] = spec.linear;
    const dx = x1 - x0, dy = y1 - y0;
    const l2 = dx * dx + dy * dy || 1;
    return (x, y, out) => lerp(((x - x0) * dx + (y - y0) * dy) / l2, out);
  }
  if (spec.radial) {
    const [cx, cy, r] = spec.radial;
    return (x, y, out) => lerp(Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / r, out);
  }
  throw new Error('unknown paint');
}

function scale2(rings) {
  return rings.map((r) => r.map(([x, y]) => [x * 2, y * 2]));
}

export function paintRoom(room) {
  const W = room.width, H = room.height;
  const SW = W * 2, SH = H * 2;
  const acc = new Float32Array(SW * SH * 3);
  const owner2 = new Int16Array(SW * SH).fill(-1);
  const tmp = [0, 0, 0];
  const seed = room.seed | 0;

  // Paint samples inside rings. If onlyOwner is given, only samples owned by
  // that object are touched (an object's details stay inside its outline).
  function layer(rings, paint, grain, setOwner, onlyOwner) {
    const fn = makePaint(paint);
    scanRings(scale2(rings), SW, SH, (Y, X0, X1) => {
      const py = (Y + 0.5) / 2;
      for (let X = X0; X <= X1; X++) {
        const s = Y * SW + X;
        if (onlyOwner !== undefined && owner2[s] !== onlyOwner) continue;
        fn((X + 0.5) / 2, py, tmp);
        const g = grain ? (hash2(X, Y, seed) - 0.5) * 2 * grain : 0;
        acc[s * 3] = tmp[0] + g;
        acc[s * 3 + 1] = tmp[1] + g;
        acc[s * 3 + 2] = tmp[2] + g;
        if (setOwner !== undefined) owner2[s] = setOwner;
      }
    });
  }

  function shade(ellipse, alpha) {
    const [cx, cy, rx, ry] = ellipse;
    const y0 = Math.max(0, Math.floor((cy - ry) * 2)), y1 = Math.min(SH - 1, Math.ceil((cy + ry) * 2));
    const x0 = Math.max(0, Math.floor((cx - rx) * 2)), x1 = Math.min(SW - 1, Math.ceil((cx + rx) * 2));
    for (let Y = y0; Y <= y1; Y++) {
      const v = ((Y + 0.5) / 2 - cy) / ry;
      for (let X = x0; X <= x1; X++) {
        const u = ((X + 0.5) / 2 - cx) / rx;
        const d = u * u + v * v;
        if (d >= 1) continue;
        const a = alpha * (1 - d) * (1 - d);
        const s = (Y * SW + X) * 3;
        acc[s] *= 1 - a;
        acc[s + 1] *= 1 - a;
        acc[s + 2] *= 1 - a;
      }
    }
  }

  for (const b of room.background) layer(b.rings, b.paint, b.grain, -1);
  if (room.surface && room.surfacePaint) layer(room.surface.rings, room.surfacePaint.paint, room.surfacePaint.grain, -1);
  for (const b of room.foreground) layer(b.rings, b.paint, b.grain, -1);

  const order = paintOrder(room);
  const paintObject = (i) => {
    const o = room.objects[i];
    layer(o.rings, o.paint, o.grain, i);
    for (const d of o.details) layer(d.rings, d.paint, d.grain, undefined, i);
  };
  const flats = order.filter((i) => room.objects[i].role === 'flat');
  const standing = order.filter((i) => room.objects[i].role !== 'flat');
  for (const i of flats) paintObject(i);
  for (const s of room.shades) shade(s.ellipse, s.alpha);
  for (const i of standing) paintObject(i);

  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = ((2 * y) * SW + 2 * x) * 3;
      const b = a + 3;
      const c = a + SW * 3;
      const d = c + 3;
      const o = (y * W + x) * 4;
      rgba[o] = Math.round((acc[a] + acc[b] + acc[c] + acc[d]) / 4);
      rgba[o + 1] = Math.round((acc[a + 1] + acc[b + 1] + acc[c + 1] + acc[d + 1]) / 4);
      rgba[o + 2] = Math.round((acc[a + 2] + acc[b + 2] + acc[c + 2] + acc[d + 2]) / 4);
      rgba[o + 3] = 255;
    }
  }

  const owner = new Int16Array(W * H).fill(-1);
  for (const i of order) fillRingsInto(owner, W, H, room.objects[i].rings, i);

  return { width: W, height: H, rgba, owner, owner2, order };
}
