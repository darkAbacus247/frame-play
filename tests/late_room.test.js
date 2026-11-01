// A late room file never leaves a three-card pick step. The judge walk of
// 11-01 saw Step 2 of the MOCK copy with three cards on one cold open of
// three, The Apartment's card absent 0.6 s after the step opened although
// rooms/apartment.json had been fetched. The page draws the sample cards
// from one awaited load of the three room files (and Free play the same),
// so once any sample card shows, all four cards show; and one load of a
// room file is shared by every screen waiting for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, until, textOf } from './apphost.js';
import { roadAt, SAMPLE_ROOMS } from './roads.js';
import { FREE_PLAY } from '../src/road.js';

const sampleCards = (app) => app.$('main').querySelectorAll('.room-card').filter((c) => /MOCK · sample room/.test(textOf(c)));
const allCards = (app) => app.$('main').querySelectorAll('.room-card').map(textOf);

test('Step 2 with one room file late: the moment a sample card shows, all four cards show', async () => {
  const app = await bootApp({ mode: 'mock', delay: { 'rooms/apartment.json': 300 } });
  app.mainPrimary().click();
  await until(app, () => sampleCards(app).length > 0, 'a sample card on Step 2');
  const cards = allCards(app);
  assert.equal(app.step(), 2);
  assert.equal(cards.length, 4, `four cards the moment any sample card shows: ${cards.join(' | ')}`);
  assert.equal(sampleCards(app).length, 3, 'the three sample rooms');
  assert.ok(cards.some((c) => /The Apartment/.test(c)), 'The Apartment among them');
  // and the late file was fetched once, though two screens may have asked
  assert.equal(app.requests.filter(([, u]) => u === 'rooms/apartment.json').length, 1);
});

test('Free play with one room file late: the moment a sample card shows, every sample card shows', async () => {
  // a road saved in Free play, reopened: no room file has been loaded yet
  const road = roadAt(FREE_PLAY, { rooms: [...SAMPLE_ROOMS, null], finished: [true, true, true, false], best: [1.24, null, null, null], own: 'skipped' });
  const app = await bootApp({ mode: 'mock', road, delay: { 'rooms/apartment.json': 300 } });
  app.cardPrimary().click();
  await until(app, () => sampleCards(app).length > 0, 'a sample card in Free play');
  assert.equal(app.step(), FREE_PLAY);
  const cards = allCards(app);
  assert.equal(cards.length, 3, `the three sample rooms the moment any shows: ${cards.join(' | ')}`);
});
