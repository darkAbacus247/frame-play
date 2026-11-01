// The room postcard (src/postcard.js) on the real app.js (tests/apphost.js):
// offered only with the server's switch on (health.postcard) and for a level
// read live from a photo this visit, never a sample room; the request
// carries the round's own shrunk photo and the room's name; a 200 draws the
// card with its label and the read-back line, an error its words, and the
// end card stays usable either way; Save is a download link to the JPEG.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, stopApps, photoFile, textOf, until } from './apphost.js';
import { played } from './stub_game.js';
import { replyFor } from './replies.js';
import { roadAt, DESK, AT_OWN } from './roads.js';
import { installFakeDocument } from './fakedom.js';
import { el } from '../src/ui.js';
import {
  makePostcard, postcardCard, postcardEligible, keepPostcardPhoto, readbackLine, blobToDataUrl,
  POSTCARD_BUTTON, POSTCARD_LABEL, POSTCARD_BUSY, POSTCARD_TITLE, POSTCARD_SAVE, POSTCARD_NO_SERVER, POSTCARD_FAILED,
} from '../src/postcard.js';

const won = () => ({ status: 'won', ratio: 1.0, words: { title: 'Room cleared!', body: 'You took the shortest route.' } });
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0xff, 0xd9]).toString('base64');
const DATA_URL = `data:image/jpeg;base64,${JPEG_B64}`;
const GOOD = { image: JPEG_B64, label: POSTCARD_LABEL, mode: 'live', readback: { lines: ['Greetings from The Desk Top'], match: true, difference: '' } };
const OFF_WORDS = 'Room postcards are switched off on this server. The round itself still works.';
const OFF = { status: 'error', error: { code: 'image_off', message: OFF_WORDS } };
const ON = { postcard: 'on', postcard_reason: 'One Muse Image edit of the round\'s photo, then a Muse Spark read-back of its printed text.' };

const cardButtons = (app) => app.$('card').querySelectorAll('button');
const cardButton = (app, name) => cardButtons(app).find((b) => textOf(b) === name) || null;
const cardTitle = (app) => textOf(app.$('card').querySelector('h2'));

// a postcard server: every request's body kept, each answer released by hand
function postcardServer(answer) {
  const s = { bodies: [], requests: [], release: null };
  s.serve = (body, opts) => {
    s.bodies.push(JSON.parse(body));
    s.requests.push(opts);
    return new Promise((resolve) => { s.release = () => resolve(answer()); });
  };
  return s;
}

async function at(road, opts = {}) {
  const app = await bootApp({ mode: 'live', road, answer: () => replyFor('desk', 'live'), ...opts });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  return app;
}

// Step 2: a photo read live, its reveal, Play, then the round ends on its card
async function playPhoto(app, seed) {
  app.choose(photoFile(seed));
  await until(app, () => app.step() === 3, 'the reveal');
  app.mainPrimary().click();
  await until(app, () => app.step() === 4, 'the play step');
  played.last.onEnd(won());
  await app.settle(3);
  assert.ok(app.cardOpen(), 'the end card is up');
}

