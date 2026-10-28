// Ask the room on our kitchen's replay. Muse Spark wrote three riddles for
// this photo in a LIVE read on 2026-10-28 (server/replay/kitchen_riddles.json).
// Their answers were that read's ids, so each riddle's points go through the
// game's own pick (src/riddle.js pickAt) on the replay's own SAM 3.1 masks: a
// riddle is replayed only when every point falls inside one thing and its
// answers map to as many things. The server then sends them on the replay's
// stream as a riddles line, checked by the page exactly as a live one
// (acceptRiddles, riddlesFromLine), labeled REPLAY. No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { bootApp, textOf, paintCanvases, until } from './apphost.js';
import { played } from './stub_game.js';
import { roadAt } from './roads.js';
import { replayLines, KITCHEN_JPG, KITCHEN_PIXELS, W, H } from './kitchen.js';
import { replayOurs } from '../src/own.js';
import { pickAt, pickForRiddle, newRiddleState, gradePick, acceptRiddles, riddlesFromLine, riddleLabel, reasonPrefix } from '../src/riddle.js';

const RECORDED = JSON.parse(readFileSync(new URL('../server/replay/kitchen_riddles.json', import.meta.url), 'utf8'));
const LABEL = 'REPLAY · Riddle by muse-spark-1.3, recorded Oct 28, 2026 · no model was called now';
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function replayed() {
  const [{ reply }, { riddles: line }] = replayLines();
  const deps = { photo: async () => ({ bytes: KITCHEN_JPG, picture: { width: W, height: H }, pixels: KITCHEN_PIXELS }), sha256: async (b) => sha(Buffer.from(b)), send: async () => reply };
  const r = await replayOurs({ deps, yieldNow: async () => {} });
  assert.equal(r.kind, 'built', r.words);
  return { reply, line, level: r.entry.built.level };
}

test('each recorded riddle is mapped by the game’s own pick on the replay’s masks, or not replayed', async () => {
  const { level } = await replayed();
  assert.equal(RECORDED.recorded, '2026-10-28');
  assert.equal(RECORDED.model, 'muse-spark-1.3');
  assert.deepEqual([RECORDED.width, RECORDED.height], [W, H], 'the same photo, the same pixels');
  for (const r of RECORDED.riddles) {
    const picks = r.points.map(([x, y]) => pickAt(level, x, y, 0));
    const to = {};
    for (let i = 0; i < picks.length; i++) if (picks[i] && !picks[i].near) to[r.points[i][2]] = level.objects[picks[i].k].id;
    const clean = picks.every((p) => p && !p.near) && Object.keys(to).length === r.answers.length
      && r.answers.every((a) => a in to) && new Set(Object.values(to)).size === r.answers.length;
    if (clean) assert.deepEqual(r.replay_answers, to, r.text);
    else assert.equal(r.replay_answers, null, r.text);
  }
  assert.deepEqual(RECORDED.riddles.map((r) => (r.replay_answers ? Object.values(r.replay_answers).map((id) => level.objects.find((o) => o.id === id).name) : null)),
    [['refrigerator'], ['stove'], null], 'the cabinets of the 10-28 read are not among the 10-27 answers');
});

test('the replay’s riddles line is honest, and the page takes it only for a replay of the same request', async () => {
  const { reply, line } = await replayed();
  assert.equal(line.request_id, reply.request_id);
  assert.equal(line.status, 'ok');
  assert.equal(line.provenance.mode, 'replay');
  assert.deepEqual(line.provenance.models, [], 'no model is called now');
  assert.deepEqual(line.provenance.calls, []);
  assert.equal(line.usage.spark_calls, 0);
  assert.equal(line.usage.estimated_usd, 0);
  assert.deepEqual(line.provenance.replay, { recorded: '2026-10-28', models: ['muse-spark-1.3'], words: 'Muse Spark wrote these riddles for this photo on Oct 28, 2026; this copy replays them; no model was called now.' });
  assert.equal(line.recorded, 'Oct 28, 2026');
  assert.ok(acceptRiddles(line, { mode: 'replay', requestId: reply.request_id }).ok);
  assert.ok(!acceptRiddles(line, { mode: 'replay', requestId: 'another' }).ok, 'another photo');
  for (const mode of ['live', 'rehearsal', 'mock']) assert.ok(!acceptRiddles(line, { mode, requestId: reply.request_id }).ok, `never as ${mode}`);
  assert.ok(!acceptRiddles({ ...line, provenance: { ...line.provenance, models: ['muse-spark-1.3'] } }, { mode: 'replay', requestId: reply.request_id }).ok, 'a replay claims no model called now');
  assert.ok(!acceptRiddles({ ...line, recorded: undefined }, { mode: 'replay', requestId: reply.request_id }).ok, 'a replay says when');
});

