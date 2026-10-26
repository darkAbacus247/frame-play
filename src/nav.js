// Navigation: a fine clearance grid built from an exact distance field, any-
// angle Theta* search with line of sight over every cell a segment touches,
// nearest free cell, string pulling with light corner rounding, and
// reachability. Paths hug the real outlines; there are no tiles in play.
import { edt, sampleField } from './distance.js';

export function navParams(width, height) {
  const L = Math.max(width, height);
  const cell = Math.max(2, Math.round(L / 256));
  const radius = 0.011 * L;
  return {
    L,
    cell,
    radius,
    planExtra: 0.75 * cell,
    hazardMargin: 0.008 * L,
    touch: radius + 0.01 * L,
    speed: 0.22 * L,
  };
}

// walk: Uint8Array w*h, 1 where the explorer's feet may be.
// hazard: Uint8Array w*h, 1 on hazard footprints (or null).
export function buildNav(walk, hazard, w, h, p) {
  const cell = p.cell;
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const wall = new Uint8Array(w * h);
  for (let i = 0; i < wall.length; i++) wall[i] = walk[i] ? 0 : 1;
  const field = edt(wall, w, h);
  const hfield = hazard ? edt(hazard, w, h) : null;
  const clear = new Float32Array(gw * gh).fill(Infinity);
  const hclear = new Float32Array(gw * gh).fill(Infinity);
  for (let y = 0; y < h; y++) {
    const cj = (y / cell) | 0;
    for (let x = 0; x < w; x++) {
      const ci = cj * gw + ((x / cell) | 0);
      const v = field[y * w + x];
      if (v < clear[ci]) clear[ci] = v;
      if (hfield) {
        const hv = hfield[y * w + x];
        if (hv < hclear[ci]) hclear[ci] = hv;
      }
    }
  }
  const planRadius = p.radius + p.planExtra;
  const margin = p.hazardMargin;
  const pass = new Uint8Array(gw * gh);
  for (let i = 0; i < pass.length; i++) {
    pass[i] = clear[i] >= planRadius && hclear[i] >= p.radius + margin + p.planExtra ? 1 : 0;
  }
  const nav = { w, h, cell, gw, gh, radius: p.radius, planRadius, margin, touch: p.touch, field, hfield, clear, hclear, pass };
  nav.comp = labelComponents(nav);
  return nav;
}

function labelComponents(nav) {
  const { gw, gh, pass } = nav;
  const comp = new Int32Array(gw * gh);
  const stack = new Int32Array(gw * gh);
  let n = 0;
  for (let s = 0; s < pass.length; s++) {
    if (!pass[s] || comp[s]) continue;
    n++;
    let top = 0;
    stack[top++] = s;
    comp[s] = n;
    while (top) {
      const c = stack[--top];
      const i = c % gw, j = (c - i) / gw;
      if (i > 0 && pass[c - 1] && !comp[c - 1]) { comp[c - 1] = n; stack[top++] = c - 1; }
      if (i < gw - 1 && pass[c + 1] && !comp[c + 1]) { comp[c + 1] = n; stack[top++] = c + 1; }
      if (j > 0 && pass[c - gw] && !comp[c - gw]) { comp[c - gw] = n; stack[top++] = c - gw; }
      if (j < gh - 1 && pass[c + gw] && !comp[c + gw]) { comp[c + gw] = n; stack[top++] = c + gw; }
    }
  }
  return comp;
}

export function cellOf(nav, x, y) {
  let i = Math.floor(x / nav.cell), j = Math.floor(y / nav.cell);
  if (i < 0) i = 0; else if (i >= nav.gw) i = nav.gw - 1;
  if (j < 0) j = 0; else if (j >= nav.gh) j = nav.gh - 1;
  return j * nav.gw + i;
}

export function cellCenter(nav, c) {
  const i = c % nav.gw, j = (c - i) / nav.gw;
  return [(i + 0.5) * nav.cell, (j + 0.5) * nav.cell];
}

function passAt(nav, i, j) {
  return i >= 0 && j >= 0 && i < nav.gw && j < nav.gh && nav.pass[j * nav.gw + i] === 1;
}

