// A sure way to completion. Every Play step on the road offers a plainly
// labelled secondary, End this round, behind a true modal card ("End this
// round? It counts as played, not won.", End it and Keep playing, Keep
// playing focused, Escape never closes it); ended, the round counts as
// played, not won, and the road goes on. Every path, in every mode, ends on
// the closing screen after the last room, and the closing screen
// celebrates: the music's sting and confetti once on arrival (none with
// Effects off or Reduce motion) and one line of the rooms won.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, textOf, paintCanvases, until } from './apphost.js';
import { played } from './stub_game.js';
import { roadAt, DESK, LIVING, APARTMENT, SAMPLE_ROOMS, AT_OWN } from './roads.js';
import { replayReply, liveKitchenReply, KITCHEN_PIXELS } from './kitchen.js';
import { OURS_REF } from '../src/own.js';
import * as R from '../src/road.js';
import { END_ROUND, END_CARD, endRoundButton, wonLine, closingRooms } from '../src/screens.js';
import { installFakeDocument } from './fakedom.js';

const CLOSING = 'You’ve completed FRAME//PLAY';
const won = (ratio = 1) => ({ status: 'won', ratio, words: { title: 'Room cleared!', body: 'Well done.' } });
const secondary = (app, name) => app.$('main').querySelectorAll('button').find((b) => textOf(b) === name && !b.hasAttribute('data-primary')) || null;
const cardButtons = (app) => app.$('card').querySelectorAll('button').map(textOf);

async function at(road, opts = {}) {
  const app = await bootApp({ road, ...opts });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  return app;
}

async function endIt(app) {
  secondary(app, END_ROUND).click();
  await app.settle(3);
  assert.ok(app.cardOpen(), 'the card asks');
  app.$('card').querySelectorAll('button').find((b) => textOf(b) === END_CARD.end).click();
  await app.settle();
}

// ---- the road ----

test('the road: a round ended counts as played, not won, and the road goes on from every Play step', () => {
  const start = { ...R.newRoad(), consent: true, rooms: [...SAMPLE_ROOMS, OURS_REF], best: [1.4, null, null, null] };
  const goesTo = { 4: 6, 7: 9, 10: R.THREE_STEP, 14: R.LAST_STEP };
  for (const [step, next] of Object.entries(goesTo)) {
    const road = { ...start, step: +step, reached: +step };
    const slot = R.slotOf(road.step);
    assert.equal(R.canForward(road).ok, false, `Step ${step}: waits for the round`);
    const ended = R.finishRound(road, slot, { status: 'lost' });
    assert.equal(ended.finished[slot], true);
    assert.equal(ended.best[slot], road.best[slot], 'not won: a best from before stays, no new one');
    assert.equal(R.continueAfterRound(ended).step, next, `Step ${step} goes on to Step ${next}`);
  }
});

test('the road: every own room, made or not, ends on the closing screen', () => {
  const base = { ...R.newRoad(), consent: true, rooms: [...SAMPLE_ROOMS, null], finished: [true, true, true, false] };
  const own = (ref) => ({ ...base, rooms: [...SAMPLE_ROOMS, ref] });
  const photo = { kind: 'photo', sha256: 'ab'.repeat(32) };
  // made from a photo, from our kitchen, or marked by you: played (or ended) on Step 14
  for (const ref of [photo, OURS_REF, { kind: 'marked', sha256: 'cd'.repeat(32), made: true }]) {
    const r = { ...own(ref), step: R.OWN_STEP + 2, reached: R.OWN_STEP + 2 };
    assert.equal(R.continueAfterRound(R.finishRound(r, R.OWN_SLOT, { status: 'lost' })).step, R.LAST_STEP, ref.kind);
  }
  // skipped, on Step 12; marks not made into a room, on Step 13
  assert.equal(R.passOwnRoom({ ...base, step: R.OWN_STEP }).step, R.LAST_STEP);
  assert.equal(R.passOwnRoom({ ...own({ kind: 'marked', sha256: 'cd'.repeat(32), made: false }), step: R.OWN_STEP + 1 }).step, R.LAST_STEP);
  assert.equal(R.stepKind(R.LAST_STEP), 'end');
});

