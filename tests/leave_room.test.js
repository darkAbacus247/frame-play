// A clear way out of a room, on the real app.js (tests/apphost.js): every
// reveal step (3, 6, 9, 13) and play step (4, 7, 10, 14) has a plainly
// labelled secondary button back to that room's pick step (2, 5, 8, 12); a round under
// way asks first in a true modal card; the naive walker, who presses only
// the one emphasized control, walks the road exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, stopApps, textOf, photoFile } from './apphost.js';
import { played } from './stub_game.js';
import { replyFor } from './replies.js';
import { LEAVE_WORDS, LEAVE_CARD, foundView, leaveButton } from '../src/screens.js';
import { installFakeDocument } from './fakedom.js';
import { mockLevel } from './screenset.js';

const DESK = { kind: 'sample', id: 'desk' };
const LIVING = { kind: 'sample', id: 'living' };
const APARTMENT = { kind: 'sample', id: 'apartment' };
const roadAt = (step, rooms, finished = [false, false, false, false]) => ({
  v: 4, step, reached: step, consent: true, own: null, rooms, finished, best: [null, null, null, null],
});
const AT12 = roadAt(12, [DESK, LIVING, APARTMENT, null], [true, true, true, false]);

async function at(road, opts = {}) {
  const app = await bootApp({ mode: 'mock', road, ...opts });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  return app;
}

// your own room read through the live path: Step 13, then Step 14
async function ownRoom(play = false) {
  const app = await at(AT12, { mode: 'live', answer: () => replyFor('desk', 'live') });
  app.choose(photoFile(61));
  for (let i = 0; i < 200 && app.step() !== 13; i++) await app.settle(2);
  assert.equal(app.step(), 13, 'read and built');
  if (play) { app.mainPrimary().click(); await app.settle(); assert.equal(app.step(), 14); }
  return app;
}

const leaveOf = (app) => app.$('main').querySelectorAll('button').filter((b) => LEAVE_WORDS.includes(textOf(b)));
const primaries = (app) => app.$('main').querySelectorAll('[data-primary]').map(textOf);
const cardButtons = (app) => app.$('card').querySelectorAll('button').map(textOf);

function plainSecondary(app, label) {
  const found = leaveOf(app);
  assert.equal(found.length, 1, 'one way out');
  const b = found[0];
  assert.equal(textOf(b), label);
  assert.ok(!b.hasAttribute('data-primary') && !b.classList.contains('primary'), 'a secondary, never the primary');
  assert.ok(!b.hasAttribute('data-tour'), 'never a tour target');
  assert.ok(!b.disabled);
  return b;
}

const SAMPLE_STEPS = [
  { step: 3, rooms: [DESK, null, null, null], back: 2 },
  { step: 4, rooms: [DESK, null, null, null], back: 2 },
  { step: 6, rooms: [DESK, LIVING, null, null], back: 5, finished: [true, false, false, false] },
  { step: 7, rooms: [DESK, LIVING, null, null], back: 5, finished: [true, false, false, false] },
  { step: 9, rooms: [DESK, LIVING, APARTMENT, null], back: 8, finished: [true, true, false, false] },
  { step: 10, rooms: [DESK, LIVING, APARTMENT, null], back: 8, finished: [true, true, false, false] },
];

for (const s of SAMPLE_STEPS) {
  test(`Step ${s.step}: Choose a different room, a plain secondary, goes back to Step ${s.back} to pick again`, async () => {
    const app = await at(roadAt(s.step, s.rooms, s.finished));
    assert.equal(app.step(), s.step);
    plainSecondary(app, 'Choose a different room').click();
    await app.settle();
    assert.ok(!app.cardOpen(), 'no round under way: nothing to ask');
    assert.equal(app.step(), s.back);
    assert.equal(app.savedRoad().step, s.back);
    assert.ok(app.$('main').querySelectorAll('.room-card').length >= 2, 'the room cards, to pick again');
    // the room on the road stays until another is picked: its card says so,
    // and the one primary goes on with it
    assert.deepEqual(app.savedRoad().rooms, s.rooms);
    assert.equal(app.$('main').querySelectorAll('.room-card[aria-current]').length, 1);
    assert.match(primaries(app)[0], /^Continue with The /);
  });
}

for (const play of [false, true]) {
  test(`Step ${play ? 14 : 13}: your own room offers Choose a different photo, back to Step 12`, async () => {
    const app = await ownRoom(play);
    plainSecondary(app, 'Choose a different photo').click();
    await app.settle();
    assert.equal(app.step(), 12);
    assert.ok(app.button('Choose a photo'), 'the picker, to choose again');
  });
}

test('on a reveal the one primary is still Play this room, and the way out sits in its row of buttons', async () => {
  const app = await at(roadAt(3, [DESK, null, null, null]));
  assert.deepEqual(primaries(app), ['Play this room']);
  const row = app.$('main').querySelector('.found-info .actions');
  assert.ok(row.contains(leaveOf(app)[0]));
});

