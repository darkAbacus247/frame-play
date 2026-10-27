// The live outline tracer: a compact GrabCut-style segmentation inside SAM's
// exact box, written from the published textbook method (colour mixtures
// plus a minimum graph cut, refitted in rounds). Pure logic: it reads an
// RGBA pixel buffer and returns rings in picture pixels.
//
// 1. Work area: the box grown by max(6 px, 12%) on each side; the ring
//    outside the box is certain background. Scaled so its long side is at
//    most 96 cells.
// 2. Seeds: certain foreground at the seed points (3 by 3 cells each), when
//    inside the box; probable foreground in the inner ellipse (65% of the
//    box); the rest unknown.
// 3. Colour models: a mixture of 4 diagonal Gaussians each for foreground
//    and background, in CIELAB, started deterministically.
// 4. Graph cut: data costs from the mixtures, 8-neighbour smoothness
//    weighted by colour contrast, a max-flow minimum cut, three rounds of
//    refitting. Then the same cut at full resolution in a band around the
//    coarse edge, so the outline sits on the picture's own edge.
// 5. Clean-up: keep the region holding the seeds or the centre, fill holes
//    smaller than 2% of the box (a mug handle's hole stays), one majority
//    pass, back to picture pixels.
// 6. Tightness: SAM's boxes are tight, so the shape must touch all four
//    sides within 2 px and its bounds cover at least 85% of the box;
//    otherwise it is traced again on a finer and a coarser grid
//    (RETRY_CELLS), held to the same test, and failing that the object
//    falls back to its box, labeled that way.
import { traceMask, components, fillHoles, maskBounds } from './raster.js';
import { simplifyShape } from './geom.js';

export const MAX_CELLS = 96;
export const K = 4;
// The smoothness weight. The textbook's 50 is for RGB; in CIELAB, with
// costs in nats, 15 keeps thin parts (a cactus arm, chair legs) and still
// smooths JPEG noise (measured on both sample rooms).
export const GAMMA = 15;
const ROUNDS = 3;
const MAX_COST = 40;
const VAR_FLOOR = 1.5;

// ---- colour ----
const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