test('the words: End this round, its card, and the line of rooms won', () => {
  installFakeDocument();
  assert.equal(END_ROUND, 'End this round');
  assert.equal(`${END_CARD.title} ${END_CARD.line}`, 'End this round? It counts as played, not won.');
  assert.deepEqual([END_CARD.end, END_CARD.stay], ['End it', 'Keep playing']);
  const b = endRoundButton(() => {});
  assert.equal(b.hasAttribute('data-primary'), false, 'a secondary');
  assert.equal(b.hasAttribute('data-tour'), false, 'never a tour target');
  const rows = (bests, own = true) => closingRooms({ road: { ...R.newRoad(), step: R.LAST_STEP, rooms: [...SAMPLE_ROOMS, own ? OURS_REF : null], finished: [true, true, true, own], best: bests }, mode: 'mock', levels: [null, null, null, null] });
  assert.equal(wonLine(rows([1, 1.2, 1, 1.1])), 'You won all four rooms.');
  assert.equal(wonLine(rows([1, null, 1.6, null])), 'You won two of your four rooms.');
  assert.equal(wonLine(rows([null, null, null, null])), 'You won none of your four rooms.');
  assert.equal(wonLine(rows([1, 1, null, null], false)), 'You won two of your three rooms.', 'your own room not made is not counted');
});

// ---- on the page ----

test('End this round on a Play step: a secondary, a true modal card with Keep playing focused, Escape never closes it', async () => {
  const app = await at(roadAt(4, { rooms: [DESK, null, null, null] }));
  assert.equal(app.step(), 4);
  const b = secondary(app, END_ROUND);
  assert.ok(b, 'plainly labelled, in the side column');
  assert.ok(!b.hasAttribute('data-tour'));
  assert.equal(app.mainPrimary(), null, 'no primary moves the counter while a round is under way');
  const focused = played.view.focused;
  b.click();
  await app.settle(3);
  assert.ok(app.cardOpen());
  assert.ok(textOf(app.$('card')).startsWith('End this round? It counts as played, not won.'));
  assert.deepEqual(cardButtons(app).sort(), ['End it', 'Keep playing']);
  assert.equal(textOf(app.cardPrimary()), 'Keep playing', 'staying is the emphasized control');
  assert.equal(textOf(app.doc.activeElement), 'Keep playing', 'and has the focus');
  app.doc.pressKey('Escape');
  app.doc.pressKey('Escape');
  assert.ok(app.cardOpen(), 'Escape never closes it');
  assert.equal(played.last.paused(), true, 'the round holds still under it');
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 4, 'Keep playing keeps the round');
  assert.equal(played.view.focused, focused + 1, 'and gives the board its focus back');
  assert.equal(app.savedRoad().finished[0], false);
  await endIt(app);
  assert.equal(app.step(), 6, 'ended: straight on to the next room');
  const road = app.savedRoad();
  assert.equal(road.finished[0], true, 'played');
  assert.equal(road.best[0], null, 'not won');
  assert.deepEqual(road.rooms[1], LIVING);
});

test('End this round is on every Play step of the road, and never in Free play', async () => {
  for (const step of [4, 7, 10]) {
    const rooms = [DESK, LIVING, APARTMENT, null];
    const app = await at(roadAt(step, { rooms, finished: [step > 4, step > 7, false, false] }));
    assert.equal(app.step(), step);
    assert.ok(secondary(app, END_ROUND), `Step ${step}`);
  }
  const free = await at(roadAt(R.FREE_PLAY, { rooms: [...SAMPLE_ROOMS, null], finished: [true, true, true, false], own: 'skipped' }));
  free.$('main').querySelector('.room-card').click();
  await free.settle();
  assert.ok(free.$('main').querySelector('.game'));
  assert.equal(secondary(free, END_ROUND), null, 'rounds in Free play leave the road as it is');
});

test('the stranger walk still reaches the closing screen with zero wrong turns, and so does a walk that wins nothing', async () => {
  // the stranger presses only the one emphasized control (and wins each round)
  const app = await bootApp({ mode: 'mock' });
  const seen = [];
  for (let i = 0; i < 80 && app.step() !== R.LAST_STEP; i++) {
    const step = app.step();
    if (seen[seen.length - 1] !== step) seen.push(step);
    if (app.cardOpen()) app.cardPrimary().click();
    else if (app.mainPrimary()) app.mainPrimary().click();
    else if (app.$('main').querySelector('.room-card:not([disabled])')) app.$('main').querySelector('.room-card:not([disabled])').click();
    else if (app.$('main').querySelector('.game')) played.last.onEnd(won());
    await app.settle(3);
  }
  assert.deepEqual([...seen, app.step()], [1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 15]);
  assert.equal(app.h1(), CLOSING);
  assert.match(app.main(), /You won all three rooms\./);
  // a player who wins nothing ends every round, and still completes the road
  const quitter = await bootApp({ mode: 'mock' });
  const path = [];
  for (let i = 0; i < 80 && quitter.step() !== R.LAST_STEP; i++) {
    const step = quitter.step();
    if (path[path.length - 1] !== step) path.push(step);
    if (quitter.cardOpen()) quitter.cardPrimary().click();
    else if (quitter.$('main').querySelector('.game')) { await endIt(quitter); continue; }
    else if (quitter.mainPrimary()) quitter.mainPrimary().click();
    else quitter.$('main').querySelector('.room-card:not([disabled])').click();
    await quitter.settle(3);
  }
  assert.deepEqual([...path, quitter.step()], [1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 15]);
  assert.equal(quitter.h1(), CLOSING);
  assert.match(quitter.main(), /You won none of your three rooms\./);
  assert.deepEqual(quitter.$('main').querySelectorAll('.closing-rooms .result').map(textOf).slice(0, 3), ['Lost on the road', 'Lost on the road', 'Lost on the road']);
});

