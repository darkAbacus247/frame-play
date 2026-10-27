// Where SAM's real answers (S1-S5) meet your own marked room (F30-F31),
// through the page's own wiring (the real app.js booted in Node by
// tests/apphost.js): a room that mixes SAM's matches and regions traced
// around Muse Spark's points says so on every screen, and again when it is
// reopened from this device; and in REHEARSAL a photo the stand-in refused
// becomes a room the player marks, with nothing more sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootApp, photoFile, textOf, paintCanvases, until } from './apphost.js';
import { played } from './stub_game.js';
import { replyFor, rooms } from './replies.js';
import { loadRoom } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { LABELS } from '../src/level.js';
import { KEY_WORDS } from '../src/reply.js';
import { jpegLike } from './jpegsim.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const AT9 = {
  v: 3, step: 9, reached: 9, consent: true, own: null,
  rooms: [{ kind: 'sample', id: 'desk' }, { kind: 'sample', id: 'living' }, null],
  finished: [true, true, false], best: [1.24, null, null],
};
const desk = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
// the desk's own picture as a browser holds it after a JPEG round trip
const DESK = { width: desk.width, height: desk.height, data: jpegLike(paintRoom(desk).rgba, desk.width, desk.height, 90) };

test('REHEARSAL: a room of 5 SAM matches and 4 regions around Muse Spark’s points says so everywhere, and again when reopened', { timeout: 240000 }, async () => {
  // the recorded 10-27 answers through the real pipeline, SAM answering no
  // match for the mug and the coins (server/tests/recorded.py; nothing sent)
  const reply = JSON.parse(execFileSync(PYTHON, ['-B', '-m', 'server.tests.recorded', '--none-for', 'coffee mug,gold coin'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 }));
  assert.deepEqual([reply.provenance.found.sam, reply.provenance.found.points], [5, 4]);
  const file = photoFile(31);
  const app = await bootApp({ mode: 'rehearsal', road: AT9, answer: () => reply });
  app.cardPrimary().click();
  await app.settle();
  paintCanvases(app, DESK);
  try {
    app.choose(file);
    await until(app, () => app.h1() === 'What the AI found', 'the reveal', 120000);
  } finally { delete globalThis.createImageBitmap; }
  assert.equal(app.posts(), 1);
  const FOUND = /The stand-in for SAM 3\.1 found 5; for 4 more, code traced around Muse Spark’s points/;
  const summary = textOf(app.$('main').querySelector('.summary'));
  assert.match(summary, FOUND);
  // the counts on the reveal are the level's own: 5 from SAM's masks, 4 from the points
  const level = app.levels()[0].level;
  const c = level.provenance.outline_sources;
  assert.equal(c.sam_mask, 5, 'the 5 SAM found are outlined by their own masks');
  assert.equal(c.traced_in_box + c.box, 0);
  assert.equal(c.traced_at_points + c.points_box, 4);
  assert.match(summary, /The stand-in for SAM 3\.1’s masks gave 5 exact outlines; code traced 0\. Code then proved the room can be won\./);
  assert.equal((app.main().match(/SAM did not find it/g) || []).length, 8, 'each of the 4 says so, in its source and its confidence');
  assert.doesNotMatch(app.main(), /marked by you|You marked/, 'a read room is never said to be marked');
  assert.equal(app.button('Mark your room'), null);
  assert.equal(textOf(app.$('main').querySelector('.level-label')), LABELS.rehearsal);
  app.mainPrimary().click();
  await app.settle();
  assert.equal(played.last.level.label, LABELS.rehearsal, 'the play label');
  played.last.onEnd({ status: 'won', ratio: 1.2, travelled: 1, words: { title: 'You won', body: 'Every coin, then the exit.' } });
  await app.settle();
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 12);
  const row = textOf(app.$('main').querySelectorAll('.closing-rooms li')[2]);
  assert.match(row, /the stand-in for SAM 3\.1 found 5; for 4 more, code traced around Muse Spark’s points/, 'the closing row');
  assert.match(row, /the stand-in for SAM 3\.1’s masks gave 5 exact outlines; code traced 0; and code proved the room can be won/);

  // reopened on a return visit: the level kept on this device, by the same
  // photo, with the same words and nothing sent
  const kept = app.levels();
  for (const step of [10, 11]) {
    const again = await bootApp({ mode: 'rehearsal', road: { ...app.savedRoad(), step, reached: step }, answer: () => { throw new Error('nothing may be sent'); }, prefs: { levels: kept } });
    again.cardPrimary().click();
    await again.settle();
    paintCanvases(again, DESK);
    try {
      again.choose(file);
      await until(again, () => (step === 10 ? again.h1() === 'What the AI found' : again.$('main').querySelector('.game')), 'the room reopened', 120000);
    } finally { delete globalThis.createImageBitmap; }
    assert.equal(again.posts(), 0, 'reopened from this device');
    assert.equal(again.step(), step, 'in place');
    if (step === 10) {
      assert.match(again.main(), /Loaded from this device: no model was called this time\./);
      assert.equal(textOf(again.$('main').querySelector('.summary')), summary, 'the same words, from the same counts');
    } else {
      assert.deepEqual(played.last.level.provenance.outline_sources, c, 'the same counts in play');
    }
  }
});

