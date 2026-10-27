// The background music: an original loop written in code for this game, made
// with oscillators only (no files, no samples). A soft pad holds four-bar
// progressions, a bass note marks the bar and a light melody grows from a
// short motif that changes every phrase, so minutes of it never repeat
// exactly. Every fourth phrase is a breath: the pad and a quiet arpeggio,
// no tune. During play it turns softer and sparser (a lower level, a darker
// filter, half the notes); the closing screen gets a short sting.
//
// planBar() is pure (which notes sound in a bar), so the score can be tested
// without audio; Music turns it into scheduled nodes on an AudioContext.
import { makeRng } from './rng.js';

export const BPM = 80;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const PHRASE_BARS = 8;
// the slider's default (0 to 1) and the bus level at full slider: at the
// default the loudest note sits under the quietest game sound
export const MUSIC_DEFAULT_VOLUME = 0.4;
export const MUSIC_MAX = 0.5;
export const MODES = {
  calm: { level: 1, cutoff: 2600, bassBeats: [0, 2], thin: false, arp: true },
  play: { level: 0.6, cutoff: 1500, bassBeats: [0], thin: true, arp: false },
};
// every voice's peak before the bus: the loudest is the melody
export const VOICE_PEAK = { pad: 0.03, bass: 0.17, lead: 0.16, arp: 0.07, sting: 0.15 };
const LOOKAHEAD = 0.6; // seconds of notes scheduled ahead
const PUMP_MS = 200;

// The chords, as a bass note and a close pad voicing (MIDI numbers).
export const CHORDS = {
  I: { bass: 50, pad: [62, 66, 69, 73] },
  ii: { bass: 52, pad: [62, 64, 67, 71] },
  iii: { bass: 54, pad: [61, 64, 66, 69] },
  IV: { bass: 55, pad: [62, 66, 67, 71] },
  V: { bass: 45, pad: [61, 64, 69, 71] },
  vi: { bass: 47, pad: [62, 66, 69, 71] },
};
export const PROGRESSIONS = [
  ['I', 'iii', 'IV', 'ii'],
  ['vi', 'IV', 'I', 'V'],
  ['IV', 'V', 'iii', 'vi'],
  ['ii', 'V', 'I', 'IV'],
];
// the melody's notes: a five-note scale over an octave and a half
export const SCALE = [69, 71, 74, 76, 78, 81, 83, 86];
// onsets over a bar's eight eighths
const RHYTHMS = [
  [1, 0, 0, 1, 0, 1, 0, 0],
  [1, 0, 1, 0, 0, 0, 1, 0],
  [0, 0, 1, 0, 1, 0, 1, 1],
  [1, 0, 0, 0, 1, 0, 0, 0],
  [1, 1, 0, 0, 1, 0, 1, 0],
];

export const midiFreq = (m) => 440 * 2 ** ((m - 69) / 12);

// One phrase's plan, from its number: the progression, whether it is a
// breath, and a two-bar motif (rhythm and scale steps) the phrase varies.
export function planPhrase(n, seed = 7) {
  const rng = makeRng(seed * 1009 + n * 7919);
  const prog = planProgression(n, seed);
  const breath = n % 4 === 3;
  const motif = [0, 1].map(() => {
    const rhythm = RHYTHMS[Math.floor(rng() * RHYTHMS.length)];
    return rhythm.map((on) => (on ? Math.floor(rng() * 5) - 2 : null));
  });
  const start = 2 + Math.floor(rng() * 3);
  return { prog, breath, motif, start, vary: rng() };
}

// each phrase moves to one of the other progressions
function planProgression(n, seed) {
  const P = PROGRESSIONS.length;
  let prog = Math.floor(makeRng(seed * 31)() * P);
  for (let i = 1; i <= n; i++) prog = (prog + 1 + Math.floor(makeRng(seed * 31 + i * 131)() * (P - 1))) % P;
  return prog;
}

