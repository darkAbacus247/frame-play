// Our kitchen when LIVE cannot read it now: the server's spending stop, its
// hourly or daily photo cap, or an account or model problem (a refused key,
// credit or billing, answered live_unavailable). Our kitchen is the first
// card on the judge path, so it falls back to Meta's recorded answer,
// replayed and labeled REPLAY, and says why, rather than ending on a
// refusal. On the real app.js (tests/apphost.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, paintCanvases, until, photoFile } from './apphost.js';
import { roadAt, AT_OWN } from './roads.js';
import { replayReply, liveKitchenReply, KITCHEN_PIXELS } from './kitchen.js';
import { OURS_REF, REPLAY_WORDS } from '../src/own.js';
import { OWN_SLOT, OWN_STEP } from '../src/road.js';

// api/room answered by the test, through the fetch the app host installs
// (kept through the setter); everything else goes to the app host's own.
// posts: every POST's address, in order.
function serve(handler) {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  let inner = null;
  const posts = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    get: () => async (url, opts = {}) => {
      if (opts.method === 'POST') posts.push(String(url));
      const r = await handler(String(url), opts);
      return r === undefined ? inner(url, opts) : r;
    },
    set: (f) => { inner = f; },
  });
  return { posts, restore: () => Object.defineProperty(globalThis, 'fetch', orig) };
}

const json = (status, body, headers = {}) => {
  const h = new Map(Object.entries({ 'content-type': 'application/json', ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => body };
};

// as the server sends them (server/limits.py, server/server.py, server/pipeline.py)
const SPEND = 'This server has reached its spending stop for today ($5.00 estimated). Please try again tomorrow, or play the sample rooms.';
const STOPS = [
  ['the spending stop', () => json(429, { status: 'refused', error: { code: 'spend_stop', message: SPEND } }, { 'Retry-After': '3600' }),
    'Not read live now: this server reached its spending stop for today.'],
  ['the daily cap', () => json(429, { status: 'refused', error: { code: 'day_cap', message: 'This server has read its 200 photos for today. Please try again tomorrow.' } }),
    'Not read live now: this server has read its photos for today.'],
  ['the hourly cap', () => json(429, { status: 'refused', error: { code: 'hour_cap', message: 'This server has read 120 photos in the last hour. Please try again later.' } }, { 'Retry-After': '900' }),
    'Not read live now: this server has read its photos for this hour.'],
  ['the live AI unavailable', () => json(503, { status: 'error', error: { code: 'live_unavailable', message: 'The live AI is unavailable on this server right now (an account or model problem the owner must fix). The sample rooms still work.' } }, { 'Retry-After': '600' }),
    'Not read live now: the live AI is unavailable on this server right now.'],
  // in the reply itself: the stop reached mid-photo, and a credit or billing refusal from the Model API
  ['the spending stop, mid-photo', () => json(200, { ...liveKitchenReply(), status: 'refused', error: { code: 'spend_stop', message: 'This server has reached its spending stop for today ($5.00 estimated).' } }),
    'Not read live now: this server reached its spending stop for today.'],
  ['a credit refusal from the Model API', () => json(200, { ...liveKitchenReply(), status: 'error', error: { code: 'live_unavailable', status: 402, message: 'The Model API account behind this server needs a payment method or credit. The owner of this server must fix this; the sample rooms still work.' } }),
    'Not read live now: the live AI is unavailable on this server right now.'],
];

async function at(road, answer, opts = {}) {
  const { posts, restore } = serve((url) => (url === 'api/room' ? answer() : undefined));
  const app = await bootApp({ mode: 'live', road, answer: () => liveKitchenReply(), replay: replayReply, ...opts });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  return { app, restore, posted: () => posts };
}

for (const [name, answer, why] of STOPS) {
  test(`LIVE, Step 2, ${name}: our kitchen is replayed, labeled REPLAY, and says why`, async () => {
    const { app, restore, posted } = await at(roadAt(2), answer);
    try {
      paintCanvases(app, KITCHEN_PIXELS);
      app.$('main').querySelector('.ours-card').click();
      await until(app, () => app.step() === 3, 'the replayed room', 120000);
    } finally { restore(); delete globalThis.createImageBitmap; }
    assert.deepEqual(posted(), ['api/room', 'api/replay/kitchen'], 'one refused send, then the replay on this page’s own server');
    assert.equal(app.h1(), 'What the AI found');
    assert.ok(app.main().includes(`${why} ${REPLAY_WORDS}`), app.main().slice(0, 400));
    assert.match(app.main(), /REPLAY · Meta’s recorded answer of Oct 27, 2026 · no model was called now/);
    assert.doesNotMatch(app.main(), /read by Meta’s models now/, 'never said to be read now');
    assert.deepEqual(app.savedRoad().rooms[0], OURS_REF);
  });
}

test('LIVE, Your own room, the spending stop: Use ours is replayed, labeled REPLAY, and says why', async () => {
  const [, answer, why] = STOPS[0];
  const { app, restore, posted } = await at(AT_OWN, answer);
  try {
    assert.equal(app.step(), OWN_STEP);
    paintCanvases(app, KITCHEN_PIXELS);
    app.$('main').querySelector('.ours-card .ours-use').click();
    await until(app, () => app.step() === OWN_STEP + 1, 'the replayed room', 120000);
  } finally { restore(); delete globalThis.createImageBitmap; }
  assert.deepEqual(posted(), ['api/room', 'api/replay/kitchen']);
  assert.ok(app.main().includes(`${why} ${REPLAY_WORDS}`), app.main().slice(0, 400));
  assert.deepEqual(app.savedRoad().rooms[OWN_SLOT], OURS_REF);
  assert.deepEqual(app.levels(), [], 'a replay is never kept as a photo’s level');
});

test('LIVE, the spending stop: a photo of your own is still refused in words (only our kitchen has a recorded answer)', async () => {
  const { app, restore, posted } = await at(roadAt(2), STOPS[0][1]);
  try {
    app.choose(photoFile(81));
    for (let i = 0; i < 200 && !app.$('main').querySelector('.progress .error'); i++) await app.settle(2);
  } finally { restore(); }
  assert.deepEqual(posted(), ['api/room']);
  assert.equal(app.step(), 2);
  assert.ok(app.main().includes(SPEND), app.main().slice(0, 400));
});

test('LIVE, the spending stop, on a server with no replay: our kitchen keeps the refusal, in words', async () => {
  const { app, restore, posted } = await at(roadAt(2), STOPS[0][1], { replay: null });
  try {
    paintCanvases(app, KITCHEN_PIXELS);
    app.$('main').querySelector('.ours-card').click();
    for (let i = 0; i < 200 && !app.$('main').querySelector('.progress .error'); i++) await app.settle(2);
  } finally { restore(); delete globalThis.createImageBitmap; }
  assert.deepEqual(posted(), ['api/room']);
  assert.equal(app.step(), 2);
  assert.ok(app.main().includes(SPEND));
});
