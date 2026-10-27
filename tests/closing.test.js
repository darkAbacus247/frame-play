import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument } from './fakedom.js';
import { el } from '../src/ui.js';
import { closingRooms, closingView, resultLine } from '../src/screens.js';
import { newRoad, LAST_STEP, counterText, lapText, primaryLabel, canForward, stepKind } from '../src/road.js';
import * as R from '../src/road.js';
import { header, mainSpace, screenHeight } from './layoutmodel.js';

const doc = installFakeDocument();
doc.body.append(el('div', { id: 'tips' }));

const desk = { kind: 'sample', id: 'desk' };
const living = { kind: 'sample', id: 'living' };
const apartment = { kind: 'sample', id: 'apartment' };
const mine = { kind: 'photo', sha256: 'ab'.repeat(32) };
// n objects; for a read, all traced but `boxes` kept as SAM's box
const level = (origin, title, n, boxes = 0) => ({
  origin, title, objects: Array.from({ length: n }, (_, k) => ({ id: `o${k}` })),
  provenance: { outline_sources: origin === 'mock' ? { exact: n } : { traced_in_box: n - boxes, box: boxes } },
});
const MOCK_DESK = level('mock', 'The Desk Top', 10);
const MOCK_LIVING = level('mock', 'The Living Room', 8);
const MOCK_APT = level('mock', 'The Apartment', 9);
const SAMPLES = [MOCK_DESK, MOCK_LIVING, MOCK_APT];

function endRoad(own) {
  return {
    ...newRoad(), step: LAST_STEP, reached: LAST_STEP, consent: true,
    own: own ? null : 'skipped',
    rooms: [desk, living, apartment, own ? mine : null],
    finished: [true, true, true, !!own],
    best: [1.24, null, 1.5, own ? 1.0 : null],
  };
}

const all = (root) => [root, ...root.all()];
const nameOf = (e) => (e.children.length ? e.children.map(nameOf).join('') : e.textContent || '');
const texts = (root) => all(root).filter((e) => !e.children.length).map((e) => e.textContent).join(' | ');

test('the closing screen is the last step of the road, and the counter says so', () => {
  const r = endRoad(false);
  assert.equal(stepKind(LAST_STEP), 'end');
  assert.equal(counterText(r), 'Step 15 of 15: The end');
  assert.equal(lapText(r), 'Circuit complete');
  assert.equal(primaryLabel(r), 'Free play');
  assert.equal(canForward(r).ok, true, 'Free play lies beyond it');
});

test('MOCK: each room, what happened, and that no model was called', () => {
  const rooms = closingRooms({ road: endRoad(false), mode: 'mock', levels: [...SAMPLES, null] });
  assert.deepEqual(rooms.map((r) => r.heading), ['First room', 'Second room', 'Third room', 'Your own room']);
  assert.deepEqual(rooms.map((r) => r.title), ['The Desk Top', 'The Living Room', 'The Apartment', null]);
  assert.deepEqual(rooms.map((r) => r.result), ['Won · best route 1.2 times the shortest', 'Lost on the road', 'Won · best route 1.5 times the shortest', 'Not made']);
  for (const k of [0, 1, 2]) assert.equal(rooms[k].ai, 'Sample room drawn by code; no model was called.');
  assert.equal(rooms[3].ai, 'No room was made from a photo of your own, and nothing was invented.');
  assert.deepEqual(rooms.map((r) => r.playable), [true, true, true, false]);
  assert.equal(resultLine({ best: [1.02], finished: [true] }, 0), 'Won · by the shortest route');
  assert.equal(resultLine({ best: [null], finished: [false] }, 0), 'Not played yet');
});

test('LIVE: your own room says what the models did, in one sentence', () => {
  const rooms = closingRooms({
    road: endRoad(true), mode: 'live',
    levels: [...SAMPLES, level('live', 'Morning desk', 7)],
    summaries: [null, null, null, { named: 6 }],
  });
  assert.equal(rooms[3].title, 'Morning desk');
  assert.equal(rooms[3].result, 'Won · by the shortest route');
  assert.equal(rooms[3].ai, 'Muse Spark named 6 things in your photo and gave each a role, SAM 3.1 found 7 of them, and code traced 7 outlines inside SAM’s boxes and kept 0 as boxes, then proved the room can be won.');
  assert.equal((rooms[3].ai.match(/\.\s/g) || []).length, 0, 'one sentence');
  const reh = closingRooms({ road: endRoad(true), mode: 'rehearsal', levels: [...SAMPLES, level('rehearsal', 'The Desk Top', 9, 1)] });
  assert.equal(reh[3].ai, 'The local stand-in (not Meta) answered for its sample picture; code traced 8 outlines inside SAM’s boxes and kept 1 as a box, and proved the room can be won.');
  // the counts are the level's own, never the number of objects
  const boxed = closingRooms({ road: endRoad(true), mode: 'live', levels: [...SAMPLES, level('live', 'Boxes', 4, 4)], summaries: [null, null, null, { named: 4 }] });
  assert.match(boxed[3].ai, /code traced 0 outlines inside SAM’s boxes and kept 4 as boxes/);
  const gone = closingRooms({ road: endRoad(true), mode: 'live', levels: [...SAMPLES, null] });
  assert.match(gone[3].ai, /not in memory on this visit; pick the same photo again on Step 12/);
  assert.equal(gone[3].playable, false);
});