function nearestChordTone(midi, chord) {
  const pcs = chord.pad.map((p) => p % 12);
  let best = midi, bd = 99;
  for (const m of SCALE) {
    const d = Math.abs(m - midi);
    if (pcs.includes(m % 12) && d < bd) { best = m; bd = d; }
  }
  return best;
}

// The notes of bar `bar` (counted from the start) in a mode: a list of
// { inst, midi, at (beats into the bar), dur (beats), peak }.
export function planBar(bar, mode = 'calm', seed = 7) {
  const m = MODES[mode] || MODES.calm;
  const n = Math.floor(bar / PHRASE_BARS);
  const inPhrase = bar % PHRASE_BARS;
  const ph = planPhrase(n, seed);
  const name = PROGRESSIONS[ph.prog][inPhrase % 4];
  const chord = CHORDS[name];
  const notes = [];
  for (const p of chord.pad) notes.push({ inst: 'pad', midi: p, at: 0, dur: 4, peak: VOICE_PEAK.pad });
  for (const b of m.bassBeats) notes.push({ inst: 'bass', midi: chord.bass, at: b, dur: 1.6, peak: VOICE_PEAK.bass * (b ? 0.7 : 1) });
  if (ph.breath) {
    if (m.arp) {
      const tones = [...chord.pad, chord.pad[1] + 12];
      for (let i = 0; i < 8; i++) notes.push({ inst: 'arp', midi: tones[(i * 3 + inPhrase) % tones.length] + 12, at: i / 2, dur: 0.6, peak: VOICE_PEAK.arp * (i % 2 ? 0.7 : 1) });
    }
    return { chord: name, notes };
  }
  // the motif's two bars, the second half answering the first with a
  // change in its last bar
  const half = inPhrase % 2;
  const steps = ph.motif[half];
  let deg = ph.start + (inPhrase >= 4 ? 1 : 0);
  steps.forEach((s, i) => {
    if (s === null) return;
    if (m.thin && i % 4 !== 0) return;
    deg = Math.max(0, Math.min(SCALE.length - 1, deg + (inPhrase === 7 && ph.vary > 0.5 ? -s : s)));
    let midi = SCALE[deg];
    if (i === 0 || i === 4) midi = nearestChordTone(midi, chord);
    notes.push({ inst: 'lead', midi, at: i / 2, dur: m.thin ? 1.5 : 0.9, peak: VOICE_PEAK.lead * (i === 0 ? 1 : 0.8) });
  });
  // the phrase's last bar comes to rest on a long chord tone
  if (inPhrase === PHRASE_BARS - 1 && !notes.some((x) => x.inst === 'lead' && x.at >= 3)) {
    notes.push({ inst: 'lead', midi: nearestChordTone(SCALE[ph.start], chord), at: 3, dur: 1, peak: VOICE_PEAK.lead * 0.7 });
  }
  return { chord: name, notes };
}

// The closing sting: a rising figure resting on a wide chord.
export const STING = [
  { midi: 62, at: 0, dur: 0.5 }, { midi: 66, at: 0.25, dur: 0.5 }, { midi: 69, at: 0.5, dur: 0.5 },
  { midi: 74, at: 0.75, dur: 2.2 }, { midi: 78, at: 0.75, dur: 2.2 }, { midi: 81, at: 0.75, dur: 2.2 },
];

function defaultTimers() {
  return {
    every: (f, ms) => { const t = setInterval(f, ms); if (t && t.unref) t.unref(); return t; },
    clear: (t) => clearInterval(t),
  };
}

