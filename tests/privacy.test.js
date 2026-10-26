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
  return n('SPARK_CALLS_PER_PHOTO') + n('SAM_CALLS_PER_PHOTO');
}

const points = (mode) => {
  const { section } = welcomeView({ mode, primaryLabel: 'Continue', onConsent: () => {} });
  const ul = section.all().find((e) => e.tagName === 'UL' && e.getAttribute('aria-label') === 'Before you start');
  return ul.children.map((li) => li.textContent);
};

test('the LIVE words never say "once", and count the calls the server makes', () => {
  const N = serverCalls();
  assert.equal(N, 10);
  const readme = read('../README.md');
  const bullet = /- \*\*LIVE\*\*[\s\S]*?(?=\n- \*\*)/.exec(readme)[0];
  const texts = { 'WHERE.live': WHERE.live, 'OWN_NOTICE.live': OWN_NOTICE.live, 'the LIVE key point': points('live')[2], 'the README LIVE bullet': bullet };
  for (const [where, t] of Object.entries(texts)) {
    assert.doesNotMatch(t, /\bonce\b/i, `${where}: ${t}`);
    for (const m of t.matchAll(/at most (\d+) calls/gi)) assert.equal(+m[1], N, `${where}: ${m[0]}`);
  }
  assert.match(WHERE.live, /at most 10 calls/);
  assert.match(bullet.replace(/\s+/g, ' '), /at most 10 calls/);
  for (const t of [WHERE.live, OWN_NOTICE.live]) assert.match(t, /Meta’s Model API/);
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