test('a round under way asks first: a true modal card, Keep playing focused, Escape never closes it', async () => {
  const app = await at(roadAt(4, [DESK, null, null, null]));
  played.view.state = { status: 'playing', travelled: 140, auto: null, collected: [true, false] };
  const before = played.view.focused;
  plainSecondary(app, 'Choose a different room').click();
  await app.settle(3);
  assert.ok(app.cardOpen(), 'the card asks');
  assert.equal(`${LEAVE_CARD.title} ${LEAVE_CARD.line}`, 'Leave this room? Your round so far is not kept.');
  assert.ok(textOf(app.$('card')).startsWith('Leave this room? Your round so far is not kept.'));
  assert.deepEqual(cardButtons(app).sort(), ['Keep playing', 'Leave']);
  assert.equal(textOf(app.doc.activeElement), 'Keep playing', 'Keep playing has the focus');
  assert.equal(textOf(app.cardPrimary()), 'Keep playing', 'staying is the default; leaving is never emphasized');
  app.doc.pressKey('Escape');
  app.doc.pressKey('Escape');
  assert.ok(app.cardOpen(), 'Escape twice: still open');
  assert.equal(app.step(), 4);
  // the round holds still under the card
  assert.equal(played.last.paused(), true);
  app.cardPrimary().click();
  await app.settle();
  assert.ok(!app.cardOpen());
  assert.equal(app.step(), 4, 'Keep playing keeps the round');
  assert.equal(played.view.focused, before + 1, 'and gives the board its focus back');
  plainSecondary(app, 'Choose a different room').click();
  await app.settle(3);
  app.$('card').querySelectorAll('button').find((b) => textOf(b) === 'Leave').click();
  await app.settle();
  assert.ok(!app.cardOpen());
  assert.equal(app.step(), 2, 'Leave goes back to pick');
});

test('a round not started, or already over, is left without asking', async () => {
  for (const state of [{ status: 'playing', travelled: 0, auto: null, collected: [false] }, { status: 'won', travelled: 900, auto: null, collected: [true] }]) {
    const app = await at(roadAt(7, [DESK, LIVING, null, null], [true, false, false, false]));
    played.view.state = state;
    plainSecondary(app, 'Choose a different room').click();
    await app.settle();
    assert.ok(!app.cardOpen(), state.status);
    assert.equal(app.step(), 5);
  }
});

test('a walk set off counts as a round under way', async () => {
  const app = await at(roadAt(4, [DESK, null, null, null]));
  played.view.state = { status: 'playing', travelled: 0, auto: { points: [[1, 1]], i: 0, k: 0 }, collected: [false] };
  plainSecondary(app, 'Choose a different room').click();
  await app.settle(3);
  assert.ok(app.cardOpen());
});

test('Free play has no way out of the road: its own end card picks another room', async () => {
  const app = await at({ ...roadAt(15, [DESK, LIVING, APARTMENT, null], [true, true, true, false]), own: 'skipped' });
  app.button('Play again: The Desk Top').click();
  await app.settle();
  assert.equal(app.step(), 16);
  assert.deepEqual(leaveOf(app), []);
});

// The naive walker presses only the one emphasized control: the main
// area's primary, the card's primary, a room card on a pick step, and the
// board's end of round. It plays the three sample rooms in a row, the end
// card taking it straight to each next room's reveal, and never meets a
// way out as the emphasized control.
test('the naive walker never meets the way out as the emphasized control', async () => {
  const app = await bootApp({ mode: 'mock' });
  const seen = [];
  for (let i = 0; i < 80 && app.step() !== 15; i++) {
    const step = app.step();
    if (seen[seen.length - 1] !== step) seen.push(step);
    for (const b of leaveOf(app)) {
      assert.ok(!b.hasAttribute('data-primary') && !b.hasAttribute('data-tour'), `Step ${step}`);
    }
    if (app.cardOpen()) app.cardPrimary().click();
    else if (app.mainPrimary()) app.mainPrimary().click();
    else if (app.$('main').querySelector('.room-card:not([disabled])')) app.$('main').querySelector('.room-card:not([disabled])').click();
    else if (app.$('main').querySelector('.game')) played.last.onEnd({ status: 'won', ratio: 1, words: { title: 'Room cleared!', body: 'You took the shortest route.' } });
    await app.settle(3);
  }
  assert.deepEqual([...seen, app.step()], [1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 15]);
});

test('foundView: the way out only when the page hands one in, by slot', () => {
  // a bare document: the booted pages' timers must not run against it
  stopApps();
  installFakeDocument();
  const noop = () => {};
  const level = mockLevel('desk');
  const without = foundView({ level, summary: null, fromDevice: false, actions: { play: noop, describe: noop, walls: noop } });
  assert.ok(!without.section.querySelectorAll('button').some((b) => LEAVE_WORDS.includes(textOf(b))));
  let pressed = 0;
  const own = foundView({ level, summary: null, fromDevice: false, slot: 3, actions: { play: noop, describe: noop, walls: noop, leave: () => pressed++ } });
  const b = own.section.querySelectorAll('button').find((x) => textOf(x) === 'Choose a different photo');
  b.click();
  assert.equal(pressed, 1);
  assert.equal(textOf(leaveButton(0, noop)), 'Choose a different room');
  assert.equal(textOf(leaveButton(1, noop)), 'Choose a different room');
  assert.equal(textOf(leaveButton(2, noop)), 'Choose a different room');
  assert.match(leaveButton(1, noop).dataset.tip, /^Back to Step 5,/);
  assert.match(leaveButton(2, noop).dataset.tip, /^Back to Step 8,/);
  assert.match(leaveButton(3, noop).dataset.tip, /^Back to Step 12,/);
});
