// The lossy part of baseline JPEG, for tests: RGB to YCbCr, 4:2:0 chroma
// subsampling, an 8 by 8 DCT quantised with the standard tables at a given
// quality (the usual quality scaling), then back. The entropy coding JPEG
// adds is lossless, so this gives the pixels a JPEG decoder would.
const LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];

function table(base, quality) {
  const s = quality < 50 ? 5000 / quality : 200 - 2 * quality;
  return base.map((t) => Math.min(255, Math.max(1, Math.floor((t * s + 50) / 100))));
}

const COS = new Float64Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
const C = (u) => (u ? 1 : Math.SQRT1_2);

function roundTrip(plane, w, h, q) {
  const out = new Float64Array(w * h);
  const blk = new Float64Array(64), coef = new Float64Array(64);
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const sx = Math.min(w - 1, bx + x), sy = Math.min(h - 1, by + y);
          blk[y * 8 + x] = plane[sy * w + sx] - 128;
        }
      }
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          let s = 0;
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += blk[y * 8 + x] * COS[x * 8 + u] * COS[y * 8 + v];
          const c = 0.25 * C(u) * C(v) * s;
          coef[v * 8 + u] = Math.round(c / q[v * 8 + u]) * q[v * 8 + u];
        }
      }
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          let s = 0;
          for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) s += C(u) * C(v) * coef[v * 8 + u] * COS[x * 8 + u] * COS[y * 8 + v];
          const X = bx + x, Y = by + y;
          if (X < w && Y < h) out[Y * w + X] = 0.25 * s + 128;
        }
      }
    }
  }
  return out;
}

export function jpegLike(rgba, w, h, quality = 90) {
  const n = w * h;
  const Y = new Float64Array(n);
  const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
  const Cb = new Float64Array(cw * ch), Cr = new Float64Array(cw * ch), cnt = new Float64Array(cw * ch);
  for (let i = 0; i < n; i++) {
    const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const x = i % w, y = (i - x) / w, c = (y >> 1) * cw + (x >> 1);
    Cb[c] += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[c] += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    cnt[c]++;
  }
  for (let c = 0; c < cw * ch; c++) { Cb[c] /= cnt[c]; Cr[c] /= cnt[c]; }
  const y2 = roundTrip(Y, w, h, table(LUMA, quality));
  const cb2 = roundTrip(Cb, cw, ch, table(CHROMA, quality));
  const cr2 = roundTrip(Cr, cw, ch, table(CHROMA, quality));
  const out = new Uint8ClampedArray(4 * n);
  for (let i = 0; i < n; i++) {
    const x = i % w, y = (i - x) / w, c = (y >> 1) * cw + (x >> 1);
    const yy = y2[i], b = cb2[c] - 128, r = cr2[c] - 128;
    out[4 * i] = yy + 1.402 * r;
    out[4 * i + 1] = yy - 0.344136 * b - 0.714136 * r;
    out[4 * i + 2] = yy + 1.772 * b;
    out[4 * i + 3] = 255;
  }
  return out;
}
