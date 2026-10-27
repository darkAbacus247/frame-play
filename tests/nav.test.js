import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNav, thetaStar, findPath, lineOfSight, nearestPass, cellCenter, cellOf, sampleClearance, polylineLength, gridDistances } from '../src/nav.js';
import { fillRingsInto } from '../src/raster.js';
import { ellipseRing } from '../src/geom.js';
import { makeRng } from '../src/rng.js';

const P = { cell: 2, radius: 3, planExtra: 1.5, hazardMargin: 2, touch: 6 };

function mapFrom(w, h, obstacles) {
  const walk = new Uint8Array(w * h).fill(1);
  for (const rings of obstacles) fillRingsInto(walk, w, h, rings, 0);
  for (let x = 0; x < w; x++) { walk[x] = 0; walk[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { walk[y * w] = 0; walk[y * w + w - 1] = 0; }
  return walk;
}

function randomObstacles(rng, w, h, n) {
  const obs = [];
  for (let k = 0; k < n; k++) {
    const cx = 8 + rng() * (w - 16), cy = 8 + rng() * (h - 16);
    if (k % 2) obs.push([ellipseRing(cx, cy, 2 + rng() * 7, 2 + rng() * 7)]);
    else {
      const a = 2 + rng() * 8, b = 2 + rng() * 8;
      obs.push([[[cx - a, cy - b], [cx + a, cy - b * 0.3], [cx + a * 0.5, cy + b], [cx - a, cy + b * 0.6]]]);
    }
  }
  return obs;
}

// The any-angle optimum over cell centres: Dijkstra on the full visibility graph.
function bruteShortest(nav, s, g) {
  const cells = [];
  for (let c = 0; c < nav.pass.length; c++) if (nav.pass[c] && nav.comp[c] === nav.comp[s]) cells.push(c);
  const idx = new Map(cells.map((c, i) => [c, i]));
  const pts = cells.map((c) => cellCenter(nav, c));
  const dist = new Float64Array(cells.length).fill(Infinity);
  const done = new Uint8Array(cells.length);
  dist[idx.get(s)] = 0;
  for (;;) {
    let u = -1, bd = Infinity;
    for (let i = 0; i < cells.length; i++) if (!done[i] && dist[i] < bd) { bd = dist[i]; u = i; }
    if (u < 0) break;
    if (cells[u] === g) return bd;
    done[u] = 1;
    for (let v = 0; v < cells.length; v++) {
      if (done[v]) continue;
      const d = bd + Math.hypot(pts[u][0] - pts[v][0], pts[u][1] - pts[v][1]);
      if (d < dist[v] && lineOfSight(nav, pts[u][0], pts[u][1], pts[v][0], pts[v][1])) dist[v] = d;
    }
  }
  return Infinity;
}

test('Theta* paths are within 5% of the brute-force any-angle optimum on small maps', () => {
  const rng = makeRng(21);
  let checked = 0;
  for (let k = 0; k < 12; k++) {
    const w = 56, h = 44;
    const nav = buildNav(mapFrom(w, h, randomObstacles(rng, w, h, 5)), null, w, h, P);
    const free = [];
    for (let c = 0; c < nav.pass.length; c++) if (nav.pass[c]) free.push(c);
    for (let t = 0; t < 3; t++) {
      const s = free[Math.floor(rng() * free.length)];
      const g = free[Math.floor(rng() * free.length)];
      if (nav.comp[s] !== nav.comp[g] || s === g) continue;
      const cells = thetaStar(nav, s, g);
      assert.ok(cells, 'reachable goal gave no path');
      const len = polylineLength(cells.map((c) => cellCenter(nav, c)));
      const best = bruteShortest(nav, s, g);
      assert.ok(len <= best * 1.05 + 1e-9, `map ${k}: ${len.toFixed(2)} vs optimum ${best.toFixed(2)}`);
      assert.ok(len >= best - 1e-9);
      checked++;
    }
  }
  assert.ok(checked >= 10);
});

test('every path segment keeps the explorer clear of walls; ends are right', () => {
  const rng = makeRng(33);
  const w = 160, h = 120;
  const nav = buildNav(mapFrom(w, h, randomObstacles(rng, w, h, 14)), null, w, h, P);
  let paths = 0;
  for (let t = 0; t < 40; t++) {
    const a = nearestPass(nav, rng() * w, rng() * h);
    const [sx, sy] = cellCenter(nav, a);
    const gx = rng() * w, gy = rng() * h;
    const res = findPath(nav, sx, sy, gx, gy);
    if (!res) continue;
    paths++;
    const pts = res.points;
    assert.deepEqual(pts[0], [sx, sy]);
    // floor the body fits on but no free cell covers is walked by the
    // exact field: such a goal is reached too
    if (!res.snapped || res.reached) assert.deepEqual(pts[pts.length - 1], [gx, gy]);
    else assert.deepEqual(pts[pts.length - 1], cellCenter(nav, res.goalCell));
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.5) + 1;
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n, y = y0 + ((y1 - y0) * k) / n;
        assert.ok(sampleClearance(nav, x, y) >= nav.radius, `path ${t} touches a wall at ${x.toFixed(1)},${y.toFixed(1)}`);
      }
    }
  }
  assert.ok(paths > 20);
});