export function rgbToLab(r, g, b, out, o) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
  const z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const fx = f(x), fy = f(y), fz = f(z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

// ---- mixtures of diagonal Gaussians ----
// Fit to the samples (indexes into a Lab array). Deterministic start: the
// samples sorted by lightness, split into K equal runs; then k-means.
export function fitGmm(lab, idx, k = K) {
  const n = idx.length;
  if (!n) return null;
  const order = Array.from(idx).sort((a, b) => lab[3 * a] - lab[3 * b] || a - b);
  const kk = Math.min(k, n);
  const mean = new Float64Array(kk * 3);
  for (let c = 0; c < kk; c++) {
    const lo = Math.floor((c * n) / kk), hi = Math.max(lo + 1, Math.floor(((c + 1) * n) / kk));
    for (let i = lo; i < hi; i++) for (let d = 0; d < 3; d++) mean[c * 3 + d] += lab[3 * order[i] + d] / (hi - lo);
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < 6; it++) {
    const sum = new Float64Array(kk * 3), cnt = new Float64Array(kk);
    for (let i = 0; i < n; i++) {
      const p = 3 * idx[i];
      let best = 0, bd = Infinity;
      for (let c = 0; c < kk; c++) {
        const d0 = lab[p] - mean[3 * c], d1 = lab[p + 1] - mean[3 * c + 1], d2 = lab[p + 2] - mean[3 * c + 2];
        const d = d0 * d0 + d1 * d1 + d2 * d2;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best;
      cnt[best]++;
      for (let d = 0; d < 3; d++) sum[3 * best + d] += lab[p + d];
    }
    for (let c = 0; c < kk; c++) if (cnt[c]) for (let d = 0; d < 3; d++) mean[3 * c + d] = sum[3 * c + d] / cnt[c];
  }
  const w = new Float64Array(kk), v = new Float64Array(kk * 3);
  for (let i = 0; i < n; i++) {
    const c = assign[i], p = 3 * idx[i];
    w[c]++;
    for (let d = 0; d < 3; d++) { const e = lab[p + d] - mean[3 * c + d]; v[3 * c + d] += e * e; }
  }
  const comps = [];
  for (let c = 0; c < kk; c++) {
    if (!w[c]) continue;
    const vv = [0, 1, 2].map((d) => Math.max(VAR_FLOOR, v[3 * c + d] / w[c]));
    comps.push({
      w: w[c] / n,
      m: [mean[3 * c], mean[3 * c + 1], mean[3 * c + 2]],
      iv: vv.map((x) => 1 / x),
      lognorm: Math.log(w[c] / n) - 0.5 * (3 * Math.log(2 * Math.PI) + Math.log(vv[0] * vv[1] * vv[2])),
    });
  }
  return comps;
}

// -log p(colour | mixture), capped.
export function gmmCost(g, lab, p) {
  let best = -Infinity;
  const ls = new Float64Array(g.length);
  for (let c = 0; c < g.length; c++) {
    const q = g[c];
    const d0 = lab[p] - q.m[0], d1 = lab[p + 1] - q.m[1], d2 = lab[p + 2] - q.m[2];
    ls[c] = q.lognorm - 0.5 * (d0 * d0 * q.iv[0] + d1 * d1 * q.iv[1] + d2 * d2 * q.iv[2]);
    if (ls[c] > best) best = ls[c];
  }
  let s = 0;
  for (let c = 0; c < g.length; c++) s += Math.exp(ls[c] - best);
  return Math.min(MAX_COST, Math.max(0, -(best + Math.log(s))));
}

// ---- max flow (Dinic), for a minimum s-t cut ----
export class FlowGraph {
  constructor(n, edgeHint = 16 * n) {
    this.n = n + 2;
    this.s = n;
    this.t = n + 1;
    this.head = new Int32Array(this.n).fill(-1);
    this.to = new Int32Array(edgeHint);
    this.next = new Int32Array(edgeHint);
    this.cap = new Float64Array(edgeHint);
    this.m = 0;
  }

  grow() {
    const size = this.to.length * 2;
    const g = (A, T) => { const B = new T(size); B.set(A); return B; };
    this.to = g(this.to, Int32Array);
    this.next = g(this.next, Int32Array);
    this.cap = g(this.cap, Float64Array);
  }

  edge(a, b, c, rc = 0) {
    if (this.m + 2 > this.to.length) this.grow();
    const m = this.m;
    this.to[m] = b; this.cap[m] = c; this.next[m] = this.head[a]; this.head[a] = m;
    this.to[m + 1] = a; this.cap[m + 1] = rc; this.next[m + 1] = this.head[b]; this.head[b] = m + 1;
    this.m += 2;
  }

  // terminal links, with the direct s->p->t flow cancelled up front
  terminals(p, cs, ct) {
    const d = Math.min(cs, ct);
    cs -= d; ct -= d;
    if (cs > 0) this.edge(this.s, p, cs);
    if (ct > 0) this.edge(p, this.t, ct);
  }

  maxflow() {
    const { n, s, t, head, to, next, cap } = this;
    const level = new Int32Array(n);
    const it = new Int32Array(n);
    const queue = new Int32Array(n);
    const pathE = new Int32Array(n);
    let flow = 0;
    const EPS = 1e-9;
    for (;;) {
      level.fill(-1);
      level[s] = 0;
      let qh = 0, qt = 0;
      queue[qt++] = s;
      while (qh < qt) {
        const u = queue[qh++];
        for (let e = head[u]; e >= 0; e = next[e]) {
          if (cap[e] > EPS && level[to[e]] < 0) { level[to[e]] = level[u] + 1; queue[qt++] = to[e]; }
        }
      }
      if (level[t] < 0) break;
      for (let i = 0; i < n; i++) it[i] = head[i];
      // iterative depth-first blocking flow
      let depth = 0;
      let u = s;
      for (;;) {
        if (u === t) {
          let f = Infinity;
          for (let i = 0; i < depth; i++) f = Math.min(f, cap[pathE[i]]);
          let cut = depth;
          for (let i = 0; i < depth; i++) {
            const e = pathE[i];
            cap[e] -= f;
            cap[e ^ 1] += f;
            if (cap[e] <= EPS && cut === depth) cut = i;
          }
          flow += f;
          depth = cut;
          u = depth ? to[pathE[depth - 1]] : s;
          continue;
        }
        let e = it[u];
        while (e >= 0 && !(cap[e] > EPS && level[to[e]] === level[u] + 1)) e = next[e];
        it[u] = e;
        if (e < 0) {
          level[u] = -1;
          if (!depth) break;
          depth--;
          u = depth ? to[pathE[depth - 1]] : s;
          it[u] = next[it[u]];
          continue;
        }
        pathE[depth++] = e;
        u = to[e];
      }
    }
    return flow;
  }

  // Nodes on the source side of the minimum cut.
  sourceSide() {
    const { n, s, head, to, next, cap } = this;
    const seen = new Uint8Array(n);
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const u = stack.pop();
      for (let e = head[u]; e >= 0; e = next[e]) {
        if (cap[e] > 1e-9 && !seen[to[e]]) { seen[to[e]] = 1; stack.push(to[e]); }
      }
    }
    return seen;
  }
}

const NB = [[1, 0, 1], [0, 1, 1], [1, 1, Math.SQRT1_2], [-1, 1, Math.SQRT1_2]];

function contrastBeta(lab, w, h) {
  let sum = 0, cnt = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = 3 * (y * w + x);
      for (const [dx, dy] of NB) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) continue;
        const q = 3 * (ny * w + nx);
        const a = lab[p] - lab[q], b = lab[p + 1] - lab[q + 1], c = lab[p + 2] - lab[q + 2];
        sum += a * a + b * b + c * c;
        cnt++;
      }
    }
  }
  return cnt && sum ? cnt / (2 * sum) : 0;
}

