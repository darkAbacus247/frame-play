// Your own room marked by hand, through the page's own wiring (the real
// app.js booted in Node by tests/apphost.js): a chosen photo is never a dead
// end, in any mode; in MOCK nothing the page does carries the photo or
// anything made from it off the device; and a reload restores the room in
// place from the marks kept here, by the same photo picked again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { bootApp, photoFile, textOf, paintCanvases, until } from './apphost.js';
import { played } from './stub_game.js';
import { rooms, replyFor } from './replies.js';
import { LABELS } from '../src/level.js';
import { AT_OWN as AT12 } from './roads.js';

const DESK = rooms.desk.pixels;

const primaries = (app) => app.$('main').querySelectorAll('[data-primary]');
const board = (app) => app.$('main').querySelector('.mark-board');
const canvas = (app) => app.$('main').querySelector('.mark-board canvas');

// a drag over the board, in picture pixels (the fake page lays nothing out,
// so client pixels are picture pixels)
function drag(app, [x0, y0, x1, y1]) {
  const c = canvas(app);
  c.dispatch('pointerdown', { clientX: x0, clientY: y0, pointerId: 1, button: 0 });
  c.dispatch('pointermove', { clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2, pointerId: 1 });
  c.dispatch('pointermove', { clientX: x1, clientY: y1, pointerId: 1 });
  c.dispatch('pointerup', { clientX: x1, clientY: y1, pointerId: 1 });
}
const key = (app, k, shiftKey = false) => board(app).dispatch('keydown', { key: k, shiftKey, ctrlKey: false, metaKey: false, altKey: false });
const roleButton = (app, name) => app.$('main').querySelectorAll('button').find((b) => b.getAttribute('data-role') && textOf(b) === name);
const ROLE_BUTTON = { collect: 'Coin', solid: 'Obstacle', avoid: 'Hazard', exit: 'Exit' };
const deskObjects = () => rooms.desk.room.objects.filter((o) => o.on_surface).map((o) => ({ role: o.role === 'flat' ? 'solid' : o.role, box: [o.bounds.x0 - 8, o.bounds.y0 - 8, o.bounds.x1 + 8, o.bounds.y1 + 8].map(Math.round) }));

async function toOwnStep(mode = 'mock', opts = {}) {
  const app = await bootApp({ mode, road: AT12, ...opts });
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 12);
  return app;
}

async function chooseAndMark(app, file) {
  app.choose(file);
  await until(app, () => app.button('Mark your room'), 'Mark your room');
  app.button('Mark your room').click();
  await until(app, () => app.h1() === 'Your marks', 'the marking screen');
}

// every request the page made, as [method, url]: in MOCK only its own files
// (our kitchen photo for its card's thumbnail) and the health check, all
// GET, none carrying a body
function onlyItsOwnFiles(app) {
  for (const [method, url] of app.requests) {
    assert.equal(method, 'GET', `${method} ${url}`);
    assert.match(url, /^(rooms\/(desk|living|apartment)\.json|rooms\/kitchen\.jpg|api\/health)$/, url);
  }
}

test('MOCK: before a photo, Step 12 is as it was; after one, Mark your room is the one primary, right under it', async () => {
  const app = await toOwnStep();
  assert.deepEqual(primaries(app).map(textOf), ['Continue to the end'], 'the stranger walk does not change');
  assert.equal(app.why(), 'Continue to the end to go on');
  paintCanvases(app, DESK);
  try {
    app.choose(photoFile(7));
    await until(app, () => app.button('Mark your room'), 'Mark your room');
  } finally { delete globalThis.createImageBitmap; }
  assert.deepEqual(primaries(app).map(textOf), ['Mark your room'], 'exactly one primary');
  assert.ok(app.button('Continue to the end'), 'Continue to the end stays, as the secondary');
  assert.ok(!app.button('Continue to the end').hasAttribute('data-primary'));
  const shown = app.$('main').querySelector('.own-result');
  assert.equal(shown.children[0].tagName, 'FIGURE', 'the photo');
  assert.ok(shown.children[1].contains(app.button('Mark your room')), 'and the way on right under it');
  assert.equal(app.why(), 'Mark your room, or continue to the end');
  onlyItsOwnFiles(app);
});