test('with the switch on and a live photo level, the end card offers the postcard as a secondary; the request carries the round’s shrunk photo and the room’s name; a 200 draws the card; Back brings the end card', async () => {
  const s = postcardServer(() => ({ status: 200, body: GOOD }));
  const app = await at(roadAt(2), { health: ON, postcard: s.serve });
  await playPhoto(app, 41);
  const b = cardButton(app, POSTCARD_BUTTON);
  assert.ok(b, `the postcard button: ${cardButtons(app).map(textOf).join(' | ')}`);
  assert.equal(b.hasAttribute('data-primary'), false, 'never the primary');
  assert.ok(b.getAttribute('aria-describedby'), 'its tip is given to screen readers');
  assert.equal(cardButtons(app).at(-1), b, 'the last of the card’s buttons');
  assert.equal(textOf(app.cardPrimary()), 'Continue: the second room', 'the road’s own primary stays');
  // the photo is kept in memory only
  assert.doesNotMatch(JSON.stringify(app.levels()), /data:image/, 'no photo on the device');
  b.click();
  await app.settle(2);
  assert.ok(app.cardOpen());
  assert.equal(cardTitle(app), POSTCARD_TITLE);
  assert.match(textOf(app.$('card')), new RegExp(POSTCARD_BUSY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the busy line while it runs');
  assert.equal(app.$('live').textContent, POSTCARD_BUSY, 'and said aloud');
  assert.equal(s.bodies.length, 1, 'one request');
  assert.equal(s.bodies[0].room, 'The Desk Top');
  assert.match(s.bodies[0].photo, /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/, 'the shrunk JPEG as a data URL');
  assert.deepEqual(Object.keys(s.bodies[0]).sort(), ['photo', 'room']);
  assert.equal(s.requests[0].method, 'POST');
  assert.equal(s.requests[0].headers['X-FramePlay-Request'], '1');
  assert.equal(s.requests[0].headers['Content-Type'], 'application/json');
  s.release();
  await app.settle(5);
  const card = app.$('card');
  const img = card.querySelector('img');
  assert.ok(img, 'the picture');
  assert.equal(img.getAttribute('src'), DATA_URL);
  assert.ok(img.getAttribute('alt'));
  assert.equal(textOf(card.querySelector('.postcard-label')), 'Made by Muse Image (AI) · LIVE', 'the label plus the honest mode');
  assert.equal(textOf(card.querySelector('.postcard-read')), 'Read back from the picture: “Greetings from The Desk Top”. It matches.');
  const save = card.querySelector('a[download]');
  assert.ok(save, 'Save is a link');
  assert.equal(textOf(save), POSTCARD_SAVE);
  assert.equal(save.getAttribute('href'), DATA_URL, 'the JPEG data URL');
  assert.equal(save.getAttribute('download'), 'postcard.jpg');
  assert.match(app.$('live').textContent, /^Your postcard is ready\. Read back from the picture/);
  assert.equal(app.posts(), 2, 'the room read and the postcard, nothing more');
  // Back: the end card again, usable
  cardButton(app, 'Back').click();
  await app.settle(2);
  assert.equal(cardTitle(app), 'Room cleared!');
  assert.ok(cardButton(app, POSTCARD_BUTTON));
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 6, 'the road goes on to the second room');
});

test('an error answer renders its words in place of the picture, and the end card stays usable', async () => {
  const s = postcardServer(() => ({ status: 409, body: OFF }));
  const app = await at(roadAt(2), { health: ON, postcard: s.serve });
  await playPhoto(app, 42);
  cardButton(app, POSTCARD_BUTTON).click();
  await app.settle(2);
  s.release();
  await app.settle(5);
  const card = app.$('card');
  assert.equal(cardTitle(app), POSTCARD_TITLE);
  assert.equal(card.querySelector('img'), null, 'no picture');
  assert.equal(card.querySelector('a[download]'), null, 'nothing to save');
  assert.match(textOf(card), new RegExp(OFF_WORDS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(app.$('live').textContent, OFF_WORDS);
  assert.ok(app.cardPrimary(), 'the road’s primary is still here');
  cardButton(app, 'Back').click();
  await app.settle(2);
  assert.equal(cardTitle(app), 'Room cleared!');
  assert.equal(textOf(app.cardPrimary()), 'Continue: the second room');
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 6);
});

test('the primary pressed while the postcard is still being made: the road goes on and the late answer is dropped', async () => {
  const s = postcardServer(() => ({ status: 200, body: GOOD }));
  const app = await at(roadAt(2), { health: ON, postcard: s.serve });
  await playPhoto(app, 43);
  cardButton(app, POSTCARD_BUTTON).click();
  await app.settle(2);
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 6);
  assert.ok(!app.cardOpen());
  s.release();
  await app.settle(5);
  assert.ok(!app.cardOpen(), 'no card comes back for a dropped answer');
  assert.equal(app.step(), 6);
});

test('with the switch off (or a health that does not name it) the end card has no postcard button', async () => {
  for (const health of [{}, { postcard: 'off' }]) {
    const app = await at(roadAt(2), { health, postcard: () => ({ status: 200, body: GOOD }) });
    await playPhoto(app, 44);
    assert.equal(cardButton(app, POSTCARD_BUTTON), null, JSON.stringify(health));
    assert.equal(app.posts(), 1, 'only the room read');
  }
});

test('a sample room never offers a postcard, even with the switch on', async () => {
  const app = await bootApp({ mode: 'mock', server: true, health: ON, road: roadAt(4, { rooms: [DESK, null, null, null] }) });
  if (app.cardOpen()) { app.cardPrimary().click(); await app.settle(); }
  assert.equal(app.step(), 4);
  played.last.onEnd(won());
  await app.settle(3);
  assert.ok(app.cardOpen());
  assert.equal(cardButton(app, POSTCARD_BUTTON), null);
  assert.equal(app.posts(), 0);
});

test('your own room read live: the end card and then the closing screen offer the postcard; Close is the card’s way back', async () => {
  const s = postcardServer(() => ({ status: 200, body: { ...GOOD, readback: { lines: ['Greetings from The Desk Tap'], match: false, difference: 'expected "Top" but read "Tap".' } } }));
  const app = await at(AT_OWN, { health: ON, postcard: s.serve });
  app.choose(photoFile(45));
  await until(app, () => app.step() === 13, 'your own room’s reveal');
  app.mainPrimary().click();
  await until(app, () => app.step() === 14, 'the play step');
  played.last.onEnd(won());
  await app.settle(3);
  assert.ok(cardButton(app, POSTCARD_BUTTON), 'on the end card');
  app.cardPrimary().click();
  await until(app, () => app.h1() === 'You’ve completed FRAME//PLAY', 'the closing screen');
  const b = app.button('Make a postcard (Muse Image): your own room');
  assert.ok(b, `on the closing screen: ${app.$('main').querySelectorAll('button').map(textOf).join(' | ')}`);
  assert.equal(b.hasAttribute('data-primary'), false);
  assert.equal(app.$('main').querySelectorAll('button').filter((x) => textOf(x).startsWith(POSTCARD_BUTTON)).length, 1, 'the sample rooms offer none');
  b.click();
  await app.settle(2);
  assert.ok(app.cardOpen());
  assert.equal(cardTitle(app), POSTCARD_TITLE);
  assert.equal(cardButton(app, 'Back'), null, 'nothing to go back to');
  s.release();
  await app.settle(5);
  assert.equal(app.$('card').querySelector('img').getAttribute('src'), DATA_URL);
  assert.equal(textOf(app.$('card').querySelector('.postcard-read')), 'Read back from the picture: “Greetings from The Desk Tap”. It does not match: expected "Top" but read "Tap".');
  assert.equal(textOf(app.cardPrimary()), 'Close');
  app.cardPrimary().click();
  await app.settle(2);
  assert.ok(!app.cardOpen());
  assert.equal(app.step(), 15, 'the closing screen stays');
  assert.equal(s.bodies[0].room, 'The Desk Top');
});

// ---- the module on its own ----

test('postcardEligible: the switch on and a LIVE level with its photo in memory, nothing else', () => {
  const live = { origin: 'live', title: 'Kitchen' };
  assert.equal(keepPostcardPhoto(live, DATA_URL), true);
  assert.equal(postcardEligible({ postcard: 'on' }, live), true);
  assert.equal(postcardEligible({ postcard: 'off' }, live), false);
  assert.equal(postcardEligible(null, live), false);
  assert.equal(postcardEligible({ postcard: 'on' }, { origin: 'live' }), false, 'no photo kept');
  for (const origin of ['mock', 'replay', 'rehearsal', 'marked']) {
    const other = { origin };
    keepPostcardPhoto(other, DATA_URL);
    assert.equal(postcardEligible({ postcard: 'on' }, other), false, origin);
  }
  assert.equal(keepPostcardPhoto(live, 'data:image/png;base64,AAAA'), false, 'only the JPEG copy');
  assert.equal(keepPostcardPhoto(live, 'http://x/photo.jpg'), false);
});

test('the kept photo never reaches the device: it is not part of the level’s JSON', () => {
  const level = { origin: 'live', title: 'Kitchen', objects: [] };
  keepPostcardPhoto(level, DATA_URL);
  assert.equal(level.postcardPhoto, DATA_URL);
  assert.doesNotMatch(JSON.stringify(level), /postcardPhoto|data:image/);
  assert.deepEqual(Object.keys(level), ['origin', 'title', 'objects']);
  assert.equal(JSON.parse(JSON.stringify(level)).postcardPhoto, undefined);
});

test('blobToDataUrl: the blob’s bytes as a JPEG data URL', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  assert.equal(await blobToDataUrl(new Blob([bytes], { type: 'image/jpeg' })), `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`);
});

