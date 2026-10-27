// B3: one clearance everywhere. The planner behind Walk to, taps and the
// any-angle paths, and the winnability proof, free a cell where the body
// that collides (bodyRadius) fits, no more and no less, so every route the
// game plans or proves is one the body walks. In every sample room, our
// kitchen's replay and the rehearsed apartment, pressing each Walk to in
// turn (the collectibles in the chips' order, then the exit) reaches each
// one and wins the round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLevel, inputFromRoom, validateLevel } from '../src/level.js';
import { loadRoom } from '../src/rooms.js';
import { bodyRadius, navParams, buildNav } from '../src/nav.js';
import { createRound, stepRound, walkToObject } from '../src/play.js';
import { kitchenLevel } from './screenset.js';
import { replayApartment } from './golden_apartment.js';

const CREATED = '2026-10-27T12:00:00Z';
const sample = (name) => buildLevel(inputFromRoom(loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${name}.json`, import.meta.url), 'utf8'))), CREATED));

// The Walk to chips as the play screen lists them (src/game.js goalChips):
// the proof's order, then any collectible or exit it left out; collectibles
// first, then the exit.
function chipOrder(level) {
  const ids = [...((level.proof && level.proof.order) || [])];
  level.objects.forEach((o) => { if ((o.role === 'collect' || o.role === 'exit') && !ids.includes(o.id)) ids.push(o.id); });
  const ks = ids.map((id) => level.objects.findIndex((o) => o.id === id)).filter((k) => k >= 0);
  return [...ks.filter((k) => level.objects[k].role === 'collect'), ...ks.filter((k) => level.objects[k].role === 'exit')];
}

function walkEveryChip(name, level, rt) {
  assert.ok(level.proof.winnable, `${name}: the proof says it can be won`);
  const state = createRound(level, rt);
  const order = chipOrder(level);
  assert.ok(order.length >= 2, `${name}: there are goals to walk to`);
  for (const k of order) {
    const id = level.objects[k].id;
    const res = walkToObject(state, level, rt, k);
    assert.ok(res.ok, `${name}: Walk to ${id} is refused (${res.reason})`);
    const events = [];
    for (let n = 0; state.auto && n < 20000; n++) events.push(...stepRound(state, level, rt));
    const types = events.map((e) => e.type);
    assert.ok(!types.includes('cancel'), `${name}: the walk to ${id} stopped short at ${state.pos.map(Math.round)}`);
    if (level.objects[k].role === 'collect') {
      assert.ok(state.collected[k], `${name}: ${id} is collected`);
    } else {
      assert.equal(state.status, 'won', `${name}: the exit wins the round`);
    }
  }
  assert.equal(state.status, 'won', `${name}: the round is won by Walk to alone`);
}

for (const name of ['apartment', 'desk', 'living']) {
  test(`${name}: each Walk to in turn arrives and wins the round`, () => {
    const { level, rt } = sample(name);
    walkEveryChip(name, level, rt);
  });
}

test('our kitchen\'s replay: each Walk to in turn arrives and wins the round', () => {
  const level = JSON.parse(JSON.stringify(kitchenLevel().level));
  const v = validateLevel(level);
  assert.ok(v.ok, String(v.errors));
  walkEveryChip('our kitchen', level, v.rt);
});

test('the rehearsed apartment: each Walk to in turn arrives and wins the round', async () => {
  const { entry } = await replayApartment();
  assert.ok(!entry.built.error, entry.built.error);
  walkEveryChip('the rehearsed apartment', entry.built.level, entry.built.rt);
});

test('the planner\'s clearance is the body radius movement collides with', () => {
  for (const [W, H] of [[1024, 768], [768, 1024], [640, 480], [4000, 3000]]) {
    const p = navParams(W, H);
    assert.equal(p.radius, bodyRadius(Math.max(W, H)));
    const walk = new Uint8Array(64 * 64).fill(1);
    const nav = buildNav(walk, null, 64, 64, { ...p, cell: 2 });
    assert.equal(nav.planRadius, bodyRadius(Math.max(W, H)));
    assert.equal(nav.radius, nav.planRadius);
  }
  for (const name of ['apartment', 'desk', 'living']) {
    const { rt } = sample(name);
    assert.equal(rt.nav.planRadius, bodyRadius(rt.p.L), name);
    assert.equal(rt.nav.planRadius, rt.p.radius, name);
  }
});