test('MOCK: marked with the pointer, made, played, ended and replayed; nothing leaves the device', async () => {
  const app = await toOwnStep();
  paintCanvases(app, DESK);
  const file = photoFile(7);
  try {
    await chooseAndMark(app, file);
    assert.equal(app.step(), 13);
    assert.equal(app.counter(), 'Step 13 of 15: Your marks');
    assert.equal(app.why(), 'Make the room from your marks to go on');
    assert.ok(app.$('road').querySelectorAll('button')[1].disabled, 'Forward waits');
    assert.deepEqual(primaries(app).map(textOf), ['Make the room']);
    const needs = () => textOf(app.$('main').querySelector('.needs'));
    assert.match(needs(), /^Draw a box over an object to mark it/);
    // too early: says why, and stays
    app.button('Make the room').click();
    await app.settle();
    assert.equal(needs(), 'Not yet: Draw a box over an object to mark it. The room needs at least one coin and an exit.');
    assert.equal(app.h1(), 'Your marks');
    const marks = deskObjects();
    for (const m of marks) {
      roleButton(app, ROLE_BUTTON[m.role]).click();
      drag(app, m.box);
    }
    assert.equal(app.$('main').querySelectorAll('.chips button').length, 9, 'a chip for each box');
    assert.match(needs(), /^Ready: 3 coins, the exit and 5 other boxes\./);
    // select, change and remove, then undo
    roleButton(app, 'Exit').click();
    drag(app, [900, 100, 1000, 200]);
    assert.equal(app.$('main').querySelectorAll('.chips button').length, 10);
    assert.match(needs(), /^Keep one exit: change or remove 1 of the 2\./);
    app.$('main').querySelectorAll('.chips button')[9].click();
    roleButton(app, 'Obstacle').click();
    assert.match(needs(), /^Ready: 3 coins, the exit and 6 other boxes/, 'the selected box changed');
    app.button('Remove the box').click();
    assert.match(needs(), /^Ready:/);
    app.button('Undo').click();
    assert.equal(app.$('main').querySelectorAll('.chips button').length, 10, 'undo brings it back');
    app.button('Undo').click();
    app.button('Undo').click();
    assert.equal(app.$('main').querySelectorAll('.chips button').length, 9);
    // a box pressed and dragged moves
    const chip = () => app.$('main').querySelectorAll('.chips button')[0];
    drag(app, [marks[0].box[0] + 20, marks[0].box[1] + 20, marks[0].box[0] + 20, marks[0].box[1] + 20]);
    assert.equal(chip().getAttribute('aria-pressed'), 'true', 'pressing a box selects it');
    const keptBox = () => JSON.parse(app.storage.getItem('frameplay.marked'))[0].marks[0].box;
    const before = keptBox();
    drag(app, [marks[0].box[0] + 20, marks[0].box[1] + 20, marks[0].box[0] + 26, marks[0].box[1] + 24]);
    assert.deepEqual(keptBox(), [before[0] + 6, before[1] + 4, before[2] + 6, before[3] + 4], 'dragging the selected box moves it');
    assert.equal(app.$('main').querySelectorAll('.chips button').length, 9, 'and draws nothing');
    app.button('Make the room').click();
    await until(app, () => app.h1() === 'Your room, from your marks', 'the reveal');
  } finally { delete globalThis.createImageBitmap; }
  assert.equal(app.step(), 13, 'made on the same step');
  assert.equal(app.counter(), 'Step 13 of 15: Your marks');
  const summary = textOf(app.$('main').querySelector('.summary'));
  assert.match(summary, /^You marked 9 objects; code traced (\d) outlines? inside your boxes and kept (\d) as (a box|boxes); no model was called\. Code proved the room can be won\.$/);
  const [, t, b] = /traced (\d) .* kept (\d)/.exec(summary);
  assert.equal(+t + +b, 9);
  assert.ok(+t >= 6, summary);
  assert.equal(textOf(app.$('main').querySelector('.level-label')), LABELS.marked);
  assert.doesNotMatch(app.main(), /Muse Spark|SAM|AI found|confidence/, 'nothing says a model read it');
  assert.ok(app.button('Change your marks'));
  app.mainPrimary().click();
  await app.settle();
  assert.equal(app.step(), 14);
  assert.equal(played.last.level.label, LABELS.marked, 'the play label says who marked it');
  played.last.onEnd({ status: 'won', ratio: 1.1, travelled: 1, words: { title: 'You won', body: 'Every coin, then the exit.' } });
  await app.settle();
  app.cardPrimary().click();
  await app.settle();
  assert.equal(app.step(), 15);
  const row = app.$('main').querySelectorAll('.closing-rooms li')[3];
  assert.match(textOf(row), /^Your own room: marked by you Won · best route 1\.1 times the shortest You marked 9 objects; code traced \d outlines? inside your boxes and kept \d as (a box|boxes); no model was called\. Code proved the room can be won\. Play again/);
  app.mainPrimary().click();
  await app.settle();
  assert.equal(app.step(), 16);
  const cards = app.$('main').querySelectorAll('.room-card').map(textOf);
  assert.ok(cards.includes('Your own room: marked by you MARKED · by you'), cards.join(' | '));
  // nothing left the device: no request but the page's own files, and what
  // is kept is the marks and their level under the photo's fingerprint
  onlyItsOwnFiles(app);
  assert.equal(app.posts(), 0);
  assert.equal(app.storage.getItem('frameplay.levels'), null, 'no read level');
  const kept = JSON.parse(app.storage.getItem('frameplay.marked'));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].sha256, file.sha256);
  assert.deepEqual(Object.keys(kept[0]).sort(), ['level', 'marks', 'saved', 'sha256']);
  assert.equal(kept[0].marks.length, 9);
  assert.equal(kept[0].level.origin, 'marked');
  for (const k of ['frameplay.marked', 'frameplay.road']) assert.doesNotMatch(app.storage.getItem(k), /data:|base64|blob:/i, k);
  assert.deepEqual(app.savedRoad().rooms[3], { kind: 'marked', sha256: file.sha256, made: true });
});

