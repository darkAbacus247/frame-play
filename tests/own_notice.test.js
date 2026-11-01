// Step 12's LIVE notice says the postcard sentence ("If you ask for a
// postcard, the same shrunk photo goes to Muse Image one more time...")
// only where this server has postcards on (health.postcard, off by
// default): on the judge walk of 11-01 the live Space said it with no
// postcard button anywhere. The full notice already shapes Say it this way
// ("when this server has it on"); the pinned OWN_NOTICE.live keeps the
// sentence whole (tests/privacy.test.js), and the screen leaves it out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument } from './fakedom.js';
import { el } from '../src/ui.js';
import { OWN_NOTICE, META_USE, POSTCARD_SENTENCE, ownNotice, ownView } from '../src/screens.js';
import { bootApp, textOf } from './apphost.js';
import { AT_OWN } from './roads.js';

const noop = () => {};
const SENTENCE = 'If you ask for a postcard, the same shrunk photo goes to Muse Image one more time, about one cent, counted in the daily stop. ';

test('the notice words: the postcard sentence only with postcards on; MOCK and REHEARSAL as they are', () => {
  assert.equal(POSTCARD_SENTENCE, SENTENCE);
  assert.ok(OWN_NOTICE.live.includes(SENTENCE), 'the pinned notice keeps the sentence');
  const off = ownNotice('live');
  assert.ok(!off.includes('postcard'), off);
  assert.ok(off.startsWith('LIVE: your photo is shrunk on this device and its camera data removed, then read by Meta’s Model API (Muse Spark and SAM 3.1). This app keeps none. '), off);
  assert.ok(off.endsWith(META_USE), 'Meta’s use is still said');
  assert.equal(off, OWN_NOTICE.live.replace(SENTENCE, ''));
  assert.equal(ownNotice('live', { postcard: true }), OWN_NOTICE.live);
  assert.equal(ownNotice('mock'), OWN_NOTICE.mock);
  assert.equal(ownNotice('mock', { postcard: true }), OWN_NOTICE.mock, 'MOCK sends nothing, postcards or not');
  assert.equal(ownNotice('rehearsal', { postcard: true }), OWN_NOTICE.rehearsal);
});

test('the screen: ownView says the sentence only when told postcards are on', () => {
  const doc = installFakeDocument();
  doc.body.append(el('div', { id: 'tips' }));
  const actions = { file: noop, skip: noop, ours: noop };
  const off = ownView({ mode: 'live', primaryLabel: 'Continue', actions });
  assert.equal(textOf(off.section.querySelector('.notice')), ownNotice('live'));
  assert.doesNotMatch(textOf(off.section.querySelector('.notice')), /postcard/);
  const on = ownView({ mode: 'live', primaryLabel: 'Continue', postcard: true, actions });
  assert.equal(textOf(on.section.querySelector('.notice')), OWN_NOTICE.live);
});

for (const [state, health] of [['off', {}], ['on', { postcard: 'on' }]]) {
  test(`the page, LIVE with postcards ${state}: Step 12's notice follows health`, async () => {
    const app = await bootApp({ mode: 'live', road: AT_OWN, health });
    if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
    const notice = textOf(app.$('main').querySelector('.notice'));
    assert.equal(notice, state === 'on' ? OWN_NOTICE.live : ownNotice('live'));
    assert.equal(notice.includes('postcard'), state === 'on');
  });
}
