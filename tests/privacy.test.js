// The privacy and welcome words say what the server really does with a
// photo: never "once" (a LIVE read is several calls, each carrying the
// photo), and any "at most K calls" is the server's own ceiling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './fakedom.js';
import { el } from '../src/ui.js';
import { WHERE, OWN_NOTICE, KEPT, KEPT_SHORT, PEOPLE, AGE, LAWFUL, welcomeView } from '../src/screens.js';

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
  return { bullet, texts: { 'WHERE.live': WHERE.live, 'OWN_NOTICE.live': OWN_NOTICE.live, 'the LIVE key point': points('live')[3], 'the README LIVE bullet': bullet } };
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

// claims-9: the transport sends a failed call again once and a busy one
// (429) twice more (server/meta_api.py), and the consent says so.
test('the LIVE notice counts the times a call may be sent again', () => {
  const [busy, other] = /attempt >= \((\d+) if e\.status == 429 else (\d+)\)/.exec(read('../server/meta_api.py')).slice(1).map(Number);
  assert.deepEqual([busy - 1, other - 1], [2, 1], 'resends: two for a busy answer, one for another failure');
  assert.match(WHERE.live, /\(a failed call may be sent one more time, a busy one two more times\)/);
});

// Meta's Billing page for the demo's key: "While using free credits your
// content may be used for product improvement." Every LIVE notice says so
// plainly, and keeps what this app does (shrunk, camera data removed, none kept).
const META_USE_WORDS = 'While this demo runs on Meta’s free hackathon credits, Meta may use the photos it receives to improve its products.';
test('every LIVE notice says Meta may use the photos while the demo runs on its free credits', () => {
  const { texts } = liveTexts();
  for (const [where, t] of Object.entries(texts)) {
    if (where === 'the LIVE key point') continue;
    const flat = t.replace(/\s+/g, ' ').replace(/'/g, '’');
    assert.ok(flat.includes(META_USE_WORDS.slice(0, -1)), `${where}: ${t}`);
  }
  assert.match(points('live')[3], /Meta reads your photo and may use it; this app keeps none\./, 'the key point is no weaker');
  assert.match(OWN_NOTICE.live, /^LIVE: your photo is shrunk on this device and its camera data removed, then read by Meta’s Model API \(Muse Spark and SAM 3\.1\)\. This app keeps none\. /);
  assert.ok(WHERE.live.endsWith('This app does not store it. ' + META_USE_WORDS));
  // the postcard sentence sits between what this app keeps and Meta's use
  assert.ok(OWN_NOTICE.live.endsWith(META_USE_WORDS));
  assert.match(OWN_NOTICE.live, /This app keeps none\. If you ask for a postcard, the same shrunk photo goes to Muse Image one more time, about one cent, counted in the daily stop\. While/);
  for (const mode of ['mock', 'rehearsal']) {
    for (const t of [WHERE[mode], OWN_NOTICE[mode], ...points(mode)]) assert.doesNotMatch(t, /free hackathon credits|may use/, `${mode}: nothing is sent to Meta`);
  }
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
    assert.equal(p[2], LAWFUL, 'the terms flow down to the player, beside the age line');
    assert.equal(p[4], KEPT_SHORT);
    assert.ok(KEPT.startsWith('Kept by this app: no photo, on this device or on its server.') && KEPT_SHORT.startsWith('Kept by this app: no photo.'));
    assert.ok(p.every((t) => t.length <= 80), `${mode}: one short line each`);
  }
  assert.match(points('mock')[3], /no photo is sent anywhere; sample rooms are drawn by code/);
  assert.match(WHERE.live, /shrunk on this device/);
  assert.match(WHERE.live, /camera data is removed/);
  assert.match(WHERE.live, /this app’s server/);
});

test('what is kept is said for this app only, the one thing this code can vouch for', () => {
  const live = points('live')[3];
  assert.equal(live, 'LIVE mode: Meta reads your photo and may use it; this app keeps none.');
  assert.ok(live.length <= 80);
  assert.ok(OWN_NOTICE.live.includes('(Muse Spark and SAM 3.1). This app keeps none. '));
  // one notice of a few lines (the postcard's sentence included)
  assert.ok(OWN_NOTICE.live.length <= 400, `${OWN_NOTICE.live.length} characters`);
  for (const t of [KEPT, KEPT_SHORT]) assert.doesNotMatch(t, /anywhere/, 'what Meta does with a photo is not this app’s to vouch for');
  for (const mode of ['mock', 'live', 'rehearsal']) {
    for (const t of [WHERE[mode], OWN_NOTICE[mode], ...points(mode)]) assert.doesNotMatch(t, /(^|\. )Not stored\./, `${mode}: a claim with no subject: ${t}`);
  }
});

test('the full notice says what the host may keep and how a player removes what this app keeps', () => {
  // the host of a public copy keeps its own access log, which is not this
  // app's to promise away; this app keeps no photo, so there is nothing of
  // it to delete, and the levels on the device go with the site's data
  assert.ok(KEPT.endsWith(' The service hosting this copy may keep its own access log. This app keeps no photo, so it has nothing to delete; your levels stay on this device until you clear this site’s data.'), KEPT);
  assert.ok(KEPT.startsWith('Kept by this app: no photo, on this device or on its server. Levels made from your photos (outlines, names and roles, never the photo) stay on this device, with your step, sound and tour choices.'), 'nothing removed');
  // the full notice carries it in every mode; the key points stay short
  for (const mode of ['mock', 'live', 'rehearsal']) {
    const { section } = welcomeView({ mode, primaryLabel: 'Continue', onConsent() {} });
    const inside = section.all().filter((e) => e.tagName === 'LI').map((e) => e.textContent);
    assert.ok(inside.includes(KEPT), `${mode}: the full notice`);
    assert.ok(points(mode).every((t) => !t.includes('access log')), `${mode}: the key points stay short`);
  }
});

// Meta's API Terms (section 1) and its AUP ask the operator to require lawful
// use of its end users: the welcome says so beside the age line, in the key
// points and the full notice, and the README's Privacy section says the same.
test('the welcome asks the player to use the demo lawfully, and the README says so too', () => {
  assert.equal(LAWFUL, 'By continuing you agree to use this demo lawfully (Meta’s Model API terms).');
  assert.ok(LAWFUL.length <= 80, 'one short line');
  for (const mode of ['mock', 'live', 'rehearsal']) {
    assert.equal(points(mode)[2], LAWFUL, `${mode}: the key point, beside the age line`);
    const { section } = welcomeView({ mode, primaryLabel: 'Continue', onConsent() {} });
    const inside = section.all().filter((e) => e.tagName === 'LI').map((e) => e.textContent);
    assert.equal(inside.filter((t) => t === LAWFUL).length, 2, `${mode}: the key points and the full notice`);
  }
  const privacy = read('../README.md').split('## Privacy')[1].split('\n## ')[0].replace(/\s+/g, ' ');
  assert.ok(privacy.includes("By continuing past it you agree to use this demo lawfully; LIVE reads run under Meta's Model API terms."), 'the README’s Privacy section');
});
