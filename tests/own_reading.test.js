// While a photo is read on your own room, the progress panel (the lines and
// Cancel) takes the room a result takes: the advice and what our kitchen
// does step aside and our kitchen's card loses its thumbnail, as they do
// once a result is shown, so the whole Cancel stays above the dock in a
// 1280x800 window (the judge walk of 11-01: it sat half under the dock).
// tests/fit.test.js measures the screen in that state (tests/screenset.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, textOf, photoFile } from './apphost.js';
import { replyFor } from './replies.js';
import { roadAt, SAMPLE_ROOMS } from './roads.js';
import { replayReply } from './kitchen.js';

const AT12 = roadAt(12, { rooms: [...SAMPLE_ROOMS, null], finished: [true, true, true, false], best: [1.2, 1.3, null, null] });
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => body });

// api/room answers only when told to; everything else goes to the app host's fetch
function holdRoom() {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  let inner = null, release = null;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    get: () => async (url, opts = {}) => {
      if (String(url) !== 'api/room') return inner(url, opts);
      return new Promise((resolve, reject) => {
        release = () => resolve(json(200, replyFor('desk', 'live')));
        if (opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    },
    set: (f) => { inner = f; },
  });
  return { held: () => !!release, restore: () => Object.defineProperty(globalThis, 'fetch', orig) };
}

test('LIVE: while a photo is read, the advice and our kitchen’s line step aside and its card is compact, as for a result', async () => {
  const s = holdRoom();
  const app = await bootApp({ mode: 'live', road: AT12, answer: () => replyFor('desk', 'live'), replay: replayReply });
  try {
    if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
    const main = app.$('main');
    assert.equal(main.querySelector('.own .advice').hidden, false, 'as it opens: the advice');
    assert.equal(main.querySelector('.ours-line').hidden, false, 'and what our kitchen does');
    assert.ok(!main.querySelector('.ours-card.wide').classList.contains('compact'), 'with its thumbnail');
    app.choose(photoFile(45));
    for (let i = 0; i < 200 && !s.held(); i++) await app.settle(2);
    assert.ok(s.held(), 'the read is under way');
    const panel = main.querySelector('.progress');
    assert.ok(panel && !panel.hidden, 'the progress panel is up');
    assert.deepEqual(panel.querySelectorAll('button').map(textOf), ['Cancel']);
    assert.equal(main.querySelector('.own .advice').hidden, true, 'the advice steps aside');
    assert.equal(main.querySelector('.ours-line').hidden, true, 'and what our kitchen does');
    assert.ok(main.querySelector('.ours-card.wide').classList.contains('compact'), 'the card keeps its words, not its thumbnail');
    app.button('Cancel').click();
    await app.settle();
    assert.equal(app.button('Cancel'), null);
    assert.equal(main.querySelector('.own .advice').hidden, true, 'after the read, as after any result');
  } finally { s.restore(); }
});
