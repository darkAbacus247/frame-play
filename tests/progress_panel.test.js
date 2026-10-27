// The progress panel of a LIVE or REHEARSAL read, on the real app.js
// (tests/apphost.js). The fake page appends as a browser does, so a null
// handed to replaceChildren shows as the word 'null' here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, textOf, photoFile } from './apphost.js';
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
    assert.deepEqual(tags(panel), ['OL', 'DIV'], 'while reading: the lines and Cancel');
    assert.equal(panel.querySelectorAll('li').length, 3);
    assert.deepEqual(panel.querySelectorAll('button').map(textOf), ['Cancel']);
    assert.doesNotMatch(textOf(panel), /\bnull\b|\bundefined\b/);
    await app.settle(60);
    if (answer) {
      assert.equal(app.step(), 3, 'read and built');
    } else {
      assert.deepEqual(tags(panel), ['OL', 'P'], 'after an error: the lines and the words (no retry_same: no button)');
      assert.match(textOf(panel), /could not be re-encoded/);
    }
    assert.doesNotMatch(textOf(app.$('main')), /\bnull\b|\bundefined\b/);
  });
}

// ---- LIVE: whole sentences, Try this photo again, Cancel, degraded levels ----
// The test answers api/room through the fetch the app host installs (kept
// through the setter); everything else goes to the app host's own.
const AT9 = {
  v: 3, step: 9, reached: 9, consent: true, own: null,
  rooms: [{ kind: 'sample', id: 'desk' }, { kind: 'sample', id: 'living' }, null],
  finished: [true, true, false], best: [1.2, 1.3, null],
};
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => body });
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
async function live(at, handler) {
  const s = serve(handler);
  const app = await bootApp({ mode: 'live', road: at, answer: () => replyFor('desk', 'live') });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  return { app, s };
}
const BUSY = { code: 'sam_busy', message: 'SAM 3.1 is busy right now. Please try the same photo again in a minute.', retry_same: true };
const primaries = (app) => app.$('main').querySelectorAll('[data-primary]').map(textOf);

test('LIVE: a failure without a period reads as whole sentences, and with no retry_same there is no Try this photo again', async () => {
  const { app, s } = await live(road, (url) => (url === 'api/room' ? json(500, { status: 'error', error: { code: 'timeout', message: 'The Model API did not answer in time' } }) : undefined));
  try {
    app.choose(photoFile(41));
    await app.settle(60);
    const panel = app.$('main').querySelector('.progress');
    assert.equal(textOf(panel.querySelector('.error')), 'The Model API did not answer in time. You can try another photo, or play a sample room below.');
    assert.equal(app.button('Try this photo again'), null);
  } finally { s.restore(); }
});

test('LIVE, Step 2: retry_same gives Try this photo again as the one primary; it sends the same photo again, with no new pick', async () => {
  const { app, s } = await live(road, (url, opts, n) => (url === 'api/room' ? json(200, n === 1 ? replyFor('desk', 'live', { status: 'error', error: BUSY }) : replyFor('desk', 'live')) : undefined));
  try {
    app.choose(photoFile(42));
    await app.settle(60);
    const panel = app.$('main').querySelector('.progress');
    assert.equal(textOf(panel.querySelector('.error')), 'SAM 3.1 is busy right now. Please try the same photo again in a minute. You can also pick another photo, or play a sample room below.');
    assert.deepEqual(primaries(app), ['Try this photo again']);
    app.button('Try this photo again').click();
    await app.settle(80);
    assert.equal(s.posts.length, 2);
    assert.equal(s.posts[1].body.size, s.posts[0].body.size, 'the same copy');
    assert.equal(app.step(), 3, 'read and built');
  } finally { s.restore(); }
});

