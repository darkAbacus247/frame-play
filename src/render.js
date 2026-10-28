// Canvas drawing: device-pixel-ratio fitting, the picture, outlines by role,
// the explorer, the occlusion repaint (the picture's own pixels drawn again
// through each nearer object's outline), the x-ray, the path preview and the
// walls overlay. The draw order is a pure function (drawPlan) so it can be
// tested without a browser; nothing at module level touches the page.
import { boxesOverlap, bounds, pointInShape, distToRings } from './geom.js';
import { stampRect } from './rooms.js';
import { bodyRadius } from './nav.js';

export const ROLE_STYLE = {
  collect: { color: '#f5c542', dash: [], width: 2.25, badge: 'star' },
  avoid: { color: '#ff5d5d', dash: [7, 5], width: 2.25, badge: 'warn' },
  exit: { color: '#4ad688', dash: [], width: 2.5, badge: 'door' },
  solid: { color: '#f3efe6', dash: [], width: 1.25, badge: null },
  flat: { color: '#f3efe6', dash: [2, 5], width: 1.25, badge: null },
};

// The explorer's sprite box in picture pixels, from its feet. Seen from
// above (a floor plan) the explorer is drawn as seen from above: its body
// disc and no more, so what is drawn is what collides and it never stands
// over a wall or a thing; at eye level it stands up from its feet.
export function spriteBox(L, feet, topDown = false) {
  if (topDown) {
    const r = bodyRadius(L);
    return { x0: feet[0] - r, y0: feet[1] - r, x1: feet[0] + r, y1: feet[1] + r };
  }
  const h = 0.05 * L, w = 0.032 * L;
  return { x0: feet[0] - w / 2, y0: feet[1] - h, x1: feet[0] + w / 2, y1: feet[1] + 0.012 * L };
}

// The draw order for one frame. Nearer objects (baseline lower on screen
// than the explorer's feet, outline bounds overlapping the sprite) are
// repainted over the explorer, far to near; then the x-ray.
export function drawPlan(level, feet, opts = {}) {
  const L = Math.max(level.picture.width, level.picture.height);
  const ops = [{ op: 'picture' }];
  if (opts.walls) ops.push({ op: 'walls' });
  // a floor that fences the play area: its outline and its doorways
  if (opts.walls && hasFloor(level)) ops.push({ op: 'floor' });
  ops.push({ op: 'halos' });
  if (opts.explorer === false) {
    // the reveal: outlines and numbered badges, no explorer
    if (opts.walls) ops.push({ op: 'route' });
    ops.push({ op: 'outlines' }, { op: 'numbers' });
    if (level.origin === 'mock') ops.push({ op: 'stamp' });
    return ops;
  }
  const above = level.view === 'top_down';
  const sb = spriteBox(L, feet, above);
  ops.push({ op: 'path' }, { op: 'shadow' }, { op: 'explorer' });
  const nearer = [];
  level.objects.forEach((o, k) => {
    // seen from above, nothing stands over the explorer
    if (above || !o.on_surface || o.role === 'flat') return;
    if (!(o.baseline_y > feet[1])) return;
    if (!boxesOverlap(bounds(o.outline.rings), sb)) return;
    nearer.push(k);
  });
  nearer.sort((a, b) => level.objects[a].baseline_y - level.objects[b].baseline_y || a - b);
  for (const k of nearer) ops.push({ op: 'repaint', k });
  if (nearer.length) ops.push({ op: 'xray', ks: nearer });
  if (opts.outlines !== false) ops.push({ op: 'outlines' });
  ops.push({ op: 'badges' });
  // Ask the room: right and wrong picks over everything but the tap marker
  if (opts.riddle) ops.push({ op: 'riddle' });
  ops.push({ op: 'marker' });
  if (level.origin === 'mock') ops.push({ op: 'stamp' });
  return ops;
}

// Whether a level's floor fences its play area (drawn by code, or traced
// from the picture): the level builder lists its doorways then.
export function hasFloor(level) {
  return !!(level.surface && Array.isArray(level.surface.rings) && level.surface.rings.length && Array.isArray(level.surface.doorways));
}