export class Music {
  // ctx: an AudioContext; out: the node the music feeds (the synth's master)
  constructor(ctx, out, { seed = 7, timers = defaultTimers(), volume = MUSIC_DEFAULT_VOLUME } = {}) {
    this.ctx = ctx;
    this.seed = seed;
    this.timers = timers;
    this.volume = volume;
    this.mode = 'calm';
    this.playing = false;
    this.bar = 0;
    this.nextBar = 0;
    this.timer = null;
    // voices -> loop -> tone (a lowpass) -> bus -> out; the lead also into a
    // soft echo; the sting goes to the bus past the loop, which dips under it
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = MODES.calm.cutoff;
    this.tone.Q.value = 0.4;
    this.loop = ctx.createGain();
    this.loop.gain.value = 1;
    this.echo = ctx.createDelay(2);
    this.echo.delayTime.value = BEAT * 0.75;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.28;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.25;
    this.loop.connect(this.tone);
    this.echo.connect(this.feedback);
    this.feedback.connect(this.echo);
    this.echo.connect(this.wet);
    this.wet.connect(this.tone);
    this.tone.connect(this.bus);
    this.bus.connect(out);
  }

  // the bus level the volume and the mode ask for
  target() {
    return Math.max(0, Math.min(1, this.volume)) * MUSIC_MAX * (MODES[this.mode] || MODES.calm).level;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    const now = this.ctx.currentTime;
    this.nextBar = now + 0.15;
    this.fade(this.target(), 2.5);
    this.timer = this.timers.every(() => this.pump(), PUMP_MS);
    this.pump();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.timers.clear(this.timer);
    this.timer = null;
    this.fade(0, 0.4);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, Number(v) || 0));
    if (this.playing) this.fade(this.target(), 0.3);
  }

  setMode(mode) {
    if (!MODES[mode] || mode === this.mode) return;
    this.mode = mode;
    const t = this.ctx.currentTime;
    this.tone.frequency.cancelScheduledValues(t);
    this.tone.frequency.setTargetAtTime(MODES[mode].cutoff, t, 0.8);
    if (this.playing) this.fade(this.target(), 1.5);
  }

  fade(to, seconds) {
    const g = this.bus.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(to, t + seconds);
  }

  // schedule every bar that starts within the lookahead; after a stall (a
  // hidden tab) skip ahead rather than play the missed bars at once
  pump() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    if (this.nextBar < now) this.nextBar = now + 0.05;
    while (this.nextBar < now + LOOKAHEAD) {
      this.playBar(this.nextBar, planBar(this.bar, this.mode, this.seed));
      this.nextBar += BAR;
      this.bar++;
    }
  }

  playBar(t0, plan) {
    for (const n of plan.notes) {
      const t = t0 + n.at * BEAT, dur = n.dur * BEAT;
      if (n.inst === 'pad') {
        this.voice('sine', n.midi, t, dur, n.peak, 0.6, -4);
        this.voice('triangle', n.midi, t, dur, n.peak, 0.6, 4);
      } else if (n.inst === 'bass') {
        this.voice('sine', n.midi, t, dur, n.peak, 0.02, 0);
      } else if (n.inst === 'lead') {
        this.voice('triangle', n.midi, t, dur, n.peak, 0.012, 0, true);
      } else {
        this.voice('sine', n.midi, t, dur, n.peak, 0.008, 0);
      }
    }
  }

  voice(type, midi, t, dur, peak, attack, detune, echo = false, dest = this.loop) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(midiFreq(midi), t);
    if (detune) o.detune.setValueAtTime(detune, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0.0001, t + Math.max(attack, dur * 0.55), dur * 0.3);
    o.connect(g);
    g.connect(dest);
    if (echo) g.connect(this.echo);
    o.start(t);
    o.stop(t + dur * 1.8 + 0.1);
  }

  // The closing sting, over a dipped loop; only while the music plays.
  sting() {
    if (!this.playing) return false;
    const t0 = this.ctx.currentTime + 0.05;
    const lg = this.loop.gain;
    lg.cancelScheduledValues(t0);
    lg.setValueAtTime(lg.value, t0);
    lg.linearRampToValueAtTime(0.3, t0 + 0.2);
    lg.setValueAtTime(0.3, t0 + 3);
    lg.linearRampToValueAtTime(1, t0 + 4.5);
    for (const n of STING) this.voice('triangle', n.midi, t0 + n.at * 0.5, n.dur * 0.5 * 2, VOICE_PEAK.sting, 0.01, 0, true, this.tone);
    return true;
  }
}
