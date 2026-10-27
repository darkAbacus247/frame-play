// What a send that fails says, on the real app.js (tests/apphost.js) in
// LIVE: the page's own 120-second limit offers Try this photo again like
// the other failures that may pass, and a refusal the server sends as its
// own status (503 live_unavailable, 429 busy) reaches the page with its
// code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, textOf, photoFile } from './apphost.js';
import { replyFor } from './replies.js';
import { READ_LIMIT_MS, TOO_LONG_WORDS } from '../src/photo.js';

const AT2 = { v: 3, step: 2, reached: 2, consent: true, own: null, rooms: [null, null, null], finished: [false, false, false], best: [null, null, null] };
const AT9 = {
  v: 3, step: 9, reached: 9, consent: true, own: null,
  rooms: [{ kind: 'sample', id: 'desk' }, { kind: 'sample', id: 'living' }, null],
  finished: [true, true, false], best: [1.2, 1.3, null],
};
const primaries = (app) => app.$('main').querySelectorAll('[data-primary]').map(textOf);

// api/room answered by the test, through the fetch the app host installs
// (kept through the setter); everything else goes to the app host's own
function serve(handler) {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  let inner = null;
  const posts = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    get: () => async (url, opts = {}) => {
      if (opts.method === 'POST') posts.push(opts);
      const r = await handler(String(url), opts, posts.length);
      return r === undefined ? inner(url, opts) : r;
    },
    set: (f) => { inner = f; },
  });
  return { posts, restore: () => Object.defineProperty(globalThis, 'fetch', orig) };
}

// the page's 120-second limit, run in a moment: only that one timer
function shortLimit() {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms, ...a) => real(f, ms === READ_LIMIT_MS ? 20 : ms, ...a);
  return () => { globalThis.setTimeout = real; };
}

// never answers, until aborted (the first send only, when `then` is given)
const hang = (opts) => new Promise((_, reject) => {
  if (opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

async function live(at, handler) {
  const s = serve(handler);
  const app = await bootApp({ mode: 'live', road: at, answer: () => replyFor('desk', 'live') });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  return { app, s };
}

test('LIVE, Step 2: the page’s own time limit offers Try this photo again, and it reads the same photo', async () => {
  const restoreTimer = shortLimit();
  const { app, s } = await live(AT2, (url, opts, n) => (url !== 'api/room' ? undefined : n === 1 ? hang(opts) : undefined));
  try {
    app.choose(photoFile(71));
    for (let i = 0; i < 200 && !app.button('Try this photo again'); i++) await app.settle(2);
    const panel = app.$('main').querySelector('.progress');
    assert.equal(textOf(panel.querySelector('.error')), `${TOO_LONG_WORDS} You can also pick another photo, or play a sample room below.`);
    assert.deepEqual(primaries(app), ['Try this photo again']);
    assert.equal(s.posts[0].signal.aborted, true, 'the send itself was stopped');
    restoreTimer();
    app.button('Try this photo again').click();
    for (let i = 0; i < 200 && app.step() !== 3; i++) await app.settle(2);
    assert.equal(s.posts.length, 2, 'sent once more, with no new pick');
    assert.equal(s.posts[1].body.size, s.posts[0].body.size, 'the same copy');
    assert.equal(app.step(), 3, 'read and built');
  } finally { restoreTimer(); s.restore(); }
});

test('LIVE, Step 9: the time limit puts Try this photo again first, Mark your room beside it', async () => {
  const restoreTimer = shortLimit();
  const { app, s } = await live(AT9, (url, opts) => (url === 'api/room' ? hang(opts) : undefined));
  try {
    app.choose(photoFile(72));
    for (let i = 0; i < 200 && !app.button('Try this photo again'); i++) await app.settle(2);
    assert.equal(textOf(app.$('main').querySelector('.own-result .error')), `${TOO_LONG_WORDS} You can try this photo again, mark the room yourself instead, try another photo, or continue to the end.`);
    assert.deepEqual(primaries(app), ['Try this photo again']);
    assert.ok(app.button('Mark your room'));
  } finally { restoreTimer(); s.restore(); }
});
