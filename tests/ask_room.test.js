// Ask the room on the real app.js, booted in Node (tests/apphost.js) with the
// stand-in board (tests/stub_game.js), in MOCK: the end card offers it as a
// secondary only when the room has riddles; each riddle ends on its own card
// whose primary is the road's own; stopping one brings the end card back;
// the road never moves for a riddle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, textOf } from './apphost.js';
import { played } from './stub_game.js';
import { roadAt, DESK } from './roads.js';

const cardButtons = (app) => app.$('card').querySelectorAll('button').map(textOf);
const cardButton = (app, name) => app.$('card').querySelectorAll('button').find((b) => textOf(b) === name) || null;
const WON = { status: 'won', ratio: 1.0, words: { title: 'Room cleared!', body: 'You took the shortest route.' } };

async function deskRoundOver() {
  const app = await bootApp({ mode: 'mock', road: roadAt(4, { rooms: [DESK, null, null, null] }) });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  played.last.onEnd(WON);
  await app.settle(3);
  return app;
}

test('the end card offers Ask the room first among its secondaries, never as the primary', async () => {
  const app = await deskRoundOver();
  const buttons = cardButtons(app);
  const primary = textOf(app.cardPrimary());
  assert.notEqual(primary, 'Ask the room');
  assert.equal(buttons[0], primary, 'the primary leads');
  assert.equal(buttons[1], 'Ask the room', 'then Ask the room, first of the secondaries');
  assert.ok(buttons.includes('Play this room again'));
});

test('Ask the room starts riddle 1 of the room’s three on the board; the road does not move', async () => {
  const app = await deskRoundOver();
  const step = app.step();
  const primary = textOf(app.cardPrimary());
  cardButton(app, 'Ask the room').click();
  await app.settle(3);
  assert.ok(!app.cardOpen(), 'the card gives way to the board');
  const asked = played.view.riddle;
  assert.ok(asked, 'the board was asked for a riddle');
  assert.equal(asked.i, 0);
  assert.equal(asked.list.length, 3);
  assert.deepEqual(asked.list.map((r) => r.origin), ['sample', 'sample', 'sample']);
  assert.equal(app.step(), step);

  // solved: its own card, the road's primary, then Next riddle and Play this room again
  asked.handlers.onEnd({ outcome: 'solved', i: 0, total: 3, riddle: asked.list[0], found: ['mug'] });
  await app.settle(3);
  assert.ok(app.cardOpen());
  const card = textOf(app.$('card'));
  assert.match(card, /^Solved!/);
  assert.match(card, /“Touch the thing you would fill with hot tea\.”/);
  assert.match(card, /Answer: the mug/);
  assert.match(card, /Written into the sample: It is made for hot drinks, handle and all\./);
  assert.match(card, /Riddle written into this sample room · MOCK · no model was asked/);
  assert.equal(textOf(app.cardPrimary()), primary, 'the riddle card’s primary is the road’s own');
  assert.deepEqual(cardButtons(app).slice(1), ['Next riddle', 'Play this room again']);
  assert.equal(app.step(), step, 'a riddle never moves the road');

  // Next riddle: the count is filled in by code
  cardButton(app, 'Next riddle').click();
  await app.settle(3);
  const second = played.view.riddle;
  assert.equal(second.i, 1);
  second.handlers.onEnd({ outcome: 'missed', i: 1, total: 3, riddle: second.list[1], found: [] });
  await app.settle(3);
  const missed = textOf(app.$('card'));
  assert.match(missed, /^Two misses/);
  assert.match(missed, /“Find the three things you could spend at a shop\.”/);
  assert.match(missed, /The answer was coin 1, coin 2 and coin 3\./);

  // the last riddle has no Next riddle
  cardButton(app, 'Next riddle').click();
  await app.settle(3);
  const third = played.view.riddle;
  third.handlers.onEnd({ outcome: 'skipped', i: 2, total: 3, riddle: third.list[2], found: [] });
  await app.settle(3);
  assert.match(textOf(app.$('card')), /^Riddle skipped/);
  assert.ok(!cardButtons(app).includes('Next riddle'));

  // the primary moves on exactly as the end card's would
  app.cardPrimary().click();
  await app.settle(3);
  assert.notEqual(app.step(), step);
});

test('Stop the riddle brings the end card back, Ask the room still on it', async () => {
  const app = await deskRoundOver();
  cardButton(app, 'Ask the room').click();
  await app.settle(3);
  played.view.riddle.handlers.onStop();
  await app.settle(3);
  assert.ok(app.cardOpen());
  assert.match(textOf(app.$('card')), /^Room cleared!/);
  assert.equal(cardButtons(app)[1], 'Ask the room');
});

test('a room without riddles shows no Ask the room', async () => {
  const app = await deskRoundOver();
  // the same desk, its riddles taken away, as a level kept from before this feature would be
  played.last.level.riddles = [];
  played.last.onEnd(WON);
  await app.settle(3);
  assert.ok(!cardButtons(app).includes('Ask the room'));
});
