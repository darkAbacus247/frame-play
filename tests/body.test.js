// B2: the explorer's body is one disc at its feet, the disc that collides,
// and seen from above (The Apartment, and any floor plan) it is drawn as
// that disc and no more: it never stands over a wall line or a thing. The
// explorer is swept along every wall of every room (The Apartment, the desk,
// the living room, the rehearsed apartment and our kitchen's replay): its
// drawn body is always on the floor, and wherever a straight path of floor
// wider than its body goes on, the arrow keys (the pad steers the same
// way) and taps take it there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLevel, inputFromRoom, validateLevel } from '../src/level.js';
import { loadRoom } from '../src/rooms.js';
import { sampleField, fieldGradient } from '../src/distance.js';
import { bodyRadius, navParams } from '../src/nav.js';
import { createRound, stepRound, moveWithCollision, walkToPoint, inHazardHalo, objectAt } from '../src/play.js';
import { spriteBox, drawPlan } from '../src/render.js';
import { kitchenLevel } from './screenset.js';
import { replayApartment } from './golden_apartment.js';

const CREATED = '2026-10-27T12:00:00Z';
const sample = (name) => buildLevel(inputFromRoom(loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${name}.json`, import.meta.url), 'utf8'))), CREATED));

// The points the arrow keys reach from the start (4-connected pixels where
// the body's disc lies on walkable floor), every `step` pixels.
function keyReach(level, rt) {
  const { W, H } = rt, r = rt.p.radius, f = rt.nav.field;
  const seen = new Uint8Array(W * H), stack = [];
  const s0 = Math.round(level.start[1]) * W + Math.round(level.start[0]);
  assert.ok(f[s0] >= r, 'the start is free');
  seen[s0] = 1; stack.push(s0);
  while (stack.length) {
    const i = stack.pop(), x = i % W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
      if (j >= 0 && j < W * H && !seen[j] && f[j] >= r) { seen[j] = 1; stack.push(j); }
    }
  }
  return seen;
}

// Every pixel of the disc of radius rr at (x, y) is walkable floor.
function discOnFloor(rt, x, y, rr) {
  for (let dy = -Math.floor(rr); dy <= rr; dy++) {
    for (let dx = -Math.floor(rr); dx <= rr; dx++) {
      if (dx * dx + dy * dy > rr * rr) continue;
      const px = Math.round(x + dx), py = Math.round(y + dy);
      if (!rt.walk[py * rt.W + px]) return false;
    }
  }
  return true;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, y]) => [x / Math.hypot(x, y), y / Math.hypot(x, y)]);

function sweep(name, level, rt) {
  const { W, H } = rt, r = rt.p.radius, nav = rt.nav;
  const L = Math.max(W, H);
  const topDown = level.view === 'top_down';
  const F = (x, y) => sampleField(nav.field, W, H, x, y);
  const reach = keyReach(level, rt);
  // along the walls: reached points whose body touches a wall or a thing
  const along = [];
  for (let y = 1; y < H - 1; y += 3) {
    for (let x = 1; x < W - 1; x += 3) {
      const i = y * W + x;
      if (reach[i] && nav.field[i] < r + 2 * nav.cell && F(x, y) >= r) along.push([x, y]);
    }
  }
  assert.ok(along.length > 100, `${name}: the sweep runs along the walls (${along.length} points)`);
  const len = nav.cell;
  for (const [x, y] of along) {
    // the body drawn is on the floor: seen from above the sprite is the
    // disc; at eye level its feet are
    if (topDown) {
      const b = spriteBox(L, [x, y], true);
      assert.ok(b.x1 - x <= r + 1e-9 && y - b.y0 <= r + 1e-9 && b.y1 - y <= r + 1e-9, `${name}: the drawn body is the collision disc`);
    }
    assert.ok(discOnFloor(rt, x, y, r - 0.5), `${name}: at ${x},${y} the body stands on a wall`);
    // every way out along a free straight path of floor wider than the body
    const ways = DIRS.slice();
    const [gx, gy] = fieldGradient(nav.field, W, H, x, y);
    if (gx || gy) ways.push([-gy, gx], [gy, -gx]); // along the wall itself
    for (const [dx, dy] of ways) {
      let free = true;
      for (let t = 0; t <= len && free; t += 0.25) free = F(x + dx * t, y + dy * t) >= r;
      if (!free) continue;
      const pos = [x, y];
      const res = moveWithCollision(rt, pos, dx * len, dy * len);
      assert.ok(!res.stuck && Math.hypot(pos[0] - x - dx * len, pos[1] - y - dy * len) < 1e-6,
        `${name}: blocked at ${x},${y} going ${dx.toFixed(2)},${dy.toFixed(2)} where the floor goes on`);
    }
  }
  // taps: a tap on any of these points (on the floor, out of the hazard
  // halos; a tap on a thing walks to the thing) walks there
  const state = createRound(level, rt);
  const tol = 1;
  let tapped = 0;
  for (let k = 0; k < along.length; k += Math.ceil(along.length / 40)) {
    const [x, y] = along[k];
    if (inHazardHalo(level, rt, x, y) >= 0 || objectAt(level, rt, x, y) >= 0) continue;
    state.pos = level.start.slice(); state.status = 'playing'; state.auto = null;
    state.collected = state.collected.map(() => true); state.goalsLeft = 0; state.doorOpen = false;
    const res = walkToPoint(state, level, rt, x, y);
    assert.ok(res.ok, `${name}: a tap at ${x},${y} is refused: ${res.reason}`);
    for (let t = 0; t < 4000 && state.auto && state.status === 'playing'; t++) stepRound(state, level, rt, {});
    const d = Math.hypot(state.pos[0] - x, state.pos[1] - y);
    assert.ok(d <= tol || state.status !== 'playing', `${name}: a tap at ${x},${y} ends ${d.toFixed(1)} px away`);
    tapped++;
  }
  assert.ok(tapped >= 20, `${name}: taps tried (${tapped})`);
}

test('the body that collides is the one drawn from above, a disc of the nav radius', () => {
  for (const [w, h] of [[1024, 768], [1024, 399], [640, 480]]) {
    const p = navParams(w, h);
    assert.equal(bodyRadius(p.L), p.radius);
    const b = spriteBox(p.L, [300, 200], true);
    assert.deepEqual([b.x0, b.y0, b.x1, b.y1], [300 - p.radius, 200 - p.radius, 300 + p.radius, 200 + p.radius]);
  }
  // at eye level the explorer still stands up from its feet
  const sb = spriteBox(1024, [100, 200]);
  assert.ok(sb.y0 < 150);
});

for (const name of ['apartment', 'desk', 'living']) {
  test(`${name}: swept along every wall, the explorer never stands on one and is never blocked where the floor goes on`, () => {
    const { level, rt, error } = sample(name);
    assert.ok(!error, error);
    sweep(name, level, rt);
  });
}

test('the rehearsed apartment: swept along every wall, the same', async () => {
  const { entry } = await replayApartment();
  const { level, rt } = entry.built;
  sweep('rehearsed apartment', level, rt);
});

test('our kitchen replay: swept along every wall, the same', () => {
  const v = validateLevel(JSON.parse(JSON.stringify(kitchenLevel().level)));
  assert.ok(v.ok);
  sweep('our kitchen', kitchenLevel().level, v.rt);
});

// The owner's walk (2026-10-27, MOCK, The Apartment, every coin taken, the
// door open): at the top of the kitchen, walking right along its top wall,
// the explorer stopped at an invisible wall, drawn standing over the wall
// line. Its standing figure rose 0.06 L above its feet, over the wall north
// of it, while what collides is a disc of 0.011 L at its feet; the floor
// between the wall (y 54) and the chair above the table (y 74) is 20 px,
// narrower than that disc (22.5 px). Now the body drawn is the disc: it
// stays below the wall line, and it visibly meets the chair where it stops.
test("the owner's walk: the kitchen's top wall, walking right toward the chair", () => {
  const { level, rt } = sample('apartment');
  const L = Math.max(rt.W, rt.H), r = rt.p.radius;
  const WALL = 54;
  const chair = level.objects.find((o) => o.id === 'chair1');
  const [cx0, cy0] = chair.box;
  const state = createRound(level, rt);
  state.collected = state.collected.map(() => true); state.goalsLeft = 0; state.doorOpen = true;
  state.pos = [560, 70];
  let lastX = state.pos[0];
  for (let t = 0; t < 300; t++) {
    stepRound(state, level, rt, { dir: [1, 0] });
    const b = spriteBox(L, state.pos, true);
    assert.ok(b.y0 >= WALL, `tick ${t}: the body is drawn over the wall line (top ${b.y0.toFixed(1)})`);
    assert.ok(state.pos[0] >= lastX - 1e-9, 'it never goes back');
    lastX = state.pos[0];
  }
  // it slid along the wall all the way to the chair, and meets it
  const b = spriteBox(L, state.pos, true);
  assert.ok(b.x1 >= cx0 && b.x1 < cx0 + 10 && sampleField(rt.nav.field, rt.W, rt.H, ...state.pos) < r + 1, `it stops where its body meets the chair's corner (${b.x1.toFixed(1)} vs ${cx0})`);
  assert.ok(cy0 - WALL < 2 * r, `the floor between the wall and the chair (${cy0 - WALL} px) is narrower than the body (${(2 * r).toFixed(1)} px)`);
  // the plan draws the explorer and repaints nothing over it from above
  assert.ok(!drawPlan(level, state.pos).some((s) => s.op === 'repaint'));
  // the right of the kitchen is reached around the table, by keys and by a tap
  const keys = keyReach(level, rt);
  assert.ok(keys[70 * rt.W + 900], 'the keys reach the top right of the kitchen');
  const res = walkToPoint(state, level, rt, 900, 70);
  assert.ok(res.ok, res.reason);
  for (let t = 0; t < 2000 && state.auto && state.status === 'playing'; t++) {
    stepRound(state, level, rt, {});
    assert.ok(spriteBox(L, state.pos, true).y0 >= WALL - 1e-9);
  }
  assert.ok(Math.hypot(state.pos[0] - 900, state.pos[1] - 70) < 10, `tapped, it walks there (${state.pos})`);
  // and from the right, walking left along the wall, it meets the chair's other side
  for (let t = 0; t < 300; t++) stepRound(state, level, rt, { dir: [-1, 0] });
  const back = spriteBox(L, state.pos, true);
  assert.ok(back.x0 <= chair.box[2] && back.x0 > chair.box[2] - 10 && sampleField(rt.nav.field, rt.W, rt.H, ...state.pos) < r + 1, `${state.pos}`);
});
