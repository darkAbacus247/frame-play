// The round: a fixed 60 Hz update, steering with sliding along the distance
// field, path following, collect / avoid / exit, win and loss, route length.
// Pure logic: the same inputs always give the same run.
import { sampleField, fieldGradient } from './distance.js';
import { findPath, gridDistances, cellOf, cellCenter, nearestPass } from './nav.js';
import { footDistance, objectWords, walledOff, bareNav } from './level.js';
import { pointInShape } from './geom.js';

export const HZ = 60;
export const DT = 1 / HZ;

export function createRound(level, rt) {
  const [x, y] = level.start;
  return {
    tick: 0,
    pos: [x, y],
    facing: [0, 1],
    moving: false,
    auto: null,
    collected: level.objects.map(() => false),
    doorOpen: false,
    status: 'playing',
    travelled: 0,
    stepAcc: 0,
    contact: null,
    lockedNear: false,
    lostTo: -1,
    goalsLeft: level.objects.filter((o) => o.role === 'collect').length,
  };
}

function field(rt, x, y) {
  return sampleField(rt.nav.field, rt.W, rt.H, x, y);
}

// One sub-step of at most half a cell, sliding along walls. Returns how far
// the explorer actually moved and whether a wall got in the way.
function subStep(rt, pos, sx, sy) {
  const r = rt.p.radius;
  const len = Math.hypot(sx, sy);
  let nx = pos[0] + sx, ny = pos[1] + sy;
  if (field(rt, nx, ny) >= r) {
    pos[0] = nx; pos[1] = ny;
    return { moved: len, blocked: false, stuck: false };
  }
  const [gx, gy] = fieldGradient(rt.nav.field, rt.W, rt.H, nx, ny);
  const dot = sx * gx + sy * gy;
  if (dot < 0) {
    nx = pos[0] + sx - dot * gx;
    ny = pos[1] + sy - dot * gy;
    const f = field(rt, nx, ny);
    if (f < r) {
      const [hx, hy] = fieldGradient(rt.nav.field, rt.W, rt.H, nx, ny);
      nx += hx * (r - f + 0.01);
      ny += hy * (r - f + 0.01);
    }
    const d = Math.hypot(nx - pos[0], ny - pos[1]);
    if (field(rt, nx, ny) >= r && d <= len * 1.5 && d > 1e-6) {
      pos[0] = nx; pos[1] = ny;
      return { moved: d, blocked: true, stuck: false };
    }
  }
  if (sx && field(rt, pos[0] + sx, pos[1]) >= r) {
    pos[0] += sx;
    return { moved: Math.abs(sx), blocked: true, stuck: false };
  }
  if (sy && field(rt, pos[0], pos[1] + sy) >= r) {
    pos[1] += sy;
    return { moved: Math.abs(sy), blocked: true, stuck: false };
  }
  return { moved: 0, blocked: true, stuck: true };
}

// Moves are split so no step is longer than half a cell: no tunneling.
export function moveWithCollision(rt, pos, dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { moved: 0, blocked: false, stuck: false };
  const n = Math.max(1, Math.ceil(len / (rt.nav.cell / 2)));
  let moved = 0, blocked = false, stuck = false;
  for (let i = 0; i < n; i++) {
    const s = subStep(rt, pos, dx / n, dy / n);
    moved += s.moved;
    if (s.blocked) blocked = true;
    if (s.stuck) { stuck = true; break; }
  }
  return { moved, blocked, stuck };
}

// What a bump was against: the nearest footprint, or the edge of the surface.
function blockerAt(level, rt, pos) {
  let best = -1, bd = Infinity;
  rt.objs.forEach((t, k) => {
    if (!t.footprint) return;
    const d = footDistance(t.footprint, pos[0], pos[1]);
    if (d < bd) { bd = d; best = k; }
  });
  return bd <= rt.p.radius + 3 ? best : -1;
}

// A bump with no thing near is the floor's edge; where the floor fences the
// play area (a floor drawn or traced, rooms seen from above), a wall.
export function blockedWords(level, k, surfaceName, wall = false) {
  if (k < 0) return wall ? 'Blocked by a wall' : `Blocked by the edge of the ${surfaceName || 'floor'}`;
  return `Blocked by the ${objectWords(level, k)}`;
}

const fenced = (rt) => !!rt.floor;
// Seen from above, the floor's edge is a wall between rooms.
const wallsAround = (level, rt) => fenced(rt) && level.view === 'top_down';