// Every path to the end, in every mode: your own room from a chosen photo
// (LIVE reads our kitchen as a chosen photo is read), from our kitchen
// replayed, marked by you, or passed by.
test('every path ends on the closing screen: your own room read fresh, replayed, marked or passed by, in each mode', async () => {
  // LIVE: read fresh through the very path a chosen photo takes, then ended
  const live = await at(AT_OWN, { mode: 'live', answer: () => liveKitchenReply(), replay: replayReply });
  paintCanvases(live, KITCHEN_PIXELS);
  try {
    live.$('main').querySelector('.ours-card').click();
    await until(live, () => live.step() === R.OWN_STEP + 1, 'the room read fresh', 120000);
  } finally { delete globalThis.createImageBitmap; }
  live.mainPrimary().click(); await live.settle();
  await endIt(live);
  assert.equal(live.step(), R.LAST_STEP);
  assert.equal(live.h1(), CLOSING);
  assert.match(textOf(live.$('main').querySelectorAll('.closing-rooms li')[3]), /^Your own room: our kitchen Lost on the road/);
  // MOCK and REHEARSAL: replayed, then won (REHEARSAL) or ended (MOCK)
  for (const mode of ['mock', 'rehearsal']) {
    const app = await at(AT_OWN, { mode, server: true, replay: replayReply });
    paintCanvases(app, KITCHEN_PIXELS);
    try {
      app.$('main').querySelector('.ours-card').click();
      await until(app, () => app.step() === R.OWN_STEP + 1, 'the replayed room', 120000);
    } finally { delete globalThis.createImageBitmap; }
    app.mainPrimary().click(); await app.settle();
    if (mode === 'mock') await endIt(app);
    else {
      played.last.onEnd(won(1.2));
      await app.settle(3);
      app.cardPrimary().click(); await app.settle();
    }
    assert.equal(app.step(), R.LAST_STEP, mode);
    assert.equal(app.h1(), CLOSING, mode);
  }
  // marked by you (its level not in memory on this visit): the way on is to the end
  for (const mode of ['mock', 'rehearsal', 'live']) {
    const road = roadAt(R.OWN_STEP + 2, { rooms: [...SAMPLE_ROOMS, { kind: 'marked', sha256: 'cd'.repeat(32), made: true }], finished: [true, true, true, false] });
    const app = await at(road, { mode });
    app.button('Continue to the end').click(); await app.settle();
    assert.equal(app.step(), R.LAST_STEP, `${mode}: marked`);
    assert.equal(app.h1(), CLOSING);
  }
  // passed by, in each mode
  for (const mode of ['mock', 'rehearsal', 'live']) {
    const app = await at(AT_OWN, { mode });
    app.button('Continue to the end').click(); await app.settle();
    assert.equal(app.step(), R.LAST_STEP, `${mode}: passed by`);
    assert.equal(app.h1(), CLOSING);
  }
});

test('the closing screen celebrates once on each arrival: confetti over it, none with Reduce motion or Effects off', async () => {
  const end = roadAt(R.LAST_STEP, { rooms: [...SAMPLE_ROOMS, null], finished: [true, true, true, false], best: [1, null, 1.3, null], own: 'skipped' });
  const app = await at(end);
  assert.equal(app.h1(), CLOSING);
  const layers = () => app.$('main').querySelectorAll('.closing .closing-fx');
  assert.equal(layers().length, 1, 'confetti, laid over the closing screen');
  assert.equal(layers()[0].getAttribute('aria-hidden'), 'true');
  assert.match(app.main(), /You won two of your three rooms\. Here is how each was made\./, 'one line of the rooms won');
  // back, and on again: a new arrival celebrates again
  app.back(); await app.settle();
  assert.equal(app.step(), R.OWN_STEP);
  app.button('Continue to the end').click(); await app.settle();
  assert.equal(app.step(), R.LAST_STEP);
  assert.equal(layers().length, 1);
  // with Reduce motion, or Effects off, no confetti at all
  for (const prefs of [{ motion: 'off' }, { effects: false }]) {
    const quiet = await at(end, { prefs });
    assert.equal(quiet.h1(), CLOSING);
    assert.equal(quiet.$('main').querySelectorAll('.closing-fx').length, 0, JSON.stringify(prefs));
    assert.match(quiet.main(), /You won two of your three rooms\./, 'the line of rooms won stays');
  }
});
