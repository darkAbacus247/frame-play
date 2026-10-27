// The level: footprints, baselines, the walk region, the start, the proof
// that the room can be won, the ordered repairs code may make (each one
// listed), and validation. Pure logic: no page, no canvas.
import { fillRings, maskBounds, traceMaskInBounds } from './raster.js';
import { ringsInside } from './geom.js';
import { navParams, buildNav, gridDistances, cellCenter, findPath } from './nav.js';

export const LEVEL_SCHEMA = 'frameplay.level/2';
export const ORIGINS = ['mock', 'live', 'rehearsal'];
export const LABELS = {
  mock: 'Sample room · MOCK · drawn by code; no model was called',
  live: 'LIVE · Meta Model API · muse-spark-1.3 and sam-3.1',
  rehearsal: 'REHEARSAL · local stand-in, not Meta',
};
export const ROLES = ['collect', 'avoid', 'exit', 'solid', 'flat'];
export const OUTLINE_SOURCES = ['exact', 'sam_mask', 'traced_in_box', 'box'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Words for one object, such as "coin 2" when there are several coins.
export function objectWords(level, k) {
  const o = level.objects[k];
  const same = level.objects.filter((x) => x.name === o.name).length;
  return same > 1 ? `${o.name} ${o.instance}` : o.name;
}

function boundaryInBox(mask, W, b) {
  const out = [];
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      if (x === b.x0 || y === b.y0 || x === b.x1 - 1 || y === b.y1 - 1 ||
          !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W]) out.push(x + 0.5, y + 0.5);
    }
  }
  return Float64Array.from(out);
}

// Distance from a point to the nearest footprint pixel centre.
export function footDistance(fp, x, y) {
  const b = fp.boundary;
  let best = Infinity;
  for (let i = 0; i < b.length; i += 2) {
    const dx = b[i] - x, dy = b[i + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// Everything the game needs at run time, recomputed from the outlines and
// roles (a stored proof is never trusted).
export function prepare(level, opts = {}) {
  const W = level.picture.width, H = level.picture.height;
  const p = navParams(W, H);
  if (level.nav && typeof level.nav.hazard_margin === 'number') p.hazardMargin = level.nav.hazard_margin;
  const L = p.L;
  const objs = level.objects.map((o) => {
    const mask = fillRings(o.outline.rings, W, H);
    return { mask, b: maskBounds(mask, W, H), footprint: null };
  });
  for (let k = 0; k < objs.length; k++) {
    const t = objs[k], o = level.objects[k];
    if (!t.b || !o.on_surface || o.role === 'flat') continue;
    const width = t.b.x1 - t.b.x0, height = t.b.y1 - t.b.y0;
    const depth = Math.max(0.006 * L, Math.min(0.22 * width, 0.5 * height));
    const yTop = t.b.y1 - depth;
    const fp = new Uint8Array(W * H);
    let area = 0;
    for (let y = Math.max(t.b.y0, Math.floor(yTop - 0.5)); y < t.b.y1; y++) {
      if (y + 0.5 < yTop) continue;
      for (let x = t.b.x0; x < t.b.x1; x++) {
        const i = y * W + x;
        if (t.mask[i]) { fp[i] = 1; area++; }
      }
    }
    if (!area) continue;
    const fb = maskBounds(fp, W, H);
    t.footprint = { mask: fp, depth, baseline: t.b.y1, top: yTop, bounds: fb, boundary: boundaryInBox(fp, W, fb), area };
  }
  let surfaceMask = null, horizon;
  if (level.surface && level.surface.rings && level.surface.rings.length) {
    surfaceMask = fillRings(level.surface.rings, W, H);
    const sb = maskBounds(surfaceMask, W, H);
    horizon = sb ? sb.y0 : 0.5 * H;
  } else {
    let top = Infinity;
    for (const t of objs) if (t.footprint && t.footprint.top < top) top = t.footprint.top;
    horizon = (top < Infinity ? top : 0.5 * H) - 0.03 * L;
  }
  horizon = clamp(horizon, 0.12 * H, 0.75 * H);

  const walk = surfaceMask ? surfaceMask.slice() : new Uint8Array(W * H).fill(1);
  for (let k = 0; k < objs.length; k++) {
    const t = objs[k];
    if (!level.objects[k].on_surface || !t.b) continue;
    for (let y = t.b.y0; y < t.b.y1; y++) {
      for (let x = t.b.x0; x < t.b.x1; x++) {
        const i = y * W + x;
        if (t.mask[i]) walk[i] = 1;
      }
    }
  }
  for (let y = 0; y < H; y++) {
    if (y + 0.5 >= horizon) break;
    walk.fill(0, y * W, (y + 1) * W);
  }
  const hazard = new Uint8Array(W * H);
  let anyHazard = false;
  for (let k = 0; k < objs.length; k++) {
    const fp = objs[k].footprint;
    if (!fp) continue;
    const isHazard = level.objects[k].role === 'avoid' && !opts.ignoreHazards;
    const b = fp.bounds;
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) {
        const i = y * W + x;
        if (fp.mask[i]) {
          walk[i] = 0;
          if (isHazard) { hazard[i] = 1; anyHazard = true; }
        }
      }
    }
  }
  for (let x = 0; x < W; x++) { walk[x] = 0; walk[(H - 1) * W + x] = 0; }
  for (let y = 0; y < H; y++) { walk[y * W] = 0; walk[y * W + W - 1] = 0; }

  const nav = buildNav(walk, anyHazard ? hazard : null, W, H, p);

  // touch rings: free cells close enough to a footprint to touch it
  const rings = objs.map((t) => {
    const fp = t.footprint;
    if (!fp) return [];
    const r = [];
    const reach = p.touch;
    const c = nav.cell;
    const i0 = Math.max(0, Math.floor((fp.bounds.x0 - reach) / c));
    const i1 = Math.min(nav.gw - 1, Math.floor((fp.bounds.x1 + reach) / c));
    const j0 = Math.max(0, Math.floor((fp.bounds.y0 - reach) / c));
    const j1 = Math.min(nav.gh - 1, Math.floor((fp.bounds.y1 + reach) / c));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = j * nav.gw + i;
        if (!nav.pass[cell]) continue;
        if (footDistance(fp, (i + 0.5) * c, (j + 0.5) * c) <= reach - 0.5) r.push(cell);
      }
    }
    return r;
  });
  return { W, H, p, objs, walk, hazard: anyHazard ? hazard : null, nav, horizon, rings };
}