test('MOCK: marked with the keyboard alone: the box cursor, its size, Enter, a role key, Delete and Undo', async () => {
  const app = await toOwnStep();
  paintCanvases(app, DESK);
  try {
    await chooseAndMark(app, photoFile(8));
    board(app).focus();
    // the cursor starts in the middle: 128 px square at [448, 320]; each
    // arrow is 16 px
    const put = (role, [x0, y0, x1, y1]) => {
      key(app, { collect: '1', solid: '2', avoid: '3', exit: '4' }[role]);
      // home: the top-left corner, at its least size
      for (let i = 0; i < 70; i++) { key(app, 'ArrowLeft'); key(app, 'ArrowUp'); key(app, 'ArrowLeft', true); key(app, 'ArrowUp', true); }
      for (let i = 0; i < Math.round(x0 / 16); i++) key(app, 'ArrowRight');
      for (let i = 0; i < Math.round(y0 / 16); i++) key(app, 'ArrowDown');
      for (let i = 0; i < Math.round((x1 - x0 - 8) / 16); i++) key(app, 'ArrowRight', true);
      for (let i = 0; i < Math.round((y1 - y0 - 8) / 16); i++) key(app, 'ArrowDown', true);
      key(app, 'Enter');
    };
    for (const m of deskObjects()) put(m.role, m.box);
    assert.equal(app.$('main').querySelectorAll('.chips button').length, 9);
    // Space selects the box under the cursor; Delete removes it; Ctrl+Z undoes
    key(app, ' ');
    assert.equal(app.$('main').querySelectorAll('.chips button[aria-pressed="true"]').length, 1);
    key(app, 'Delete');
    assert.equal(app.$('main').querySelectorAll('.chips button').length, 8);
    board(app).dispatch('keydown', { key: 'z', ctrlKey: true });
    assert.equal(app.$('main').querySelectorAll('.chips button').length, 9);
    key(app, 'Escape');
    assert.equal(app.$('main').querySelectorAll('.chips button[aria-pressed="true"]').length, 0);
    assert.match(textOf(app.$('main').querySelector('.needs')), /^Ready: 3 coins, the exit/);
    // and the room is made from the keyboard too: Tab to the button, Enter
    app.button('Make the room').click();
    await until(app, () => app.h1() === 'Your room, from your marks', 'the reveal');
  } finally { delete globalThis.createImageBitmap; }
  assert.match(textOf(app.$('main').querySelector('.summary')), /^You marked 9 objects; code traced \d outlines? inside your boxes/);
  onlyItsOwnFiles(app);
});