test('readbackLine: a match, the named difference, and a read-back that did not run', () => {
  assert.equal(readbackLine({ lines: ['Greetings from Kitchen'], match: true, difference: '' }), 'Read back from the picture: “Greetings from Kitchen”. It matches.');
  assert.equal(readbackLine({ lines: ['Greetings from', 'Kitchen'], match: true, difference: 'extra "x".' }), 'Read back from the picture: “Greetings from / Kitchen”. It matches.');
  assert.equal(readbackLine({ lines: ['Greetings from Kitchn'], match: false, difference: 'expected "Kitchen" but read "Kitchn".' }), 'Read back from the picture: “Greetings from Kitchn”. It does not match: expected "Kitchen" but read "Kitchn".');
  assert.equal(readbackLine({ lines: [], match: false, difference: 'the read-back did not run' }), 'Read back from the picture: no printed text. It does not match: the read-back did not run.');
  assert.equal(readbackLine(null), 'Read back from the picture: no printed text. It does not match: it does not match the room’s name.');
});

test('makePostcard: one POST to api/postcard with the photo and the room; the server’s words on a refusal; this page’s words when it does not answer', async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const seen = [];
  try {
    globalThis.fetch = async (url, opts) => {
      seen.push([url, opts]);
      return { ok: true, status: 200, json: async () => GOOD };
    };
    const answer = await makePostcard(DATA_URL, 'Kitchen');
    assert.equal(answer, GOOD);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 'api/postcard');
    assert.equal(seen[0][1].method, 'POST');
    assert.deepEqual(JSON.parse(seen[0][1].body), { photo: DATA_URL, room: 'Kitchen' });
    assert.equal(seen[0][1].headers['X-FramePlay-Request'], '1');
    assert.equal(seen[0][1].credentials, 'same-origin');
    assert.equal(seen[0][1].cache, 'no-store');
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ status: 'error', error: { code: 'postcard_day_cap', message: 'This server has made its 100 postcards for today. Please try again tomorrow.' } }) });
    await assert.rejects(makePostcard(DATA_URL, 'Kitchen'), { message: 'This server has made its 100 postcards for today. Please try again tomorrow.' });
    globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not JSON'); } });
    await assert.rejects(makePostcard(DATA_URL, 'Kitchen'), { message: 'The postcard could not be made. The round itself still works (the server answered 502).' });
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ label: POSTCARD_LABEL }) });
    await assert.rejects(makePostcard(DATA_URL, 'Kitchen'), { message: POSTCARD_FAILED });
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(makePostcard(DATA_URL, 'Kitchen'), { message: POSTCARD_NO_SERVER });
  } finally {
    if (had) Object.defineProperty(globalThis, 'fetch', had); else delete globalThis.fetch;
  }
});

