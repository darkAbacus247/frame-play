// A2: the footer holds Take the tour, Settings, Sound and the mode badge,
// centred as one group, and no wordmark (the header carries the name); the
// header keeps the counter and the arrows. The tour still starts only when
// invited, from the footer or from its 45-second offer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootApp, nameOf } from './apphost.js';
import { styleOf, MAIN_CHAIN } from './layoutmodel.js';
import { OFFER_AFTER_MS, offerDue } from '../src/tour.js';

test('the footer: Take the tour, Settings, Sound and the mode, and no FRAME//PLAY', async () => {
  const app = await bootApp({ mode: 'mock' });
  const dock = app.$('dock');
  const names = dock.children.map((c) => nameOf(c));
  assert.deepEqual(names, ['Take the tour', '⚙Settings', 'Sound: on', 'MOCK']);
  assert.ok(!names.some((n) => /FRAME\/\/PLAY/.test(n)), 'no wordmark in the footer');
  // the header: the arrows and the counter, no tour button
  const road = app.$('road');
  assert.equal(road.querySelectorAll('.tour-btn').length, 0);
  assert.equal(road.querySelectorAll('button').length, 2);
  assert.match(app.counter(), /^Step 1/);
  assert.equal(app.$('top').querySelector('.brand').textContent, 'FRAME//PLAY');
  // the tour only when invited: off on arrival, on from the footer, off again
  const tour = dock.querySelector('.tour-btn');
  assert.equal(tour.getAttribute('aria-pressed'), 'false');
  assert.equal(app.$('tour-strip').children.length, 0);
  tour.click();
  await app.settle(2);
  const on = app.$('dock').querySelector('.tour-btn');
  assert.equal(on.getAttribute('aria-pressed'), 'true');
  assert.equal(nameOf(on), 'End the tour');
  assert.ok(app.$('tour-strip').children.length > 0, 'the tour strip shows its line');
  on.click();
  await app.settle(2);
  assert.equal(nameOf(app.$('dock').querySelector('.tour-btn')), 'Take the tour');
  assert.equal(app.$('tour-strip').children.length, 0);
});

test('the footer is one centred group at every window', () => {
  for (const [vw, vh] of [[839, 945], [1259, 1418], [559, 630], [420, 472]]) {
    const st = styleOf([MAIN_CHAIN[0], MAIN_CHAIN[1], MAIN_CHAIN[2], { tag: 'footer', cls: ['dock'] }], vw, vh);
    assert.equal(st.display, 'flex');
    assert.equal(st['justify-content'], 'center', `${vw}x${vh}`);
    assert.equal(st['flex-wrap'], 'wrap');
  }
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.dock \.mark/, 'no wordmark rule left, so nothing pushes the group aside');
  assert.doesNotMatch(css, /\.dock[^{]*\{[^}]*margin-left: auto/);
});

test('the 45-second offer still opens by itself, once', () => {
  const base = { now: 100000, lastProgress: 100000 - OFFER_AFTER_MS, offered: false, tourOn: false, cardOpen: false, step: 2, notOn: null };
  assert.equal(offerDue(base), true);
  assert.equal(offerDue({ ...base, offered: true }), false);
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /'New here\? Take the tour\.'/);
  // starting or ending the tour redraws the footer, where its button is
  const start = app.slice(app.indexOf('function startTour()'), app.indexOf('function toggleTour()'));
  assert.equal((start.match(/renderDock\(\)/g) || []).length, 2);
});
