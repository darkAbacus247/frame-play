// The background music: its score (planBar, pure) and its graph, built
// against a stand-in AudioContext (tests/audio_stub.js). It starts only
// after a gesture, sits under the game's sounds, turns softer in play,
// follows the Sound switch and its own volume, and stings on the close.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StubAudioContext, installAudio, handTimers } from './audio_stub.js';
import {
  Music, planBar, planPhrase, BAR, PHRASE_BARS, MODES, VOICE_PEAK, MUSIC_DEFAULT_VOLUME, MUSIC_MAX, SCALE, CHORDS, PROGRESSIONS, STING,
} from '../src/music.js';
import { Synth } from '../src/audio.js';

test('the score: every bar has its chord and bass; the melody stays in its scale', () => {
  for (let bar = 0; bar < 64; bar++) {
    const p = planBar(bar);
    assert.ok(CHORDS[p.chord], `bar ${bar}`);
    assert.equal(p.notes.filter((n) => n.inst === 'pad').length, 4);
    assert.ok(p.notes.some((n) => n.inst === 'bass' && n.at === 0));
    for (const n of p.notes.filter((x) => x.inst === 'lead')) assert.ok(SCALE.includes(n.midi), `bar ${bar}: ${n.midi}`);
    for (const n of p.notes) assert.ok(n.at >= 0 && n.at < 4 && n.dur > 0 && n.peak > 0 && n.peak <= VOICE_PEAK[n.inst]);
  }
});

test('the score evolves: phrases change progression and motif, and every fourth breathes', () => {
  const phrases = Array.from({ length: 16 }, (_, n) => planPhrase(n));
  for (let n = 1; n < 16; n++) assert.notEqual(phrases[n].prog, phrases[n - 1].prog, `phrase ${n} changes its chords`);
  assert.ok(new Set(phrases.map((p) => p.prog)).size >= 3, 'most progressions are heard');
  assert.ok(new Set(phrases.map((p) => JSON.stringify(p.motif))).size >= 12, 'the motifs differ');
  assert.deepEqual(phrases.map((p) => p.breath).slice(0, 8), [false, false, false, true, false, false, false, true]);
  const breath = planBar(3 * PHRASE_BARS);
  assert.ok(!breath.notes.some((n) => n.inst === 'lead'), 'a breath has no tune');
  assert.ok(breath.notes.some((n) => n.inst === 'arp'));
  // two minutes of music never repeats the same 8 bars of melody back to back
  const leadOf = (b) => JSON.stringify(planBar(b).notes.filter((n) => n.inst === 'lead'));
  const bars = Math.ceil(120 / BAR);
  const phraseKey = (k) => Array.from({ length: PHRASE_BARS }, (_, i) => leadOf(k * PHRASE_BARS + i)).join();
  for (let k = 1; k * PHRASE_BARS < bars; k++) assert.notEqual(phraseKey(k), phraseKey(k - 1));
  assert.equal(PROGRESSIONS.every((p) => p.every((c) => CHORDS[c])), true);
});

test('in play the music is softer and sparser', () => {
  assert.ok(MODES.play.level < MODES.calm.level && MODES.play.cutoff < MODES.calm.cutoff);
  let calm = 0, play = 0;
  for (let b = 0; b < 32; b++) {
    calm += planBar(b, 'calm').notes.filter((n) => n.inst !== 'pad').length;
    play += planBar(b, 'play').notes.filter((n) => n.inst !== 'pad').length;
    assert.ok(!planBar(b, 'play').notes.some((n) => n.inst === 'arp'));
  }
  assert.ok(play < calm * 0.6, `${play} notes in play, ${calm} on the screens`);
});

test('the loudest music note at the default volume is quieter than the quietest game sound', () => {
  const loudest = Math.max(...Object.values(VOICE_PEAK)) * MUSIC_DEFAULT_VOLUME * MUSIC_MAX;
  assert.ok(loudest < 0.05, `${loudest}`); // the step and the tick peak at 0.05
  assert.ok(MUSIC_DEFAULT_VOLUME > 0 && MUSIC_DEFAULT_VOLUME <= 0.5, 'gentle, not silent');
});