// One cut over a w by h grid. state: 0 free, 1 fixed foreground, 2 fixed
// background. Only free cells become nodes; links to fixed neighbours fold
// into their terminal links. Returns a 0/1 foreground mask.
export function gridCut(lab, w, h, state, fg, bg, beta, gamma = GAMMA) {
  const node = new Int32Array(w * h).fill(-1);
  let n = 0;
  for (let i = 0; i < w * h; i++) if (state[i] === 0) node[i] = n++;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (state[i] === 1) out[i] = 1;
  if (!n) return out;
  const cs = new Float64Array(n), ct = new Float64Array(n);
  const g = new FlowGraph(n, 10 * n + 16);
  for (let i = 0; i < w * h; i++) {
    const a = node[i];
    if (a < 0) continue;
    cs[a] += gmmCost(bg, lab, 3 * i); // cutting s->p labels p background
    ct[a] += gmmCost(fg, lab, 3 * i);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = 3 * i;
      for (const [dx, dy, inv] of NB) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx, q = 3 * j;
        const a = node[i], b = node[j];
        if (a < 0 && b < 0) continue;
        const d0 = lab[p] - lab[q], d1 = lab[p + 1] - lab[q + 1], d2 = lab[p + 2] - lab[q + 2];
        const wgt = gamma * inv * Math.exp(-beta * (d0 * d0 + d1 * d1 + d2 * d2));
        if (a >= 0 && b >= 0) g.edge(a, b, wgt, wgt);
        else if (a >= 0) { if (state[j] === 1) cs[a] += wgt; else ct[a] += wgt; }
        else if (state[i] === 1) cs[b] += wgt; else ct[b] += wgt;
      }
    }
  }
  for (let a = 0; a < n; a++) g.terminals(a, cs[a], ct[a]);
  g.maxflow();
  const side = g.sourceSide();
  for (let i = 0; i < w * h; i++) if (node[i] >= 0 && side[node[i]]) out[i] = 1;
  return out;
}

function majority(mask, w, h, keepOff) {
  const out = mask.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0, all = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          all++;
          on += mask[ny * w + nx];
        }
      }
      const i = y * w + x;
      out[i] = keepOff && keepOff[i] ? 0 : (2 * on > all ? 1 : 0);
    }
  }
  return out;
}

// Keep the regions that hold a seed (or the centre); with none of those
// set, the largest region, or with `nearest`, the one nearest a seed.
function keepSeeded(mask, w, h, seedCells, nearest = false) {
  const { labels, count, sizes } = components(mask, w, h, 4);
  if (!count) return mask;
  const keep = new Uint8Array(count + 1);
  for (const i of seedCells) if (labels[i]) keep[labels[i]] = 1;
  if (!keep.some((v) => v) && nearest) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < mask.length; i++) {
      if (!labels[i]) continue;
      const y = Math.floor(i / w), x = i - y * w;
      for (const s of seedCells) {
        const sy = Math.floor(s / w), d = (x - (s - sy * w)) ** 2 + (y - sy) ** 2;
        if (d < bd) { bd = d; best = labels[i]; }
      }
    }
    keep[best] = 1;
  } else if (!keep.some((v) => v)) {
    let best = 1;
    for (let l = 2; l <= count; l++) if (sizes[l] > sizes[best]) best = l;
    keep[best] = 1;
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = keep[labels[i]] ? 1 : 0;
  return out;
}

