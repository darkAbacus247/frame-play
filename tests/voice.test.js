// Say it: the WAV the page writes from a clip, the request it posts, and
// the riddle panel's voice control on the real board (src/game.js on
// tests/fakedom.js) with the recorder, the WAV step and the send stood in
// for; then the page's own gate (health's voice switch) through apphost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './fakedom.js';
import { el } from '../src/ui.js';
import { loadRoom } from '../src/rooms.js';
import { buildLevel, inputFromRoom } from '../src/level.js';
import { DT } from '../src/play.js';
import { Renderer } from '../src/render.js';
import { RIDDLE_WORDS } from '../src/words.js';
import {
  encodeWav, downmixResample, bytesToBase64, requestBody, thingsOf, sayIt, voiceOn,
  VOICE_WORDS, VOICE_RATE, VOICE_MAX_SECONDS,
} from '../src/voice.js';

// The header fields, read as server/voice.py check_wav reads them.
function readWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  return {
    riff: text(0, 4), riffSize: v.getUint32(4, true), wave: text(8, 4), fmt: text(12, 4), fmtLen: v.getUint32(16, true),
    format: v.getUint16(20, true), channels: v.getUint16(22, true), rate: v.getUint32(24, true), byteRate: v.getUint32(28, true),
    block: v.getUint16(32, true), bits: v.getUint16(34, true), data: text(36, 4), dataSize: v.getUint32(40, true),
    sample: (i) => v.getInt16(44 + i * 2, true),
  };
}

test('the WAV writer: five seconds of 48 kHz stereo become a 44-byte header and mono 16-bit samples at 16 kHz, under 161 KB', () => {
  const n = 5 * 48000;
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) { left[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000); right[i] = left[i]; }
  const mono = downmixResample([left, right], 48000, VOICE_RATE);
  assert.equal(mono.length, 5 * VOICE_RATE, 'five seconds at 16 kHz');
  const wav = encodeWav(mono, VOICE_RATE);
  assert.equal(wav.byteLength, 44 + 5 * VOICE_RATE * 2);
  assert.ok(wav.byteLength <= 161 * 1024, `${wav.byteLength} bytes`);
  const h = readWav(wav);
  assert.equal(h.riff, 'RIFF');
  assert.equal(h.riffSize, wav.byteLength - 8);
  assert.equal(h.wave, 'WAVE');
  assert.equal(h.fmt, 'fmt ');
  assert.equal(h.fmtLen, 16);
  assert.equal(h.format, 1, 'PCM');
  assert.equal(h.channels, 1, 'mono');
  assert.equal(h.rate, 16000);
  assert.equal(h.byteRate, 32000);
  assert.equal(h.block, 2);
  assert.equal(h.bits, 16);
  assert.equal(h.data, 'data');
  assert.equal(h.dataSize, wav.byteLength - 44);
  assert.ok(h.dataSize <= 6 * 16000 * 2, 'within the server’s six seconds');
  // the tone survives the resampling: a 440 Hz sine crosses zero 880 times a second
  let crossings = 0;
  for (let i = 1; i < mono.length; i++) if ((h.sample(i) >= 0) !== (h.sample(i - 1) >= 0)) crossings++;
  assert.ok(Math.abs(crossings - 880 * 5) <= 10, `${crossings} zero crossings`);
});

test('the WAV writer clamps a hot sample and keeps a quiet one exact', () => {
  const wav = encodeWav(new Float32Array([2, -2, 0.5, 0, -0.5]), VOICE_RATE);
  const h = readWav(wav);
  assert.equal(h.dataSize, 10);
  assert.deepEqual([0, 1, 2, 3, 4].map(h.sample), [32767, -32767, 16384, 0, -16383]);
  assert.equal(downmixResample([], 48000).length, 0);
  assert.equal(downmixResample([new Float32Array(160)], 16000, 16000).length, 160, 'the same rate is not resampled');
});