test('postcardCard: the picture, the label with its mode, one read-back line and Save as a download link', () => {
  // a bare document: the booted pages' timers must not run against it
  stopApps();
  const doc = installFakeDocument();
  doc.body.append(el('div', { id: 'tips' }));
  const card = postcardCard({ ...GOOD, mode: 'live' });
  const img = card.querySelector('img');
  assert.equal(img.getAttribute('src'), DATA_URL);
  assert.match(img.getAttribute('alt'), /Muse Image/);
  assert.equal(card.querySelector('.postcard-label').textContent, 'Made by Muse Image (AI) · LIVE');
  assert.equal(card.querySelector('.postcard-read').textContent, 'Read back from the picture: “Greetings from The Desk Top”. It matches.');
  const save = card.querySelector('a[download]');
  assert.equal(save.getAttribute('href'), DATA_URL);
  assert.equal(save.getAttribute('download'), 'postcard.jpg');
  assert.equal(save.textContent, POSTCARD_SAVE);
  assert.ok(save.getAttribute('aria-describedby'), 'its tip is given to screen readers');
  // a label the server did not send falls back to the honest one
  const bare = postcardCard({ image: JPEG_B64, readback: null });
  assert.equal(bare.querySelector('.postcard-label').textContent, `${POSTCARD_LABEL} · LIVE`);
});
