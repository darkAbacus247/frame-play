// The privacy and welcome words say what the server really does with a
// photo: never "once" (a LIVE read is several calls, each carrying the
// photo), and any "at most K calls" is the server's own ceiling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './fakedom.js';
import { el } from '../src/ui.js';
import { WHERE, OWN_NOTICE, KEPT, KEPT_SHORT, PEOPLE, AGE, welcomeView } from '../src/screens.js';

const doc = installFakeDocument();
doc.body.append(el('div', { id: 'tips' }));
const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

function serverCalls() {
  const config = read('../server/config.py');
  const n = (name) => +new RegExp(`^${name}\\s*=\\s*(\\d+)`, 'm').exec(config)[1];
  // Ask the room's call carries the photo too (server/riddles.py)
  return n('SPARK_CALLS_PER_PHOTO') + n('SAM_CALLS_PER_PHOTO') + n('RIDDLE_SPARK_CALLS');
}

const points = (mode) => {
  const { section } = welcomeView({ mode, primaryLabel: 'Continue', onConsent: () => {} });
  const ul = section.all().find((e) => e.tagName === 'UL' && e.getAttribute('aria-label') === 'Before you start');
  return ul.children.map((li) => li.textContent);
};

const liveTexts = () => {
  const readme = read('../README.md');
  const bullet = /- \*\*LIVE\*\*[\s\S]*?(?=\n- \*\*)/.exec(readme)[0];
  return { bullet, texts: { 'WHERE.live': WHERE.live, 'OWN_NOTICE.live': OWN_NOTICE.live, 'the LIVE key point': points('live')[2], 'the README LIVE bullet': bullet } };
};

test('the LIVE words never say "once", and count the calls the server makes', () => {
  const N = serverCalls();
  assert.equal(N, 14, 'one Muse Spark call, 12 SAM 3.1 calls (W1c) and the riddles’ Muse Spark call');
  const { bullet, texts } = liveTexts();
  for (const [where, t] of Object.entries(texts)) assert.doesNotMatch(t, /\bonce\b/i, `${where}: ${t}`);
  for (const m of bullet.matchAll(/at most (\d+) calls/gi)) assert.equal(+m[1], N, `the README LIVE bullet: ${m[0]}`);
  assert.match(bullet.replace(/\s+/g, ' '), /at most 14 calls/);
  for (const t of [WHERE.live, OWN_NOTICE.live]) assert.match(t, /Meta’s Model API/);
});

// The page's LIVE words (src/screens.js, WHERE.live) count the same 14.
test('the page’s LIVE words count the calls the server makes', () => {
  const N = serverCalls();
  const { texts } = liveTexts();
  for (const [where, t] of Object.entries(texts)) {
    for (const m of t.matchAll(/at most (\d+) calls/gi)) assert.equal(+m[1], N, `${where}: ${m[0]}`);
  }
  assert.match(WHERE.live, /At most 14 calls/);
});

test('no privacy or welcome line in any mode says "once"', () => {
  for (const mode of ['mock', 'live', 'rehearsal']) {
    for (const t of [WHERE[mode], OWN_NOTICE[mode], ...points(mode)]) assert.doesNotMatch(t, /\bonce\b/i, `${mode}: ${t}`);
  }
});

test('the key points are no weaker than the full notice', () => {
  for (const mode of ['mock', 'live', 'rehearsal']) {
    const p = points(mode);
    assert.equal(p[0], PEOPLE);
    assert.equal(p[1], AGE, 'you must be 18 or over');
    assert.equal(p[3], KEPT_SHORT);
    assert.ok(KEPT.startsWith('Kept: no photo, anywhere.') && KEPT_SHORT.startsWith('Kept: no photo, anywhere.'));
    assert.ok(p.every((t) => t.length <= 80), `${mode}: one short line each`);
  }
  assert.match(points('mock')[2], /no photo is sent anywhere; sample rooms are drawn by code/);
  assert.match(WHERE.live, /shrunk on this device/);
  assert.match(WHERE.live, /camera data is removed/);
  assert.match(WHERE.live, /this app’s server/);
});

test('what is kept is said for this app only, the one thing this code can vouch for', () => {
  const live = points('live')[2];
  assert.equal(live, 'LIVE mode: your photo goes to Meta’s Model API to be read; this app keeps none.');
  assert.ok(live.length <= 80);
  assert.ok(OWN_NOTICE.live.endsWith('(Muse Spark and SAM 3.1). This app keeps none.'));
  assert.ok(OWN_NOTICE.live.length <= 151, `${OWN_NOTICE.live.length} characters`);
  for (const mode of ['mock', 'live', 'rehearsal']) {
    for (const t of [WHERE[mode], OWN_NOTICE[mode], ...points(mode)]) assert.doesNotMatch(t, /(^|\. )Not stored\./, `${mode}: a claim with no subject: ${t}`);
  }
});
