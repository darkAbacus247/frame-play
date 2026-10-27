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
import { roadAt, SAMPLE_ROOMS } from './roads.js';

const AT2 = roadAt(2);
const AT12 = roadAt(12, { rooms: [...SAMPLE_ROOMS, null], finished: [true, true, true, false], best: [1.2, 1.3, null, null] });
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

const json = (status, body, headers = {}) => {
  const h = new Map(Object.entries({ 'content-type': 'application/json', ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => body };
};
const LIVE_UNAVAILABLE = { status: 'error', error: { code: 'live_unavailable', message: 'The live AI is unavailable on this server right now (an account or model problem the owner must fix). The sample rooms still work.' } };
const BUSY = { status: 'error', error: { code: 'busy', message: 'Every reader on this server is busy with other photos. Please try again in a few seconds.' } };

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

test('LIVE, Step 12: the time limit puts Try this photo again first, Mark your room beside it', async () => {
  const restoreTimer = shortLimit();
  const { app, s } = await live(AT12, (url, opts) => (url === 'api/room' ? hang(opts) : undefined));
  try {
    app.choose(photoFile(72));
    for (let i = 0; i < 200 && !app.button('Try this photo again'); i++) await app.settle(2);
    assert.equal(textOf(app.$('main').querySelector('.own-result .error')), `${TOO_LONG_WORDS} You can try this photo again, mark the room yourself instead, try another photo, or continue to the end.`);
    assert.deepEqual(primaries(app), ['Try this photo again']);
    assert.ok(app.button('Mark your room'));
  } finally { restoreTimer(); s.restore(); }
});

// health asked again after the boot's own check (the test answers the
// POST itself, so only the page's GETs are on the list)
const healthAfterPost = (app) => app.requests.filter(([, u]) => u === 'api/health').length - 1;

test('LIVE, Step 2: the server’s own 503 live_unavailable turns the picker off at once, with its wait', async () => {
  const { app, s } = await live(AT2, (url) => (url === 'api/room' ? json(503, LIVE_UNAVAILABLE, { 'Retry-After': '120' }) : undefined));
  try {
    app.choose(photoFile(73));
    for (let i = 0; i < 200 && !app.button('Check again'); i++) await app.settle(2);
    assert.equal(s.posts.length, 1);
    assert.equal(app.button('Choose a photo').disabled, true, 'the picker is off');
    assert.equal(app.$('main').querySelector('input'), null, 'and nothing a photo could reach');
    const why = textOf(app.$('main').querySelector('.actions .why'));
    assert.match(why, /^Off: the live AI is unavailable on this server right now\./);
    assert.match(why, /about 2 minutes: press Check again then\./, 'the server’s Retry-After');
    assert.equal(healthAfterPost(app), 0, 'from the refusal’s own code, not by asking health again');
  } finally { s.restore(); }
});

test('LIVE, Step 12: the server’s own 503 live_unavailable says so in place; Mark your room stays', async () => {
  const { app, s } = await live(AT12, (url) => (url === 'api/room' ? json(503, LIVE_UNAVAILABLE, { 'Retry-After': '60' }) : undefined));
  try {
    app.choose(photoFile(74));
    for (let i = 0; i < 200 && !app.button('Check again'); i++) await app.settle(2);
    assert.match(textOf(app.$('main').querySelector('.notice')), /^LIVE, but the live AI is unavailable on this server right now\./);
    assert.match(textOf(app.$('main').querySelector('.own-result .error')), /^The live AI is unavailable on this server right now/);
    assert.ok(app.button('Mark your room'), 'the photo can still be marked');
    assert.equal(app.button('Try this photo again'), null, 'never the same photo again into an unavailable AI');
    assert.equal(healthAfterPost(app), 0);
  } finally { s.restore(); }
});

test('LIVE, Step 2: every reader still busy after the waits gives the busy words and Try this photo again', async () => {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms, ...a) => real(f, ms === 1000 ? 1 : ms, ...a); // the countdown's seconds
  const { app, s } = await live(AT2, (url) => (url === 'api/room' ? json(429, BUSY, { 'Retry-After': '1' }) : undefined));
  try {
    app.choose(photoFile(75));
    for (let i = 0; i < 300 && !app.button('Try this photo again'); i++) await app.settle(2);
    assert.equal(s.posts.length, 3, 'three sends, then the words');
    const panel = app.$('main').querySelector('.progress');
    assert.equal(textOf(panel.querySelector('.error')), `${BUSY.error.message} You can also pick another photo, or play a sample room below.`);
    assert.deepEqual(primaries(app), ['Try this photo again']);
    assert.equal(app.button('Choose a photo').disabled, false, 'the picker stays on: busy is not unavailable');
  } finally { globalThis.setTimeout = real; s.restore(); }
});

test('LIVE, Step 2: an hourly stop is not offered again on the same photo', async () => {
  const HOUR = { status: 'error', error: { code: 'hour_cap', message: 'This server has read its photos for this hour. Please try again later.' } };
  const { app, s } = await live(AT2, (url) => (url === 'api/room' ? json(429, HOUR, { 'Retry-After': '900' }) : undefined));
  try {
    app.choose(photoFile(76));
    for (let i = 0; i < 200 && !app.$('main').querySelector('.progress .error'); i++) await app.settle(2);
    assert.match(textOf(app.$('main').querySelector('.progress .error')), /^This server has read its photos for this hour\. Please try again later\. You can try another photo/);
    assert.equal(app.button('Try this photo again'), null);
    assert.equal(s.posts.length, 1);
  } finally { s.restore(); }
});
