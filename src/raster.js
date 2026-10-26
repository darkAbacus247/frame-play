// Masks in picture pixel space. A mask is a Uint8Array of w * h, row major.
// Pixel (x, y) covers [x, x + 1) x [y, y + 1); its centre is (x + 0.5, y + 0.5).
// A pixel is inside a shape when its centre is inside by the even-odd rule.

// Edges of every ring, kept in ring order so the crossing arithmetic is
// bit-for-bit the same as geom.pointInRing.
function edgeTable(rings) {
  const edges = [];
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[j][0], ay = ring[j][1];
      const bx = ring[i][0], by = ring[i][1];
      if (ay === by) continue;
      edges.push({ ax, ay, bx, by, ymin: Math.min(ay, by), ymax: Math.max(ay, by) });
    }
  }
  edges.sort((a, b) => a.ymin - b.ymin);
  return edges;
}

function firstAtOrAfter(c) {
  // smallest integer x with x + 0.5 >= c
  let g = Math.ceil(c - 0.5);
  while (g + 0.5 < c) g++;
  while (g - 0.5 >= c) g--;
  return g;
}

function lastBefore(c) {
  // largest integer x with x + 0.5 < c
  let e = Math.ceil(c - 0.5) - 1;
  while (e + 0.5 >= c) e--;
  while (e + 1.5 < c) e++;
  return e;
}

// Calls span(y, xStart, xEnd) for every run of inside pixels (inclusive ends).
export function scanRings(rings, w, h, span) {
  const edges = edgeTable(rings);
  if (!edges.length) return;
  let ylo = Infinity, yhi = -Infinity;
  for (const e of edges) { if (e.ymin < ylo) ylo = e.ymin; if (e.ymax > yhi) yhi = e.ymax; }
  const yStart = Math.max(0, Math.floor(ylo - 0.5));
  const yEnd = Math.min(h - 1, Math.ceil(yhi));
  let next = 0;
  let active = [];
  const xs = [];
  for (let y = yStart; y <= yEnd; y++) {
    const py = y + 0.5;
    while (next < edges.length && edges[next].ymin <= py) active.push(edges[next++]);
    if (active.length) active = active.filter((e) => e.ymax > py);
    xs.length = 0;
    for (const e of active) {
      if ((e.ay > py) !== (e.by > py)) {
        xs.push(e.ax + (py - e.ay) * (e.bx - e.ax) / (e.by - e.ay));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let x0 = firstAtOrAfter(xs[k]);
      let x1 = lastBefore(xs[k + 1]);
      if (x0 < 0) x0 = 0;
      if (x1 > w - 1) x1 = w - 1;
      if (x1 >= x0) span(y, x0, x1);
    }
  }
}

export function fillRingsInto(mask, w, h, rings, value = 1) {
  scanRings(rings, w, h, (y, x0, x1) => {
    const row = y * w;
    for (let x = x0; x <= x1; x++) mask[row + x] = value;
  });
  return mask;
}

export function fillRings(rings, w, h) {
  return fillRingsInto(new Uint8Array(w * h), w, h, rings, 1);
}

export function maskArea(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

// Bounds in pixel-edge coordinates: x1 and y1 are exclusive. null if empty.
export function maskBounds(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// Trace a mask into rings along pixel edges. Outer rings have positive
// signed area and holes negative. Filling the rings with fillRings gives back
// exactly the same mask, holes included. Diagonal-only contacts are kept as
// separate rings (4-connected regions).
export function traceMask(mask, w, h) {
  const W1 = w + 1;
  const orig = new Uint8Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      if (y === 0 || !mask[row - w + x]) orig[y * W1 + x] |= 1;
      if (x === w - 1 || !mask[row + x + 1]) orig[y * W1 + x + 1] |= 2;
      if (y === h - 1 || !mask[row + w + x]) orig[(y + 1) * W1 + x + 1] |= 4;
      if (x === 0 || !mask[row + x - 1]) orig[(y + 1) * W1 + x] |= 8;
    }
  }
  const used = new Uint8Array(orig.length);
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const rings = [];
  for (let v = 0; v < orig.length; v++) {
    let bits = orig[v] & ~used[v];
    while (bits) {
      const d0 = bits & 1 ? 0 : bits & 2 ? 1 : bits & 4 ? 2 : 3;
      let vx = v % W1;
      let vy = (v - vx) / W1;
      const ring = [[vx, vy]];
      used[v] |= 1 << d0;
      let d = d0;
      for (;;) {
        vx += DX[d];
        vy += DY[d];
        const cur = vy * W1 + vx;
        const o = orig[cur];
        const r = (d + 1) & 3;
        const l = (d + 3) & 3;
        const nd = o & (1 << r) ? r : o & (1 << d) ? d : l;
        if (used[cur] & (1 << nd)) break;
        used[cur] |= 1 << nd;
        if (nd !== d) ring.push([vx, vy]);
        d = nd;
      }
      if (d === d0) ring.shift();
      if (ring.length >= 3) rings.push(ring);
      bits = orig[v] & ~used[v];
    }
  }
  return rings;
}

// Connected regions of set pixels. conn is 4 or 8.
export function components(mask, w, h, conn = 4) {
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    count++;
    let top = 0;
    stack[top++] = i;
    labels[i] = count;
    let size = 0;
    while (top) {
      const p = stack[--top];
      size++;
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (conn === 4 && dx && dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = count;
            stack[top++] = q;
          }
        }
      }
    }
    sizes.push(size);
  }
  return { labels, count, sizes };
}

// Fill holes: unset regions (4-connected) that do not touch the border and
// hold at most maxArea pixels become set. Bigger holes, such as the inside of
// a mug's handle, stay open when maxArea is small enough.
export function fillHoles(mask, w, h, maxArea = Infinity) {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  const { labels, count, sizes } = components(inv, w, h, 4);
  const border = new Uint8Array(count + 1);
  for (let x = 0; x < w; x++) { border[labels[x]] = 1; border[labels[(h - 1) * w + x]] = 1; }
  for (let y = 0; y < h; y++) { border[labels[y * w]] = 1; border[labels[y * w + w - 1]] = 1; }
  const out = mask.slice();
  for (let i = 0; i < out.length; i++) {
    const l = labels[i];
    if (l && !border[l] && sizes[l] <= maxArea) out[i] = 1;
  }
  return out;
}

export function offsetRings(rings, dx, dy) {
  return rings.map((r) => r.map(([x, y]) => [x + dx, y + dy]));
}

export function cropMask(mask, w, h, x0, y0, x1, y1) {
  const cw = x1 - x0, ch = y1 - y0;
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const sy = y + y0;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < cw; x++) {
      const sx = x + x0;
      if (sx < 0 || sx >= w) continue;
      out[y * cw + x] = mask[sy * w + sx];
    }
  }
  return out;
}

// Trace only the part of a big mask inside its bounds (faster), in full
// picture coordinates.
export function traceMaskInBounds(mask, w, h) {
  const b = maskBounds(mask, w, h);
  if (!b) return [];
  const sub = cropMask(mask, w, h, b.x0, b.y0, b.x1, b.y1);
  return offsetRings(traceMask(sub, b.x1 - b.x0, b.y1 - b.y0), b.x0, b.y0);
}

// Pixels of a mask that have an unset 4-neighbour (or touch the border).
export function boundaryPixels(mask, w, h) {
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) {
        out.push(x, y);
      }
    }
  }
  return Int32Array.from(out);
}