test('after a reload, the same photo chosen again restores the room in place; another photo is refused; nothing is sent', async () => {
  const first = await toOwnStep();
  paintCanvases(first, DESK);
  const file = photoFile(9);
  try {
    await chooseAndMark(first, file);
    for (const m of deskObjects()) { roleButton(first, ROLE_BUTTON[m.role]).click(); drag(first, m.box); }
    first.button('Make the room').click();
    await until(first, () => first.h1() === 'Your room, from your marks', 'the reveal');
  } finally { delete globalThis.createImageBitmap; }
  const marked = first.storage.getItem('frameplay.marked');
  for (const step of [13, 14]) {
    const road = { ...first.savedRoad(), step, reached: step };
    const app = await bootApp({ mode: 'mock', road, prefs: { marked: JSON.parse(marked) } });
    app.cardPrimary().click();
    await app.settle();
    assert.equal(app.step(), step);
    assert.equal(app.h1(), 'Pick your photo again');
    assert.equal(app.why(), step === 14 ? 'Pick the same photo to see your marks' : '', 'the header names an action this screen offers');
    assert.deepEqual(primaries(app).map(textOf), ['Choose the same photo']);
    assert.ok(app.button('Continue to the end'), 'and the way on');
    paintCanvases(app, DESK);
    try {
      app.choose(photoFile(3));
      await until(app, () => /That is not the photo you marked/.test(app.main()), 'the refusal');
      assert.match(app.main(), /That is not the photo you marked\. Nothing was sent\. Pick the same photo, or continue to the end\./);
      assert.equal(app.step(), step);
      app.choose(file);
      await until(app, () => (step === 13 ? app.h1() === 'Your room, from your marks' : app.$('main').querySelector('.game')), 'the room restored');
    } finally { delete globalThis.createImageBitmap; }
    assert.equal(app.step(), step, 'in place: the counter never moved back');
    if (step === 13) assert.match(app.main(), /Loaded from this device: no model was called this time\./);
    else assert.equal(played.last.level.origin, 'marked');
    onlyItsOwnFiles(app);
  }
  // back on Step 12 the same photo restores the made room, not a blank one
  const app = await bootApp({ mode: 'mock', road: { ...first.savedRoad(), step: 12 }, prefs: { marked: JSON.parse(marked) } });
  app.cardPrimary().click();
  await app.settle();
  paintCanvases(app, DESK);
  try {
    await (async () => { app.choose(file); await until(app, () => app.button('Mark your room'), 'Mark your room'); app.button('Mark your room').click(); })();
    await until(app, () => app.h1() === 'Your room, from your marks', 'the room restored');
  } finally { delete globalThis.createImageBitmap; }
  assert.equal(app.step(), 13);
  app.button('Change your marks').click();
  await app.settle();
  assert.equal(app.h1(), 'Your marks');
  assert.equal(app.$('main').querySelectorAll('.chips button').length, 9, 'the marks are back too');
  assert.ok(app.button('Keep the room as it was'));
  onlyItsOwnFiles(app);
});

const people = { code: 'people_present', message: 'This photo seems to show a person. Please use one with no people.' };
const keyRefused = { code: 'invalid_api_key', message: 'The Model API did not accept the key' };

test('LIVE: a refused key leaves the photo a way on: Mark your room, and it makes the room with no further send', async () => {
  const app = await toOwnStep('live', { answer: () => replyFor('desk', 'live', { status: 'error', error: keyRefused }) });
  paintCanvases(app, DESK);
  try {
    await chooseAndMark(app, photoFile(11));
    assert.equal(app.posts(), 1, 'the one read that was refused');
    for (const m of deskObjects()) { roleButton(app, ROLE_BUTTON[m.role]).click(); drag(app, m.box); }
    assert.deepEqual(app.$('main').querySelectorAll('.chips button').map(textOf), ['obstacle 1', 'coin 1', 'obstacle 2', 'obstacle 3', 'obstacle 4', 'hazard', 'coin 2', 'exit', 'coin 3']);
    app.button('Make the room').click();
    await until(app, () => app.h1() === 'Your room, from your marks', 'the reveal');
  } finally { delete globalThis.createImageBitmap; }
  assert.equal(app.posts(), 1, 'marking sends nothing');
  assert.match(textOf(app.$('main').querySelector('.summary')), /^You marked 9 objects; .*no model was called\./);
});