function checkTouches(state, level, rt, events) {
  const [x, y] = state.pos;
  const r = rt.p.radius;
  let nearExit = false;
  for (let k = 0; k < level.objects.length; k++) {
    const t = rt.objs[k];
    if (!t.footprint) continue;
    const o = level.objects[k];
    const d = footDistance(t.footprint, x, y);
    if (o.role === 'avoid' && d < r + rt.p.hazardMargin) {
      state.status = 'lost';
      state.lostTo = k;
      state.auto = null;
      events.push({ type: 'lose', k });
      return;
    }
    if (d > rt.p.touch) continue;
    if (o.role === 'collect' && !state.collected[k]) {
      state.collected[k] = true;
      state.goalsLeft--;
      events.push({ type: 'collect', k, left: state.goalsLeft });
      if (state.goalsLeft === 0 && !state.doorOpen) {
        state.doorOpen = true;
        events.push({ type: 'unlock' });
      }
    } else if (o.role === 'exit') {
      nearExit = true;
      if (state.doorOpen) {
        state.status = 'won';
        state.auto = null;
        events.push({ type: 'win', k, travelled: state.travelled });
        return;
      }
      if (!state.lockedNear) events.push({ type: 'locked', k, left: state.goalsLeft });
    }
  }
  state.lockedNear = nearExit;
}

// Advance one fixed step. input.dir is the steering vector (the keys or
// the pad); any steering cancels an auto-walk. Returns the events.
export function stepRound(state, level, rt, input = {}) {
  const events = [];
  if (state.status !== 'playing') return events;
  state.tick++;
  const speed = rt.p.speed * DT;
  const dir = input.dir || [0, 0];
  const dl = Math.hypot(dir[0], dir[1]);
  let moved = 0, blocked = false;
  if (dl > 0) {
    if (state.auto) { state.auto = null; events.push({ type: 'cancel' }); }
    const mx = (dir[0] / dl) * speed, my = (dir[1] / dl) * speed;
    const res = moveWithCollision(rt, state.pos, mx, my);
    moved = res.moved;
    blocked = res.blocked;
    state.facing = [dir[0] / dl, dir[1] / dl];
  } else if (state.auto) {
    let left = speed;
    while (left > 1e-9 && state.auto) {
      const a = state.auto;
      const [tx, ty] = a.points[a.i];
      const ddx = tx - state.pos[0], ddy = ty - state.pos[1];
      const dist = Math.hypot(ddx, ddy);
      if (dist > 1e-9) state.facing = [ddx / dist, ddy / dist];
      const go = Math.min(dist, left);
      const res = moveWithCollision(rt, state.pos, dist ? (ddx / dist) * go : 0, dist ? (ddy / dist) * go : 0);
      moved += res.moved;
      left -= go;
      if (res.stuck) {
        state.auto = null;
        blocked = true;
        events.push({ type: 'cancel' });
        break;
      }
      if (go >= dist - 1e-9 || Math.hypot(tx - state.pos[0], ty - state.pos[1]) < 0.05) {
        a.i++;
        if (a.i >= a.points.length) {
          state.auto = null;
          events.push({ type: 'arrive', k: a.k });
        }
      }
    }
  }
  state.moving = moved > 1e-6;
  state.travelled += moved;
  state.stepAcc += moved;
  const stride = 0.03 * rt.p.L;
  if (state.stepAcc >= stride) {
    state.stepAcc -= stride;
    events.push({ type: 'step' });
  }
  if (blocked) {
    const k = blockerAt(level, rt, state.pos);
    const key = `b${k}`;
    if (state.contact !== key) {
      state.contact = key;
      events.push(k < 0 && wallsAround(level, rt) ? { type: 'bump', k, wall: true } : { type: 'bump', k });
    }
  } else if (state.contact && field(rt, state.pos[0], state.pos[1]) > rt.p.radius + 2) {
    state.contact = null;
  }
  checkTouches(state, level, rt, events);
  return events;
}