export function boxRingsOf(box) {
  const [x0, y0, x1, y1] = box;
  return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
}

// A second look: where cells fall can split a part whose colour is close to
// its background (a terracotta pot on a wooden desk, through a browser's
// own JPEG) from the rest. A trace that is not tight is tried again on
// these grids; each try must pass the same tightness test, or the object
// still falls back to its box.
export const RETRY_CELLS = [128, 64];

// How far from Muse Spark's point a shape traced around it may lie: the
// same 3% the server allows a point beside SAM's box (SEED_REACH).
export const POINT_REACH = 0.03;

// Trace one object. pixels: { width, height, data: RGBA }. box: half-open
// [x0, y0, x1, y1] in pixels. seeds: [[x, y]...] in pixels.
// Returns { source: 'traced_in_box' | 'box', rings, why }.
export function traceInBox(pixels, box, seeds = [], opts = {}) {
  const first = traceOnce(pixels, box, seeds, opts);
  if (first.source === 'traced_in_box' || opts.maxCells) return first;
  for (const maxCells of RETRY_CELLS) {
    const again = traceOnce(pixels, box, seeds, { ...opts, maxCells });
    if (again.source === 'traced_in_box') return again;
  }
  return first;
}

// A box drawn by hand is looser than SAM's: the same cut inside it, with no
// tightness test, finds the bounds of the shape that stands out in it, so
// the object can then be traced inside those bounds exactly as inside SAM's
// box (traceInBox, tightness test and all). The bounds [x0, y0, x1, y1], or
// null when nothing stood out or the shape is a sliver of the box (under
// a tenth of its area, or under 4 px on a side).
export function snugBox(pixels, box, seeds = []) {
  const t = traceOnce(pixels, box, seeds, { loose: true });
  if (t.source !== 'loose') return null;
  const [x0, y0, x1, y1] = t.bounds;
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  if ((x1 - x0) * (y1 - y0) < 0.1 * (box[2] - box[0]) * (box[3] - box[1])) return null;
  return t.bounds;
}

// A thing SAM did not find: the server sends a region around Muse Spark's
// own points for it instead (server/pipeline.py, point_regions). The same
// cut runs there with the points as certain foreground, held to a looser
// test (the shape need not reach the region's sides; it must hold a point
// and stand out from the region). Returns { source: 'traced_at_points' |
// 'points_box', rings, why }: failing the test, the region itself is kept,
// labeled that way.
export function traceAroundPoints(pixels, box, points, opts = {}) {
  let t = traceOnce(pixels, box, points, { ...opts, around: true });
  for (const maxCells of opts.maxCells ? [] : RETRY_CELLS) {
    if (t.source === 'traced_in_box') break;
    const again = traceOnce(pixels, box, points, { ...opts, around: true, maxCells });
    if (again.source === 'traced_in_box') t = again;
  }
  return { ...t, source: t.source === 'traced_in_box' ? 'traced_at_points' : 'points_box' };
}

