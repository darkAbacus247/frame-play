// The mode check and the live AI's state, on the real app.js
// (tests/apphost.js): health tried up to 3 times, Check again, and the photo
// picker off in words when the live AI is unavailable (health's live_state,
// or a send answered live_unavailable). No server, no network: the test
// answers api/health and api/room through the fetch the app host installs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, photoFile, textOf } from './apphost.js';
import { replyFor } from './replies.js';

const AT2 = { v: 3, step: 2, reached: 2, consent: true, own: null, rooms: [null, null, null], finished: [false, false, false], best: [null, null, null] };
const AT9 = {
  v: 3, step: 9, reached: 9, consent: true, own: null,
  rooms: [{ kind: 'sample', id: 'desk' }, { kind: 'sample', id: 'living' }, null],
  finished: [true, true, false], best: [1.2, 1.3, null],
};
const REASON = "The Model API did not accept this server's key. The owner of this server must fix this; the sample rooms still work.";
const LIVE = { mode: 'live', reason: '', label: 'live', live_state: 'ok', live_reason: null };
const DOWN = { ...LIVE, live_state: 'unavailable', live_reason: REASON, live_check_again_s: 540 };
const json = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : headers[k] ?? null) },
  json: async () => body,
});

// handler(url, opts): an answer, or undefined for the app host's own. The
// app host's fetch is kept (it is set through the setter) for the rest.
function serve(handler) {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  let inner = null;
  const seen = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    get: () => async (url, opts = {}) => {
      seen.push([opts.method || 'GET', String(url)]);
      const r = await handler(String(url), opts);
      return r === undefined ? inner(url, opts) : r;
    },
    set: (f) => { inner = f; },
  });
  return {
    health: () => seen.filter(([, u]) => u === 'api/health').length,
    posts: () => seen.filter(([m]) => m === 'POST').length,
    restore: () => Object.defineProperty(globalThis, 'fetch', orig),
  };
}

async function at(road, mode, answer = () => replyFor('desk', 'live')) {
  const app = await bootApp({ mode, road, answer });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  return app;
}
const choose = (app) => app.button('Choose a photo');
const why = (app) => textOf(app.$('main').querySelector('.actions .why') || { children: [], textContent: '' });

test('health is tried up to 3 times: two failures, then LIVE, and the picker is on', async () => {
  let n = 0;
  const s = serve((url) => (url === 'api/health' ? (++n < 3 ? Promise.reject(new Error('waking')) : json(200, LIVE)) : undefined));
  try {
    const app = await at(AT2, 'live');
    assert.equal(s.health(), 3);
    assert.equal(textOf(app.$('dock').querySelector('.mode-chip')), 'LIVE');
    assert.equal(choose(app).disabled, false);
    assert.equal(app.button('Check again'), null, 'nothing to check again');
  } finally { s.restore(); }
});

test('three failures: sample rooms only, in words, and Check again turns the picker on when the server answers', async () => {
  let up = false;
  const s = serve((url) => (url === 'api/health' ? (up ? json(200, LIVE) : json(502, {})) : undefined));
  try {
    const app = await at(AT2, 'live');
    assert.equal(s.health(), 3);
    assert.equal(textOf(app.$('dock').querySelector('.mode-chip')), 'MOCK');
    assert.equal(choose(app).disabled, true);
    assert.equal(why(app), 'Off: The server did not answer, so this page shows sample rooms only.');
    const again = app.button('Check again');
    assert.ok(again && !again.disabled);
    up = true;
    again.click();
    await app.settle();
    assert.equal(textOf(app.$('dock').querySelector('.mode-chip')), 'LIVE');
    assert.equal(choose(app).disabled, false);
    assert.equal(app.button('Check again'), null);
    assert.equal(app.step(), 2, 'the same step, drawn again');
  } finally { s.restore(); }
});

test('Check again while the server is still silent says so and keeps the picker off', async () => {
  const s = serve((url) => (url === 'api/health' ? Promise.reject(new Error('down')) : undefined));
  try {
    const app = await at(AT2, 'live');
    app.button('Check again').click();
    await app.settle();
    assert.equal(s.health(), 6, 'three more tries');
    assert.equal(choose(app).disabled, true);
    assert.ok(app.button('Check again'));
    assert.equal(app.$('live').textContent, 'The server still did not answer.');
  } finally { s.restore(); }
});

