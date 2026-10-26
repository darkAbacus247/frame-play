import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pointInRing, pointInShape, ringSignedArea, orientation, shapeArea, bounds,
  simplifyRing, distToRings, ellipseRing, transformRings, pathLength,
} from '../src/geom.js';
import { makeRng } from '../src/rng.js';

// An independent containment test: cast the ray upward instead of to the
// right. For points off every edge both must agree.
function insideUpRay(px, py, rings) {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [ax, ay] = ring[j];
      const [bx, by] = ring[i];
      if ((ax > px) !== (bx > px)) {
        const yc = ay + (px - ax) * (by - ay) / (bx - ax);
        if (py > yc) inside = !inside;
      }
    }
  }
  return inside;
}

function randomRing(rng, cx, cy, r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.45 + 0.55 * rng());
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return pts;
}

test('containment with holes agrees with an independent ray test', () => {
  const rng = makeRng(7);
  for (let k = 0; k < 40; k++) {
    const outer = randomRing(rng, 50, 50, 45, 5 + Math.floor(rng() * 20));
    const hole = randomRing(rng, 50 + rng() * 6, 50 + rng() * 6, 14, 3 + Math.floor(rng() * 8));
    const rings = [outer, hole];
    for (let t = 0; t < 400; t++) {
      const px = rng() * 100 + 1e-7, py = rng() * 100 + 2e-7;
      assert.equal(pointInShape(px, py, rings), insideUpRay(px, py, rings));
    }
  }
});

test('a rectangle with a hole: containment, area, orientation, bounds', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole = [[3, 3], [3, 7], [7, 7], [7, 3]];
  const rings = [outer, hole];
  assert.equal(pointInShape(1, 1, rings), true);
  assert.equal(pointInShape(5, 5, rings), false);
  assert.equal(pointInShape(11, 5, rings), false);
  assert.equal(ringSignedArea(outer), 100);
  assert.equal(orientation(outer), 1);
  assert.equal(orientation(hole), -1);
  assert.equal(shapeArea(rings), 84);
  assert.deepEqual(bounds(rings), { x0: 0, y0: 0, x1: 10, y1: 10 });
  assert.equal(pointInRing(5, 5, outer), true);
});

test('simplification stays within tolerance', () => {
  const rng = makeRng(11);
  for (let k = 0; k < 30; k++) {
    const ring = [];
    const n = 50 + Math.floor(rng() * 300);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 80 + rng() * 3 + 10 * Math.sin(a * 5);
      ring.push([200 + Math.cos(a) * r, 200 + Math.sin(a) * r]);
    }
    for (const tol of [0.5, 0.75, 2]) {
      const s = simplifyRing(ring, tol);
      assert.ok(s && s.length >= 3 && s.length <= ring.length);
      for (const [x, y] of ring) {
        assert.ok(distToRings(x, y, [s]) <= tol + 1e-9, 'a dropped point is farther than the tolerance');
      }
    }
  }
});

test('ellipse rings are exact, symmetric and closed without trigonometry', () => {
  const r = ellipseRing(100, 60, 40, 20);
  for (const [x, y] of r) {
    const u = (x - 100) / 40, v = (y - 60) / 20;
    assert.ok(Math.abs(u * u + v * v - 1) < 1e-12);
  }
  assert.equal(r.length % 4, 0);
  const again = ellipseRing(100, 60, 40, 20);
  assert.deepEqual(r, again);
  assert.ok(Math.abs(Math.abs(ringSignedArea(r)) - Math.PI * 40 * 20) / (Math.PI * 800) < 0.01);
});

test('transforms and path length', () => {
  const t = transformRings([[[0, 0], [2, 0], [2, 2]]], 2, 3, 1, 1);
  assert.deepEqual(t, [[[1, 1], [5, 1], [5, 7]]]);
  assert.equal(pathLength([[0, 0], [3, 4], [3, 8]]), 9);
});
