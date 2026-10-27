// SAM 3.1's floor mask as the play area. The server decodes the masks of
// SAM's floor matches and sends their union as rings (the floor's outline
// and its holes, which are the footprints of the things standing on it).
// Here: the rings are checked, and pieces of floor that SAM's mask leaves
// apart by a crack (touching only at a corner, or across a gap of one or two
// nav squares) are joined, so no coin sits on an island the explorer cannot
// reach by a step a real floor would allow. Walls stay where they are: a gap
// wider than two squares (a wall in a floor plan) is never joined.
import { fillRings, components, traceMask, fillHoles } from './raster.js';
import { edt } from './distance.js';
import { ringsInside, simplifyShape } from './geom.js';
import { navParams } from './nav.js';

// pieces smaller than this share of the picture are left as they are
export const JOIN_PIECE = 0.004;
// the widest gap joined, in nav squares
export const JOIN_SQUARES = 2;

// The floor mask's rings from a reply's floor, if usable: rings of three or
// more points, all numbers, all on the picture. Else null.
export function floorMaskRings(floor, W, H) {
  const m = floor && floor.mask;
  if (!m || !Array.isArray(m.rings) || !m.rings.length) return null;
  const ok = m.rings.every((ring) => Array.isArray(ring) && ring.length >= 3
    && ring.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])));
  return ok && ringsInside(m.rings, W, H) ? m.rings : null;
}

// Join the pieces of a floor mask that lie at most JOIN_SQUARES nav squares
// apart (8-connected pieces; a corner touch at the pixel level is one piece
// already). Each gap is filled where it is that narrow, and a passage as
// wide as the explorer is opened at its narrowest place, so the join can be
// walked. Returns { mask, joins } (joins: how many gaps were opened).
export function joinFloor(mask, W, H) {
  const p = navParams(W, H);
  const G = JOIN_SQUARES * p.cell + 1; // a gap of g pixels meets at d1 + d2 = g + 1
  const { labels, count, sizes } = components(mask, W, H, 8);
  const big = new Uint8Array(count + 1);
  let bigCount = 0;
  for (let l = 1; l <= count; l++) if (sizes[l] >= JOIN_PIECE * W * H) { big[l] = 1; bigCount++; }
  if (bigCount < 2) return { mask, joins: 0 };
  // from the edge of every big piece outward over what is not floor, the
  // two nearest pieces of each pixel and how far they are (8 steps)
  const n = W * H;
  const lab1 = new Int32Array(n), lab2 = new Int32Array(n);
  const d1 = new Uint8Array(n), d2 = new Uint8Array(n);
  const qi = new Int32Array(2 * n), ql = new Int32Array(2 * n), qd = new Uint8Array(2 * n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (!l || !big[l]) continue;
    const x = i % W, y = (i - x) / W;
    let edge = false;
    for (let dy = -1; dy <= 1 && !edge; dy++) {
      for (let dx = -1; dx <= 1 && !edge; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && !mask[ny * W + nx]) edge = true;
      }
    }
    if (edge) { qi[tail] = i; ql[tail] = l; qd[tail] = 0; tail++; }
  }
  while (head < tail) {
    const i = qi[head], l = ql[head], d = qd[head];
    head++;
    if (d + 1 >= G) continue;
    const x = i % W, y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (mask[j]) continue;
        if (!lab1[j]) { lab1[j] = l; d1[j] = d + 1; }
        else if (lab1[j] !== l && !lab2[j]) { lab2[j] = l; d2[j] = d + 1; }
        else continue;
        qi[tail] = j; ql[tail] = l; qd[tail] = d + 1; tail++;
      }
    }
  }
  // the gaps: pixels between two pieces no wider than G - 1
  const out = mask.slice();
  const best = new Map();
  for (let j = 0; j < n; j++) {
    if (!lab2[j] || d1[j] + d2[j] > G) continue;
    out[j] = 1;
    const a = Math.min(lab1[j], lab2[j]), b = Math.max(lab1[j], lab2[j]);
    const key = a * (count + 1) + b;
    const g = d1[j] + d2[j];
    const was = best.get(key);
    if (!was || g < was.g) best.set(key, { a, b, g, j });
  }
  // one passage for each pair of pieces not yet joined, narrowest gaps first
  const parent = Int32Array.from({ length: count + 1 }, (_, k) => k);
  const find = (k) => { while (parent[k] !== k) k = parent[k] = parent[parent[k]]; return k; };
  const R = Math.ceil(p.radius + p.planExtra + p.cell);
  let joins = 0;
  for (const e of [...best.values()].sort((u, v) => u.g - v.g || u.j - v.j)) {
    const ra = find(e.a), rb = find(e.b);
    if (ra === rb) continue;
    parent[ra] = rb;
    joins++;
    const cx = e.j % W, cy = (e.j - cx) / W;
    for (let y = Math.max(0, cy - R); y <= Math.min(H - 1, cy + R); y++) {
      for (let x = Math.max(0, cx - R); x <= Math.min(W - 1, cx + R); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= R * R) out[y * W + x] = 1;
      }
    }
  }
  return { mask: joins ? out : mask, joins };
}