test('health says live_state unavailable: the picker is off in words, the sample rooms and marking named, then back on when health is ok', async () => {
  let h = DOWN;
  const s = serve((url) => (url === 'api/health' ? json(200, h) : undefined));
  try {
    const app = await at(AT2, 'live');
    assert.equal(textOf(app.$('dock').querySelector('.mode-chip')), 'LIVE');
    assert.equal(choose(app).disabled, true);
    assert.equal(app.$('main').querySelector('input'), null, 'an off picker has no file input');
    const words = why(app);
    assert.match(words, /^Off: the live AI is unavailable on this server right now\. The Model API did not accept this server's key\./);
    assert.match(words, /The sample rooms still work, and on Step 9 you can mark your own room by hand; nothing is sent\./);
    assert.match(words, /about 9 minutes: press Check again then\.$/);
    assert.doesNotMatch(words, /\.\./);
    assert.ok(app.$('main').querySelectorAll('.room-card').length >= 2 || app.main().includes('Sample rooms'));
    h = LIVE;
    app.button('Check again').click();
    await app.settle();
    assert.equal(choose(app).disabled, false);
    assert.equal(app.button('Check again'), null);
    assert.equal(s.posts(), 0, 'nothing was sent');
  } finally { s.restore(); }
});

test('a health with no live_state (an older server) changes nothing: the picker is on', async () => {
  const s = serve((url) => (url === 'api/health' ? json(200, { mode: 'live', reason: '', label: 'live' }) : undefined));
  try {
    const app = await at(AT2, 'live');
    assert.equal(choose(app).disabled, false);
    assert.equal(app.button('Check again'), null);
  } finally { s.restore(); }
});

test('a 503 live_unavailable sent as the server’s own status: sendPhoto passes its code on, so the picker is off at once, with its wait, one POST', async () => {
  const s = serve((url, opts) => {
    if (url === 'api/health') return json(200, LIVE);
    if (url === 'api/room') return json(503, { status: 'error', error: { code: 'live_unavailable', message: 'The live AI is unavailable on this server right now (an account or model problem the owner must fix). The sample rooms still work.' } }, { 'Retry-After': '600' });
    return undefined;
  });
  try {
    const app = await at(AT2, 'live');
    app.choose(photoFile(31));
    await app.settle(60);
    assert.equal(s.posts(), 1);
    // health still says ok here: the refusal's own code decides
    assert.equal(choose(app).disabled, true);
    assert.match(why(app), /^Off: the live AI is unavailable on this server right now\./);
    assert.match(why(app), /about 10 minutes: press Check again then\.$/);
    assert.ok(app.button('Check again'));
  } finally { s.restore(); }
});

test('after a send failed with no code, health asked again: live_state unavailable turns the picker off', async () => {
  let h = LIVE;
  const s = serve((url) => {
    if (url === 'api/health') return json(200, h);
    if (url === 'api/room') { h = DOWN; return json(502, { status: 'error' }); }
    return undefined;
  });
  try {
    const app = await at(AT2, 'live');
    app.choose(photoFile(32));
    await app.settle(60);
    assert.equal(s.posts(), 1);
    assert.equal(choose(app).disabled, true);
    assert.match(why(app), /the live AI is unavailable/);
    assert.ok(app.button('Check again'));
  } finally { s.restore(); }
});

test('a reply whose error code is live_unavailable turns the picker off without asking health', async () => {
  const s = serve((url) => (url === 'api/health' ? json(200, LIVE) : undefined));
  try {
    const app = await at(AT2, 'live', () => replyFor('desk', 'live', { status: 'error', error: { code: 'live_unavailable', message: 'The live AI is unavailable on this server right now.' } }));
    const before = s.health();
    app.choose(photoFile(33));
    await app.settle(60);
    assert.equal(choose(app).disabled, true, app.main());
    assert.match(why(app), /the live AI is unavailable/);
    assert.equal(s.health(), before, 'health not asked');
  } finally { s.restore(); }
});

test('Step 9 with the live AI unavailable: the notice says so, a photo stays on this device and Mark your room is offered; nothing is sent', async () => {
  const s = serve((url) => (url === 'api/health' ? json(200, DOWN) : undefined));
  try {
    const app = await at(AT9, 'live');
    const notice = textOf(app.$('main').querySelector('.notice'));
    assert.match(notice, /^LIVE, but the live AI is unavailable on this server right now\. The Model API did not accept/);
    assert.match(notice, /you can mark your room yourself; nothing is sent\. The sample rooms still work\.$/);
    assert.ok(app.button('Check again'));
    app.choose(photoFile(34));
    for (let i = 0; i < 200 && !app.button('Mark your room'); i++) await app.settle(2);
    assert.ok(app.button('Mark your room'), app.main());
    assert.equal(s.posts(), 0);
  } finally { s.restore(); }
});
