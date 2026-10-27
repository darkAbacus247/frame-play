// Free play from the closing screen always opens the room list, however
// the player left an earlier replay: the real app.js, booted in Node
// (tests/apphost.js), in MOCK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './apphost.js';
import { AT_END as END } from './roads.js';

async function atTheEnd() {
  const app = await bootApp({ mode: 'mock', road: END });
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 15);
  return app;
}

function isTheList(app) {
  assert.equal(app.step(), 16);
  assert.equal(app.h1(), 'Free play');
  assert.match(app.main(), /Pick any room: the three sample rooms, and your own room once it is made\. Rounds here do not change your road\./);
  assert.equal(app.$('main').querySelectorAll('.room-card').length, 3, 'the three sample rooms (your own room was passed by)');
  assert.equal(app.$('main').querySelector('.game'), null, 'no board');
}

test('A: Play again, ←, then Free play shows the room list', async () => {
  const app = await atTheEnd();
  app.button('Play again: The Desk Top').click();
  await app.settle();
  assert.ok(app.$('main').querySelector('.game'), 'the replay is on');
  app.back();
  await app.settle();
  assert.equal(app.step(), 15);
  app.mainPrimary().click();
  await app.settle();
  isTheList(app);
});

test('B: a room picked in Free play, ←, then Free play shows the room list', async () => {
  const app = await atTheEnd();
  app.mainPrimary().click();
  await app.settle();
  isTheList(app);
  app.$('main').querySelector('.room-card').click();
  await app.settle();
  assert.ok(app.$('main').querySelector('.game'));
  app.back();
  await app.settle();
  app.mainPrimary().click();
  await app.settle();
  isTheList(app);
});

test('C: Play again, the browser’s Back, then Free play shows the room list', async () => {
  const app = await atTheEnd();
  app.button('Play again: The Desk Top').click();
  await app.settle();
  app.popstate({ step: 15 });
  await app.settle();
  assert.equal(app.step(), 15);
  app.mainPrimary().click();
  await app.settle();
  isTheList(app);
});
