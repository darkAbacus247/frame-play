// Ask the room (src/riddle.js): the text rules, the checks against a level,
// picking on the things' own outlines, grading by code, the count filled in
// by code, and honesty by origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLevel, inputFromRoom } from '../src/level.js';
import { loadRoom } from '../src/rooms.js';
import { pointInShape, bounds } from '../src/geom.js';
import {
  textProblem, checkRiddles, riddlesFromRoom, pickAt, pickForRiddle, newRiddleState, gradePick, fillCount,
  thingWords, answerWords, answerChoices, placeOf, riddleLabel, reasonPrefix, acceptRiddles, riddlesFromLine, riddleSlack, MAX_RIDDLES,
} from '../src/riddle.js';

const room = (name) => loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${name}.json`, import.meta.url), 'utf8')));
const built = (name) => { const r = room(name); const b = buildLevel(inputFromRoom(r, '2026-10-28T00:00:00Z')); return { room: r, level: b.level }; };
const kOf = (level, id) => level.objects.findIndex((o) => o.id === id);

test('the text rules: length, no digits, the count only as {n}, never the answer’s own name', () => {
  assert.equal(textProblem('Touch the thing you would fill with hot tea.', 'one', ['mug']), null);
  assert.match(textProblem('Too short', 'one', ['mug']), /characters/);
  assert.match(textProblem('x'.repeat(91), 'one', ['mug']), /characters/);
  assert.match(textProblem('Touch the 1 thing you would fill with tea.', 'one', ['mug']), /digit/);
  assert.match(textProblem('Find the things you could spend at a shop.', 'all', ['coin']), /count/);
  assert.match(textProblem('Find the three things you could spend {n}.', 'all', ['coin']), /count itself/);
  assert.match(textProblem('Find both {n} things that make a pair here.', 'all', ['slipper']), /count itself/);
  assert.match(textProblem('Touch the {n} thing you would fill with tea.', 'one', ['mug']), /count/);
  assert.match(textProblem('Touch the mug you would fill with hot tea.', 'one', ['mug']), /names its answer \("mug"\)/);
  assert.match(textProblem('Find the {n} gold things you could spend.', 'all', ['gold coin']), /"gold"/);
  // a plural is the same word
  assert.match(textProblem('Find the {n} coins you could spend at a shop.', 'all', ['coin']), /"coin"/);
});

test('every sample riddle is kept by its own room: three each, the count from the room, honest as a sample', () => {
  for (const name of ['desk', 'living', 'apartment']) {
    const { room: r, level } = built(name);
    const { kept, warnings } = riddlesFromRoom(r, level);
    assert.deepEqual(warnings, [], `${name}: ${warnings}`);
    assert.equal(kept.length, 3, name);
    for (const rd of kept) {
      assert.equal(rd.n, rd.answers.length);
      assert.equal(rd.origin, 'sample');
      for (const id of rd.answers) assert.equal(rd.regions[id], 'exact', `${name} ${rd.id}: graded on the painted shape`);
      assert.equal(riddleLabel(rd), 'Riddle written into this sample room · MOCK · no model was asked');
    }
  }
});

test('checkRiddles drops what does not fit the level, in words, and keeps at most three', () => {
  const { level } = built('desk');
  const ok = { text: 'Touch the thing you would fill with hot tea.', rule: 'one', answers: ['mug'], why: 'Hot drinks.' };
  const cases = [
    [{ ...ok, answers: ['nothing'] }, /not a thing in this room/],
    [{ ...ok, rule: 'some' }, /rule is unknown/],
    [{ ...ok, answers: [] }, /no answer/],
    [{ ...ok, answers: ['mug', 'lamp'] }, /one answer but several/],
    [{ ...ok, rule: 'all', text: 'Find the {n} things you would fill with tea.' }, /asks for all but has one answer/],
    [{ ...ok, answers: level.objects.map((o) => o.id), rule: 'any' }, /every thing answers it/],
    [{ ...ok, text: 'Touch the mug you would fill with hot tea.' }, /names its answer/],
    [{ ...ok, why: 'Hold it in one hand.' }, /about people \("hand"\)/],
  ];
  for (const [r, why] of cases) {
    const { kept, warnings } = checkRiddles(level, [r]);
    assert.equal(kept.length, 0, String(why));
    assert.match(warnings[0], why);
  }
  // 'any' with one answer is a 'one'
  assert.equal(checkRiddles(level, [{ ...ok, rule: 'any' }]).kept[0].rule, 'one');
  // the same answer twice: the second goes
  const two = checkRiddles(level, [ok, { ...ok, text: 'Touch whatever keeps your coffee warm.' }]);
  assert.equal(two.kept.length, 1);
  assert.match(two.warnings[0], /same answer/);
  const many = checkRiddles(level, [
    ok,
    { text: 'Touch whatever you could write your ideas in.', rule: 'one', answers: ['notebook'], why: '' },
    { text: 'Find the {n} things you could spend at a shop.', rule: 'all', answers: ['coin1', 'coin2', 'coin3'], why: '' },
    { text: 'Touch the thing that makes light at night.', rule: 'one', answers: ['lamp'], why: '' },
  ]);
  assert.equal(many.kept.length, MAX_RIDDLES);
  assert.match(many.warnings[0], /at most 3/);
});

test('each answer’s painted pixels pick it (scanned on a grid), and a pick off every outline is no pick', () => {
  for (const name of ['desk', 'living', 'apartment']) {
    const { room: r, level } = built(name);
    for (const rd of riddlesFromRoom(r, level).kept) {
      for (const id of rd.answers) {
        const k = kOf(level, id);
        const rings = level.objects[k].outline.rings;
        const b = bounds(rings);
        let inside = 0, mine = 0;
        for (let y = Math.ceil(b.y0) + 0.5; y < b.y1; y += 3) {
          for (let x = Math.ceil(b.x0) + 0.5; x < b.x1; x += 3) {
            if (!pointInShape(x, y, rings)) continue;
            inside++;
            const p = pickAt(level, x, y, 0);
            if (p && p.k === k) mine++;
          }
        }
        assert.ok(inside > 0, `${name} ${id}: sampled`);
        // a thing may stand in front of part of another (a mug on a notebook)
        assert.ok(mine / inside > 0.6, `${name} ${id}: ${mine} of ${inside} picks are its own`);
      }
    }
  }
  const { level } = built('desk');
  assert.equal(pickAt(level, 2, 2, 0), null, 'the picture corner holds no thing');
});

test('pickAt: a thing on a flat one wins; near within the slack is marked near; past the slack, none', () => {
  const { level } = built('desk');
  const mug = kOf(level, 'mug');
  const nb = kOf(level, 'notebook');
  // a point inside both the mug and the notebook (if they overlap) goes to the mug
  const mb = bounds(level.objects[mug].outline.rings);
  for (let y = mb.y0 + 1; y < mb.y1; y += 2) {
    for (let x = mb.x0 + 1; x < mb.x1; x += 2) {
      if (pointInShape(x, y, level.objects[mug].outline.rings) && pointInShape(x, y, level.objects[nb].outline.rings)) {
        assert.equal(pickAt(level, x, y, 0).k, mug);
      }
    }
  }
  // just outside the mug's right edge, on nothing else
  const y = (mb.y0 + mb.y1) / 2;
  let x = mb.x1 + 3;
  while (level.objects.some((o) => pointInShape(x, y, o.outline.rings))) x += 1;
  const slack = riddleSlack(level);
  const near = pickAt(level, x, y, slack);
  assert.ok(near && near.near, 'near pick');
  assert.equal(pickAt(level, x, y, 0), null, 'no slack, no pick');
});

test('gradePick: one, any and all; already found costs nothing; the same wrong thing counts once; two misses end it', () => {
  const one = newRiddleState({ rule: 'one', answers: ['mug'], n: 1 });
  assert.deepEqual(gradePick(one, 'lamp'), { kind: 'wrong', id: 'lamp', left: 1 });
  assert.deepEqual(gradePick(one, 'lamp'), { kind: 'again', id: 'lamp' });
  assert.equal(one.misses, 1);
  assert.equal(gradePick(one, 'mug').kind, 'solved');
  assert.equal(one.done, 'solved');
  assert.equal(gradePick(one, 'mug').kind, 'over');

  const any = newRiddleState({ rule: 'any', answers: ['coin1', 'coin2'], n: 2 });
  assert.equal(gradePick(any, 'coin2').kind, 'solved');

  const all = newRiddleState({ rule: 'all', answers: ['coin1', 'coin2', 'coin3'], n: 3 });
  assert.deepEqual(gradePick(all, 'coin2'), { kind: 'found', id: 'coin2', count: 1 });
  assert.deepEqual(gradePick(all, 'coin2'), { kind: 'already', id: 'coin2' });
  assert.equal(gradePick(all, 'mug').kind, 'wrong');
  assert.equal(gradePick(all, 'coin1').kind, 'found');
  assert.equal(gradePick(all, 'coin3').kind, 'solved');

  const lost = newRiddleState({ rule: 'one', answers: ['mug'], n: 1 });
  gradePick(lost, 'lamp');
  assert.deepEqual(gradePick(lost, 'box'), { kind: 'missed', id: 'box' });
  assert.equal(lost.done, 'missed');
});

test('the count is the game’s, in words; answers and places in words', () => {
  assert.equal(fillCount('Find the {n} things you could spend.', 3), 'Find the three things you could spend.');
  assert.equal(fillCount('Find the {n} things that work as a pair.', 2), 'Find the two things that work as a pair.');
  const { room: r, level } = built('desk');
  const [, coins] = riddlesFromRoom(r, level).kept;
  assert.equal(answerWords(level, coins), 'coin 1, coin 2 and coin 3');
  assert.equal(thingWords(level, kOf(level, 'mug')), 'the mug');
  const choices = answerChoices(level);
  assert.equal(choices.length, level.objects.length);
  assert.deepEqual(choices.map((c) => c.text), [...choices.map((c) => c.text)].sort((a, b) => a.localeCompare(b)), 'alphabetical: the order gives nothing away');
  assert.ok(choices.every((c) => / · (top|middle|bottom)/.test(c.text)), 'each with its place');
  assert.match(placeOf(level, kOf(level, 'lamp')), /left/);
});

test('honest by origin: labels and reason prefixes', () => {
  assert.equal(riddleLabel({ origin: 'live', regions: { o8: 'sam_mask' } }), 'Riddle by muse-spark-1.3 · found by sam-3.1 · graded on SAM 3.1’s own masks');
  assert.equal(riddleLabel({ origin: 'live', regions: { o8: 'traced_in_box' } }), 'Riddle by muse-spark-1.3 · found by sam-3.1 · graded on outlines traced inside SAM’s boxes');
  assert.equal(riddleLabel({ origin: 'live', regions: { o8: 'sam_mask', o9: 'box' } }), 'Riddle by muse-spark-1.3 · found by sam-3.1 · graded on SAM’s boxes');
  assert.match(riddleLabel({ origin: 'rehearsal' }), /^REHEARSAL · .*not Meta$/);
  assert.equal(riddleLabel({ origin: 'replay', recorded: 'Oct 28, 2026' }), 'REPLAY · Meta’s recorded riddle of Oct 28, 2026 · no model was called now');
  assert.equal(reasonPrefix('live'), 'Muse Spark says: ');
  assert.equal(reasonPrefix('sample'), 'Written into the sample: ');
  assert.equal(reasonPrefix('rehearsal'), 'The stand-in says: ');
});

const LINE = (over = {}) => ({
  schema: 'frameplay.riddles/1', request_id: 'r1', status: 'ok',
  provenance: { mode: 'live', label: 'LIVE · Meta Model API · muse-spark-1.3 and sam-3.1', models: ['muse-spark-1.3'], calls: [] },
  riddles: [], ...over,
});

test('acceptRiddles: the room’s own request, honest by mode', () => {
  assert.ok(acceptRiddles(LINE(), { mode: 'live', requestId: 'r1' }).ok);
  assert.ok(!acceptRiddles(LINE(), { mode: 'live', requestId: 'r2' }).ok, 'another photo');
  assert.ok(!acceptRiddles(LINE({ status: 'none' }), { mode: 'live', requestId: 'r1' }).ok);
  assert.ok(!acceptRiddles(LINE({ provenance: { mode: 'rehearsal', models: [] } }), { mode: 'live', requestId: 'r1' }).ok, 'live takes live only');
  assert.ok(!acceptRiddles(LINE(), { mode: 'rehearsal', requestId: 'r1' }).ok, 'a rehearsal claims no model');
  assert.ok(acceptRiddles(LINE({ provenance: { mode: 'rehearsal', models: [] } }), { mode: 'rehearsal', requestId: 'r1' }).ok);
  assert.ok(!acceptRiddles(LINE(), { mode: 'mock', requestId: 'r1' }).ok, 'MOCK never shows a riddle over a photo');
});

test('riddlesFromLine: an unknown id drops the riddle; a point off its outline grades that answer on its box, and pickForRiddle honours it', () => {
  const { level } = built('desk');
  const mug = level.objects[kOf(level, 'mug')];
  const mb = bounds(mug.outline.rings);
  const riddle = (pt) => ({ id: 'q1', text: 'Touch the thing you would fill with hot tea.', rule: 'one', answers: ['mug'], n: 1, why: 'Hot drinks.', points: [[...pt, 'mug']] });
  const line = LINE({
    riddles: [
      riddle([(mb.x0 + mb.x1) / 2, (mb.y0 + mb.y1) / 2]),
      { id: 'q2', text: 'Touch whatever you could write your ideas in.', rule: 'one', answers: ['nope'], n: 1, why: '', points: [] },
    ],
  });
  const { kept, warnings } = riddlesFromLine(line, level, 'live');
  assert.equal(kept.length, 1);
  assert.match(warnings[0], /not a thing in this room/);
  assert.equal(kept[0].origin, 'live');
  assert.equal(kept[0].regions.mug, 'exact', 'the point on the mug: graded on its outline');
  // a point farther than g from the mug's outline: the outline missed what Spark meant
  const rd = riddlesFromLine(LINE({ riddles: [riddle([mb.x1 + 40, mb.y1 + 40])] }), level, 'live').kept[0];
  assert.equal(rd.regions.mug, 'box');
  assert.match(riddleLabel(rd), /graded on SAM’s boxes/);
  // a tap in the mug's box but off its outline (and off every other thing) counts for the mug
  let spot = null;
  for (let y = mb.y0 + 0.5; y < mb.y1 && !spot; y += 1) {
    for (let x = mb.x0 + 0.5; x < mb.x1 && !spot; x += 1) {
      if (!level.objects.some((o) => pointInShape(x, y, o.outline.rings))) spot = [x, y];
    }
  }
  assert.ok(spot, 'the box has a corner the outline does not fill');
  assert.equal(pickAt(level, ...spot, 0), null);
  assert.equal(pickForRiddle(level, rd, ...spot, 0).k, kOf(level, 'mug'));
  assert.equal(pickForRiddle(level, kept[0], ...spot, 0), null, 'graded on its outline, the same tap picks nothing');
});
