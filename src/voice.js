// Say it: answering an Ask the room riddle by voice.
// The server does the writing down (POST /api/voice, server/voice.py); this
// file only records a short clip, makes the WAV the server wants (mono
// 16-bit PCM at 16 kHz) and posts it. The WAV writer, the resampler, the
// base64 step and the request body are pure so tests can use them in Node
// without a browser.
export const VOICE_RATE = 16000;
export const VOICE_MAX_SECONDS = 5;
// the server refuses a longer clip (server/config.py, VOICE_MAX_SECONDS)
const SERVER_MAX_SECONDS = 6;

// The words the panel shows. The consent is said before the first clip,
// exactly so, and claims no more than this code keeps (nothing).
export const VOICE_WORDS = {
  button: 'Say it',
  stop: 'Stop listening',
  tip: 'Answer by voice: about five seconds, written down by Muse Voice Transcribe. V does the same.',
  consent: 'Your voice clip goes to Meta’s Muse Voice Transcribe to be written down; this app keeps none. While this demo runs on Meta’s free hackathon credits, Meta may use what it receives to improve its products. Voice is for players 18 and over.',
  ok: 'OK',
  listening: `Listening... (${VOICE_MAX_SECONDS} s)`,
  writing: 'Writing it down...',
  heard: (transcript) => `Heard: “${transcript}”`,
  keyHint: 'V answers by voice.',
  noMic: 'No microphone could be used. Tap a thing, or choose it under Answer with.',
  failed: 'The voice answer could not be read. Tap a thing, or choose it under Answer with.',
};

// Whether the page may offer Say it: the server's health says the switch
// is on, and it is LIVE (in MOCK and REHEARSAL the server sends no voice).
export function voiceOn(health) {
  return !!(health && health.voice === 'on' && health.mode === 'live');
}

// A mono Float32 clip at `rate` into WAV bytes: a 44-byte RIFF header plus
// Int16 samples. Clamped, so a hot mic cannot wrap.
export function encodeWav(samples, rate = VOICE_RATE) {
  const n = samples.length;
  const out = new Uint8Array(44 + n * 2);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const writeText = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return out;
}

// Channel data (one Float32Array a channel) at `fromRate` down to one mono
// Float32Array at `toRate`, by averaging then linear resampling.
export function downmixResample(channels, fromRate, toRate = VOICE_RATE) {
  if (!channels.length) return new Float32Array(0);
  const len = Math.min(...channels.map((c) => c.length));
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (const c of channels) s += c[i];
    mono[i] = s / channels.length;
  }
  if (fromRate === toRate || !len) return mono;
  const outLen = Math.max(1, Math.floor((len * toRate) / fromRate));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = (i * len) / outLen;
    const i0 = Math.floor(pos);
    const i1 = Math.min(len - 1, i0 + 1);
    const f = pos - i0;
    out[i] = mono[i0] * (1 - f) + mono[i1] * f;
  }
  return out;
}

// Bytes to base64 without a browser or Node dependency leaking out.
export function bytesToBase64(bytes) {
  if (globalThis.Buffer && typeof globalThis.Buffer.from === 'function') {
    return globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return globalThis.btoa(s);
}

// The room's things as the server matches them: id and name only.
export function thingsOf(level) {
  return level.objects.map((o) => ({ id: o.id, name: o.name }));
}

// The request body: the WAV as base64 and the things, nothing else.
export function requestBody(wavBytes, things) {
  return { wav: bytesToBase64(wavBytes), things: things.map((t) => ({ id: t.id, name: t.name })) };
}

// A recorded clip: the microphone up to `maxSeconds`, stopping on its own
// then or on a second press (stop). Returns { done, stop }; done is the
// clip as a Blob.
export function recordClip(maxSeconds = VOICE_MAX_SECONDS) {
  const media = (globalThis.navigator && globalThis.navigator.mediaDevices) || null;
  if (!media || typeof media.getUserMedia !== 'function' || typeof globalThis.MediaRecorder !== 'function') {
    return { done: Promise.reject(new Error(VOICE_WORDS.noMic)), stop() {} };
  }
  let timer = 0;
  let onStop = null;
  let stopped = false;
  const done = (async () => {
    const stream = await media.getUserMedia({ audio: true });
    const end = () => { for (const t of stream.getTracks()) t.stop(); };
    if (stopped) { end(); throw new Error(VOICE_WORDS.noMic); }
    const chunks = [];
    return await new Promise((resolve, reject) => {
      let rec;
      try {
        rec = new MediaRecorder(stream);
      } catch {
        end();
        reject(new Error(VOICE_WORDS.noMic));
        return;
      }
      const stop = () => { clearTimeout(timer); try { rec.stop(); } catch { /* already stopped */ } };
      onStop = stop;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onerror = () => { clearTimeout(timer); end(); reject(new Error(VOICE_WORDS.failed)); };
      rec.onstop = () => { clearTimeout(timer); end(); resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })); };
      rec.start();
      timer = setTimeout(stop, maxSeconds * 1000);
    });
  })();
  return { done, stop() { stopped = true; if (onStop) onStop(); } };
}

// A recorded blob into the WAV bytes the server wants: decoded, then mono
// at 16 kHz through an OfflineAudioContext (the browser resamples), cut at
// the server's longest clip, then written out here.
export async function wavFromBlob(blob) {
  const OC = globalThis.OfflineAudioContext;
  if (typeof OC !== 'function') throw new Error(VOICE_WORDS.failed);
  const buf = await blob.arrayBuffer();
  // decoded by an offline context at 16 kHz, so the samples arrive at that rate
  const decoded = await new OC(1, 1, VOICE_RATE).decodeAudioData(buf.slice(0));
  const frames = Math.min(SERVER_MAX_SECONDS * VOICE_RATE, Math.max(1, Math.ceil(decoded.duration * VOICE_RATE)));
  const off = new OC(1, frames, VOICE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  return encodeWav(rendered.getChannelData(0), VOICE_RATE);
}

// The WAV bytes (Uint8Array) and the room's things [{id, name}] to the
// server; its answer {transcript, match, words}. A refusal is an Error
// carrying the server's words and code.
export async function sayIt(wavBytes, things) {
  const res = await fetch('api/voice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FramePlay-Request': '1' },
    body: JSON.stringify(requestBody(wavBytes, things)),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    throw new Error(VOICE_WORDS.failed);
  }
  if (!res.ok || !body || body.status !== 'ok') {
    const err = new Error((body && body.error && body.error.message) || VOICE_WORDS.failed);
    err.code = (body && body.error && body.error.code) || `http_${res.status}`;
    throw err;
  }
  return { transcript: typeof body.transcript === 'string' ? body.transcript : '', match: body.match ?? null, words: String(body.words || '') };
}
