import test from 'node:test';
import assert from 'node:assert/strict';
import { fillRings, traceMask, components, fillHoles, maskBounds, maskArea, traceMaskInBounds, boundaryPixels } from '../src/raster.js';
import { pointInShape, ringSignedArea, ellipseRing } from '../src/geom.js';
import { makeRng } from '../src/rng.js';

function randomPolygon(rng, w, h, n) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([rng() * w, rng() * h]);
  return pts;
}

test('scanline fill matches the per-pixel even-odd test on random polygons', () => {
  const rng = makeRng(3);
  const w = 61, h = 47;
  for (let k = 0; k < 60; k++) {
    const rings = [randomPolygon(rng, w, h, 3 + Math.floor(rng() * 12))];
    if (k % 2) rings.push(randomPolygon(rng, w, h, 3 + Math.floor(rng() * 6)));
    if (k % 5 === 0) rings.push([[2, 2], [20, 2], [20, 20.5], [2, 20.5]]);
    const m = fillRings(rings, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        assert.equal(!!m[y * w + x], pointInShape(x + 0.5, y + 0.5, rings), `pixel ${x},${y} case ${k}`);
      }
    }
  }
});

test('fill handles vertices exactly on pixel centres and rings past the border', () => {
  const w = 20, h = 12;
  const rings = [[[-5.5, 0.5], [10.5, 0.5], [10.5, 5.5], [25, 5.5], [25, 30], [-5.5, 30]]];
  const m = fillRings(rings, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      assert.equal(!!m[y * w + x], pointInShape(x + 0.5, y + 0.5, rings));
    }
  }
});

function randomBlobMask(rng, w, h) {
  const m = new Uint8Array(w * h);
  const blobs = 2 + Math.floor(rng() * 4);
  for (let b = 0; b < blobs; b++) {
    const cx = rng() * w, cy = rng() * h, rx = 3 + rng() * w / 3, ry = 3 + rng() * h / 3;
    const hole = rng() < 0.6;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry;
        const d = u * u + v * v;
        if (d < 1 && !(hole && d < 0.25)) m[y * w + x] = 1;
      }
    }
  }
  return m;
}

test('trace then fill returns the same mask, holes included', () => {
  const rng = makeRng(5);
  for (let k = 0; k < 40; k++) {
    const w = 30 + Math.floor(rng() * 50), h = 20 + Math.floor(rng() * 40);
    let m;
    if (k % 4 === 3) {
      m = new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) m[i] = rng() < 0.45 ? 1 : 0; // salt and pepper: many saddles
    } else {
      m = randomBlobMask(rng, w, h);
    }
    const rings = traceMask(m, w, h);
    const back = fillRings(rings, w, h);
    assert.deepEqual(back, m, `round trip case ${k}`);
  }
});

test('traced outer rings are positive and holes negative', () => {
  const w = 20, h = 20;
  const m = new Uint8Array(w * h);
  for (let y = 2; y < 18; y++) for (let x = 2; x < 18; x++) m[y * w + x] = 1;
  for (let y = 7; y < 12; y++) for (let x = 7; x < 12; x++) m[y * w + x] = 0;
  const rings = traceMask(m, w, h);
  assert.equal(rings.length, 2);
  const areas = rings.map(ringSignedArea).sort((a, b) => a - b);
  assert.deepEqual(areas, [-25, 256]);
  assert.equal(rings[0].length, 4); // collinear points removed
  const inB = traceMaskInBounds(m, w, h);
  assert.deepEqual(fillRings(inB, w, h), m);
});

test('components, bounds, area and hole filling', () => {
  const w = 12, h = 8;
  const m = new Uint8Array(w * h);
  const set = (x, y) => { m[y * w + x] = 1; };
  set(1, 1); set(2, 2); // diagonal neighbours
  for (let x = 6; x < 11; x++) for (let y = 1; y < 7; y++) set(x, y);
  m[3 * w + 8] = 0; // a one-pixel hole
  assert.equal(components(m, w, h, 4).count, 3);
  assert.equal(components(m, w, h, 8).count, 2);
  assert.deepEqual(maskBounds(m, w, h), { x0: 1, y0: 1, x1: 11, y1: 7 });
  assert.equal(maskArea(m), 2 + 30 - 1);
  const filled = fillHoles(m, w, h, 1);
  assert.equal(filled[3 * w + 8], 1);
  const kept = fillHoles(m, w, h, 0);
  assert.equal(kept[3 * w + 8], 0);
  const b = boundaryPixels(m, w, h);
  assert.ok(b.length > 0 && b.length % 2 === 0);
});

test('an ellipse ring fills to the analytic ellipse except at the very edge', () => {
  const w = 100, h = 80;
  const ring = ellipseRing(50, 40, 30, 20);
  const m = fillRings([ring], w, h);
  let off = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x + 0.5 - 50) / 30, v = (y + 0.5 - 40) / 20;
    const r = Math.sqrt(u * u + v * v);
    if (!!m[y * w + x] !== (r < 1)) {
      off++;
      // only pixel centres hugging the true edge may differ (chord sagitta)
      assert.ok(Math.abs(r - 1) * 20 < 0.2, `pixel ${x},${y} is far from the edge`);
    }
  }
  assert.ok(off < 30, `pixels off the analytic ellipse: ${off}`);
});