test('the request body: the WAV as base64 and each thing’s id and name, nothing else', () => {
  const bytes = new Uint8Array([82, 73, 70, 70, 0, 255, 128, 1]);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  // without Node's Buffer the browser's btoa does the same
  const B = globalThis.Buffer;
  globalThis.Buffer = undefined;
  try { assert.equal(bytesToBase64(bytes), B.from(bytes).toString('base64')); } finally { globalThis.Buffer = B; }
  const body = requestBody(bytes, [{ id: 'mug', name: 'mug', role: 'solid', outline: {} }, { id: 'lamp', name: 'desk lamp' }]);
  assert.deepEqual(Object.keys(body), ['wav', 'things']);
  assert.deepEqual(body.things, [{ id: 'mug', name: 'mug' }, { id: 'lamp', name: 'desk lamp' }]);
  assert.deepEqual([...Buffer.from(body.wav, 'base64')], [...bytes]);
  const level = { objects: [{ id: 'a', name: 'cactus', role: 'avoid' }, { id: 'b', name: 'mug', role: 'solid' }] };
  assert.deepEqual(thingsOf(level), [{ id: 'a', name: 'cactus' }, { id: 'b', name: 'mug' }]);
});

test('sayIt posts the body to api/voice as JSON and reads the answer, or the server’s refusal in words', async () => {
  const saved = globalThis.fetch;
  const calls = [];
  const wav = encodeWav(new Float32Array(160), VOICE_RATE);
  const things = [{ id: 'mug', name: 'mug' }];
  try {
    globalThis.fetch = async (url, init) => { calls.push([url, init]); return { ok: true, status: 200, json: async () => ({ status: 'ok', transcript: 'the mug', match: 'mug', words: 'That names the right thing.' }) }; };
    const ans = await sayIt(wav, things);
    assert.deepEqual(ans, { transcript: 'the mug', match: 'mug', words: 'That names the right thing.' });
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url, 'api/voice');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers['X-FramePlay-Request'], '1');
    assert.deepEqual(JSON.parse(init.body), requestBody(wav, things));
    // a refusal: the server's own words and code
    globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ status: 'error', error: { code: 'voice_off', message: 'Say it is switched off on this server.' } }) });
    await assert.rejects(sayIt(wav, things), (e) => e.message === 'Say it is switched off on this server.' && e.code === 'voice_off');
    // no match is a plain answer, not a refusal
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', transcript: 'blue', match: null, words: 'That does not name any of the kept things.' }) });
    assert.equal((await sayIt(wav, things)).match, null);
    // an answer that is not JSON
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
    await assert.rejects(sayIt(wav, things), (e) => e.message === VOICE_WORDS.failed);
  } finally {
    globalThis.fetch = saved;
  }
});

test('the switch: health must say voice on and LIVE; MOCK, REHEARSAL, off and no health offer nothing', () => {
  assert.equal(voiceOn({ mode: 'live', voice: 'on' }), true);
  assert.equal(voiceOn({ mode: 'mock', voice: 'on' }), false, 'MOCK sends no voice');
  assert.equal(voiceOn({ mode: 'rehearsal', voice: 'on' }), false);
  assert.equal(voiceOn({ mode: 'live', voice: 'off' }), false);
  assert.equal(voiceOn({ mode: 'live' }), false);
  assert.equal(voiceOn(null), false);
});

test('the words: the consent is exactly the agreed line, and nothing claims to keep a clip', () => {
  assert.equal(VOICE_WORDS.consent, 'Your voice clip goes to Meta’s Muse Voice Transcribe to be written down; this app keeps none. While this demo runs on Meta’s free hackathon credits, Meta may use what it receives to improve its products. Voice is for players 18 and over.');
  assert.equal(VOICE_WORDS.listening, 'Listening... (5 s)');
  assert.equal(VOICE_MAX_SECONDS, 5);
  for (const t of Object.values(VOICE_WORDS)) if (typeof t === 'string') assert.doesNotMatch(t, /—/, 'no em-dashes');
});

// ---- the real board, in riddle mode, with the voice parts stood in for ----
const RIDDLE = { text: 'Find the thing that holds a hot drink', n: 1, rule: 'one', answers: ['mug'] };
const RIDDLE_2 = { text: 'Find the thing that keeps the dark away', n: 1, rule: 'one', answers: ['lamp'] };
const settle = (n = 6) => new Promise((r) => setTimeout(r, n));

