// Free play from the closing screen always opens the room list, however
// the player left an earlier replay: the real app.js, booted in Node
// (tests/apphost.js), in MOCK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './apphost.js';

const END = {
  v: 3, step: 12, reached: 12, consent: true, own: 'skipped',
  rooms: [{ kind: 'sample', id: 'desk' }, { kind: 'sample', id: 'living' }, null],
  finished: [true, true, false], best: [1.24, null, null],
};

async function atTheEnd() {
  const app = await bootApp({ mode: 'mock', road: END });
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 12);
  return app;
}

function isTheList(app) {
  assert.equal(app.step(), 13);
  assert.equal(app.h1(), 'Free play');
  assert.match(app.main(), /Pick any room\. Rounds here do not change your road\./);
  assert.equal(app.$('main').querySelector('.game'), null, 'no board');
}

test('A: Play again, ←, then Free play shows the room list', async () => {
  const app = await atTheEnd();
  app.button('Play again: The Desk Top').click();
  await app.settle();
  assert.ok(app.$('main').querySelector('.game'), 'the replay is on');
  app.back();
  await app.settle();
  assert.equal(app.step(), 12);
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
  app.popstate({ step: 12 });
  await app.settle();
  assert.equal(app.step(), 12);
  app.mainPrimary().click();
  await app.settle();
  isTheList(app);
});
