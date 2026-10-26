// A room on the road whose level is not in memory (a return visit): the
// real app.js, booted in Node (tests/apphost.js). No primary may move the
// counter back, and Forward from Your own room never leads to a screen
// whose only way on is back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './apphost.js';

const road = (S) => ({
  v: 3, step: S, reached: S, consent: true, own: null,
  rooms: [{ kind: 'sample', id: 'desk' }, { kind: 'sample', id: 'living' }, { kind: 'photo', sha256: 'ab'.repeat(32) }],
  finished: [true, true, false], best: [1.24, null, null],
});

for (const mode of ['rehearsal', 'mock']) {
  for (const S of [10, 11]) {
    test(`${mode}: back on Step ${S} with your own room's level missing, no primary moves the counter back`, async () => {
      const app = await bootApp({ mode, road: road(S) });
      assert.ok(app.cardOpen(), 'the welcome-back card');
      app.cardPrimary().click();
      await app.settle();
      assert.equal(app.step(), S);
      const seen = [app.step()];
      const p = app.mainPrimary();
      assert.ok(p, 'the screen has a primary');
      if (mode === 'mock') {
        assert.match(app.main(), /This copy runs in MOCK, so its level cannot load here\./);
        assert.equal(p.textContent, 'Continue to the end');
      } else {
        assert.match(app.main(), /Choose the same photo/);
        assert.doesNotMatch(app.main(), /when it can/);
        assert.equal(app.why(), S === 11 ? 'Pick the same photo to play this room' : '', 'the header names an action this screen offers');
      }
      p.click();
      await app.settle();
      seen.push(app.step());
      assert.ok(seen.every((s) => s >= S), `the counter went ${seen.join(' → ')}`);
      if (mode === 'mock') {
        assert.equal(app.step(), 12, 'on to the closing screen');
        assert.match(app.main(), /Your own room/);
        assert.doesNotMatch(app.main(), /Not made/, 'the room stays on the road');
      }
    });
  }

  test(`${mode}: ← to Your own room, then →, never reaches a screen whose primary leads back`, async () => {
    const app = await bootApp({ mode, road: road(10) });
    app.cardPrimary().click();
    await app.settle();
    app.back();
    await app.settle();
    assert.equal(app.step(), 9);
    app.forward();
    await app.settle();
    assert.equal(app.step(), 10);
    app.mainPrimary().click();
    await app.settle();
    assert.ok(app.step() >= 10, `the primary moved the counter to ${app.counter()}`);
  });
}