// Line of sight between two points in picture pixels: every grid cell the
// segment touches must be passable (corners count both side cells).
export function lineOfSight(nav, ax, ay, bx, by) {
  const c = nav.cell;
  const x0 = ax / c, y0 = ay / c, x1 = bx / c, y1 = by / c;
  let i = Math.floor(x0), j = Math.floor(y0);
  const iEnd = Math.floor(x1), jEnd = Math.floor(y1);
  if (!passAt(nav, i, j) || !passAt(nav, iEnd, jEnd)) return false;
  const dx = x1 - x0, dy = y1 - y0;
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tdx = sx ? Math.abs(1 / dx) : Infinity;
  const tdy = sy ? Math.abs(1 / dy) : Infinity;
  let tx = sx > 0 ? (i + 1 - x0) / dx : sx < 0 ? (x0 - i) / -dx : Infinity;
  let ty = sy > 0 ? (j + 1 - y0) / dy : sy < 0 ? (y0 - j) / -dy : Infinity;
  let guard = Math.abs(iEnd - i) + Math.abs(jEnd - j) + 4;
  while ((i !== iEnd || j !== jEnd) && guard-- > 0) {
    if (Math.abs(tx - ty) < 1e-10) {
      if (!passAt(nav, i + sx, j) || !passAt(nav, i, j + sy)) return false;
      i += sx; j += sy; tx += tdx; ty += tdy;
    } else if (tx < ty) {
      i += sx; tx += tdx;
    } else {
      j += sy; ty += tdy;
    }
    if (tx > 1 + 1e-9 && ty > 1 + 1e-9 && (i !== iEnd || j !== jEnd)) {
      // floating point ended a hair early: the end cell was checked above
      if (!passAt(nav, i, j)) return false;
      break;
    }
    if (!passAt(nav, i, j)) return false;
  }
  return true;
}

// A small binary heap keyed by (cost, index) so ties always break the same way.
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  less(a, b) { return this.k[a] < this.k[b] || (this.k[a] === this.k[b] && this.v[a] < this.v[b]); }
  swap(a, b) {
    const k = this.k[a]; this.k[a] = this.k[b]; this.k[b] = k;
    const v = this.v[a]; this.v[a] = this.v[b]; this.v[b] = v;
  }
  push(key, val) {
    this.k.push(key); this.v.push(val);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p); i = p;
    }
  }
  pop() {
    const top = this.v[0];
    const lk = this.k.pop(), lv = this.v.pop();
    if (this.k.length) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0;
      const n = this.k.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
}

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function neighbours(nav, c, out) {
  out.length = 0;
  const { gw, gh, pass } = nav;
  const i = c % gw, j = (c - i) / gw;
  for (const [di, dj] of N8) {
    const ni = i + di, nj = j + dj;
    if (ni < 0 || nj < 0 || ni >= gw || nj >= gh) continue;
    const n = nj * gw + ni;
    if (!pass[n]) continue;
    if (di && dj && (!pass[j * gw + ni] || !pass[nj * gw + i])) continue;
    out.push(n);
  }
  return out;
}

// Grid distances (8 neighbours, no corner cutting) from one or more sources.
// sources: array of [cell, startCost].
export function gridDistances(nav, sources) {
  const N = nav.gw * nav.gh;
  const dist = new Float64Array(N).fill(Infinity);
  const heap = new Heap();
  for (const [c, d0] of sources) {
    if (!nav.pass[c]) continue;
    if (d0 < dist[c]) { dist[c] = d0; heap.push(d0, c); }
  }
  const nb = [];
  const gw = nav.gw, cs = nav.cell, diag = Math.SQRT2 * cs;
  while (heap.size) {
    const kd = heap.k[0];
    const c = heap.pop();
    if (kd > dist[c]) continue;
    for (const n of neighbours(nav, c, nb)) {
      const step = (n - c === 1 || c - n === 1 || n - c === gw || c - n === gw) ? cs : diag;
      const nd = dist[c] + step;
      if (nd < dist[n]) { dist[n] = nd; heap.push(nd, n); }
    }
  }
  return dist;
}

