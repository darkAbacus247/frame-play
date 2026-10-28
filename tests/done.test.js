// A3: "I'm done" on the closing screen ends the visit: a short thank-you
// (one line of what was played and won, a soft fade, the closing sting
// once), then window.close(). Where the browser keeps the tab open, the
// thank-you says so and offers Free play and Start over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootApp, textOf, nameOf, until } from './apphost.js';
import { AT_END as END } from './roads.js';
import { doneLine, doneView, CLOSE_TAB } from '../src/screens.js';
import { on } from '../src/events.js';

async function atEnd() {
  const app = await bootApp({ mode: 'mock', road: END });
  app.cardPrimary().click();
  await app.settle();
  return app;
}

test('the closing screen has I’m done, a plain secondary right after Free play', async () => {
  const app = await atEnd();
  const buttons = app.$('main').querySelector('.actions').querySelectorAll('button');
  assert.equal(buttons[0].getAttribute('data-primary'), 'true');
  assert.equal(nameOf(buttons[1]), 'I’m done');
  assert.ok(!/primary/.test(buttons[1].className), 'a secondary');
  assert.equal(app.$('main').querySelectorAll('[data-primary]').length, 1);
});

test('I’m done in an app window: the thank-you, the sting once, then the window closes', async () => {
  const app = await atEnd();
  let closes = 0, stings = 0;
  const off = on('closing', () => { stings++; });
  globalThis.closed = false;
  globalThis.close = () => { closes++; globalThis.closed = true; };
  try {
    app.button('I’m done').click();
    await app.settle(2);
    assert.equal(app.h1(), 'Thank you for playing');
    assert.match(app.main(), /^Thank you for playing You played (three|four) rooms and won (none|one|two|three|all three|all four)\.$/);
    assert.equal(stings, 1, 'the closing sting once');
    assert.equal(app.$('main').querySelectorAll('button').length, 0, 'nothing to press while it closes');
    await until(app, () => closes === 1, 'window.close()', 5000);
    await app.settle(40);
    assert.equal(closes, 1);
    assert.doesNotMatch(app.main(), /close this tab/, 'a closed window says nothing more');
  } finally {
    off && off();
    delete globalThis.close;
    delete globalThis.closed;
  }
});

test('I’m done in an ordinary tab: it says the tab can be closed and offers Free play and Start over', async () => {
  const app = await atEnd();
  let closes = 0;
  globalThis.closed = false;
  globalThis.close = () => { closes++; }; // the browser ignores it
  try {
    app.button('I’m done').click();
    await until(app, () => /close this tab/.test(app.main()), 'the tab line', 5000);
    assert.equal(closes, 1);
    assert.match(app.main(), /You can close this tab now\./);
    const names = app.$('main').querySelectorAll('button').map(nameOf);
    assert.deepEqual(names, ['Free play', 'Start over']);
    assert.equal(app.$('main').querySelectorAll('[data-primary]').length, 1);
    app.button('Free play').click();
    await app.settle();
    assert.equal(app.counter(), 'Free play');
  } finally {
    delete globalThis.close;
    delete globalThis.closed;
  }
});

test('the thank-you line counts the rooms played and won', () => {
  const r = (won, ref = true) => ({ ref: ref ? {} : null, won });
  assert.equal(doneLine([r(true), r(true), r(false), r(true)]), 'You played four rooms and won three.');
  assert.equal(doneLine([r(true), r(true), r(true), r(true)]), 'You played four rooms and won all four.');
  assert.equal(doneLine([r(false), r(false), r(false), r(false, false)]), 'You played three rooms and won none.');
  assert.equal(doneLine([r(true), r(false, false)]), 'You played one room and won it.');
  const v = doneView({ rooms: [r(true)], open: true, actions: {} });
  assert.match(textOf(v), new RegExp(CLOSE_TAB.replace('.', '\\.')));
});

test('the fade is soft and none with Reduce motion; the sting honours Effects', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.screen\.done \{[^}]*animation: done-in 1\.2s ease-out 1;/);
  // scoped to the screen: a progress step marked done is never centred or faded in
  assert.doesNotMatch(css, /^\.done \{/m);
  assert.match(css, /\.rm \*, \.rm \*::before, \.rm \*::after \{ animation: none !important/);
  const audio = readFileSync(new URL('../src/audio.js', import.meta.url), 'utf8');
  assert.match(audio, /listen\('closing', \(\) => this\.sting\(\)\)/);
  assert.match(audio, /this\.on && this\.musicOn && this\.effects && this\.music/);
});
