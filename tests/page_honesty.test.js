// MOCK through the page's own wiring (the real app.js, booted in Node by
// tests/apphost.js): a photo is never read for sending, sent or stored, and
// the road says the one way on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootApp } from './apphost.js';
import { AT_OWN as AT12 } from './roads.js';


test('MOCK: a photo chosen on Your own room is shown here only: never fingerprinted, sent or stored', async () => {
  const app = await bootApp({ mode: 'mock', road: AT12 });
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 12);
  assert.equal(app.why(), 'Continue to the end to go on', 'the header names the one way on');
  const digest = crypto.subtle.digest;
  let fingerprinted = 0, decoded = 0;
  crypto.subtle.digest = (...a) => { fingerprinted++; return digest.apply(crypto.subtle, a); };
  globalThis.createImageBitmap = async () => { decoded++; return { width: 1600, height: 1200, close() {} }; };
  try {
    const input = app.$('main').querySelectorAll('input').find((i) => i.getAttribute('type') === 'file');
    assert.ok(input, 'the picker');
    app.button('Choose a photo').focus();
    input.files = [{ name: 'my-room.jpg', type: 'image/jpeg', size: 300000, arrayBuffer: async () => new ArrayBuffer(16) }];
    input.dispatch('change');
    await app.settle();
  } finally {
    crypto.subtle.digest = digest;
    delete globalThis.createImageBitmap;
  }
  assert.equal(decoded, 1, 'decoded once, to show it');
  assert.equal(fingerprinted, 0, 'never fingerprinted');
  assert.deepEqual(app.requests.filter(([, u]) => /api\/room/.test(u)), [], 'never sent');
  assert.equal(app.storage.getItem('frameplay.levels'), null, 'no level stored');
  const road = app.savedRoad();
  assert.equal(road.step, 12);
  assert.equal(road.rooms[3], null, 'no room on the road');
  assert.match(app.main(), /Your photo, on this device only\. Nothing was sent, and no level was made from it\./);
  assert.equal(app.doc.activeElement, app.button('Choose a photo'), 'the focus is back on Choose a photo, not lost to the page');
});

test('MOCK: Steps 2 and 5 hold no file input at all', async () => {
  for (const [step, rooms] of [[2, [null, null, null]], [5, [{ kind: 'sample', id: 'desk' }, null, null]]]) {
    const app = await bootApp({ mode: 'mock', road: { ...AT12, step, reached: step, rooms, finished: [step > 2, false, false], best: [null, null, null] } });
    app.cardPrimary().click();
    await app.settle();
    assert.equal(app.step(), step);
    assert.equal(app.$('main').querySelectorAll('input').length, 0, `Step ${step}`);
  }
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(src, /function choosePhoto\(slot, file, panel, opts\) \{\n {2}if \(A\.mode !== 'live'\) return null;/, 'and choosePhoto reads only in LIVE');
});

test('your own room made again in place has the samples’ fingerprints at hand', () => {
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const own = src.slice(src.indexOf('async function ownPhoto'), src.indexOf('function showOwnResult'));
  assert.ok(own.indexOf('await sample(s.id)') > 0 && own.indexOf('await sample(s.id)') < own.indexOf('makeOwnRoom('),
    'a return visit can reach ownPhoto before any sample room was drawn');
});