test('Music schedules bars ahead, fades in, follows volume and mode, and stops', () => {
  const ctx = new StubAudioContext();
  const out = ctx.createGain();
  const timers = handTimers();
  const m = new Music(ctx, out, { timers });
  assert.equal(ctx.of('osc').length, 0, 'nothing sounds before start');
  m.start();
  assert.equal(timers.count, 1);
  const first = ctx.of('osc').length;
  assert.ok(first > 0, 'the first bar is scheduled');
  timers.run();
  assert.equal(ctx.of('osc').length, first, 'no more than the lookahead');
  ctx.currentTime = BAR;
  timers.run();
  assert.ok(ctx.of('osc').length > first, 'the next bar, in time');
  assert.equal(m.bus.gain.last, MUSIC_DEFAULT_VOLUME * MUSIC_MAX, 'fades to the default level');
  m.setVolume(1);
  assert.equal(m.bus.gain.last, MUSIC_MAX);
  m.setMode('play');
  assert.equal(m.bus.gain.last, MUSIC_MAX * MODES.play.level);
  assert.equal(m.tone.frequency.last, MODES.play.cutoff);
  // a stalled tab skips ahead instead of playing the missed bars at once
  const before = ctx.of('osc').length;
  ctx.currentTime = 600;
  timers.run();
  const added = ctx.of('osc').length - before;
  assert.ok(added > 0 && added < 40, `${added} voices after a stall`);
  m.stop();
  assert.equal(timers.count, 0);
  assert.equal(m.bus.gain.last, 0, 'fades out');
  const n = ctx.of('osc').length;
  ctx.currentTime += 10;
  timers.run();
  assert.equal(ctx.of('osc').length, n, 'nothing after stop');
});

test('the sting plays only while the music plays, over a dipped loop', () => {
  const ctx = new StubAudioContext();
  const m = new Music(ctx, ctx.createGain(), { timers: handTimers() });
  assert.equal(m.sting(), false);
  m.start();
  const n = ctx.of('osc').length;
  assert.equal(m.sting(), true);
  assert.equal(ctx.of('osc').length, n + STING.length);
  assert.ok(m.loop.gain.calls.some(([k, v]) => k === 'lin' && v < 0.5), 'the loop dips');
  assert.equal(m.loop.gain.last, 1, 'and comes back');
});

test('the synth makes no music before a gesture, then starts it once unlocked', () => {
  const undo = installAudio();
  try {
    const s = new Synth();
    assert.equal(StubAudioContext.made.length, 0, 'no context until a gesture');
    assert.equal(s.music, null);
    s.musicMode('play');
    assert.equal(s.sting(), false);
    s.unlock(); // the first press or key
    assert.equal(StubAudioContext.made.length, 1);
    assert.ok(s.music && s.music.playing, 'music on by default, from the gesture');
    assert.equal(s.music.mode, 'play', 'the mode asked before the gesture holds');
    s.unlock();
    assert.equal(StubAudioContext.made.length, 1, 'one context');
    // the music feeds the synth's master, which reaches the speakers
    assert.ok(s.music.bus.outs.includes(s.master) && s.master.outs.includes(s.ctx.destination));
    s.setOn(false);
    assert.equal(s.music.playing, false, 'Sound off silences the music');
    s.setOn(true);
    assert.equal(s.music.playing, true);
    s.setMusic(false);
    assert.equal(s.music.playing, false, 'Music off');
    s.setMusic(true, 0.8);
    assert.equal(s.music.playing, true);
    assert.equal(s.music.volume, 0.8);
    s.setMusic(true, 7);
    assert.equal(s.music.volume, 1, 'the volume is clamped');
    s.setOn(false);
  } finally { undo(); }
});

test('with music off before the gesture, the gesture starts no music', () => {
  const undo = installAudio();
  try {
    const s = new Synth();
    s.setMusic(false);
    s.unlock();
    assert.equal(s.music.playing, false);
    assert.equal(s.music.bus.gain.value, 0);
  } finally { undo(); }
});

test('the music is written in code: no audio files, no fetch, nothing loaded', () => {
  for (const f of ['src/music.js', 'src/audio.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /fetch\(|decodeAudioData|\.mp3|\.ogg|\.wav|new Audio\b|import\(/, f);
  }
});
