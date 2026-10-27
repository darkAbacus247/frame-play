// Cards and small page behaviour on the real app.js, booted in Node
// (tests/apphost.js), in MOCK: Start over asks first, a replay's end card
// says the road is unchanged, Describe this room says whether it is open,
// and Settings shows the About words unfolded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, textOf } from './apphost.js';
import { played } from './stub_game.js';
import { AT_END as END, roadAt, DESK } from './roads.js';

async function at(road) {
  const app = await bootApp({ mode: 'mock', road });
  app.cardPrimary().click();
  await app.settle();
  return app;
}

test('Start over asks first, in a true modal card; Keep my road has the focus and Escape never closes it', async () => {
  const app = await at(END);
  app.button('Start over').click();
  await app.settle(3);
  assert.ok(app.cardOpen());
  assert.match(textOf(app.$('card')), /Start over\? This clears your road on this device\./);
  assert.equal(textOf(app.doc.activeElement), 'Keep my road');
  app.doc.pressKey('Escape');
  app.doc.pressKey('Escape');
  assert.ok(app.cardOpen(), 'Escape twice: still open');
  app.cardPrimary().click();
  await app.settle();
  assert.ok(!app.cardOpen());
  assert.equal(app.step(), 15, 'the road is kept');
  assert.equal(app.savedRoad().step, 15);
  app.button('Start over').click();
  await app.settle(3);
  app.$('card').querySelectorAll('button').find((b) => textOf(b) === 'Start over').click();
  await app.settle();
  assert.equal(app.step(), 1);
});

test('a replay’s end card says Free play leaves the road as it was', async () => {
  const app = await at(END);
  app.button('Play again: The Living Room').click();
  await app.settle();
  played.last.onEnd({ status: 'won', ratio: 1.0, words: { title: 'Room cleared!', body: 'You took the shortest route.' } });
  await app.settle(3);
  assert.match(textOf(app.$('card')), /Rounds in Free play do not change your road\./);
  assert.equal(app.savedRoad().finished[1], true);
  assert.equal(app.savedRoad().best[1], null, 'the road’s own result is unchanged');
});

test('Describe this room says whether its words are open', async () => {
  const app = await at(roadAt(3, { rooms: [DESK, null, null, null] }));
  const b = app.button('Describe this room');
  assert.equal(b.getAttribute('aria-controls'), 'describe-room');
  assert.equal(b.getAttribute('aria-expanded'), 'false');
  b.click();
  assert.equal(b.getAttribute('aria-expanded'), 'true');
  assert.equal(app.doc.getElementById('describe-room').hidden, false);
  b.click();
  assert.equal(b.getAttribute('aria-expanded'), 'false');
});

test('Settings shows the About words, never folded', async () => {
  const app = await at(END);
  app.$('dock').querySelectorAll('button')[1].click(); // Settings, after Take the tour
  await app.settle(3);
  const drawer = app.$('drawer');
  assert.equal(drawer.querySelectorAll('details').length, 0);
  assert.match(textOf(drawer), /Built with AI assistance/);
});
