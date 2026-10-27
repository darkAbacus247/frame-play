// The connected flow (F31): Step 12 says, in each mode, what will happen to
// a photo before one is chosen; a refused key says it is the operator's key
// and offers marking; the README says how a photo becomes a room in each
// mode, marking included.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootApp, photoFile, textOf } from './apphost.js';
import { replyFor } from './replies.js';
import { refusalWords, keyRefused, KEY_WORDS, acceptReply } from '../src/reply.js';
import { makeOwnRoom, MOCK_WORDS } from '../src/own.js';
import { OWN_NOTICE } from '../src/screens.js';
import { AT_OWN as AT12 } from './roads.js';

const KEY = { code: 'invalid_api_key', message: "The Model API did not accept this server's key", status: 401 };

test('Step 12 says what will happen to a photo, in each mode, before one is chosen', async () => {
  const want = {
    live: /^LIVE: your photo is shrunk on this device and its camera data removed, then read by Meta’s Model API \(Muse Spark, then SAM 3\.1\)\./,
    mock: /^MOCK: no model reads photos in this copy\. Your photo stays on this device, and you mark its objects yourself; code traces their outlines\. Nothing is sent\.$/,
    rehearsal: /^REHEARSAL: a local stand-in answers, not Meta\./,
  };
  for (const mode of ['live', 'mock', 'rehearsal']) {
    const app = await bootApp({ mode, road: AT12 });
    app.cardPrimary().click();
    await app.settle();
    const notice = textOf(app.$('main').querySelector('.notice'));
    assert.match(notice, want[mode], mode);
    assert.equal(notice, OWN_NOTICE[mode]);
    assert.equal(app.$('main').querySelector('.own-result').hidden, true, `${mode}: nothing chosen yet`);
  }
  assert.equal(OWN_NOTICE.mock, MOCK_WORDS);
  assert.doesNotMatch(MOCK_WORDS, /live AI|needs/, 'MOCK no longer reads as a dead end');
});

test('a refused key is told by its status, and named as the operator’s key, never the player’s', () => {
  const live = replyFor('desk', 'live', { status: 'error', error: KEY });
  assert.equal(keyRefused(live), true);
  assert.equal(refusalWords(live), KEY_WORDS.live);
  assert.match(KEY_WORDS.live, /^Meta’s Model API refused the key that whoever runs this copy set for it \(not anything of yours\)/);
  assert.equal(acceptReply('live', live, { width: 1024, height: 768 }).why, KEY_WORDS.live);
  const reh = replyFor('desk', 'rehearsal', { status: 'error', error: KEY });
  assert.equal(refusalWords(reh), KEY_WORDS.rehearsal);
  assert.match(KEY_WORDS.rehearsal, /not Meta/);
  // other errors keep their own words, ending as a sentence ends
  assert.equal(refusalWords(replyFor('desk', 'live', { status: 'error', error: { code: 'timeout', message: 'The photo ran out of time' } })), 'The photo ran out of time.');
  assert.equal(keyRefused(replyFor('desk', 'live', { status: 'error', error: { code: 'http_402', message: 'x', status: 402 } })), false);
});

test('makeOwnRoom: a refused key can be marked; the people and content refusals cannot', async () => {
  const deps = (reply) => ({
    preview: async () => ({}),
    readPhoto: async () => ({ sha256: 'cd'.repeat(32), blob: 'b', picture: 'the copy', pixels: null, width: 1024, height: 768 }),
    send: async () => reply,
  });
  const file = { type: 'image/jpeg', size: 300000 };
  const key = await makeOwnRoom({ mode: 'live', file, deps: deps(replyFor('desk', 'live', { status: 'error', error: KEY })) });
  assert.deepEqual([key.kind, key.markable, key.sha256, key.picture, key.words], ['refused', true, 'cd'.repeat(32), 'the copy', KEY_WORDS.live]);
  for (const code of ['people_present', 'content_filter']) {
    const r = await makeOwnRoom({ mode: 'live', file, deps: deps(replyFor('desk', 'live', { status: 'refused', error: { code, message: 'No.' } })) });
    assert.equal(r.markable, false, code);
  }
  const mock = await makeOwnRoom({ mode: 'mock', file, deps: deps(null) });
  assert.equal(mock.markable, true);
  // a room made again in place is never offered marking
  const inPlace = await makeOwnRoom({ mode: 'live', file, sameAs: 'cd'.repeat(32), deps: deps(replyFor('desk', 'live', { status: 'error', error: KEY })) });
  assert.equal(inPlace.markable, false);
});

test('LIVE, through the page: the refused key’s words, then Mark your room as the one primary', async () => {
  const app = await bootApp({ mode: 'live', road: AT12, answer: () => replyFor('desk', 'live', { status: 'error', error: KEY }) });
  app.cardPrimary().click();
  await app.settle();
  app.choose(photoFile(21));
  for (let i = 0; i < 200 && !app.button('Mark your room'); i++) await app.settle(2);
  const words = textOf(app.$('main').querySelector('.own-result .error'));
  assert.equal(words, `${KEY_WORDS.live} You can mark the room yourself instead, try another photo, or continue to the end.`);
  assert.deepEqual(app.$('main').querySelectorAll('[data-primary]').map(textOf), ['Mark your room']);
  assert.equal(app.why(), 'Mark your room, or continue to the end');
  assert.equal(app.posts(), 1);
});

test('the README says how a photo becomes a room in each mode, marking included', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(readme, /### How a photo becomes a room/);
  assert.match(readme, /\*\*LIVE\*\*.*for a refused key it says plainly that it is the operator's key, not anything of yours; then Mark your room is the way on, and nothing more is sent\./);
  assert.match(readme, /\*\*MOCK\*\* \(no key\): no model reads the photo.*Mark your room, right under it, is the way on: you mark the room yourself\. Nothing is sent\./);
  assert.match(readme, /\*\*REHEARSAL\*\*.*A refused photo, or a read that fails, can be marked as in MOCK\./);
  assert.match(readme, /\*\*Mark it yourself\.\*\* On Step 13 \(named Your marks\)/);
  assert.match(readme, /keeping your box where the trace is not tight/);
  assert.match(readme, /"Your own room: marked by you"/);
  assert.match(readme, /never the photo, so after a reload the same photo picked again brings the room back in place/);
  assert.doesNotMatch(readme, /why it needs the live AI/);
});