test('LIVE: after the refusal, the words then Mark your room as the one primary; never after the people refusal', async () => {
  const app = await toOwnStep('live', { answer: () => replyFor('desk', 'live', { status: 'error', error: keyRefused }) });
  app.choose(photoFile(12));
  await until(app, () => app.button('Mark your room'), 'Mark your room');
  const shown = app.$('main').querySelector('.own-result');
  assert.equal(shown.children[0].className, 'error');
  assert.match(textOf(shown.children[0]), /You can mark the room yourself instead, try another photo, or continue to the end\.$/);
  assert.deepEqual(primaries(app).map(textOf), ['Mark your room']);
  const p = await toOwnStep('live', { answer: () => replyFor('desk', 'live', { status: 'refused', error: people }) });
  p.choose(photoFile(13));
  await until(p, () => /no people/.test(p.main()), 'the people refusal');
  assert.equal(p.button('Mark your room'), null);
  assert.doesNotMatch(p.main(), /mark the room yourself/);
  // a server that cannot be reached: the panel says so, and the photo can be marked
  const down = await toOwnStep('live', { answer: () => { throw new Error('down'); } });
  down.choose(photoFile(14));
  await until(down, () => down.button('Mark your room'), 'Mark your room');
  assert.match(textOf(down.$('main').querySelector('.own-result .error')), /^The server could not be reached\..* You can mark the room yourself instead/);
  assert.ok(down.$('main').querySelector('.progress').hidden, 'the words, then the way on, as a refusal');
  assert.deepEqual(primaries(down).map(textOf), ['Mark your room']);
});

test('REHEARSAL: a photo the stand-in does not know is refused before sending, and can be marked', async () => {
  const app = await toOwnStep('rehearsal', { answer: () => replyFor('desk', 'rehearsal') });
  const noise = { width: 1024, height: 768, data: new Uint8ClampedArray(1024 * 768 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 2654435761) >>> 24)) };
  paintCanvases(app, noise);
  try {
    app.choose(photoFile(15));
    await until(app, () => app.button('Mark your room'), 'Mark your room');
    assert.match(app.main(), /not one of them\. Nothing was sent, and no level is made from it\. You can mark the room yourself instead/);
    app.button('Mark your room').click();
    await until(app, () => app.h1() === 'Your marks', 'the marking screen');
  } finally { delete globalThis.createImageBitmap; }
  assert.equal(app.posts(), 0);
});

test('in MOCK no page code can send: the only network call is fetch, and its only callers are the health check, the rooms, our kitchen photo and the send', () => {
  const files = ['app.js', ...readdirSync(new URL('../src/', import.meta.url)).map((f) => `src/${f}`)];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /XMLHttpRequest|sendBeacon|WebSocket|EventSource|new Image\b|navigator\.share|postMessage/, f);
    const calls = [...src.matchAll(/\bfetch\(/g)].length;
    const expected = { 'app.js': 3, 'src/photo.js': 1 }[f] || 0;
    assert.equal(calls, expected, `${f}: fetch calls`);
  }
  // the third in app.js: a GET of this page's own sample photo, nothing sent
  const page = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(page, /async function oursBlob\(\) \{\n\s+const res = await fetch\(OURS\.photo\);/);
  const marking = ['src/marks.js', 'src/marker.js'].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(marking, /sendPhoto|fetch|readPhoto/);
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  for (const fn of ['markPhoto', 'screenMarking', 'makeFromMarks', 'restoreMarked']) {
    const at = app.indexOf(`function ${fn}(`);
    assert.ok(at > 0, fn);
    const body = app.slice(at, app.indexOf('\n}\n', at));
    assert.doesNotMatch(body, /sendPhoto|fetch|readPhoto|canvasJpeg/, `${fn} never sends or encodes`);
  }
});