// Show walls: the floor's outline, and a ring across each doorway as wide
// as the doorway, in picture pixels.
export const FLOOR_STYLE = { edge: '#ffffff', under: 'rgba(0,0,0,0.55)', door: '#7cf2c4', doorFill: 'rgba(124,242,196,0.28)' };

// Where each numbered badge goes on the reveal: beside its object, clear of
// every outline and of the other badges, inside the picture.
export function badgeSpots(level, r) {
  const W = level.picture.width, H = level.picture.height;
  const rings = level.objects.map((o) => o.outline.rings);
  const placed = [];
  return level.objects.map((o, k) => {
    const b = bounds(o.outline.rings);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, g = r + 4;
    const cands = [
      [cx, b.y0 - g], [b.x1 + g, cy], [b.x0 - g, cy], [cx, b.y1 + g],
      [b.x1 + g, b.y0 - g], [b.x0 - g, b.y0 - g], [b.x1 + g, b.y1 + g], [b.x0 - g, b.y1 + g],
    ];
    const inside = ([x, y]) => x >= r && y >= r && x <= W - r && y <= H - r;
    const clear = ([x, y]) => {
      for (const rs of rings) {
        if (pointInShape(x, y, rs) || distToRings(x, y, rs) < r + 2) return false;
      }
      return placed.every(([px, py]) => Math.hypot(px - x, py - y) > 2 * r + 2);
    };
    let spot = cands.find((c) => inside(c) && clear(c));
    if (!spot) spot = cands.find(inside) || [Math.min(Math.max(cx, r), W - r), Math.min(Math.max(cy, r), H - r)];
    placed.push(spot);
    return { x: spot[0], y: spot[1], n: k + 1 };
  });
}

// The numbered badges for a picture drawn at `scale` CSS px per picture px:
// the largest radius (12, 10 or 8 CSS px) at which no two badges touch, or
// null when even the smallest would crowd, and the picture shows outlines
// without numbers.
export const BADGE_RADII = [12, 10, 8];
export function numberSpots(level, scale) {
  for (const rCss of BADGE_RADII) {
    const r = rCss / scale;
    const spots = badgeSpots(level, r);
    const apart = spots.every((a, i) => spots.every((b, j) => j <= i || Math.hypot(a.x - b.x, a.y - b.y) >= 2 * r + 2 / scale));
    if (apart) return { r, rCss, spots };
  }
  return null;
}

// The exit badge pulses once when it opens: a phase from 0 to 1 over 900 ms,
// or null when there is no pulse (never under reduced motion).
export const PULSE_MS = 900;
export function unlockPulse(unlockAt, now, reduced) {
  if (!unlockAt || reduced) return null;
  const t = (now - unlockAt) / PULSE_MS;
  return t >= 0 && t < 1 ? t : null;
}

// The largest size with the picture's aspect that fits a box.
export function fitSize(availW, availH, picW, picH) {
  const s = Math.max(0.05, Math.min(availW / picW, availH / picH));
  return { cssW: Math.floor(picW * s), cssH: Math.floor(picH * s), scale: Math.floor(picW * s) / picW };
}

function ringsPath(rings) {
  const p = new Path2D();
  for (const r of rings) {
    if (!r.length) continue;
    p.moveTo(r[0][0], r[0][1]);
    for (let i = 1; i < r.length; i++) p.lineTo(r[i][0], r[i][1]);
    p.closePath();
  }
  return p;
}

// Seen from above: the body disc (inset so its outline stays inside it).
function explorerPathAbove(L, feet) {
  const p = new Path2D();
  p.arc(feet[0], feet[1], 0.86 * bodyRadius(L), 0, Math.PI * 2);
  p.closePath();
  return p;
}

