// Polygon geometry in picture pixel space.
// A ring is an array of [x, y] points, closed implicitly (last joins first).
// A shape is an array of rings read with the even-odd rule, so holes stay open.

export function ringSignedArea(ring) {
  let a = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

// +1 or -1 (0 for a degenerate ring). In screen space (y down) a positive
// ring runs clockwise as seen on screen.
export function orientation(ring) {
  const a = ringSignedArea(ring);
  return a > 0 ? 1 : a < 0 ? -1 : 0;
}

// Even-odd crossing test against one ring. The half-open rule here is the
// same one the scanline fill uses, so the two always agree exactly.
export function pointInRing(px, py, ring) {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = ring[j][0], ay = ring[j][1];
    const bx = ring[i][0], by = ring[i][1];
    if ((ay > py) !== (by > py)) {
      const xc = ax + (py - ay) * (bx - ax) / (by - ay);
      if (px < xc) inside = !inside;
    }
  }
  return inside;
}

export function pointInShape(px, py, rings) {
  let inside = false;
  for (const ring of rings) if (pointInRing(px, py, ring)) inside = !inside;
  return inside;
}

export function bounds(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
  }
  return { x0, y0, x1, y1 };
}

export function boxesOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// Area of an even-odd shape: each ring counts with the sign of its nesting
// depth (outer +, hole -, island in a hole +).
export function shapeArea(rings) {
  let total = 0;
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    if (r.length < 3) continue;
    const a = Math.abs(ringSignedArea(r));
    const [px, py] = interiorProbe(r);
    let depth = 0;
    for (let j = 0; j < rings.length; j++) {
      if (j !== i && pointInRing(px, py, rings[j])) depth++;
    }
    total += depth % 2 === 0 ? a : -a;
  }
  return total;
}

// A point just inside the first edge of a ring, used to find nesting depth.
function interiorProbe(ring) {
  const [ax, ay] = ring[0];
  const [bx, by] = ring[1];
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const s = orientation(ring) >= 0 ? 1 : -1;
  // Right-hand normal in screen space is (-dy, dx); positive rings hold
  // their inside on that side.
  const e = 1e-3;
  return [mx + (-dy / len) * e * s, my + (dx / len) * e * s];
}

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

export function distToRings(px, py, rings) {
  let best = Infinity;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const d = distToSegment(px, py, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
      if (d < best) best = d;
    }
  }
  return best;
}

export function pathLength(points) {
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    s += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return s;
}

// Douglas-Peucker on an open polyline, keeping both ends.
function dpOpen(pts, tol, out) {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > worst) { worst = d; wi = i; }
    }
    if (wi >= 0 && worst > tol) {
      keep[wi] = 1;
      stack.push([a, wi], [wi, b]);
    }
  }
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
}

// Simplify a closed ring so no dropped point lies farther than tol from the
// result. Returns null when the ring collapses below three points.
export function simplifyRing(ring, tol) {
  const n = ring.length;
  if (n < 4) return ring.slice();
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > fd) { fd = d; far = i; }
  }
  const first = ring.slice(0, far + 1);
  const second = ring.slice(far).concat([ring[0]]);
  const out = [];
  dpOpen(first, tol, out);
  out.pop();
  dpOpen(second, tol, out);
  out.pop();
  if (out.length < 3) return null;
  return out;
}

export function simplifyShape(rings, tol) {
  const out = [];
  for (const r of rings) {
    const s = simplifyRing(r, tol);
    if (s && Math.abs(ringSignedArea(s)) > 0) out.push(s);
  }
  return out;
}

export function transformRings(rings, sx, sy, tx, ty) {
  return rings.map((r) => r.map(([x, y]) => [x * sx + tx, y * sy + ty]));
}

// An axis-aligned ellipse as a ring. Only + - * / are used (a rational
// parametrisation of the circle), so every JavaScript engine produces the
// very same vertices. That keeps painted sample rooms identical everywhere.
export function ellipseRing(cx, cy, rx, ry, perQuadrant) {
  const n = perQuadrant || Math.max(6, Math.min(40, Math.ceil(Math.sqrt(Math.max(rx, ry)) * 2.2)));
  const q = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const d = 1 + t * t;
    q.push([(1 - t * t) / d, (2 * t) / d]);
  }
  const ring = [];
  for (const [x, y] of q) ring.push([cx + rx * x, cy + ry * y]);
  for (const [x, y] of q) ring.push([cx - rx * y, cy + ry * x]);
  for (const [x, y] of q) ring.push([cx - rx * x, cy - ry * y]);
  for (const [x, y] of q) ring.push([cx + rx * y, cy - ry * x]);
  return ring;
}

// Sine and cosine of an angle in degrees, using only + - * / after an exact
// range reduction, so every engine returns the very same numbers.
const RAD = Math.PI / 180;
function polySin(x) {
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000 + x2 * (1 / 355687428096000)))))))));
}
function polyCos(x) {
  const x2 = x * x;
  return 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600 + x2 * (-1 / 87178291200 + x2 * (1 / 20922789888000))))))));
}
export function sinCosDeg(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  const k = Math.round(d / 90);
  const r = (d - 90 * k) * RAD;
  const s = polySin(r), c = polyCos(r);
  switch (k & 3) {
    case 0: return [s, c];
    case 1: return [c, -s];
    case 2: return [-s, -c];
    default: return [-c, s];
  }
}

export function ringsInside(rings, w, h) {
  for (const r of rings) {
    for (const [x, y] of r) {
      if (!(x >= 0 && y >= 0 && x <= w && y <= h)) return false;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    }
  }
  return true;
}

export function centroidOfPoints(points) {
  let sx = 0, sy = 0;
  for (const p of points) { sx += p[0]; sy += p[1]; }
  return [sx / points.length, sy / points.length];
}