function traceOnce(pixels, box, seeds, opts) {
  const fallback = (why) => ({ source: 'box', rings: boxRingsOf(box), why });
  const W = pixels.width, H = pixels.height, data = pixels.data;
  const bx0 = Math.max(0, Math.floor(box[0])), by0 = Math.max(0, Math.floor(box[1]));
  const bx1 = Math.min(W, Math.ceil(box[2])), by1 = Math.min(H, Math.ceil(box[3]));
  const bw = bx1 - bx0, bh = by1 - by0;
  if (bw < 3 || bh < 3) return fallback('The box is too small to trace');
  const gx = Math.max(6, Math.round(0.12 * bw)), gy = Math.max(6, Math.round(0.12 * bh));
  const ax0 = Math.max(0, bx0 - gx), ay0 = Math.max(0, by0 - gy);
  const ax1 = Math.min(W, bx1 + gx), ay1 = Math.min(H, by1 + gy);
  const aw = ax1 - ax0, ah = ay1 - ay0;
  const sc = Math.max(1, Math.max(aw, ah) / (opts.maxCells || MAX_CELLS));
  const cw = Math.max(1, Math.round(aw / sc)), ch = Math.max(1, Math.round(ah / sc));
  const sx = aw / cw, sy = ah / ch;

  // the work area in Lab, at full resolution
  const plab = new Float64Array(aw * ah * 3);
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      const s = 4 * ((y + ay0) * W + x + ax0);
      rgbToLab(data[s], data[s + 1], data[s + 2], plab, 3 * (y * aw + x));
    }
  }
  // cells: the mean Lab of the pixels they cover
  const clab = new Float64Array(cw * ch * 3);
  const ccount = new Float64Array(cw * ch);
  const cellOfX = new Int32Array(aw), cellOfY = new Int32Array(ah);
  for (let x = 0; x < aw; x++) cellOfX[x] = Math.min(cw - 1, Math.floor(x / sx));
  for (let y = 0; y < ah; y++) cellOfY[y] = Math.min(ch - 1, Math.floor(y / sy));
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      const c = cellOfY[y] * cw + cellOfX[x], p = 3 * (y * aw + x);
      clab[3 * c] += plab[p]; clab[3 * c + 1] += plab[p + 1]; clab[3 * c + 2] += plab[p + 2];
      ccount[c]++;
    }
  }
  for (let c = 0; c < cw * ch; c++) for (let d = 0; d < 3; d++) clab[3 * c + d] /= ccount[c] || 1;

  // cell classes: certain background outside the box; certain foreground at
  // the seeds; probable foreground in the inner ellipse
  const state = new Uint8Array(cw * ch);
  const probable = new Uint8Array(cw * ch);
  const inBoxCell = new Uint8Array(cw * ch);
  const ecx = (bx0 + bx1) / 2, ecy = (by0 + by1) / 2, erx = 0.65 * bw / 2, ery = 0.65 * bh / 2;
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const c = j * cw + i;
      const px0 = ax0 + i * sx, px1 = ax0 + (i + 1) * sx, py0 = ay0 + j * sy, py1 = ay0 + (j + 1) * sy;
      if (px1 <= bx0 + 1e-9 || px0 >= bx1 - 1e-9 || py1 <= by0 + 1e-9 || py0 >= by1 - 1e-9) { state[c] = 2; continue; }
      inBoxCell[c] = 1;
      const mx = (px0 + px1) / 2 - ecx, my = (py0 + py1) / 2 - ecy;
      if ((mx * mx) / (erx * erx) + (my * my) / (ery * ery) <= 1) probable[c] = 1;
    }
  }
  const seedCells = [];
  const usable = seeds.filter(([x, y]) => x >= bx0 && x < bx1 && y >= by0 && y < by1);
  for (const [x, y] of usable) {
    const ci = Math.min(cw - 1, Math.floor((x - ax0) / sx)), cj = Math.min(ch - 1, Math.floor((y - ay0) / sy));
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= cw || j >= ch) continue;
        const c = j * cw + i;
        // Muse Spark's points are rough (on the recorded desk, 12 px beside
        // a coin): around them, they only choose which region is kept
        if (inBoxCell[c]) { if (!opts.around) state[c] = 1; seedCells.push(c); }
      }
    }
  }
  const centreCell = Math.min(ch - 1, Math.floor((ecy - ay0) / sy)) * cw + Math.min(cw - 1, Math.floor((ecx - ax0) / sx));
  if (!seedCells.length) seedCells.push(centreCell);

  const idx = (pred) => { const out = []; for (let c = 0; c < cw * ch; c++) if (pred(c)) out.push(c); return out; };
  // the first foreground model learns from everything inside the box, as
  // in the textbook method; the ring's own colours teach the background
  let fg = fitGmm(clab, idx((c) => inBoxCell[c] === 1));
  let bg = fitGmm(clab, idx((c) => state[c] === 2));
  if (!fg || !bg) return fallback('There is no background around the box to learn from');
  const beta = contrastBeta(clab, cw, ch);
  let mask = null;
  for (let r = 0; r < (opts.rounds ?? ROUNDS); r++) {
    mask = gridCut(clab, cw, ch, state, fg, bg, beta, opts.gamma ?? GAMMA);
    const fgIdx = idx((c) => mask[c] === 1);
    const bgIdx = idx((c) => mask[c] === 0);
    if (!fgIdx.length) return fallback('Nothing inside the box stood out from its background');
    fg = fitGmm(clab, fgIdx);
    bg = fitGmm(clab, bgIdx.length ? bgIdx : idx((c) => state[c] === 2));
  }
  const boxCells = Math.max(1, idx((c) => inBoxCell[c]).length);
  mask = keepSeeded(mask, cw, ch, seedCells, !!opts.around);
  mask = fillHoles(mask, cw, ch, 0.02 * boxCells);
  // one majority pass on cells bigger than a pixel (the band cut below then
  // redraws the edge); on single pixels it would only eat curved edges
  if (sc > 1) mask = majority(mask, cw, ch, state.map((v) => (v === 2 ? 1 : 0)));

  // back to picture pixels: the coarse labels, then the same cut at full
  // resolution in a band around the coarse edge
  let pmask = new Uint8Array(aw * ah);
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) pmask[y * aw + x] = mask[cellOfY[y] * cw + cellOfX[x]];
  const outside = new Uint8Array(aw * ah);
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      const X = x + ax0, Y = y + ay0;
      if (X < bx0 || X >= bx1 || Y < by0 || Y >= by1) { outside[y * aw + x] = 1; pmask[y * aw + x] = 0; }
    }
  }
  if (sc > 1) {
    const band = Math.ceil(2 * Math.max(sx, sy)) + 1;
    const pstate = new Uint8Array(aw * ah);
    // distance (in pixels, chessboard) to the coarse edge, by two passes
    const near = new Uint8Array(aw * ah);
    for (let y = 0; y < ah; y++) {
      for (let x = 0; x < aw; x++) {
        const i = y * aw + x;
        const v = pmask[i];
        if ((x + 1 < aw && pmask[i + 1] !== v) || (y + 1 < ah && pmask[i + aw] !== v)) {
          for (let dy = -band; dy <= band; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= ah) continue;
            for (let dx = -band; dx <= band; dx++) {
              const nx = x + dx;
              if (nx >= 0 && nx < aw) near[ny * aw + nx] = 1;
            }
          }
        }
      }
    }
    for (let i = 0; i < aw * ah; i++) pstate[i] = outside[i] ? 2 : near[i] ? 0 : (pmask[i] ? 1 : 2);
    const pbeta = contrastBeta(plab, aw, ah);
    pmask = gridCut(plab, aw, ah, pstate, fg, bg, pbeta, opts.gamma ?? GAMMA);
    const seedPixels = seedCells.map((c) => {
      const j = Math.floor(c / cw), i = c - j * cw;
      return Math.min(ah - 1, Math.floor((j + 0.5) * sy)) * aw + Math.min(aw - 1, Math.floor((i + 0.5) * sx));
    });
    pmask = keepSeeded(pmask, aw, ah, seedPixels, !!opts.around);
    pmask = fillHoles(pmask, aw, ah, 0.02 * bw * bh);
  }

  // tightness against SAM's box
  const mb = maskBounds(pmask, aw, ah);
  if (!mb) return fallback('Nothing was left after the clean-up');
  const tx0 = mb.x0 + ax0, ty0 = mb.y0 + ay0, tx1 = mb.x1 + ax0, ty1 = mb.y1 + ay0;
  // a loose box (snugBox): where the shape is, with no test
  if (opts.loose) return { source: 'loose', bounds: [tx0, ty0, tx1, ty1], why: null };
  const touches = Math.abs(tx0 - bx0) <= 2 && Math.abs(ty0 - by0) <= 2 && Math.abs(tx1 - bx1) <= 2 && Math.abs(ty1 - by1) <= 2;
  const cover = ((tx1 - tx0) * (ty1 - ty0)) / (bw * bh);
  if (opts.around) {
    // a region around Muse Spark's points is a guess, not a tight box: the
    // shape must lie at a point (or within POINT_REACH of the picture's long
    // side) and stand out from the region, nothing more
    const reach = POINT_REACH * Math.max(W, H);
    const near = usable.some(([x, y]) => Math.max(tx0 - x, x - tx1, 0) <= reach && Math.max(ty0 - y, y - ty1, 0) <= reach);
    if (!near) return fallback('The traced shape was not at Muse Spark’s point');
    if (touches && cover > 0.95) return fallback('Nothing around Muse Spark’s points stood out from its background');
    if ((tx1 - tx0) < 3 || (ty1 - ty0) < 3) return fallback('The traced shape was too small');
  } else {
    if (!touches) return fallback('The traced shape did not reach every side of SAM’s box');
    if (cover < 0.85) return fallback('The traced shape covered too little of SAM’s box');
  }
  const rings = simplifyShape(traceMask(pmask, aw, ah).map((r) => r.map(([x, y]) => [x + ax0, y + ay0])), opts.simplify ?? 0.75);
  if (!rings.length) return fallback('The traced shape had no outline');
  return { source: 'traced_in_box', rings, why: null };
}