function roleIndexes(level, role) {
  const out = [];
  level.objects.forEach((o, k) => { if (o.role === role) out.push(k); });
  return out;
}

export function targetIndexes(level) {
  return [...roleIndexes(level, 'collect'), ...roleIndexes(level, 'exit')];
}

export function ringReachable(rt, k, comp) {
  return comp > 0 && rt.rings[k].some((c) => rt.nav.comp[c] === comp);
}

// The start: a free cell in the lowest fifth of the walk region, nearest the
// horizontal centre, from which every target can be reached (or the most).
export function chooseStart(level, rt) {
  const { nav, W } = rt;
  const wb = maskBounds(rt.walk, rt.W, rt.H);
  if (!wb) return -1;
  const yMin = wb.y1 - (wb.y1 - wb.y0) / 5;
  const inRing = new Uint8Array(nav.pass.length);
  for (const r of rt.rings) for (const c of r) inRing[c] = 1;
  const targets = targetIndexes(level);
  const compScore = new Map();
  const score = (comp) => {
    if (!compScore.has(comp)) compScore.set(comp, targets.filter((k) => ringReachable(rt, k, comp)).length);
    return compScore.get(comp);
  };
  const pick = (lowOnly) => {
    const cands = [];
    for (let c = 0; c < nav.pass.length; c++) {
      if (!nav.pass[c] || inRing[c]) continue;
      const [x, y] = cellCenter(nav, c);
      if (lowOnly && y < yMin) continue;
      cands.push([Math.abs(x - W / 2), -y, c]);
    }
    cands.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    let best = -1, bestScore = -1;
    for (const [, , c] of cands) {
      const s = score(nav.comp[c]);
      if (s === targets.length) return c;
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return best;
  };
  const low = pick(true);
  if (low >= 0 && score(nav.comp[low]) === targets.length) return low;
  const any = pick(false);
  if (low < 0) return any;
  return score(nav.comp[any]) > score(nav.comp[low]) ? any : low;
}

function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((x, i) => {
    for (const rest of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

// The proof: every collectible and the exit can be reached from the start,
// and the shortest route that collects everything and then exits.
export function proveLevel(level, rt, start) {
  const collect = roleIndexes(level, 'collect');
  const exits = roleIndexes(level, 'exit');
  const fail = (why) => ({ winnable: false, route_length: null, order: [], route: [], why });
  if (exits.length !== 1) return fail('There must be exactly one exit');
  if (!collect.length) return fail('There is nothing to collect');
  if (start < 0) return fail('There is nowhere to start');
  const comp = rt.nav.comp[start];
  const exit = exits[0];
  const unreachable = [...collect, exit].filter((k) => !ringReachable(rt, k, comp));
  if (unreachable.length) {
    return fail(`Out of reach: ${unreachable.map((k) => objectWords(level, k)).join(', ')}`);
  }
  const nav = rt.nav;
  const ringSeeds = (k, base) => rt.rings[k].map((c) => [c, base ? base[c] : 0]);
  const fields = new Map();
  for (const k of [...collect, exit]) fields.set(k, gridDistances(nav, ringSeeds(k)));
  const setDist = (a, b) => {
    const f = fields.get(b);
    let best = Infinity;
    for (const c of rt.rings[a]) if (f[c] < best) best = f[c];
    return best;
  };
  let bestOrder = null, bestCost = Infinity;
  const evalOrder = (ord) => {
    let cost = fields.get(ord[0])[start];
    for (let i = 1; i < ord.length; i++) cost += setDist(ord[i - 1], ord[i]);
    return cost + setDist(ord[ord.length - 1], exit);
  };
  if (collect.length <= 7) {
    for (const ord of permutations(collect)) {
      const cost = evalOrder(ord);
      if (cost < bestCost - 1e-9) { bestCost = cost; bestOrder = ord; }
    }
  } else {
    const left = collect.slice();
    const ord = [];
    let cur = -1;
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((k, i) => {
        const d = cur < 0 ? fields.get(k)[start] : setDist(cur, k);
        if (d < bd) { bd = d; bi = i; }
      });
      cur = left.splice(bi, 1)[0];
      ord.push(cur);
    }
    bestOrder = ord;
  }
  // chained distances along the chosen order give the touch point on each
  // ring: stage s holds the cost of having touched targets 0..s, ending at
  // any cell, and which cell of target s's ring that came through
  const N = nav.gw * nav.gh;
  const stages = [];
  let prev = gridDistances(nav, [[start, 0]]);
  for (const k of bestOrder) {
    const src = new Int32Array(N);
    const d = gridDistances(nav, ringSeeds(k, prev), src);
    stages.push({ k, d, src });
    prev = d;
  }
  let endCell = -1, endCost = Infinity;
  for (const c of rt.rings[exit]) if (prev[c] < endCost) { endCost = prev[c]; endCell = c; }
  if (endCell < 0) return fail('The exit cannot be reached after collecting');
  const touches = [endCell];
  for (let s = stages.length - 1; s >= 0; s--) touches.unshift(stages[s].src[touches[0]]);
  const route = [];
  let [cx, cy] = cellCenter(nav, start);
  route.push([cx, cy]);
  let length = 0;
  for (const c of touches) {
    const res = findPath(nav, cx, cy, ...cellCenter(nav, c));
    if (!res) return fail('A route could not be traced');
    length += res.length;
    for (let i = 1; i < res.points.length; i++) route.push(res.points[i]);
    [cx, cy] = cellCenter(nav, c);
  }
  return {
    winnable: true,
    route_length: Math.round(length),
    order: [...bestOrder, exit].map((k) => level.objects[k].id),
    route: route.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
  };
}

function areaOf(rt, k) {
  const b = rt.objs[k].b;
  if (!b) return 0;
  let n = 0;
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) if (rt.objs[k].mask[y * rt.W + x]) n++;
  return n;
}

// The reachable object of one role farthest from the start (by walking distance).
function farthestOf(level, rt, start, role) {
  if (start < 0) return -1;
  const d = gridDistances(rt.nav, [[start, 0]]);
  let best = -1, bd = -1;
  level.objects.forEach((o, k) => {
    if (o.role !== role || !rt.objs[k].footprint) return;
    let m = Infinity;
    for (const c of rt.rings[k]) if (d[c] < m) m = d[c];
    if (m < Infinity && m > bd) { bd = m; best = k; }
  });
  return best;
}

// The room as it would be with no hazards: whether a hazard itself can be
// reached is judged without its own halo.
function hazardFree(level) {
  const rt = prepare(level, { ignoreHazards: true });
  return { rt, start: chooseStart(level, rt) };
}

// Who can become the exit: a solid object, else a collectible (only when
// another one stays to be collected), else a hazard; the farthest reachable.
function exitCandidate(level, rt, start) {
  let k = farthestOf(level, rt, start, 'solid');
  if (k < 0 && roleIndexes(level, 'collect').length >= 2) k = farthestOf(level, rt, start, 'collect');
  if (k < 0 && roleIndexes(level, 'avoid').length) {
    const free = hazardFree(level);
    k = farthestOf(level, free.rt, free.start, 'avoid');
  }
  return k;
}

const nameList = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// Why no level could be made, in words a person understands, naming what was
// found and what is missing.
function noLevelWords(level, rt, start, proof) {
  const surface = (level.surface && level.surface.name) || 'floor';
  const the = (k) => `the ${objectWords(level, k)}`;
  const standing = [], elsewhere = [];
  level.objects.forEach((o, k) => (rt.objs[k].footprint ? standing : elsewhere).push(k));
  const also = elsewhere.length ? ` Also found, but not standing on it: ${nameList(elsewhere.map(the))}.` : '';
  const advice = 'A game needs an exit and at least one thing to collect, so try a photo with three or more separate objects on a floor or desk.';
  const roomier = `Try a photo with more open ${surface} around the objects.`;
  const comp = start >= 0 ? rt.nav.comp[start] : 0;
  const cut = standing.filter((k) => level.objects[k].role !== 'avoid' && !ringReachable(rt, k, comp));
  const rest = standing.filter((k) => !cut.includes(k));
  let why;
  if (!standing.length) {
    why = `Nothing was found standing on the ${surface}.${also} ${advice}`;
  } else if (standing.length === 1) {
    why = `Only one thing was found standing on the ${surface} (${the(standing[0])}).${also} ${advice}`;
  } else if (start < 0) {
    why = `There is no open ${surface} to start on: the things found cover it. ${roomier}`;
  } else if (cut.length) {
    const alone = rest.length === 1 ? `, and ${the(rest[0])} alone cannot be both the exit and a thing to collect` : '';
    why = `The explorer cannot walk to ${nameList(cut.map(the))} on the ${surface}${alone}. ${roomier}`;
  } else {
    why = `${proof.why}.`;
  }
  return `No level from this picture: ${why}`;
}

// Build a level from the read of a room (sample or live): footprints, the
// walk region, ordered repairs (each listed), the start and the proof.
// Returns { level, rt } or { error } in words.
export function buildLevel(input) {
  const level = normalizeInput(input);
  const changes = level.changes_by_code;
  const say = (what, why) => changes.push({ what, why });
  let rt = prepare(level);

  // a single exit: keep the first one, the rest become solid
  let exits = roleIndexes(level, 'exit').filter((k) => rt.objs[k].footprint);
  for (const k of roleIndexes(level, 'exit')) {
    if (!rt.objs[k].footprint) { level.objects[k].role = 'solid'; say(`The ${objectWords(level, k)} is no longer the exit`, 'It does not stand on the play surface'); }
  }
  for (const k of exits.slice(1)) {
    level.objects[k].role = 'solid';
    say(`The ${objectWords(level, k)} is solid`, 'A room has exactly one exit');
  }
  exits = roleIndexes(level, 'exit');
  for (const k of roleIndexes(level, 'collect')) {
    if (!rt.objs[k].footprint) { level.objects[k].role = 'solid'; say(`The ${objectWords(level, k)} is not a collectible`, 'It does not stand on the play surface'); }
  }

  // a hazard given another role changes the hazard mask: prepare again
  const takeRole = (k, role) => {
    const wasHazard = level.objects[k].role === 'avoid';
    level.objects[k].role = role;
    if (wasHazard) rt = prepare(level);
  };

  // 1. no exit: the reachable object farthest along the way becomes the exit
  let start = chooseStart(level, rt);
  if (!exits.length) {
    const k = exitCandidate(level, rt, start);
    if (k >= 0) {
      takeRole(k, 'exit');
      say(`The ${objectWords(level, k)} became the exit`, 'No exit was found');
      start = chooseStart(level, rt);
    }
  }

  // hazards whose halo cuts the way: the margin goes to zero. A zero margin
  // makes the halo coincide with the wall clearance every footprint already
  // has, so it always restores the ways the halo alone was cutting; making
  // the hazard solid would change nothing more for the planner.
  const unreachableNow = () => {
    const comp = start >= 0 ? rt.nav.comp[start] : 0;
    return targetIndexes(level).filter((k) => !ringReachable(rt, k, comp));
  };
  if (unreachableNow().length && roleIndexes(level, 'avoid').length) {
    const free = prepare(level, { ignoreHazards: true });
    const fs = chooseStart(level, free);
    const before = unreachableNow().length;
    const without = targetIndexes(level).filter((k) => !ringReachable(free, k, fs >= 0 ? free.nav.comp[fs] : 0)).length;
    if (without < before) {
      const names = roleIndexes(level, 'avoid').map((k) => objectWords(level, k)).join(' and ');
      level.nav.hazard_margin = 0;
      say(`The ${names} danger zone shrank to its edge`, 'Its halo cut off the way to a goal');
      rt = prepare(level);
      start = chooseStart(level, rt);
    }
  }

  // 2. the exit cannot be reached: the farthest reachable object takes over
  const exitK = roleIndexes(level, 'exit')[0];
  if (exitK !== undefined && !ringReachable(rt, exitK, start >= 0 ? rt.nav.comp[start] : 0)) {
    const k = exitCandidate(level, rt, start);
    if (k >= 0) {
      level.objects[exitK].role = 'solid';
      takeRole(k, 'exit');
      say(`The ${objectWords(level, k)} became the exit`, `The ${objectWords(level, exitK)} cannot be reached`);
      start = chooseStart(level, rt);
    }
  }

  // 3. collectibles out of reach become solid
  const comp = () => (start >= 0 ? rt.nav.comp[start] : 0);
  for (const k of roleIndexes(level, 'collect')) {
    if (!ringReachable(rt, k, comp())) {
      level.objects[k].role = 'solid';
      say(`The ${objectWords(level, k)} is solid`, 'Out of reach');
    }
  }
  start = chooseStart(level, rt);

  // 4. nothing to collect: the two smallest reachable solid objects, else
  // the smallest reachable hazards
  if (!roleIndexes(level, 'collect').length) {
    const smallest = (ks) => ks.sort((a, b) => areaOf(rt, a) - areaOf(rt, b) || a - b);
    const cands = smallest(roleIndexes(level, 'solid').filter((k) => rt.objs[k].footprint && ringReachable(rt, k, comp())));
    if (cands.length < 2 && roleIndexes(level, 'avoid').length) {
      const free = hazardFree(level);
      const fc = free.start >= 0 ? free.rt.nav.comp[free.start] : 0;
      cands.push(...smallest(roleIndexes(level, 'avoid').filter((k) => rt.objs[k].footprint && ringReachable(free.rt, k, fc))));
    }
    for (const k of cands.slice(0, 2)) {
      takeRole(k, 'collect');
      say(`The ${objectWords(level, k)} became a collectible`, 'Nothing else could be collected');
    }
    start = chooseStart(level, rt);
  }

  const proof = proveLevel(level, rt, start);
  if (!proof.winnable) return { error: noLevelWords(level, rt, start, proof) };
  finishLevel(level, rt, start, proof);
  return { level, rt };
}

function normalizeInput(input) {
  const objects = input.objects.map((o, k) => ({
    id: String(o.id ?? `obj${k + 1}`),
    name: String(o.name),
    instance: o.instance ?? 1,
    role: o.role,
    reason: o.reason ?? '',
    box: o.box ?? null,
    confidence: o.confidence ?? null,
    outline: { source: o.outline.source, rings: o.outline.rings },
    footprint: null,
    baseline_y: null,
    on_surface: o.on_surface !== false,
  }));
  const origin = input.origin;
  return {
    schema: LEVEL_SCHEMA,
    origin,
    label: LABELS[origin],
    picture: { ...input.picture },
    title: input.title ?? '',
    theme_line: input.theme_line ?? '',
    surface: input.surface ? { name: input.surface.name, rings: input.surface.rings, source: input.surface.source, horizon_y: null } : null,
    objects,
    rules: { collect: [], avoid: [], exit: null },
    start: null,
    nav: { cell: null, radius: null, hazard_margin: null },
    proof: null,
    changes_by_code: [],
    provenance: {
      models: (input.provenance && input.provenance.models) || [],
      request_id: (input.provenance && input.provenance.request_id) || null,
      created: (input.provenance && input.provenance.created) || new Date().toISOString(),
      outline_sources: {},
    },
  };
}

function finishLevel(level, rt, start, proof) {
  const r1 = (v) => Math.round(v * 100) / 100;
  level.objects.forEach((o, k) => {
    const t = rt.objs[k];
    if (!o.box && t.b) o.box = [t.b.x0, t.b.y0, t.b.x1, t.b.y1];
    if (t.footprint) {
      o.footprint = { rings: traceMaskInBounds(t.footprint.mask, rt.W, rt.H), depth: r1(t.footprint.depth) };
      o.baseline_y = t.footprint.baseline;
    } else {
      o.footprint = null;
      o.baseline_y = t.b ? t.b.y1 : null;
    }
  });
  if (level.surface) level.surface.horizon_y = r1(rt.horizon);
  level.rules = {
    collect: roleIndexes(level, 'collect').map((k) => level.objects[k].id),
    avoid: roleIndexes(level, 'avoid').map((k) => level.objects[k].id),
    exit: level.objects[roleIndexes(level, 'exit')[0]].id,
  };
  const [sx, sy] = cellCenter(rt.nav, start);
  level.start = [sx, sy];
  level.nav = { cell: rt.p.cell, radius: r1(rt.p.radius), hazard_margin: rt.p.hazardMargin };
  level.proof = proof;
  const counts = {};
  for (const s of OUTLINE_SOURCES) counts[s] = 0;
  for (const o of level.objects) counts[o.outline.source] = (counts[o.outline.source] || 0) + 1;
  level.provenance.outline_sources = counts;
  rt.start = start;
}

// Check a level before play. The proof is always recomputed.
export function validateLevel(level) {
  const errors = [];
  const bad = (m) => { errors.push(m); };
  if (!level || level.schema !== LEVEL_SCHEMA) return { ok: false, errors: ['Not a FRAME//PLAY level'] };
  if (!ORIGINS.includes(level.origin)) bad('Unknown origin');
  else if (level.label !== LABELS[level.origin]) bad('The label does not match the origin');
  const W = level.picture && level.picture.width, H = level.picture && level.picture.height;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 16 || H < 16 || W > 4096 || H > 4096) {
    return { ok: false, errors: [...errors, 'Bad picture size'] };
  }
  if (!Array.isArray(level.objects) || !level.objects.length) return { ok: false, errors: [...errors, 'No objects'] };
  const ids = new Set();
  for (const o of level.objects) {
    if (ids.has(o.id)) bad(`Duplicate id ${o.id}`);
    ids.add(o.id);
    if (!ROLES.includes(o.role)) bad(`Unknown role for ${o.id}`);
    if (!o.outline || !OUTLINE_SOURCES.includes(o.outline.source)) bad(`Unknown outline source for ${o.id}`);
    if (!o.outline || !Array.isArray(o.outline.rings) || !ringsInside(o.outline.rings, W, H)) bad(`An outline of ${o.id} leaves the picture`);
  }
  if (level.surface && level.surface.rings && !ringsInside(level.surface.rings, W, H)) bad('The surface leaves the picture');
  const exits = level.objects.filter((o) => o.role === 'exit').length;
  if (exits !== 1) bad(`A level needs exactly one exit (found ${exits})`);
  if (!level.objects.some((o) => o.role === 'collect')) bad('A level needs at least one collectible');
  if (errors.length) return { ok: false, errors };
  const rt = prepare(level);
  const start = chooseStart(level, rt);
  const proof = proveLevel(level, rt, start);
  if (!proof.winnable) return { ok: false, errors: [proof.why] };
  rt.start = start;
  return { ok: true, errors: [], rt, proof, start };
}

// A MOCK level's input, straight from a sample room's exact shapes.
export function inputFromRoom(room, created) {
  return {
    origin: 'mock',
    picture: { kind: 'sample', id: room.id, width: room.width, height: room.height },
    title: room.title,
    theme_line: room.theme_line,
    surface: room.surface ? { name: room.surface.name, rings: room.surface.rings, source: 'exact' } : null,
    objects: room.objects.map((o) => ({
      id: o.id, name: o.name, instance: o.instance, role: o.role, reason: o.reason,
      box: [o.bounds.x0, o.bounds.y0, o.bounds.x1, o.bounds.y1].map((v) => Math.round(v * 100) / 100),
      confidence: null, outline: { source: 'exact', rings: o.rings }, on_surface: o.on_surface,
    })),
    provenance: { models: [], request_id: null, created: created || new Date().toISOString() },
  };
}