// The play area from SAM's floor mask: the rings as they came when no gap
// was joined, else the joined floor traced again. Returns { rings, joins }
// or null.
export function floorFromMask(floor, W, H) {
  const rings = floorMaskRings(floor, W, H);
  if (!rings) return null;
  const { mask, joins } = joinFloor(fillRings(rings, W, H), W, H);
  return { rings: joins ? simplifyShape(traceMask(mask, W, H), 0.75) : rings, joins };
}

// The floor no camera saw: hidden behind and under the things standing on
// it, inferred from the floor that was seen. The floor's holes are filled
// (seen at eye level, together with the things' outlines: a thing hides the
// floor behind it), and so are the slivers a mask leaves between a thing and
// the floor around it, wherever the floor closes over them within
// HIDDEN_SEAL of the long side and they lie that close to a thing. The
// floor's outer boundary away from things, and the picture's edges, stay
// walls: a gap far from any thing is never closed. Seen from above, a thing
// opens no wall (a rug over a wall stays a wall). things: the outlines of
// the things standing on the floor, as one mask. Returns the mask.
export const HIDDEN_SEAL = 0.006;
export function hiddenFloor(floor, things, W, H, topDown) {
  const n = W * H;
  const r = Math.max(2, Math.round(HIDDEN_SEAL * Math.max(W, H)));
  const base = floor.slice();
  if (!topDown) for (let i = 0; i < n; i++) if (things[i]) base[i] = 1;
  const out = fillHoles(base, W, H);
  // the closing of the floor by a disc of radius r, kept only near things
  const near = edt(things, W, H);
  const grown = edt(base, W, H);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) outside[i] = grown[i] > r ? 1 : 0;
  const shrunk = edt(outside, W, H);
  for (let i = 0; i < n; i++) if (!out[i] && near[i] <= r && shrunk[i] > r) out[i] = 1;
  return out;
}

// Where the walkable floor meets the exit's outline: the floor pixels that
// touch it, as a doorway { x, y, width, exit: true } at the one nearest
// their middle; null when the floor never touches the exit.
export function exitDoorway(walk, exitMask, W, H) {
  let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  const touch = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!walk[i] || exitMask[i]) continue;
      if (!(exitMask[i - 1] || exitMask[i + 1] || exitMask[i - W] || exitMask[i + W])) continue;
      touch.push(i);
      n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (!n) return null;
  const mx = sx / n, my = sy / n;
  let at = touch[0], bestD = Infinity;
  for (const i of touch) {
    const x = i % W, y = (i - x) / W;
    const d = (x - mx) ** 2 + (y - my) ** 2;
    if (d < bestD) { bestD = d; at = i; }
  }
  const x = at % W;
  return { x: x + 0.5, y: (at - x) / W + 0.5, width: Math.max(x1 - x0, y1 - y0) + 1, exit: true };
}
