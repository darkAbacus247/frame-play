// The photo path on the device, with fetch, timers, createImageBitmap,
// Image and the canvas stubbed: no browser, no server, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendPhoto, retryAfterSeconds, WAITING_WORDS, BUSY_WAIT_MS } from '../src/photo.js';

const ndjson = (lines) => new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(''), { headers: { 'Content-Type': 'application/x-ndjson' } });
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const busy = (after) => json(429, { error: { code: 'busy', message: 'Two photos are already being read. Please try again in a few seconds.' } }, after == null ? {} : { 'Retry-After': String(after) });
const OK = () => ndjson([{ type: 'progress', words: 'Reading your room' }, { type: 'reply', reply: { ok: 1 } }]);

// fetch answers from a list, one per call; records each call
async function withFetch(answers, f) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return typeof a === 'function' ? a(init) : a.clone(); // the list's own copy is never read
  };
  try {
    return await f(calls);
  } finally {
    globalThis.fetch = real;
  }
}

// a timer that only counts
function clock() {
  const slept = [];
  return { slept, sleep: async (ms) => { slept.push(ms); } };
}

test('D1: a busy server is waited for and the same copy sent again, with a countdown', async () => {
  const blob = new Blob(['the copy'], { type: 'image/jpeg' });
  const c = clock();
  const words = [];
  await withFetch([busy(1), OK()], async (calls) => {
    const reply = await sendPhoto(blob, (m) => words.push(m.words), 'api/room', { sleep: c.sleep });
    assert.deepEqual(reply, { ok: 1 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.body, blob);
    assert.equal(calls[1].init.body, blob, 'the very same copy, not read again');
  });
  assert.deepEqual(words, [`${WAITING_WORDS}: trying again in 1 s`, 'Reading your room'], 'one waiting line, then the read');
  assert.deepEqual(c.slept, [1000]);
});

test('D1: Retry-After is honored (5 s from the server, 5 s when none), with a line each second', async () => {
  for (const after of [5, null]) {
    const c = clock();
    const words = [];
    await withFetch([busy(after), OK()], () => sendPhoto(new Blob(['x']), (m) => words.push(m), 'u', { sleep: c.sleep }));
    assert.deepEqual(c.slept, [1000, 1000, 1000, 1000, 1000]);
    assert.deepEqual(words.slice(0, 5).map((m) => m.seconds), [5, 4, 3, 2, 1]);
    assert.ok(words.slice(0, 5).every((m) => m.type === 'progress' && m.stage === 'waiting'));
  }
});

test('D1: three busy answers in a row give the busy words; never more than 30 s of waiting', async () => {
  const c = clock();
  await withFetch([busy(5)], async (calls) => {
    await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { sleep: c.sleep }), { message: 'Two photos are already being read. Please try again in a few seconds.' });
    assert.equal(calls.length, 3);
  });
  assert.equal(c.slept.length, 10, 'two waits of 5 s');
  // a long Retry-After is cut to what is left of the 30 s
  const d = clock();
  await withFetch([busy(25)], async (calls) => {
    await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { sleep: d.sleep }), /already being read/);
    assert.equal(calls.length, 3);
  });
  assert.equal(d.slept.reduce((s, ms) => s + ms, 0), BUSY_WAIT_MS);
  // past the 30 s, no third send
  const e = clock();
  await withFetch([busy(3600)], async (calls) => {
    await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { sleep: e.sleep }), /already being read/);
    assert.equal(calls.length, 2);
  });
  assert.equal(e.slept.length, 30);
});

test('D1: the hourly, daily and spending stops and other refusals are not sent again', async () => {
  for (const [status, code] of [[429, 'hour_cap'], [429, 'day_cap'], [429, 'spend_stop'], [503, 'live_unavailable'], [400, 'bad_photo']]) {
    const c = clock();
    await withFetch([json(status, { error: { code, message: `Stopped: ${code}.` } }, { 'Retry-After': '5' })], async (calls) => {
      await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { sleep: c.sleep }), { message: `Stopped: ${code}.` });
      assert.equal(calls.length, 1, code);
    });
    assert.deepEqual(c.slept, []);
  }
  // a 429 that is not JSON is not retried either
  await withFetch([new Response('slow down', { status: 429 })], async (calls) => {
    await assert.rejects(sendPhoto(new Blob(['x']), () => {}, 'u', { sleep: async () => {} }), { message: 'The server answered 429.' });
    assert.equal(calls.length, 1);
  });
});

test('D1: Retry-After read as seconds or as a date', () => {
  assert.equal(retryAfterSeconds('5'), 5);
  assert.equal(retryAfterSeconds(null), null);
  assert.equal(retryAfterSeconds('soon'), null);
  const now = Date.parse('2026-10-27T10:00:00Z');
  assert.equal(retryAfterSeconds('Tue, 27 Oct 2026 10:00:07 GMT', now), 7);
  assert.equal(retryAfterSeconds('Tue, 27 Oct 2026 09:00:00 GMT', now), 0);
});