test('an unreachable goal gives no path, and snapping stays reachable', () => {
  const w = 80, h = 40;
  const wallRing = [[[38, 0], [42, 0], [42, 40], [38, 40]]];
  const nav = buildNav(mapFrom(w, h, [wallRing]), null, w, h, P);
  const s = cellOf(nav, 10, 20), g = cellOf(nav, 70, 20);
  assert.ok(nav.pass[s] && nav.pass[g]);
  assert.notEqual(nav.comp[s], nav.comp[g]);
  assert.equal(thetaStar(nav, s, g), null);
  const res = findPath(nav, 10, 20, 70, 20);
  assert.ok(res.snapped);
  assert.equal(nav.comp[res.goalCell], nav.comp[s]);
  const end = res.points[res.points.length - 1];
  assert.ok(end[0] < 38);
});

test('a goal inside a wall snaps to the nearest free cell', () => {
  const w = 80, h = 60;
  const box = [[[30, 20], [50, 20], [50, 40], [30, 40]]];
  const nav = buildNav(mapFrom(w, h, [box]), null, w, h, P);
  const c = nearestPass(nav, 40, 21);
  const [x, y] = cellCenter(nav, c);
  assert.ok(y < 20 && Math.abs(x - 40) <= 2, `snapped to ${x},${y}`);
  assert.ok(sampleClearance(nav, x, y) >= nav.planRadius);
});

test('hazard cells are not passable; distances are consistent', () => {
  const w = 80, h = 60;
  const walk = mapFrom(w, h, []);
  const hazard = new Uint8Array(w * h);
  for (let y = 28; y < 32; y++) for (let x = 38; x < 42; x++) hazard[y * w + x] = 1;
  const nav = buildNav(walk, hazard, w, h, P);
  const c = cellOf(nav, 40, 30);
  assert.equal(nav.pass[c], 0);
  const d = gridDistances(nav, [[cellOf(nav, 10, 10), 0]]);
  assert.ok(Number.isFinite(d[cellOf(nav, 70, 50)]));
  assert.equal(d[c], Infinity);
});

test('the same answer on every run', () => {
  const rng = makeRng(77);
  const w = 120, h = 90;
  const walk = mapFrom(w, h, randomObstacles(rng, w, h, 10));
  const a = findPath(buildNav(walk, null, w, h, P), 6, 6, 110, 80);
  const b = findPath(buildNav(walk, null, w, h, P), 6, 6, 110, 80);
  assert.deepEqual(a, b);
});
