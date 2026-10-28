// Step 12, Your own room, has exactly one filled primary in every mode: our
// kitchen's own button where its recorded answer is replayed (MOCK and
// REHEARSAL with the page's server), Choose a photo in LIVE, and Continue to
// the end where no server answered (the card saying why it is off). The
// stranger walk, pressing only that one control, passes Step 12 in MOCK by
// our kitchen and reaches the closing screen with zero wrong turns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, photoFile, textOf, paintCanvases, until } from './apphost.js';
import { played } from './stub_game.js';
import { rooms } from './replies.js';
import { AT_OWN } from './roads.js';
import { replayReply, liveKitchenReply, KITCHEN_PIXELS } from './kitchen.js';
import { OURS_USE } from '../src/screens.js';
import * as R from '../src/road.js';
import { Layout, styleOf, MAIN_CHAIN, mainSpace } from './layoutmodel.js';
import { screens, headFor } from './screenset.js';

const CLOSING = 'You’ve completed FRAME//PLAY';

async function ownStep(opts) {
  const app = await bootApp({ road: AT_OWN, ...opts });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  assert.equal(app.step(), R.OWN_STEP);
  return app;
}

// the one filled primary: data-primary 'true' and the btn primary class
function onePrimary(app, label) {
  const main = app.$('main');
  const marked = main.querySelectorAll('[data-primary]');
  assert.equal(marked.length, 1, `${label}: one data-primary, not ${marked.map(textOf).join(', ')}`);
  const p = marked[0];
  assert.equal(p.getAttribute('data-primary'), 'true');
  assert.equal(p.tagName, 'BUTTON');
  assert.ok(p.classList.contains('btn') && p.classList.contains('primary'), `${label}: filled (btn primary)`);
  const filled = main.querySelectorAll('.btn.primary');
  assert.deepEqual(filled, [p], `${label}: no other filled button`);
  return p;
}

for (const mode of ['mock', 'rehearsal']) {
  test(`${mode.toUpperCase()} with the page's server: our kitchen's button is the one filled primary`, async () => {
    const app = await ownStep({ mode, server: true, replay: replayReply });
    const p = onePrimary(app, mode);
    assert.equal(textOf(p), OURS_USE);
    assert.ok(p.closest('.ours-card'), 'inside the card');
    assert.ok(p.closest('.ours-card').querySelector('canvas.thumb'), 'the card keeps its thumbnail');
    assert.match(textOf(p.closest('.ours-card')), /REPLAY · recorded answer/, 'and its badge');
    assert.ok(!app.button('Choose a photo').classList.contains('primary'), 'Choose a photo a secondary');
    assert.ok(!app.button('Continue to the end').classList.contains('primary'), 'Continue to the end a secondary');
  });
}

test('LIVE: Choose a photo is the one filled primary; our kitchen’s button a secondary', async () => {
  const app = await ownStep({ mode: 'live', answer: () => liveKitchenReply(), replay: replayReply });
  assert.equal(textOf(onePrimary(app, 'live')), 'Choose a photo');
  const use = app.$('main').querySelector('.ours-card .ours-use');
  assert.ok(use && !use.disabled && !use.classList.contains('primary'));
});

test('no server: Continue to the end is the one filled primary, and the card says why it is off', async () => {
  const app = await ownStep({ mode: 'mock' });
  assert.equal(textOf(onePrimary(app, 'no server')), 'Continue to the end');
  const card = app.$('main').querySelector('.ours-card');
  assert.ok(card.querySelector('.ours-use').disabled);
  assert.match(textOf(card), /Off here: no server answered/);
});

test('a photo of your own shown on Step 12: Mark your room is the one filled primary, as before', async () => {
  const app = await ownStep({ mode: 'mock', server: true, replay: replayReply });
  paintCanvases(app, rooms.desk.pixels);
  try {
    app.choose(photoFile(21));
    await until(app, () => app.button('Mark your room'), 'Mark your room');
  } finally { delete globalThis.createImageBitmap; }
  assert.equal(textOf(onePrimary(app, 'after a photo')), 'Mark your room');
});

// Our kitchen is the first card on every pick step (his 10-28 pick: judges see Meta's work first), so a
// stranger's first click plays it first; Step 12 is then passed by its one primary.
test('the stranger walk in MOCK with the server plays our kitchen first (the first card), passes Step 12 by its one primary and reaches the closing screen with zero wrong turns', async () => {
  const app = await bootApp({ mode: 'mock', server: true, replay: replayReply });
  paintCanvases(app, KITCHEN_PIXELS);
  const seen = [];
  let atOwn = null;
  try {
    for (let i = 0; i < 120 && app.step() !== R.LAST_STEP; i++) {
      const step = app.step();
      if (seen[seen.length - 1] !== step) seen.push(step);
      if (app.cardOpen()) app.cardPrimary().click();
      else if (app.$('main').querySelector('.game')) played.last.onEnd({ status: 'won', ratio: 1, words: { title: 'Room cleared!', body: 'Well done.' } });
      else if (app.mainPrimary()) {
        if (step === R.OWN_STEP && !atOwn) atOwn = onePrimary(app, 'the walk at Step 12');
        app.mainPrimary().click();
      } else if (app.$('main').querySelector('.room-card:not([disabled])')) app.$('main').querySelector('.room-card:not([disabled])').click();
      else assert.fail(`Step ${step}: no single control to press`);
      if (step === R.OWN_STEP) await until(app, () => app.step() !== R.OWN_STEP, 'the replayed room', 120000);
      await app.settle(3);
    }
  } finally { delete globalThis.createImageBitmap; }
  assert.equal(textOf(atOwn), 'Continue to the end', 'Step 12 passed by its one primary: our kitchen is already on the road');
  assert.deepEqual([...seen, app.step()], [1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 15]);
  assert.equal(app.h1(), CLOSING);
  assert.match(app.main(), /You won all three rooms\./);
  assert.match(app.main(), /First room: our kitchen Won/);
});

// ---- the fit ----

test('the kitchen card on Step 12: its title on one line and its badge never wrapping, at both strict windows', () => {
  let checked = 0;
  for (const [vw, vh] of [[839, 945], [1259, 1418]]) {
    for (const mode of ['mock', 'live', 'rehearsal']) {
      for (const s of screens(mode).filter((x) => /^Your own room/.test(x.name))) {
        const card = s.section.querySelector('.ours-card');
        const width = mainSpace(vw, vh, headFor(s.step, mode, s.road), mode).width;
        const L = new Layout(vw, vh);
        const chain = [...MAIN_CHAIN, { tag: 'section', cls: ['screen', 'own'] }, { tag: 'div', cls: ['actions'] }];
        const cardChain = [...chain, { tag: 'div', cls: card.className.split(/\s+/) }];
        const textChain = [...cardChain, { tag: 'span', cls: ['card-text'] }];
        for (const sel of ['.room-title', '.tag']) {
          const e = card.querySelector(sel);
          const st = styleOf([...textChain, { tag: 'span', cls: e.className.split(/\s+/) }], vw, vh);
          assert.equal(st['white-space'], 'nowrap', `${sel} never wraps`);
        }
        // the words' column is as wide as they need, and the card fits main
        // (once a photo is shown, the thumbnail steps aside: one column)
        if (!card.classList.contains('compact')) assert.equal(styleOf(cardChain, vw, vh)['grid-template-columns'], '8rem max-content');
        const need = L.natural(card, chain, { size: 16, weight: 400, lh: 1.5 });
        assert.ok(need <= width, `${vw}x${vh} ${mode} · ${s.name}: the card needs ${need.toFixed(1)} of ${width.toFixed(1)}px`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 12);
});
