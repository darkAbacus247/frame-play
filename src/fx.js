// Particles on their own canvas, laid exactly over the board (styles.css
// .fx-layer: out of the flow, under no pointer), so they never change the
// board's size or the page's layout: a sparkle on a coin, a glint at the
// exit, confetti on a win, a puff on a hazard, light dust under the steps
// and a shimmer tracing each outline on the reveal.
//
// Counts are capped, nothing runs while nothing is alive, and with reduced
// motion (the system's or the page's switch) there are no particles at all.
// Positions come in picture pixels; particles live in CSS pixels.

export const FX_CAP = 160;
export const BURST = { coin: 16, exit: 14, hazard: 12, dust: 2, win: 70, trace: 22 };
const GOLD = ['#f5c542', '#ffe9a3', '#ffffff'];
const GREEN = ['#4ad688', '#bff5d6', '#ffffff'];
const PUFF = ['#d9d2c5', '#ff9d8a', '#bdb6aa'];
const DUST = ['#efe6d3', '#d8cdb6'];
const CONFETTI = ['#f5c542', '#4ad688', '#7ff3e4', '#ff7a7a', '#b99cff', '#ffffff'];
const MAX_DT = 0.05;

// a seeded spread, so a test sees the same burst every time
function spread(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Points evenly along rings (picture pixels), at most n.
export function alongRings(rings, n) {
  const segs = [];
  let total = 0;
  for (const r of rings || []) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 0) { segs.push([a, b, len]); total += len; }
    }
  }
  if (!total || n < 1) return [];
  const out = [];
  let si = 0, acc = 0;
  for (let i = 0; i < n; i++) {
    const d = (i / n) * total;
    while (si < segs.length - 1 && acc + segs[si][2] < d) { acc += segs[si][2]; si++; }
    const [a, b, len] = segs[si];
    const f = Math.min(1, (d - acc) / len);
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

export class Fx {
  // board: the board's canvas (only read, never sized here); pic: its
  // picture size; reduced(): true while motion is reduced
  constructor(board, pic, { reduced = () => false, raf, caf, seed = 1 } = {}) {
    this.board = board;
    this.pic = pic;
    this.reduced = reduced;
    this.raf = raf || ((f) => globalThis.requestAnimationFrame(f));
    this.caf = caf || ((id) => globalThis.cancelAnimationFrame && globalThis.cancelAnimationFrame(id));
    this.rand = spread(seed);
    this.layer = board.ownerDocument.createElement('canvas');
    this.layer.className = 'fx-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    this.g = this.layer.getContext('2d');
    this.parts = [];
    this.scale = 1;
    this.dpr = 1;
    this.cssW = 0;
    this.cssH = 0;
    this.loop = 0;
    this.last = 0;
    this.destroyed = false;
  }

  // Lay the layer over a board drawn at cssW x cssH CSS pixels.
  fit(cssW, cssH, dpr = 1) {
    const s = cssW / this.pic.width;
    if (!(s > 0) || !(cssH > 0) || !Number.isFinite(s)) return;
    if (this.scale && s !== this.scale) {
      const r = s / this.scale;
      for (const p of this.parts) { p.x *= r; p.y *= r; }
    }
    this.scale = s;
    this.dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;
    this.layer.style.width = `${cssW}px`;
    this.layer.style.height = `${cssH}px`;
    this.layer.width = Math.max(1, Math.round(cssW * dpr));
    this.layer.height = Math.max(1, Math.round(cssH * dpr));
  }

  allowed() { return !this.destroyed && !this.reduced(); }

  add(p) {
    if (this.parts.length >= FX_CAP) return false;
    this.parts.push({ age: 0, delay: 0, g: 0, rot: 0, spin: 0, alpha: 1, grow: 0, shape: 'dot', ...p });
    return true;
  }

  // kind: coin | exit | hazard | dust | win | trace; x, y in picture pixels
  // (win covers the board; trace takes { rings, color }). Returns how many
  // particles were added.
  burst(kind, x = 0, y = 0, opts = {}) {
    if (!this.allowed() || !BURST[kind]) return 0;
    const R = this.rand;
    const pick = (list) => list[Math.floor(R() * list.length)];
    const cx = x * this.scale, cy = y * this.scale;
    let n = 0;
    const put = (p) => { if (this.add(p)) n++; };
    if (kind === 'coin' || kind === 'exit') {
      for (let i = 0; i < BURST[kind]; i++) {
        const a = (i / BURST[kind]) * Math.PI * 2 + R() * 0.4, v = 45 + R() * 75;
        put({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 20, g: 70, life: 0.5 + R() * 0.35, size: 2 + R() * 2, color: pick(kind === 'coin' ? GOLD : GREEN), shape: 'star', spin: (R() - 0.5) * 8 });
      }
    } else if (kind === 'hazard') {
      for (let i = 0; i < BURST.hazard; i++) {
        const a = R() * Math.PI * 2, v = 15 + R() * 35;
        put({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6 - 12, g: -10, life: 0.6 + R() * 0.35, size: 3 + R() * 2, grow: 9, alpha: 0.4, color: pick(PUFF) });
      }
    } else if (kind === 'dust') {
      for (let i = 0; i < BURST.dust; i++) {
        put({ x: cx + (R() - 0.5) * 6, y: cy, vx: (R() - 0.5) * 30, vy: -10 - R() * 15, g: 40, life: 0.35 + R() * 0.15, size: 1.2 + R() * 0.8, alpha: 0.45, color: pick(DUST) });
      }
    } else if (kind === 'win') {
      for (let i = 0; i < BURST.win; i++) {
        put({ x: R() * this.cssW, y: -6 - R() * this.cssH * 0.25, vx: (R() - 0.5) * 50, vy: 40 + R() * 80, g: 60, life: 1.6 + R() * 0.8, size: 3 + R() * 2, color: pick(CONFETTI), shape: 'rect', rot: R() * Math.PI, spin: (R() - 0.5) * 10, delay: R() * 0.35 });
      }
    } else if (kind === 'trace') {
      const pts = alongRings(opts.rings, BURST.trace);
      pts.forEach(([px, py], i) => {
        put({ x: px * this.scale, y: py * this.scale, vx: 0, vy: -6, life: 0.45, size: 1.6 + R(), color: opts.color || '#ffffff', shape: 'star', delay: (i / pts.length) * 0.3 });
      });
    }
    if (n) this.run();
    return n;
  }

  run() {
    if (this.loop || this.destroyed) return;
    this.last = 0;
    this.loop = this.raf((t) => this.frame(t));
  }

  // advance by dt seconds; drop the spent
  step(dt) {
    dt = Math.min(MAX_DT, Math.max(0, dt));
    for (const p of this.parts) {
      if (p.delay > 0) { p.delay -= dt; continue; }
      p.age += dt;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
    this.parts = this.parts.filter((p) => p.age < p.life && p.y < this.cssH + 40);
  }

  frame(t) {
    this.loop = 0;
    if (this.destroyed) return;
    if (this.reduced()) this.parts = [];
    const dt = this.last ? (t - this.last) / 1000 : 1 / 60;
    this.last = t;
    this.step(dt);
    this.draw();
    if (this.parts.length) this.loop = this.raf((tt) => this.frame(tt));
  }

  draw() {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.layer.width, this.layer.height);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (const p of this.parts) {
      if (p.delay > 0) continue;
      const k = p.age / p.life;
      g.globalAlpha = Math.max(0, p.alpha * (1 - k * k));
      g.fillStyle = p.color;
      const s = p.size + p.grow * k;
      if (p.shape === 'rect') {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.fillRect(-s / 2, -s, s, s * 2);
        g.restore();
      } else if (p.shape === 'star') {
        // a four-point glint: two thin crossed bars
        g.fillRect(p.x - s, p.y - s * 0.22, s * 2, s * 0.44);
        g.fillRect(p.x - s * 0.22, p.y - s, s * 0.44, s * 2);
      } else {
        g.beginPath();
        g.arc(p.x, p.y, s, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;
  }

  clear() {
    this.parts = [];
    this.draw();
  }

  destroy() {
    this.destroyed = true;
    if (this.loop) this.caf(this.loop);
    this.loop = 0;
    this.parts = [];
    this.layer.remove();
  }
}