test('your own room passed by after it was made stays made, played and playable', () => {
  const made = { ...endRoad(true), own: 'skipped' };
  const rooms = closingRooms({ road: made, mode: 'rehearsal', levels: [...SAMPLES, level('rehearsal', 'The Desk Top', 9)] });
  assert.equal(rooms[3].result, 'Won · by the shortest route');
  assert.equal(rooms[3].playable, true);
  assert.match(texts(closingView({ rooms, mode: 'rehearsal', primaryLabel: 'Free play', actions: {} })), /four rooms/);
  const none = closingRooms({ road: endRoad(false), mode: 'rehearsal', levels: [...SAMPLES, null] });
  assert.equal(none[3].result, 'Not made', 'nothing in the slot: not made');
});

// Every action the page wires to the road, in random order: a room in the
// own slot is never reported "Not made", and a round played in it is
// reported won or lost.
test('no sequence of road actions turns a made own room into "Not made"', () => {
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) % n; };
  const photos = [mine, { kind: 'photo', sha256: 'cd'.repeat(32) }];
  const L = level('rehearsal', 'A room', 5);
  const actions = {
    primary: (r) => {
      switch (r.step) {
        case 1: return R.giveConsent(r);
        case 2: return R.chooseRoom(r, 0, [desk, living, apartment][rand(3)]);
        case 5: return R.chooseRoom(r, 1, [desk, living, apartment][rand(3)]);
        case 8: return R.chooseRoom(r, 2, [desk, living, apartment][rand(3)]);
        case 12: return rand(2) ? R.chooseRoom(r, 3, photos[rand(2)]) : R.passOwnRoom(r);
        case 3: case 6: case 9: case 13: return R.startPlay(r);
        case 4: case 7: case 10: case 14: return R.continueAfterRound(R.finishRound(r, R.slotOf(r.step), rand(2) ? { status: 'won', ratio: 1 + rand(3) } : { status: 'lost' }));
        case 11: return R.toOwnRoom(r);
        case 15: return R.startFreePlay(r);
        default: return r;
      }
    },
    forward: (r) => R.forward(r),
    back: (r) => R.back(r),
    round: (r) => (R.stepKind(r.step) === 'play' ? R.finishRound(r, R.slotOf(r.step), { status: rand(2) ? 'won' : 'lost', ratio: 1.5 }) : r),
    newPhoto: (r) => (R.stepKind(r.step) === 'play' && r.finished[R.slotOf(r.step)] ? { ...r, step: R.PICK_STEPS[R.slotOf(r.step)] } : r),
    tryOwn: (r) => (r.step === LAST_STEP ? { ...r, step: R.OWN_STEP } : r),
    continueToEnd: (r) => R.passOwnRoom(r),
    reload: (r) => R.sanitizeRoad(JSON.parse(JSON.stringify(r))),
  };
  const names = Object.keys(actions);
  let hits = 0;
  for (let run = 0; run < 400; run++) {
    let r = newRoad();
    for (let k = 0; k < 80; k++) {
      r = actions[names[rand(names.length)]](r);
      const rooms = closingRooms({ road: r, mode: 'rehearsal', levels: [L, L, L, r.rooms[3] ? L : null] });
      if (r.rooms[3]) { hits++; assert.notEqual(rooms[3].result, 'Not made', JSON.stringify(r)); }
      if (r.finished[3]) assert.match(rooms[3].result, /^(Won|Lost)/, JSON.stringify(r));
      // no sample room is ever on the road twice
      const ids = r.rooms.slice(0, 3).filter((x) => x && x.kind === 'sample').map((x) => x.id);
      assert.equal(new Set(ids).size, ids.length, JSON.stringify(r));
    }
  }
  assert.ok(hits > 1000, `the own room was made often enough to tell (${hits})`);
});