// The object drawn at a point (nearest the camera first), or -1.
export function objectAt(level, rt, x, y) {
  let best = -1, by = -Infinity;
  level.objects.forEach((o, k) => {
    if (!o.on_surface) return;
    const b = rt.objs[k].b;
    if (!b || x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return;
    if (!pointInShape(x, y, o.outline.rings)) return;
    const base = o.baseline_y ?? b.y1;
    if (base > by) { by = base; best = k; }
  });
  return best;
}

// The hazard whose halo (as the planner sees it) holds a point, or -1.
export function inHazardHalo(level, rt, x, y) {
  const reach = rt.p.radius + rt.p.hazardMargin + rt.p.planExtra;
  let best = -1, bd = Infinity;
  level.objects.forEach((o, k) => {
    const t = rt.objs[k];
    if (o.role !== 'avoid' || !t.footprint) return;
    const d = footDistance(t.footprint, x, y);
    if (d < reach && d < bd) { bd = d; best = k; }
  });
  return best;
}

// at: the point tapped on the thing, or null: the place within reach of it
// nearest that point is walked to (else the one nearest along the way)
export function walkToObject(state, level, rt, k, at = null) {
  if (state.status !== 'playing') return { ok: false, reason: 'The round is over' };
  const o = level.objects[k];
  if (o.role === 'avoid') return { ok: false, reason: `Too close to the ${objectWords(level, k)}` };
  const ring = rt.rings[k] || [];
  if (!ring.length) return { ok: false, reason: `Can't reach the ${objectWords(level, k)}` };
  let s = cellOf(rt.nav, state.pos[0], state.pos[1]);
  if (!rt.nav.pass[s]) s = nearestPass(rt.nav, state.pos[0], state.pos[1]);
  if (s < 0) return { ok: false, reason: 'Nowhere to walk from here' };
  const d = gridDistances(rt.nav, [[s, 0]]);
  let best = -1, bd = Infinity;
  for (const c of ring) {
    if (d[c] === Infinity) continue;
    const [cx, cy] = at ? cellCenter(rt.nav, c) : [0, 0];
    const score = at ? Math.hypot(cx - at[0], cy - at[1]) : d[c];
    if (score < bd) { bd = score; best = c; }
  }
  if (best < 0) {
    if (walledOff(rt, k, rt.nav.comp[s])) return { ok: false, reason: `No doorway leads to the ${objectWords(level, k)}` };
    return { ok: false, reason: `Can't reach the ${objectWords(level, k)}` };
  }
  const res = findPath(rt.nav, state.pos[0], state.pos[1], ...cellCenter(rt.nav, best));
  if (!res) return { ok: false, reason: `Can't reach the ${objectWords(level, k)}` };
  state.auto = { points: res.points.slice(1), i: 0, k, length: res.length };
  if (!state.auto.points.length) state.auto = null;
  return { ok: true, path: res.points, k };
}

// Tap or click on the picture: an object walks to it, a point walks there.
// A solid thing is walked to on the side that was tapped: a tap on the far
// part of an island walks behind it, on the floor it hides.
export function walkToPoint(state, level, rt, x, y) {
  if (state.status !== 'playing') return { ok: false, reason: 'The round is over' };
  const k = objectAt(level, rt, x, y);
  if (k >= 0 && level.objects[k].role !== 'flat') return walkToObject(state, level, rt, k, level.objects[k].role === 'solid' ? [x, y] : null);
  const h = inHazardHalo(level, rt, x, y);
  if (h >= 0) return { ok: false, reason: `Too close to the ${objectWords(level, h)}` };
  // a point on the floor of a room no doorway leads to is not walked
  // toward (the nearest point this side of the wall is no answer)
  if (fenced(rt) && behindWalls(rt, state.pos, x, y)) return { ok: false, reason: 'No doorway leads there' };
  const res = findPath(rt.nav, state.pos[0], state.pos[1], x, y);
  if (!res) return { ok: false, reason: 'There is no way there' };
  state.auto = { points: res.points.slice(1), i: 0, k: -1, length: res.length };
  if (!state.auto.points.length) state.auto = null;
  return { ok: true, path: res.points, k: -1, snapped: res.snapped };
}

// Whether a point lies on floor that walls with no doorway keep the
// explorer from: the free cell nearest the point (within the explorer's
// reach of it, so a tap on a wall is still walked toward) cannot be reached
// even on the bare floor.
function behindWalls(rt, pos, x, y) {
  const nav = rt.nav;
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= rt.W || yi >= rt.H || !rt.floor[yi * rt.W + xi]) return false;
  let s = cellOf(nav, pos[0], pos[1]);
  if (!nav.pass[s]) s = nearestPass(nav, pos[0], pos[1]);
  if (s < 0) return false;
  let g = cellOf(nav, x, y);
  if (!nav.pass[g]) {
    g = nearestPass(nav, x, y);
    if (g < 0) return false;
    const [gx, gy] = cellCenter(nav, g);
    if (Math.hypot(gx - x, gy - y) > 2 * nav.planRadius + nav.cell) return false;
  }
  if (nav.comp[g] === nav.comp[s]) return false;
  // things standing in the way are not walls: the nearest point is walked to
  const bare = bareNav(rt);
  return !!bare.comp[g] && !!bare.comp[s] && bare.comp[g] !== bare.comp[s];
}

// The next goal: the first uncollected collectible in the proof's order,
// then the exit.
export function nextGoal(state, level) {
  const order = (level.proof && level.proof.order) || [];
  for (const id of order) {
    const k = level.objects.findIndex((o) => o.id === id);
    if (k >= 0 && level.objects[k].role === 'collect' && !state.collected[k]) return k;
  }
  return level.objects.findIndex((o) => o.role === 'exit');
}

export function routeRatio(state, level) {
  const best = level.proof && level.proof.route_length;
  if (!best) return null;
  return Math.max(1, Math.round((state.travelled / best) * 10) / 10);
}