async function board(voice) {
  const doc = installFakeDocument();
  doc.body.append(el('div', { id: 'tips' }));
  let frames = [];
  const saved = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, ResizeObserver: globalThis.ResizeObserver, Path2D: globalThis.Path2D };
  Object.assign(globalThis, {
    Path2D: class { constructor() { return new Proxy(this, { get: (o, k) => (k in o ? o[k] : () => {}) }); } },
    requestAnimationFrame: (f) => { frames.push(f); return frames.length; },
    cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  const draw = Renderer.prototype.draw;
  Renderer.prototype.draw = () => {};
  const { mountPlay } = await import('../src/game.js');
  const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
  const { level, rt } = buildLevel(inputFromRoom(room));
  const said = [];
  const sounds = [];
  const root = el('main', {});
  doc.body.append(root);
  const view = mountPlay(root, {
    level, rt, picture: doc.createElement('canvas'), say: (t) => said.push(t), ui: () => ({ reducedMotion: true }),
    audio: { play: (s) => sounds.push(s), musicMode() {} }, onEnd() {}, voice,
  });
  // the round ends (the board sees the state's status on its next frames), so a riddle may start
  let t = 1000;
  const pump = (n) => { for (let i = 0; i < n; i++) { const run = frames; frames = []; t += DT * 1000 + 1; for (const f of run) f(t); } };
  pump(2);
  view.state.status = 'lost';
  pump(3);
  const panel = () => root.querySelector('.riddle-panel');
  const $ = (sel) => (panel() ? panel().querySelector(sel) : null);
  const text = (sel) => { const e = $(sel); return e ? e.textContent : null; };
  const restore = () => { view.destroy(); Renderer.prototype.draw = draw; Object.assign(globalThis, saved); };
  return { doc, level, view, said, sounds, root, panel, $, text, restore, game: root.querySelector('.game') };
}

// a stand-in recorder: the clip ends when the test says so, or on stop
function recorder() {
  const r = { calls: 0, stops: 0, resolve: null, reject: null };
  r.record = (max) => {
    r.calls++;
    r.max = max;
    const done = new Promise((res, rej) => { r.resolve = res; r.reject = rej; });
    return { done, stop() { r.stops++; r.resolve({ clip: 'stopped' }); } };
  };
  return r;
}

test('with the switch off the panel has no Say it and V does nothing', async () => {
  for (const voice of [undefined, { on: false }]) {
    const b = await board(voice);
    try {
      assert.ok(b.view.startRiddle([RIDDLE], 0), 'the riddle starts');
      assert.ok(b.panel(), 'the panel is up');
      assert.equal(b.$('.say-it'), null, 'no Say it');
      assert.equal(b.$('.voice-line'), null);
      assert.equal(b.game.getAttribute('aria-label'), RIDDLE_WORDS.gameLabel);
      b.view.focusGame();
      const before = b.said.length;
      b.doc.pressKey('v');
      b.doc.pressKey('V');
      assert.equal(b.said.length, before, 'V says nothing');
      assert.equal(b.$('.voice-consent'), null);
      assert.equal(b.view.riddleState.done, null);
    } finally { b.restore(); }
  }
});

test('Say it: the consent shows one time, OK starts listening, and a match grades through the riddle path as a tap would', async () => {
  const rec = recorder();
  const sent = [];
  const voice = {
    on: true, consented: false, record: rec.record,
    toWav: async (blob) => { assert.deepEqual(blob, { clip: 1 }); return encodeWav(new Float32Array(16000), VOICE_RATE); },
    send: async (wav, things) => { sent.push([wav, things]); return { transcript: 'the mug', match: 'mug', words: 'That names the right thing.' }; },
  };
  const b = await board(voice);
  try {
    b.view.startRiddle([RIDDLE, RIDDLE_2], 0);
    const btn = b.$('.say-it');
    assert.ok(btn, 'Say it is beside the choice');
    assert.equal(btn.textContent, 'Say it');
    assert.equal(btn.parentNode, b.$('.answer-row'));
    assert.equal(btn.getAttribute('aria-keyshortcuts'), 'v');
    assert.match(b.game.getAttribute('aria-label'), /V answers by voice\.$/);
    // the first press: the consent, not a recording
    btn.click();
    assert.equal(rec.calls, 0, 'nothing is recorded before OK');
    const consent = b.$('.voice-consent');
    assert.ok(consent, 'the consent is in the panel');
    assert.equal(b.text('.voice-consent-line'), VOICE_WORDS.consent);
    const ok = consent.querySelector('button');
    assert.equal(ok.textContent, 'OK');
    assert.equal(b.doc.activeElement, ok, 'OK has the focus');
    assert.ok(b.said.includes(VOICE_WORDS.consent), 'the consent is announced');
    // a second press while the consent is up asks for nothing more
    btn.click();
    assert.equal(b.panel().querySelectorAll('.voice-consent').length, 1);
    assert.equal(rec.calls, 0);
    // OK: the clip starts
    ok.click();
    assert.equal(voice.consented, true);
    assert.equal(b.$('.voice-consent'), null, 'the consent is gone');
    assert.equal(rec.calls, 1);
    assert.equal(rec.max, 5);
    assert.equal(b.text('.voice-line'), 'Listening... (5 s)');
    assert.ok(b.said.includes('Listening... (5 s)'));
    assert.equal(btn.textContent, 'Stop listening');
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.equal(b.view.riddleState.done, null, 'the riddle waits');
    // the clip ends on its own; the answer names the mug
    rec.resolve({ clip: 1 });
    await settle();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0][1], thingsOf(b.level));
    assert.equal(readWav(sent[0][0]).rate, 16000);
    assert.deepEqual(b.view.riddleState.found, ['mug'], 'graded by gradePick');
    assert.equal(b.view.riddleState.done, 'solved');
    assert.ok(b.said.includes(RIDDLE_WORDS.right('the mug')), `said: ${b.said.join(' | ')}`);
    assert.ok(b.sounds.includes('collect'));
    assert.equal(b.text('.voice-line'), 'Heard: “the mug”');
    assert.equal(btn.textContent, 'Say it');
    assert.equal(btn.getAttribute('aria-pressed'), null);
    assert.match(b.text('.riddle-status'), /Misses left 2/);
    // the next riddle: no consent again, the clip starts at the press
    b.view.startRiddle([RIDDLE, RIDDLE_2], 1);
    b.$('.say-it').click();
    assert.equal(b.$('.voice-consent'), null, 'asked one time only');
    assert.equal(rec.calls, 2);
    assert.equal(b.text('.voice-line'), 'Listening... (5 s)');
  } finally { b.restore(); }
});