// Every room whose level is not in memory, in every slot, kind and mode:
// its line names the step it was picked on, says what it was, and gives an
// instruction only where this mode can make it again.
test('a room not in memory names its own step, and only what this mode can do', () => {
  // the running stand-in answers for the desk: it can make the desk again,
  // never a room another sample's stand-in made
  const kinds = { photo: mine, rehearsal: { kind: 'rehearsal', id: 'desk' }, 'other stand-in': { kind: 'rehearsal', id: 'living' } };
  for (const slot of [0, 1, 2, 3]) {
    for (const [kind, ref] of Object.entries(kinds)) {
      for (const mode of ['live', 'rehearsal', 'mock']) {
        const rooms = [desk, living, apartment, null];
        rooms[slot] = ref;
        const road = { ...endRoad(true), rooms, own: null };
        const line = closingRooms({ road, mode, room: mode === 'rehearsal' ? 'desk' : null, levels: [null, null, null, null] })[slot].ai;
        const at = `slot ${slot}, ${kind}, ${mode}: ${line}`;
        for (const m of line.matchAll(/Step (\d+)/g)) assert.equal(+m[1], R.PICK_STEPS[slot], at);
        if (/photo/.test(line)) assert.equal(kind, 'photo', at);
        if (/through the stand-in/.test(line)) assert.equal(kind, 'rehearsal', at);
        const remakes = kind === 'photo' ? mode === 'live' || (slot === 3 && mode === 'rehearsal') : kind === 'rehearsal' && mode === 'rehearsal';
        if (!remakes) {
          assert.doesNotMatch(line, /pick|send|Step/, at);
          assert.match(line, /this copy cannot make it again/, at);
        } else {
          assert.match(line, /pick|send/, at);
        }
      }
    }
  }
  const one = (slot, ref, mode, room = null) => {
    const rooms = [desk, living, apartment, null];
    rooms[slot] = ref;
    return closingRooms({ road: { ...endRoad(true), rooms }, mode, room, levels: [null, null, null, null] })[slot].ai;
  };
  assert.match(one(0, mine, 'live'), /pick the same photo again on Step 2/);
  assert.match(one(1, { kind: 'rehearsal', id: 'living' }, 'rehearsal', 'living'), /send it through the stand-in again on Step 5/);
  assert.match(one(1, { kind: 'rehearsal', id: 'living' }, 'rehearsal', 'desk'), /this copy cannot make it again/, 'the desk’s stand-in cannot make the living room');
  assert.match(one(2, mine, 'live'), /pick the same photo again on Step 8/);
  assert.match(one(3, mine, 'live'), /pick the same photo again on Step 12/);
  // a level kept here by the other mode cannot load, and this copy cannot
  // make the room again; in REHEARSAL only the stand-in's own picture can
  const own = (mode, kept) => closingRooms({ road: { ...endRoad(true), rooms: [desk, living, apartment, mine] }, mode, kept: [null, null, null, kept], levels: [null, null, null, null] })[3].ai;
  assert.match(own('rehearsal', 'live'), /this copy cannot make it again\.$/);
  assert.match(own('live', 'rehearsal'), /this copy cannot make it again\.$/);
  assert.match(own('rehearsal', 'rehearsal'), /only the stand-in’s own sample picture can be made again/);
  assert.match(own('rehearsal', null), /only the stand-in’s own sample picture can be made again/);
  assert.match(own('live', 'live'), /pick the same photo again on Step 12 to see it\.$/);
  // the opening line counts the rooms on the road, not those in memory
  const photos = { ...endRoad(true), rooms: [mine, { kind: 'photo', sha256: 'cd'.repeat(32) }, apartment, { kind: 'photo', sha256: 'ef'.repeat(32) }] };
  const rows = closingRooms({ road: photos, mode: 'live', levels: [null, null, null, null] });
  assert.match(texts(closingView({ rooms: rows, mode: 'live', primaryLabel: 'Free play', actions: {} })), /That is the whole road: four rooms, and what the AI did in each\./);
  const mock = closingRooms({ road: endRoad(false), mode: 'mock', levels: [...SAMPLES, null] });
  const mockText = texts(closingView({ rooms: mock, mode: 'mock', primaryLabel: 'Free play', actions: {} }));
  assert.match(mockText, /That is the whole road: three rooms, and how each was made\./, 'MOCK: no AI did anything');
  assert.equal((mockText.match(/no model reads a photo/g) || []).length, 1, 'one sentence on why, and what your own room is in MOCK');
  assert.match(mockText, /your own room is a photo you mark yourself\.$/, 'with no server to replay ours, only marking is offered');
  const withReplay = texts(closingView({ rooms: mock, mode: 'mock', primaryLabel: 'Free play', actions: {}, canReplay: true }));
  assert.match(withReplay, /In MOCK no model reads a photo: your own room is a photo you mark yourself, or ours, with Meta’s recorded answer replayed\./);
});