// Theta* from cell s to cell g. Returns the cell list or null.
export function thetaStar(nav, s, g) {
  if (!nav.pass[s] || !nav.pass[g] || nav.comp[s] !== nav.comp[g]) return null;
  const N = nav.gw * nav.gh;
  const cost = new Float64Array(N).fill(Infinity);
  const parent = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const [gx, gy] = cellCenter(nav, g);
  const hOf = (c) => { const [x, y] = cellCenter(nav, c); return Math.hypot(x - gx, y - gy); };
  const heap = new Heap();
  cost[s] = 0;
  parent[s] = s;
  heap.push(hOf(s), s);
  const nb = [];
  while (heap.size) {
    const u = heap.pop();
    if (closed[u]) continue;
    if (u === g) break;
    closed[u] = 1;
    const p = parent[u];
    const [px, py] = cellCenter(nav, p);
    const [ux, uy] = cellCenter(nav, u);
    for (const v of neighbours(nav, u, nb)) {
      if (closed[v]) continue;
      const [vx, vy] = cellCenter(nav, v);
      let cand, par;
      if (p !== u && lineOfSight(nav, px, py, vx, vy)) {
        cand = cost[p] + Math.hypot(vx - px, vy - py);
        par = p;
      } else {
        cand = cost[u] + Math.hypot(vx - ux, vy - uy);
        par = u;
      }
      if (cand < cost[v] - 1e-9) {
        cost[v] = cand;
        parent[v] = par;
        heap.push(cand + hOf(v), v);
      }
    }
  }
  if (parent[g] < 0) return null;
  const cells = [g];
  let c = g;
  while (c !== s) {
    c = parent[c];
    cells.push(c);
  }
  return cells.reverse();
}

// The passable cell nearest to a point, optionally inside one component.
export function nearestPass(nav, x, y, comp = 0) {
  let best = -1, bd = Infinity;
  const { gw, cell, pass } = nav;
  for (let c = 0; c < pass.length; c++) {
    if (!pass[c] || (comp && nav.comp[c] !== comp)) continue;
    const i = c % gw, j = (c - i) / gw;
    const d = ((i + 0.5) * cell - x) ** 2 + ((j + 0.5) * cell - y) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// String pulling, then light corner rounding; each change is kept only where
// line of sight (and so the clearance) still holds.
export function smoothPath(nav, pts) {
  if (pts.length <= 2) return pts.slice();
  const out = [pts[0]];
  let a = 0;
  while (a < pts.length - 1) {
    let b = pts.length - 1;
    while (b > a + 1 && !lineOfSight(nav, pts[a][0], pts[a][1], pts[b][0], pts[b][1])) b--;
    out.push(pts[b]);
    a = b;
  }
  const r = [out[0]];
  for (let k = 1; k < out.length - 1; k++) {
    const A = r[r.length - 1], V = out[k], B = out[k + 1];
    const la = Math.hypot(A[0] - V[0], A[1] - V[1]);
    const lb = Math.hypot(B[0] - V[0], B[1] - V[1]);
    const cut = Math.min(2.5 * nav.cell, la * 0.4, lb * 0.4);
    if (cut < nav.cell * 0.5) { r.push(V); continue; }
    const a2 = [V[0] + ((A[0] - V[0]) * cut) / la, V[1] + ((A[1] - V[1]) * cut) / la];
    const b2 = [V[0] + ((B[0] - V[0]) * cut) / lb, V[1] + ((B[1] - V[1]) * cut) / lb];
    const mid = [(a2[0] + b2[0] + V[0]) / 3, (a2[1] + b2[1] + V[1]) / 3];
    if (lineOfSight(nav, a2[0], a2[1], mid[0], mid[1]) && lineOfSight(nav, mid[0], mid[1], b2[0], b2[1])) {
      r.push(a2, mid, b2);
    } else {
      r.push(V);
    }
  }
  r.push(out[out.length - 1]);
  return r;
}

export function polylineLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

// A walkable path from a point to a point, both in picture pixels. The goal
// snaps to the nearest passable cell the explorer can reach.
export function findPath(nav, sx, sy, gx, gy) {
  let s = cellOf(nav, sx, sy);
  if (!nav.pass[s]) s = nearestPass(nav, sx, sy);
  if (s < 0) return null;
  let g = cellOf(nav, gx, gy);
  let exactGoal = true;
  if (!nav.pass[g] || nav.comp[g] !== nav.comp[s]) {
    g = nearestPass(nav, gx, gy, nav.comp[s]);
    exactGoal = false;
  }
  if (g < 0) return null;
  const cells = thetaStar(nav, s, g);
  if (!cells) return null;
  const pts = [[sx, sy]];
  for (const c of cells) pts.push(cellCenter(nav, c));
  if (exactGoal) pts.push([gx, gy]);
  const smooth = smoothPath(nav, pts);
  return { points: smooth, length: polylineLength(smooth), snapped: !exactGoal, goalCell: g };
}

export function pathToCell(nav, sx, sy, g) {
  const [gx, gy] = cellCenter(nav, g);
  return findPath(nav, sx, sy, gx, gy);
}

export function sampleClearance(nav, x, y) {
  return sampleField(nav.field, nav.w, nav.h, x, y);
}
