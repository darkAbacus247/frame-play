import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument } from './fakedom.js';
import { el } from '../src/ui.js';
import { closingRooms, closingView, resultLine } from '../src/screens.js';
import { newRoad, LAST_STEP, counterText, lapText, primaryLabel, canForward, stepKind } from '../src/road.js';
import { header, mainSpace, screenHeight } from './layoutmodel.js';

const doc = installFakeDocument();
doc.body.append(el('div', { id: 'tips' }));

const desk = { kind: 'sample', id: 'desk' };
const living = { kind: 'sample', id: 'living' };
const mine = { kind: 'photo', sha256: 'ab'.repeat(32) };
const level = (origin, title, n) => ({ origin, title, objects: Array.from({ length: n }, (_, k) => ({ id: `o${k}` })) });
const MOCK_DESK = level('mock', 'The Desk Top', 10);
const MOCK_LIVING = level('mock', 'The Living Room', 8);

function endRoad(own) {
  return {
    ...newRoad(), step: LAST_STEP, reached: LAST_STEP, consent: true,
    own: own ? null : 'skipped',
    rooms: [desk, living, own ? mine : null],
    finished: [true, true, !!own],
    best: [1.24, null, own ? 1.0 : null],
  };
}

const all = (root) => [root, ...root.all()];
const texts = (root) => all(root).filter((e) => !e.children.length).map((e) => e.textContent).join(' | ');

test('the closing screen is the last step of the road, and the counter says so', () => {
  const r = endRoad(false);
  assert.equal(stepKind(LAST_STEP), 'end');
  assert.equal(counterText(r), 'Step 12 of 12: The end');
  assert.equal(lapText(r), 'Circuit complete');
  assert.equal(primaryLabel(r), 'Free play');
  assert.equal(canForward(r).ok, true, 'Free play lies beyond it');
});

test('MOCK: each room, what happened, and that no model was called', () => {
  const rooms = closingRooms({ road: endRoad(false), mode: 'mock', levels: [MOCK_DESK, MOCK_LIVING, null] });
  assert.deepEqual(rooms.map((r) => r.result), ['Won · best route 1.2 times the shortest', 'Lost · not won yet', 'Not made']);
  assert.equal(rooms[0].ai, 'Sample room drawn by code; no model was called.');
  assert.equal(rooms[1].ai, 'Sample room drawn by code; no model was called.');
  assert.match(rooms[2].ai, /^Reading a real photo needs the live AI \(Meta’s models\); this copy runs without it, so no model was called and nothing was invented\.$/);
  assert.deepEqual(rooms.map((r) => r.playable), [true, true, false]);
  assert.equal(resultLine({ best: [1.02], finished: [true] }, 0), 'Won · by the shortest route');
  assert.equal(resultLine({ best: [null], finished: [false] }, 0), 'Not played yet');
});

test('LIVE: your own room says what the models did, in one sentence', () => {
  const rooms = closingRooms({
    road: endRoad(true), mode: 'live',
    levels: [MOCK_DESK, MOCK_LIVING, level('live', 'Morning desk', 7)],
    summaries: [null, null, { named: 6 }],
  });
  assert.equal(rooms[2].title, 'Morning desk');
  assert.equal(rooms[2].result, 'Won · by the shortest route');
  assert.equal(rooms[2].ai, 'Muse Spark named 6 things in your photo and gave each a role, SAM 3.1 found 7 of them, and code traced the outlines and proved the room can be won.');
  assert.equal((rooms[2].ai.match(/\.\s/g) || []).length, 0, 'one sentence');
  const reh = closingRooms({ road: endRoad(true), mode: 'rehearsal', levels: [MOCK_DESK, MOCK_LIVING, level('rehearsal', 'The Desk Top', 9)] });
  assert.match(reh[2].ai, /^The local stand-in \(not Meta\) answered/);
  const gone = closingRooms({ road: endRoad(true), mode: 'live', levels: [MOCK_DESK, MOCK_LIVING, null] });
  assert.match(gone[2].ai, /not in memory on this visit; pick the same photo again on Step 9/);
  assert.equal(gone[2].playable, false);
});

function view(mode, own) {
  const calls = [];
  const levels = [MOCK_DESK, MOCK_LIVING, own ? level(mode, 'A long title for a photo of my own room', 7) : null];
  const rooms = closingRooms({ road: endRoad(own), mode, levels, summaries: [null, null, { named: 8 }] });
  const actions = {
    freePlay: () => calls.push('free'), playAgain: (ref, t) => calls.push(['again', ref, t]),
    ownRoom: () => calls.push('own'), startOver: () => calls.push('over'),
  };
  return { section: closingView({ rooms, mode, primaryLabel: 'Free play', actions }), calls };
}

test('one heading, one primary, real buttons for every way on; MOCK says why there is no own room', () => {
  const { section, calls } = view('mock', false);
  const h1 = all(section).filter((e) => e.tagName === 'H1');
  assert.equal(h1.length, 1);
  assert.equal(h1[0].textContent, 'You’ve completed FRAME//PLAY');
  const buttons = all(section).filter((e) => e.tagName === 'BUTTON');
  const primary = buttons.filter((b) => b.hasAttribute('data-primary'));
  assert.deepEqual(primary.map((b) => b.textContent), ['Free play']);
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-label') || b.textContent),
    ['Play The Desk Top again', 'Play The Living Room again', 'Free play', 'Start over']);
  assert.ok(buttons.every((b) => b.getAttribute('type') === 'button' && b.dataset.tip && b.getAttribute('aria-describedby')), 'keyboard buttons with words for screen readers');
  assert.match(texts(section), /Your own room needs the live AI \(Meta’s models\)\. This copy runs without it\./);
  assert.doesNotMatch(texts(section), /Try your own room/);
  const list = all(section).find((e) => e.tagName === 'UL');
  assert.equal(list.getAttribute('aria-label'), 'The rooms you played');
  assert.equal(list.children.length, 3);
  for (const b of buttons) b.click();
  assert.deepEqual(calls, [['again', desk, 'The Desk Top'], ['again', living, 'The Living Room'], 'free', 'over']);
});

test('LIVE and REHEARSAL offer Try your own room', () => {
  for (const mode of ['live', 'rehearsal']) {
    const { section, calls } = view(mode, true);
    const b = all(section).find((e) => e.tagName === 'BUTTON' && e.textContent === 'Try your own room');
    assert.ok(b, mode);
    b.click();
    assert.deepEqual(calls, ['own']);
    assert.equal(all(section).filter((e) => e.tagName === 'BUTTON' && /again$/.test(e.getAttribute('aria-label') || '')).length, 3);
  }
});

// Modeled with the stylesheet's cascade (tests/layoutmodel.js), with text
// wrapped a little wider than the real font: the closing screen fits main
// without scrolling at 100% zoom.
test('the closing screen fits without scrolling at 839x945 and 1259x1418', () => {
  for (const [vw, vh] of [[839, 945], [1259, 1418]]) {
    for (const [mode, own] of [['mock', false], ['live', true], ['rehearsal', true]]) {
      const head = header({ lap: 'Circuit complete', counter: 'Step 12 of 12: The end', why: '', band: mode === 'rehearsal' ? 'REHEARSAL · local stand-in, not Meta. No photo leaves this machine.' : null });
      const { space, width, layout } = mainSpace(vw, vh, head, mode);
      const h = screenHeight(layout, view(mode, own).section, width);
      assert.ok(h <= space, `${vw}x${vh} ${mode}: ${Math.round(h)}px of content in ${Math.round(space)}px`);
    }
  }
});
