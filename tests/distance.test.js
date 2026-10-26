import test from 'node:test';
import assert from 'node:assert/strict';
import { edt, sampleField, fieldGradient } from '../src/distance.js';
import { makeRng } from '../src/rng.js';

function brute(features, w, h) {
  const pts = [];
  for (let i = 0; i < w * h; i++) if (features[i]) pts.push([i % w, Math.floor(i / w)]);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity;
      for (const [fx, fy] of pts) {
        const d = (fx - x) * (fx - x) + (fy - y) * (fy - y);
        if (d < best) best = d;
      }
      out[y * w + x] = Math.sqrt(best);
    }
  }
  return out;
}

test('the distance transform equals brute force on random grids', () => {
  const rng = makeRng(9);
  for (let k = 0; k < 30; k++) {
    const w = 5 + Math.floor(rng() * 45), h = 5 + Math.floor(rng() * 45);
    const density = [0.002, 0.02, 0.2, 0.6][k % 4];
    const f = new Uint8Array(w * h);
    for (let i = 0; i < f.length; i++) f[i] = rng() < density ? 1 : 0;
    f[Math.floor(rng() * f.length)] = 1;
    const got = edt(f, w, h);
    const want = brute(f, w, h);
    for (let i = 0; i < f.length; i++) {
      assert.ok(Math.abs(got[i] - want[i]) < 1e-4, `case ${k} pixel ${i}: ${got[i]} vs ${want[i]}`);
    }
  }
});

test('no feature means infinite distance', () => {
  const d = edt(new Uint8Array(12), 4, 3);
  assert.ok(d.every((v) => v === Infinity));
});

test('bilinear sampling and gradient point away from the wall', () => {
  const w = 20, h = 10;
  const f = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) f[y * w] = 1; // a wall along the left column
  const d = edt(f, w, h);
  assert.ok(Math.abs(sampleField(d, w, h, 5.5, 4.5) - 5) < 1e-6);
  assert.ok(Math.abs(sampleField(d, w, h, 6, 4.5) - 5.5) < 1e-6);
  const [gx, gy] = fieldGradient(d, w, h, 8.5, 5);
  assert.ok(gx > 0.99 && Math.abs(gy) < 1e-6);
  assert.equal(sampleField(d, w, h, -3, 4), 0);
});
