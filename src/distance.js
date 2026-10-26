// Exact Euclidean distance transform (Felzenszwalb and Huttenlocher, 2012).
// Input: a Uint8Array of w * h where non-zero marks a feature (a wall pixel).
// Output: a Float32Array holding, for every pixel centre, the distance in
// pixels to the nearest feature pixel centre (0 on features). With no
// feature at all every value is Infinity.

const BIG = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

export function edtSquared(features, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) {
    if (features[i]) { grid[i] = 0; any = true; } else grid[i] = BIG;
  }
  if (!any) return null;
  // columns
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  // rows
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
  return grid;
}

export function edt(features, w, h) {
  const sq = edtSquared(features, w, h);
  const out = new Float32Array(w * h);
  if (!sq) { out.fill(Infinity); return out; }
  for (let i = 0; i < out.length; i++) out[i] = sq[i] >= BIG / 2 ? Infinity : Math.sqrt(sq[i]);
  return out;
}

// Bilinear read of a per-pixel field at a point in picture coordinates.
// Pixel centres sit at (x + 0.5, y + 0.5). Outside the picture the field
// reads 0, so the border always behaves as a wall.
export function sampleField(field, w, h, px, py) {
  const fx = px - 0.5, fy = py - 0.5;
  if (!(fx >= 0 && fy >= 0 && fx <= w - 1 && fy <= h - 1)) return 0;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = fx - x0, ty = fy - y0;
  const a = field[y0 * w + x0], b = field[y0 * w + x1];
  const c = field[y1 * w + x0], d = field[y1 * w + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

// Gradient of the field by central differences (points away from walls).
export function fieldGradient(field, w, h, px, py) {
  const e = 1;
  const gx = sampleField(field, w, h, px + e, py) - sampleField(field, w, h, px - e, py);
  const gy = sampleField(field, w, h, px, py + e) - sampleField(field, w, h, px, py - e);
  const len = Math.hypot(gx, gy);
  if (len < 1e-9) return [0, 0];
  return [gx / len, gy / len];
}