function explorerPath(L, feet, bob) {
  const h = 0.05 * L, w = 0.032 * L;
  const [fx, fy] = feet;
  const top = fy - h * 0.6 + bob;
  const p = new Path2D();
  const rw = w / 2;
  // body: a rounded capsule standing on the feet
  p.moveTo(fx - rw, fy - rw * 0.6);
  p.lineTo(fx - rw, top + rw * 0.5);
  p.quadraticCurveTo(fx - rw, top, fx, top);
  p.quadraticCurveTo(fx + rw, top, fx + rw, top + rw * 0.5);
  p.lineTo(fx + rw, fy - rw * 0.6);
  p.quadraticCurveTo(fx + rw, fy, fx, fy);
  p.quadraticCurveTo(fx - rw, fy, fx - rw, fy - rw * 0.6);
  p.closePath();
  // head
  const hr = w * 0.42;
  p.moveTo(fx + hr, top - hr * 0.55);
  p.arc(fx, top - hr * 0.55, hr, 0, Math.PI * 2);
  p.closePath();
  return p;
}

export class Renderer {
  constructor(canvas, picture, level, rt) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.picture = picture;
    this.level = level;
    this.rt = rt;
    this.L = Math.max(level.picture.width, level.picture.height);
    this.paths = level.objects.map((o) => ringsPath(o.outline.rings));
    this.footPaths = level.objects.map((o) => (o.footprint ? ringsPath(o.footprint.rings) : null));
    this.boxes = level.objects.map((o) => bounds(o.outline.rings));
    this.stamp = level.origin === 'mock' ? stampRect({ width: level.picture.width, height: level.picture.height, objects: level.objects.map((o, k) => ({ bounds: this.boxes[k] })) }) : null;
    this.scale = 1;
    this.dpr = 1;
    this.wallsImage = null;
    this.floorPath = hasFloor(level) ? ringsPath(level.surface.rings) : null;
  }

  drawFloor() {
    const { ctx, level } = this;
    if (!this.floorPath) return;
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = FLOOR_STYLE.under;
    ctx.lineWidth = this.px(4.5);
    ctx.stroke(this.floorPath);
    ctx.strokeStyle = FLOOR_STYLE.edge;
    ctx.lineWidth = this.px(2);
    ctx.stroke(this.floorPath);
    for (const d of level.surface.doorways) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, Math.max(this.px(6), d.width / 2), 0, Math.PI * 2);
      ctx.fillStyle = FLOOR_STYLE.doorFill;
      ctx.fill();
      ctx.strokeStyle = FLOOR_STYLE.door;
      ctx.lineWidth = this.px(2.5);
      ctx.setLineDash([this.px(6), this.px(4)]);
      ctx.stroke();
    }
    ctx.restore();
  }

  resize(cssW, cssH, dpr) {
    this.dpr = dpr;
    this.scale = cssW / this.level.picture.width;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
  }

  // Client (CSS pixel) coordinates to picture pixels.
  toPicture(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return [((clientX - r.left) / r.width) * this.level.picture.width, ((clientY - r.top) / r.height) * this.level.picture.height];
  }

  px(n) { return n / this.scale; } // CSS pixels to picture pixels

  wallsOverlay() {
    if (this.wallsImage) return this.wallsImage;
    const nav = this.rt.nav;
    const c = document.createElement('canvas');
    c.width = nav.gw; c.height = nav.gh;
    const g = c.getContext('2d');
    const img = g.createImageData(nav.gw, nav.gh);
    for (let i = 0; i < nav.pass.length; i++) {
      const o = i * 4;
      if (nav.pass[i]) { img.data[o] = 60; img.data[o + 1] = 200; img.data[o + 2] = 255; img.data[o + 3] = 46; }
      else { img.data[o] = 255; img.data[o + 1] = 70; img.data[o + 2] = 90; img.data[o + 3] = 110; }
    }
    g.putImageData(img, 0, 0);
    this.wallsImage = c;
    return c;
  }

  draw(state, ui = {}) {
    const { ctx, level, L } = this;
    const k = this.dpr * this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (!state) state = { pos: [-1000, -1000], facing: [0, 1], collected: [], doorOpen: false, auto: null, tick: 0 };
    const feet = state.pos;
    const reduced = !!ui.reducedMotion;
    const bob = state.moving && !reduced ? Math.sin((state.tick || 0) * 0.45) * 0.0035 * L : 0;
    const above = level.view === 'top_down';
    const body = above ? explorerPathAbove(L, feet) : explorerPath(L, feet, bob);
    const plan = drawPlan(level, feet, { outlines: ui.outlines !== false, walls: !!ui.walls, explorer: !ui.reveal, riddle: !!(ui.riddle && ui.riddle.marks.length) });
    for (const step of plan) {
      switch (step.op) {
        case 'picture':
          if (ui.dim) ctx.globalAlpha = 0.72;
          ctx.drawImage(this.picture, 0, 0, level.picture.width, level.picture.height);
          ctx.globalAlpha = 1;
          break;
        case 'walls': {
          ctx.save();
          ctx.imageSmoothingEnabled = false;
          const nav = this.rt.nav;
          ctx.drawImage(this.wallsOverlay(), 0, 0, nav.gw * nav.cell, nav.gh * nav.cell);
          ctx.restore();
          break;
        }
        case 'floor': this.drawFloor(); break;
        case 'halos': this.drawHalos(ui); break;
        case 'path': this.drawPath(state, ui); break;
        case 'shadow':
          ctx.save();
          ctx.fillStyle = 'rgba(0,0,0,0.32)';
          ctx.beginPath();
          if (above) ctx.arc(feet[0], feet[1], bodyRadius(L), 0, Math.PI * 2);
          else ctx.ellipse(feet[0], feet[1], 0.019 * L, 0.006 * L, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        case 'explorer': this.drawExplorer(body, feet, state, ui); break;
        case 'repaint':
          ctx.save();
          ctx.clip(this.paths[step.k], 'evenodd');
          if (ui.dim) ctx.globalAlpha = 0.72;
          ctx.drawImage(this.picture, 0, 0, level.picture.width, level.picture.height);
          ctx.restore();
          break;
        case 'xray':
          for (const kk of step.ks) {
            ctx.save();
            ctx.clip(this.paths[kk], 'evenodd');
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = '#7ff3e4';
            ctx.fill(body, 'nonzero');
            ctx.globalAlpha = 0.9;
            ctx.lineWidth = this.px(1.5);
            ctx.strokeStyle = '#ffffff';
            ctx.setLineDash([this.px(3), this.px(2)]);
            ctx.stroke(body);
            ctx.restore();
          }
          break;
        case 'outlines': this.drawOutlines(state, ui); break;
        case 'badges': this.drawBadges(state, ui); break;
        case 'numbers': this.drawNumbers(ui); break;
        case 'route': this.drawRoute(); break;
        case 'riddle': this.drawRiddle(ui.riddle, ui); break;
        case 'marker': this.drawMarker(ui); break;
        case 'stamp': this.drawStamp(); break;
        default: break;
      }
    }
  }

  drawExplorer(body, feet, state, ui) {
    const { ctx, L } = this;
    ctx.save();
    if (this.level.view === 'top_down') {
      // nothing drawn past the body disc, however thick the outline
      ctx.beginPath();
      ctx.arc(feet[0], feet[1], bodyRadius(L), 0, Math.PI * 2);
      ctx.clip();
    }
    ctx.fillStyle = ui.highContrast ? '#00e5cc' : '#22b8a8';
    ctx.fill(body, 'nonzero');
    ctx.lineWidth = this.px(ui.highContrast ? 2.5 : 1.75);
    ctx.strokeStyle = '#0a2422';
    ctx.stroke(body);
    // face: a light visor with two eyes looking where it walks
    if (this.level.view === 'top_down') {
      // from above, the visor sits inside the disc on the side it faces
      const r = bodyRadius(L);
      const [fx, fy] = state.facing;
      const vx = feet[0] + fx * r * 0.42, vy = feet[1] + fy * r * 0.42;
      const a = Math.atan2(fy, fx) + Math.PI / 2;
      ctx.fillStyle = '#f7f4ec';
      ctx.beginPath();
      ctx.ellipse(vx, vy, r * 0.5, r * 0.26, a, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#10201f';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(vx + Math.cos(a) * s * r * 0.22, vy + Math.sin(a) * s * r * 0.22, r * 0.09, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    const w = 0.032 * L, h = 0.05 * L;
    const bob = state.moving && !ui.reducedMotion ? Math.sin((state.tick || 0) * 0.45) * 0.0035 * L : 0;
    const top = feet[1] - h * 0.6 + bob;
    const hr = w * 0.42;
    const cx = feet[0] + state.facing[0] * hr * 0.25;
    const cy = top - hr * 0.55 + Math.max(0, state.facing[1]) * hr * 0.12;
    ctx.fillStyle = '#f7f4ec';
    ctx.beginPath();
    ctx.ellipse(cx, cy, hr * 0.72, hr * 0.48, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#10201f';
    const ex = state.facing[0] * hr * 0.18;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + s * hr * 0.3 + ex, cy, hr * 0.11, hr * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawPath(state, ui) {
    const { ctx } = this;
    if (!state.auto) return;
    const pts = [state.pos, ...state.auto.points.slice(state.auto.i)];
    if (pts.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = 'rgba(10,20,20,0.55)';
    ctx.lineWidth = this.px(5);
    ctx.stroke();
    ctx.strokeStyle = ui.highContrast ? '#ffffff' : 'rgba(255,255,255,0.92)';
    ctx.lineWidth = this.px(2.25);
    ctx.setLineDash(ui.reducedMotion ? [this.px(6), this.px(5)] : [this.px(6), this.px(5)]);
    ctx.lineDashOffset = ui.reducedMotion ? 0 : -((state.tick || 0) * 0.4) / this.scale;
    ctx.stroke();
    ctx.restore();
  }

  drawHalos(ui) {
    const { ctx, level, rt } = this;
    const reach = rt.p.radius + rt.p.hazardMargin;
    level.objects.forEach((o, k) => {
      if (o.role !== 'avoid' || !this.footPaths[k]) return;
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2 * reach;
      ctx.strokeStyle = ui.highContrast ? 'rgba(255,60,60,0.45)' : 'rgba(255,70,70,0.22)';
      ctx.stroke(this.footPaths[k]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill(this.footPaths[k], 'evenodd');
      ctx.restore();
    });
  }

  drawNumbers(ui) {
    const { ctx, level } = this;
    if (this.spotsScale !== this.scale) { this.numbers = numberSpots(level, this.scale); this.spotsScale = this.scale; }
    if (!this.numbers) return;
    const { r, rCss, spots } = this.numbers;
    const count = ui.outlineCount ?? level.objects.length;
    spots.forEach((s, k) => {
      if (k >= count) return;
      const st = ROLE_STYLE[level.objects[k].role] || ROLE_STYLE.solid;
      ctx.save();
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ui.highContrast ? '#000000' : 'rgba(14,16,18,0.88)';
      ctx.fill();
      ctx.lineWidth = this.px(2);
      ctx.strokeStyle = level.objects[k].on_surface ? st.color : '#b9b3a8';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${this.px((13 * rCss) / 12)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(s.n), s.x, s.y + this.px(0.5));
      ctx.restore();
    });
  }

  drawRoute() {
    const { ctx, level } = this;
    const pts = (level.proof && level.proof.route) || [];
    if (pts.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = 'rgba(10,20,20,0.6)';
    ctx.lineWidth = this.px(5);
    ctx.stroke();
    ctx.strokeStyle = '#7ff3e4';
    ctx.lineWidth = this.px(2.5);
    ctx.setLineDash([this.px(7), this.px(5)]);
    ctx.stroke();
    ctx.restore();
  }

  drawOutlines(state, ui) {
    const { ctx, level } = this;
    const count = ui.outlineCount ?? level.objects.length;
    level.objects.forEach((o, k) => {
      if (k >= count) return;
      if (!o.on_surface && o.role !== 'flat') {
        // scenery is listed on the reveal, but never a wall: a faint line only
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([this.px(2), this.px(4)]);
        ctx.lineWidth = this.px(1);
        ctx.strokeStyle = '#f3efe6';
        ctx.stroke(this.paths[k]);
        ctx.restore();
        return;
      }
      const st = ROLE_STYLE[o.role];
      const done = o.role === 'collect' && state.collected && state.collected[k];
      const hc = ui.highContrast ? 1.6 : 1;
      ctx.save();
      ctx.lineJoin = 'round';
      if (done) ctx.globalAlpha = 0.4;
      ctx.setLineDash(st.dash.map((d) => this.px(d)));
      ctx.strokeStyle = 'rgba(12,14,16,0.85)';
      ctx.lineWidth = this.px((st.width + 2) * hc);
      ctx.stroke(this.paths[k]);
      ctx.strokeStyle = o.role === 'exit' && !state.doorOpen ? '#9fe3bd' : st.color;
      ctx.lineWidth = this.px(st.width * hc * 0.6);
      ctx.stroke(this.paths[k]);
      ctx.restore();
    });
  }

  badgePos(k) {
    const b = this.boxes[k];
    const r = this.px(12);
    let y = b.y0 - r - this.px(6);
    if (y - r < 0) y = b.y1 + r + this.px(6);
    const x = Math.min(Math.max((b.x0 + b.x1) / 2, r), this.level.picture.width - r);
    return [x, y, r];
  }

  drawBadges(state, ui) {
    const { ctx, level } = this;
    level.objects.forEach((o, k) => {
      const st = ROLE_STYLE[o.role];
      if (!st || !st.badge || !o.on_surface) return;
      const [x, y, r] = this.badgePos(k);
      const done = o.role === 'collect' && state.collected && state.collected[k];
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = ui.highContrast ? '#000000' : 'rgba(14,16,18,0.82)';
      ctx.fill();
      ctx.lineWidth = this.px(2);
      ctx.strokeStyle = st.color;
      ctx.stroke();
      ctx.fillStyle = st.color;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = this.px(1.75);
      ctx.lineJoin = 'round';
      const u = r * 0.55;
      if (done) {
        ctx.beginPath();
        ctx.moveTo(x - u * 0.8, y);
        ctx.lineTo(x - u * 0.2, y + u * 0.6);
        ctx.lineTo(x + u * 0.85, y - u * 0.6);
        ctx.stroke();
      } else if (st.badge === 'star') {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          const rr = i % 2 ? u * 0.45 : u;
          ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
      } else if (st.badge === 'warn') {
        ctx.beginPath();
        ctx.moveTo(x, y - u);
        ctx.lineTo(x + u, y + u * 0.8);
        ctx.lineTo(x - u, y + u * 0.8);
        ctx.closePath();
        ctx.stroke();
        ctx.fillRect(x - this.px(0.9), y - u * 0.35, this.px(1.8), u * 0.6);
        ctx.fillRect(x - this.px(0.9), y + u * 0.42, this.px(1.8), this.px(1.8));
      } else if (st.badge === 'door') {
        if (ui.pulse != null) {
          ctx.save();
          ctx.globalAlpha = 1 - ui.pulse;
          ctx.lineWidth = this.px(3);
          ctx.beginPath();
          ctx.arc(x, y, r * (1 + 1.4 * ui.pulse), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        if (state.doorOpen) {
          ctx.strokeRect(x - u * 0.55, y - u * 0.85, u * 1.1, u * 1.7);
          ctx.beginPath();
          ctx.moveTo(x - u * 0.55, y - u * 0.85);
          ctx.lineTo(x + u * 0.2, y - u * 0.6);
          ctx.lineTo(x + u * 0.2, y + u * 1.0);
          ctx.lineTo(x - u * 0.55, y + u * 0.85);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.strokeRect(x - u * 0.7, y - u * 0.05, u * 1.4, u * 1.0);
          ctx.beginPath();
          ctx.arc(x, y - u * 0.05, u * 0.45, Math.PI, 0);
          ctx.stroke();
        }
      }
      ctx.restore();
    });
  }

  // Ask the room. A right pick: the thing's own picture pixels drawn again
  // inside its outline (even-odd, so a mug handle's hole stays open),
  // brighter, pulsing three times over 1.2 s (a steady highlight with
  // reduced motion), then a gold edge and a check that stay. A wrong pick:
  // a red dashed edge and a cross for 1.2 s. Shape and line style differ,
  // so colour is never the only signal.
  drawRiddle(rd, ui) {
    const { ctx, level } = this;
    for (const m of rd.marks) {
      const path = this.paths[m.k];
      if (!path) continue;
      const age = rd.now - m.t;
      const wide = this.px(ui.highContrast ? 6 : 4.5), thin = this.px(ui.highContrast ? 3.5 : 2.5);
      if (m.kind === 'wrong') {
        if (age > 1200) continue;
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.setLineDash([this.px(6), this.px(4)]);
        ctx.strokeStyle = 'rgba(12,14,16,0.85)';
        ctx.lineWidth = wide;
        ctx.stroke(path);
        ctx.strokeStyle = '#ff5d5d';
        ctx.lineWidth = thin;
        ctx.stroke(path);
        ctx.restore();
        this.drawPickBadge(m.k, false, ui);
        continue;
      }
      if (age < (rd.reduced ? 1500 : 1200)) {
        ctx.save();
        ctx.clip(path, 'evenodd');
        ctx.globalAlpha = rd.reduced ? 1 : 0.55 + 0.45 * Math.abs(Math.sin((age / 1200) * Math.PI * 3));
        ctx.filter = 'brightness(1.35)';
        ctx.drawImage(this.picture, 0, 0, level.picture.width, level.picture.height);
        ctx.restore();
      }
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(12,14,16,0.85)';
      ctx.lineWidth = wide;
      ctx.stroke(path);
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = thin;
      ctx.stroke(path);
      ctx.restore();
      this.drawPickBadge(m.k, true, ui);
    }
  }

  drawPickBadge(k, right, ui) {
    const { ctx } = this;
    const [x, y, r] = this.badgePos(k);
    const u = r * 0.55;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = ui.highContrast ? '#000000' : 'rgba(14,16,18,0.88)';
    ctx.fill();
    ctx.lineWidth = this.px(2);
    ctx.strokeStyle = right ? '#ffd34d' : '#ff5d5d';
    ctx.stroke();
    ctx.lineWidth = this.px(2.25);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (right) {
      ctx.moveTo(x - u * 0.8, y);
      ctx.lineTo(x - u * 0.2, y + u * 0.6);
      ctx.lineTo(x + u * 0.85, y - u * 0.6);
    } else {
      ctx.moveTo(x - u * 0.6, y - u * 0.6); ctx.lineTo(x + u * 0.6, y + u * 0.6);
      ctx.moveTo(x + u * 0.6, y - u * 0.6); ctx.lineTo(x - u * 0.6, y + u * 0.6);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawMarker(ui) {
    const m = ui.marker;
    if (!m) return;
    const { ctx } = this;
    const r = this.px(9);
    ctx.save();
    ctx.lineWidth = this.px(2.5);
    ctx.strokeStyle = m.refused ? '#ff5d5d' : '#ffffff';
    ctx.beginPath();
    if (m.refused) {
      ctx.moveTo(m.x - r, m.y - r); ctx.lineTo(m.x + r, m.y + r);
      ctx.moveTo(m.x + r, m.y - r); ctx.lineTo(m.x - r, m.y + r);
    } else {
      ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawStamp() {
    const s = this.stamp;
    if (!s) return;
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(12,14,16,0.78)';
    const rr = s.font * 0.4;
    ctx.beginPath();
    ctx.roundRect(s.x, s.y, s.w, s.h, rr);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    let font = s.font;
    ctx.font = `700 ${font}px system-ui, sans-serif`;
    const widest = Math.max(...s.lines.map((t) => ctx.measureText(t).width));
    if (widest > s.w - s.font) {
      font = font * ((s.w - s.font) / widest);
      ctx.font = `700 ${font}px system-ui, sans-serif`;
    }
    s.lines.forEach((t, i) => ctx.fillText(t, s.x + s.font * 0.5, s.y + s.h * ((i + 1) / (s.lines.length + 1))));
    ctx.restore();
  }
}

// The picture as a canvas, from painter output or an image.
export function pictureFromRGBA(width, height, rgba) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return c;
}