function view(mode, own) {
  const calls = [];
  const levels = [...SAMPLES, own ? level(mode, 'A long title for a photo of my own room', 7) : null];
  const rooms = closingRooms({ road: endRoad(own), mode, levels, summaries: [null, null, null, { named: 8 }] });
  const actions = {
    freePlay: () => calls.push('free'), playAgain: (ref, t) => calls.push(['again', ref, t]),
    ownRoom: () => calls.push('own'), startOver: () => calls.push('over'),
  };
  return { section: closingView({ rooms, mode, primaryLabel: 'Free play', actions }), calls };
}

test('one heading, one primary, real buttons for every way on; MOCK says what your own room is there', () => {
  const { section, calls } = view('mock', false);
  const h1 = all(section).filter((e) => e.tagName === 'H1');
  assert.equal(h1.length, 1);
  assert.equal(h1[0].textContent, 'You’ve completed FRAME//PLAY');
  const buttons = all(section).filter((e) => e.tagName === 'BUTTON');
  const primary = buttons.filter((b) => b.hasAttribute('data-primary'));
  assert.deepEqual(primary.map((b) => b.textContent), ['Free play']);
  // the accessible name starts with the visible words (label in name)
  assert.deepEqual(buttons.map(nameOf), ['Play again: The Desk Top', 'Play again: The Living Room', 'Play again: The Apartment', 'Free play', 'Try your own room', 'Start over']);
  assert.ok(buttons.every((b) => !b.hasAttribute('aria-label')), 'no label that hides the visible words');
  assert.ok(buttons.every((b) => b.getAttribute('type') === 'button' && b.dataset.tip && b.getAttribute('aria-describedby')), 'keyboard buttons with words for screen readers');
  // in MOCK your own room is a photo you mark yourself, so it is offered too
  assert.match(texts(section), /In MOCK no model reads a photo: your own room is a photo you mark yourself\./);
  assert.doesNotMatch(texts(section), /needs the live AI/);
  const list = all(section).find((e) => e.tagName === 'UL');
  assert.equal(list.getAttribute('aria-label'), 'The rooms you played');
  assert.equal(list.children.length, 4);
  for (const b of buttons) b.click();
  assert.deepEqual(calls, [['again', desk, 'The Desk Top'], ['again', living, 'The Living Room'], ['again', apartment, 'The Apartment'], 'free', 'own', 'over']);
});

test('every mode offers Try your own room (in MOCK it is marked by hand)', () => {
  for (const mode of ['live', 'rehearsal', 'mock']) {
    const { section, calls } = view(mode, true);
    const b = all(section).find((e) => e.tagName === 'BUTTON' && e.textContent === 'Try your own room');
    assert.ok(b, mode);
    b.click();
    assert.deepEqual(calls, ['own']);
    const again = all(section).filter((e) => e.tagName === 'BUTTON' && nameOf(e).startsWith('Play again: ')).map(nameOf);
    assert.deepEqual(again, ['Play again: The Desk Top', 'Play again: The Living Room', 'Play again: The Apartment', 'Play again: your own room'], 'your own room by its row');
  }
});

// Modeled with the stylesheet's cascade (tests/layoutmodel.js), with text
// wrapped a little wider than the real font: the closing screen fits main
// without scrolling at 100% zoom.
test('the closing screen fits without scrolling at 839x945 and 1259x1418', () => {
  for (const [vw, vh] of [[839, 945], [1259, 1418]]) {
    for (const [mode, own] of [['mock', false], ['live', true], ['rehearsal', true]]) {
      const head = header({ lap: 'Circuit complete', counter: 'Step 15 of 15: The end', why: '', band: mode === 'rehearsal' ? 'REHEARSAL · local stand-in, not Meta. No photo leaves this machine.' : null });
      const { space, width, layout } = mainSpace(vw, vh, head, mode);
      const h = screenHeight(layout, view(mode, own).section, width);
      assert.ok(h <= space, `${vw}x${vh} ${mode}: ${Math.round(h)}px of content in ${Math.round(space)}px`);
    }
    // a LIVE road of four photos reopened: every level missing
    const head = header({ lap: 'Circuit complete', counter: 'Step 15 of 15: The end', why: '' });
    const { space, width, layout } = mainSpace(vw, vh, head, 'live');
    const road = { ...endRoad(true), rooms: [mine, { kind: 'photo', sha256: 'cd'.repeat(32) }, { kind: 'photo', sha256: '12'.repeat(32) }, { kind: 'photo', sha256: 'ef'.repeat(32) }] };
    const rooms = closingRooms({ road, mode: 'live', levels: [null, null, null, null] });
    const h = screenHeight(layout, closingView({ rooms, mode: 'live', primaryLabel: 'Free play', actions: {} }), width);
    assert.ok(h <= space, `${vw}x${vh} all missing: ${Math.round(h)}px of content in ${Math.round(space)}px`);
  }
});