test('Say it: no match shows the server’s words and what was heard, and the riddle goes on', async () => {
  const rec = recorder();
  const voice = {
    on: true, consented: true, record: rec.record, toWav: async () => new Uint8Array(44),
    send: async () => ({ transcript: 'something blue', match: null, words: 'That does not name any of the kept things. Please try again from the page.' }),
  };
  const b = await board(voice);
  try {
    b.view.startRiddle([RIDDLE], 0);
    // V while the board has the focus does what the button does
    b.view.focusGame();
    const e = b.doc.pressKey('v');
    assert.ok(e.defaultPrevented);
    assert.equal(rec.calls, 1);
    rec.resolve({ clip: 2 });
    await settle();
    assert.equal(b.text('.voice-line'), 'That does not name any of the kept things. Please try again from the page. Heard: “something blue”');
    assert.ok(b.said.includes(b.text('.voice-line')));
    assert.equal(b.view.riddleState.done, null);
    assert.deepEqual(b.view.riddleState.found, []);
    assert.equal(b.view.riddleState.misses, 0, 'not a miss');
    // a tap-style pick still works after it
    b.$('select').setAttribute('value', 'mug');
    b.$('select').value = 'mug';
    b.panel().querySelectorAll('button').find((x) => x.textContent === 'Pick it').click();
    assert.equal(b.view.riddleState.done, 'solved');
  } finally { b.restore(); }
});