test('REHEARSAL: the stand-in refuses the photo (its key drill); the player marks the room, and nothing more is sent', { timeout: 120000 }, async () => {
  const refused = replyFor('desk', 'rehearsal', { status: 'error', error: { code: 'invalid_api_key', message: "The Model API did not accept this server's key", status: 401 } });
  const app = await bootApp({ mode: 'rehearsal', road: AT9, answer: () => refused });
  app.cardPrimary().click();
  await app.settle();
  paintCanvases(app, rooms.desk.pixels);
  try {
    app.choose(photoFile(32));
    await until(app, () => app.button('Mark your room'), 'Mark your room');
    assert.equal(app.posts(), 1, 'the one read the stand-in refused');
    assert.equal(textOf(app.$('main').querySelector('.own-result .error')), `${KEY_WORDS.rehearsal} You can mark the room yourself instead, try another photo, or continue to the end.`);
    assert.deepEqual(app.$('main').querySelectorAll('[data-primary]').map(textOf), ['Mark your room']);
    app.button('Mark your room').click();
    await until(app, () => app.h1() === 'Your marks', 'the marking screen');
    const canvas = app.$('main').querySelector('.mark-board canvas');
    const ROLE_BUTTON = { collect: 'Coin', solid: 'Obstacle', avoid: 'Hazard', exit: 'Exit' };
    for (const o of rooms.desk.room.objects.filter((x) => x.on_surface)) {
      const role = o.role === 'flat' ? 'solid' : o.role;
      app.$('main').querySelectorAll('button').find((b) => b.getAttribute('data-role') && textOf(b) === ROLE_BUTTON[role]).click();
      const [x0, y0, x1, y1] = [o.bounds.x0 - 8, o.bounds.y0 - 8, o.bounds.x1 + 8, o.bounds.y1 + 8].map(Math.round);
      canvas.dispatch('pointerdown', { clientX: x0, clientY: y0, pointerId: 1, button: 0 });
      canvas.dispatch('pointermove', { clientX: x1, clientY: y1, pointerId: 1 });
      canvas.dispatch('pointerup', { clientX: x1, clientY: y1, pointerId: 1 });
    }
    app.button('Make the room').click();
    await until(app, () => app.h1() === 'Your room, from your marks', 'the reveal');
  } finally { delete globalThis.createImageBitmap; }
  assert.equal(app.posts(), 1, 'marking sends nothing');
  const summary = textOf(app.$('main').querySelector('.summary'));
  assert.match(summary, /^You marked 9 objects; code traced (\d) outlines? inside your boxes and kept (\d) as (a box|boxes); no model was called\. Code proved the room can be won\.$/);
  const [, t, b] = /traced (\d) .* kept (\d)/.exec(summary);
  assert.equal(+t + +b, 9);
  assert.doesNotMatch(app.main(), /Muse Spark|SAM|stand-in|confidence/, 'nothing says a model read it');
  assert.equal(textOf(app.$('main').querySelector('.level-label')), LABELS.marked);
  assert.equal(app.storage.getItem('frameplay.levels'), null, 'no read level is kept');
  assert.equal(JSON.parse(app.storage.getItem('frameplay.marked'))[0].level.origin, 'marked');
  app.mainPrimary().click();
  await app.settle();
  assert.equal(played.last.level.label, LABELS.marked);
  played.last.onEnd({ status: 'won', ratio: 1.1, travelled: 1, words: { title: 'You won', body: 'Every coin, then the exit.' } });
  await app.settle();
  app.cardPrimary().click();
  await app.settle();
  assert.match(textOf(app.$('main').querySelectorAll('.closing-rooms li')[2]), /^Your own room: marked by you Won .* You marked 9 objects; code traced \d outlines? inside your boxes/);
  app.mainPrimary().click();
  await app.settle();
  assert.ok(app.$('main').querySelectorAll('.room-card').map(textOf).includes('Your own room: marked by you MARKED · by you'), 'Free play');
  assert.equal(app.posts(), 1);
});