test('each kept riddle, in Muse Spark’s words, grades right on its replay mask and wrong on every other thing', async () => {
  const { line, level } = await replayed();
  const { kept, warnings } = riddlesFromLine(line, level, 'replay');
  assert.deepEqual(warnings, []);
  assert.deepEqual(kept.map((r) => r.text), ['Touch the tall white chilly keeper that keeps snacks cold.', 'Touch the black top where pots get hot to make dinner.']);
  assert.deepEqual(kept.map((r) => r.why), ['It is big white and keeps food cold.', 'It cooks food with hot burners and oven.']);
  assert.deepEqual(kept.map((r) => r.rule), ['one', 'one']);
  for (const r of kept) {
    assert.equal(r.origin, 'replay');
    assert.equal(r.recorded, 'Oct 28, 2026');
    assert.equal(riddleLabel(r), LABEL);
    assert.deepEqual(Object.values(r.regions), ['sam_mask'], 'graded on SAM 3.1’s own mask');
    // right: at Muse Spark's point
    const [x, y] = r.points[0];
    const p = pickForRiddle(level, r, x, y, 0);
    assert.equal(gradePick(newRiddleState(r), level.objects[p.k].id).kind, 'solved', r.text);
    // wrong: a point inside each other thing
    for (let k = 0; k < level.objects.length; k++) {
      const id = level.objects[k].id;
      if (r.answers.includes(id)) continue;
      let at = null;
      for (let py = 0; py < H && !at; py += 3) for (let px = 0; px < W && !at; px += 3) { const q = pickAt(level, px, py, 0); if (q && q.k === k && !q.near) at = [px, py]; }
      assert.ok(at, `a point on the ${level.objects[k].name}`);
      const q = pickForRiddle(level, r, at[0], at[1], 0);
      assert.equal(gradePick(newRiddleState(r), level.objects[q.k].id).kind, 'wrong', `${r.text} / ${level.objects[k].name}`);
    }
  }
  assert.equal(reasonPrefix('replay'), 'Muse Spark said: ');
});

// On the page: with no key (MOCK, a server that can replay), Step 2's first
// card is our kitchen, replayed; its end card offers Ask the room.
test('MOCK, Step 2: our kitchen’s replay offers Ask the room, with Muse Spark’s recorded riddles labeled REPLAY', async () => {
  const app = await bootApp({ mode: 'mock', server: true, road: roadAt(2), replay: replayLines });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  paintCanvases(app, KITCHEN_PIXELS);
  try {
    app.$('main').querySelector('.ours-card').click();
    await until(app, () => app.h1() === 'What the AI found', 'the replayed room', 120000);
  } finally { delete globalThis.createImageBitmap; }
  app.mainPrimary().click();
  await app.settle();
  played.last.onEnd({ status: 'won', ratio: 1, words: { title: 'Room cleared!', body: 'You took the shortest route.' } });
  await app.settle(3);
  const ask = app.$('card').querySelectorAll('button').find((b) => textOf(b) === 'Ask the room');
  assert.ok(ask, textOf(app.$('card')));
  ask.click();
  await app.settle(3);
  const asked = played.view.riddle;
  assert.deepEqual(asked.list.map((r) => r.origin), ['replay', 'replay']);
  assert.deepEqual(asked.list.map(riddleLabel), [LABEL, LABEL]);
  asked.handlers.onEnd({ outcome: 'solved', i: 0, total: 2, riddle: asked.list[0], found: asked.list[0].answers });
  await app.settle(3);
  const card = textOf(app.$('card'));
  assert.match(card, /“Touch the tall white chilly keeper that keeps snacks cold\.”/);
  assert.match(card, /Answer: the refrigerator/);
  assert.match(card, /Muse Spark said: It is big white and keeps food cold\./);
  assert.ok(card.includes(LABEL), card);
});