test('LIVE, Step 9: retry_same puts Try this photo again first, Mark your room beside it', async () => {
  const { app, s } = await live(AT9, (url) => (url === 'api/room' ? json(200, replyFor('desk', 'live', { status: 'error', error: BUSY })) : undefined));
  try {
    app.choose(photoFile(43));
    for (let i = 0; i < 200 && !app.button('Try this photo again'); i++) await app.settle(2);
    const words = textOf(app.$('main').querySelector('.own-result .error'));
    assert.equal(words, 'SAM 3.1 is busy right now. Please try the same photo again in a minute. You can try this photo again, mark the room yourself instead, try another photo, or continue to the end.');
    assert.deepEqual(primaries(app), ['Try this photo again']);
    assert.ok(app.button('Mark your room'));
    app.button('Try this photo again').click();
    await app.settle(60);
    assert.equal(s.posts.length, 2);
  } finally { s.restore(); }
});

test('LIVE: Cancel stays pressable while reading, stops the wait at once, says so, and a late answer is neither used nor kept', async () => {
  let late = null;
  const { app, s } = await live(road, (url, opts) => {
    if (url !== 'api/room') return undefined;
    return new Promise((resolve, reject) => {
      late = () => resolve(json(200, replyFor('desk', 'live')));
      if (opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  });
  try {
    app.choose(photoFile(44));
    for (let i = 0; i < 200 && !late; i++) await app.settle(2);
    const cancel = app.button('Cancel');
    assert.ok(cancel && !cancel.disabled, 'Cancel is pressable');
    assert.equal(app.button('Choose a photo').disabled, true, 'every other button waits');
    cancel.click();
    await app.settle();
    const panel = app.$('main').querySelector('.progress');
    assert.match(textOf(panel.querySelector('.error')), /^Cancelled: this page stopped waiting for the read, and nothing from it is used\. You can also pick another photo/);
    assert.equal(app.button('Cancel'), null);
    assert.equal(app.button('Choose a photo').disabled, false, 'no longer busy');
    assert.ok(app.button('Try this photo again'));
    // where sendPhoto hands the signal to fetch, the send itself is aborted
    if (s.posts[0].signal) assert.equal(s.posts[0].signal.aborted, true);
    late();
    await app.settle(60);
    assert.equal(app.step(), 2, 'the late answer is not used');
    assert.deepEqual(app.levels(), [], 'nor kept');
  } finally { s.restore(); }
});

test('LIVE, Step 9: Cancel works on your own room too', async () => {
  let started = false;
  const { app, s } = await live(AT9, (url) => {
    if (url !== 'api/room') return undefined;
    started = true;
    return new Promise(() => {});
  });
  try {
    app.choose(photoFile(45));
    for (let i = 0; i < 200 && !started; i++) await app.settle(2);
    app.button('Cancel').click();
    await app.settle();
    assert.match(app.main(), /Cancelled: this page stopped waiting for the read/);
    assert.equal(app.step(), 9);
    assert.equal(app.button('Choose a photo').disabled, false);
  } finally { s.restore(); }
});

// a reply made while calls were failing: a call that did not answer 200,
// or a noun not looked for
const degraded = (how) => {
  const r = replyFor('desk', 'live');
  if (how === 'call') r.provenance.calls = [{ stage: 'read', status: 200 }, { stage: 'find', status: 429 }];
  else r.warnings = ['not looked for: lamp (SAM 3.1 is busy right now.)'];
  return r;
};

for (const how of ['call', 'warning']) {
  test(`LIVE, Step 2: a level read while calls were failing (${how}) is played but not kept, so the next pick reads again`, async () => {
    const { app, s } = await live(road, (url) => (url === 'api/room' ? json(200, degraded(how)) : undefined));
    try {
      app.choose(photoFile(46));
      await app.settle(80);
      assert.equal(app.step(), 3, 'built and on the road');
      assert.deepEqual(app.levels(), [], 'not kept');
    } finally { s.restore(); }
  });
}

test('LIVE, Step 9: your own room read while calls were failing is played but not kept', async () => {
  const { app, s } = await live(AT9, (url) => (url === 'api/room' ? json(200, degraded('call')) : undefined));
  try {
    app.choose(photoFile(47));
    await app.settle(80);
    assert.equal(app.step(), 10, 'built and on the road');
    assert.deepEqual(app.levels(), []);
    assert.equal(s.posts.length, 1);
  } finally { s.restore(); }
});
