// The progress panel of a LIVE or REHEARSAL read, on the real app.js
// (tests/apphost.js). The fake page appends as a browser does, so a null
// handed to replaceChildren shows as the word 'null' here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, textOf } from './apphost.js';
import { fakeDocument } from './fakedom.js';
import { replyFor } from './replies.js';

const road = { v: 3, step: 2, reached: 2, consent: true, own: null, rooms: [null, null, null], finished: [false, false, false], best: [null, null, null] };
const tags = (panel) => panel.children.map((c) => c.tagName);

test('the fake page writes a stray null or undefined as text, as a browser does', () => {
  const doc = fakeDocument();
  const p = doc.createElement('p');
  p.replaceChildren(doc.createElement('b'), null, undefined, 'x');
  assert.deepEqual(p.children.map((c) => c.textContent), ['', 'null', 'undefined', 'x']);
});

for (const [name, answer] of [['an answer', () => replyFor('desk', 'rehearsal')], ['an error', null]]) {
  test(`REHEARSAL: the progress panel never shows 'null', while reading and after ${name}`, async () => {
    const app = await bootApp({ mode: 'rehearsal', road, answer });
    app.cardPrimary().click();
    await app.settle();
    app.button('Rehearse the live path').click();
    const panel = app.$('main').querySelector('.progress');
    assert.ok(panel && !panel.hidden);
    assert.deepEqual(tags(panel), ['OL'], 'while reading: the lines only');
    assert.equal(panel.querySelectorAll('li').length, 3);
    assert.doesNotMatch(textOf(panel), /\bnull\b|\bundefined\b/);
    await app.settle(60);
    if (answer) {
      assert.equal(app.step(), 3, 'read and built');
    } else {
      assert.deepEqual(tags(panel), ['OL', 'P'], 'after an error: the lines and the words');
      assert.match(textOf(panel), /could not be re-encoded/);
    }
    assert.doesNotMatch(textOf(app.$('main')), /\bnull\b|\bundefined\b/);
  });
}