test('Say it: a second press stops the clip early; a failure shows its words and never blocks the riddle', async () => {
  const rec = recorder();
  const voice = {
    on: true, consented: true, record: rec.record, toWav: async () => new Uint8Array(44),
    send: async () => { const e = new Error('The voice reader is busy. Please try again shortly.'); e.code = 'voice_busy'; throw e; },
  };
  const b = await board(voice);
  try {
    b.view.startRiddle([RIDDLE], 0);
    const btn = b.$('.say-it');
    btn.click();
    assert.equal(rec.calls, 1);
    btn.click();
    assert.equal(rec.stops, 1, 'the second press stops the clip');
    await settle();
    assert.equal(b.text('.voice-line'), 'The voice reader is busy. Please try again shortly.');
    assert.ok(b.said.includes('The voice reader is busy. Please try again shortly.'));
    assert.equal(btn.textContent, 'Say it');
    assert.equal(b.view.riddleState.done, null);
    assert.equal(b.view.riddleState.misses, 0);
    // the riddle is answered by hand after it
    b.$('select').value = 'mug';
    b.panel().querySelectorAll('button').find((x) => x.textContent === 'Pick it').click();
    assert.equal(b.view.riddleState.done, 'solved');
  } finally { b.restore(); }
});

test('Say it: a clip still recording ends with the riddle, and its answer is dropped', async () => {
  const rec = recorder();
  const sent = [];
  const voice = {
    on: true, consented: true, record: rec.record, toWav: async () => new Uint8Array(44),
    send: async (wav, things) => { sent.push(things); return { transcript: 'the mug', match: 'mug', words: 'That names the right thing.' }; },
  };
  const b = await board(voice);
  try {
    b.view.startRiddle([RIDDLE], 0);
    b.$('.say-it').click();
    assert.equal(rec.calls, 1);
    b.view.stopRiddle();
    assert.equal(rec.stops, 1, 'stopping the riddle stops the clip');
    await settle();
    assert.equal(sent.length, 0, 'nothing is sent for a riddle that is over');
    assert.equal(b.view.riddleOn, false);
    assert.equal(b.root.querySelector('.riddle-panel'), null);
    // a mic that cannot be used: the words, the riddle open
    const voice2 = { on: true, consented: true, record: () => ({ done: Promise.reject(new Error(VOICE_WORDS.noMic)), stop() {} }) };
    b.restore();
    const c = await board(voice2);
    try {
      c.view.startRiddle([RIDDLE], 0);
      c.$('.say-it').click();
      await settle();
      assert.equal(c.text('.voice-line'), VOICE_WORDS.noMic);
      assert.equal(c.view.riddleState.done, null);
    } finally { c.restore(); }
    return;
  } catch (e) { b.restore(); throw e; }
});

// ---- the page: the switch comes from health, and only LIVE offers it ----
test('the page hands the board Say it only when health says voice on in LIVE', async () => {
  const { bootApp } = await import('./apphost.js');
  const { played } = await import('./stub_game.js');
  const road = { v: 3, step: 4, reached: 4, consent: true, own: null, rooms: [{ kind: 'sample', id: 'desk' }, null, null], finished: [false, false, false], best: [null, null, null] };
  for (const [mode, health, on] of [['live', { voice: 'on' }, true], ['live', { voice: 'off' }, false], ['live', {}, false], ['mock', { voice: 'on' }, false], ['rehearsal', { voice: 'on' }, false]]) {
    const app = await bootApp({ mode, road, health });
    if (app.cardOpen()) app.cardPrimary().click();
    await app.settle();
    assert.equal(app.step(), 4, `${mode}: on Play`);
    assert.ok(played.last.voice, `${mode}: the board is told about Say it`);
    assert.equal(played.last.voice.on, on, `${mode} with health ${JSON.stringify(health)}`);
    assert.equal(played.last.voice.consented, false, 'no consent is given before the player gives it');
  }
});
