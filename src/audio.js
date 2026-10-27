// Every sound is synthesised; there are no sound files. A browser lets sound
// start only after the first press or key, so the context is created then,
// and the background music (src/music.js) starts with it: never by itself,
// not after a reload until the next press or key.
import { Music, MUSIC_DEFAULT_VOLUME } from './music.js';

export class Synth {
  constructor() {
    this.ctx = null;
    this.on = true;
    this.master = null;
    this.music = null;
    this.musicOn = true;
    this.musicVolume = MUSIC_DEFAULT_VOLUME;
    this.mode = 'calm';
    // a hidden tab holds every sound and the music; it goes on when shown
    const doc = globalThis.document;
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (doc.hidden) this.ctx.suspend && this.ctx.suspend().catch(() => {});
        else this.ctx.resume().catch(() => {});
      });
    }
  }

  // Call from a user gesture.
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this.syncMusic();
      return;
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.music = new Music(this.ctx, this.master, { volume: this.musicVolume });
    } catch {
      this.ctx = null;
      this.music = null;
    }
    this.syncMusic();
  }

  // the music plays while sound and music are both on, once a gesture made
  // the context
  syncMusic() {
    const m = this.music;
    if (!m) return;
    m.setVolume(this.musicVolume);
    m.setMode(this.mode);
    if (this.on && this.musicOn) m.start();
    else m.stop();
  }

  setOn(on) { this.on = !!on; this.syncMusic(); }

  setMusic(on, volume = this.musicVolume) {
    this.musicOn = !!on;
    this.musicVolume = Math.max(0, Math.min(1, Number(volume) || 0));
    this.syncMusic();
  }

  // 'calm' on the screens, 'play' (softer) during a round
  musicMode(mode) {
    this.mode = mode === 'play' ? 'play' : 'calm';
    if (this.music) this.music.setMode(this.mode);
  }

  // the closing screen's sting, when the music plays
  sting() {
    return !!(this.on && this.musicOn && this.music && this.music.sting());
  }

  tone(freq, dur, { type = 'sine', gain = 0.2, at = 0, slide = 0, attack = 0.005 } = {}) {
    if (!this.on || !this.ctx || this.ctx.state !== 'running') return;
    const t0 = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  noise(dur, { gain = 0.08, at = 0, freq = 900 } = {}) {
    if (!this.on || !this.ctx || this.ctx.state !== 'running') return;
    const t0 = this.ctx.currentTime + at;
    const n = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      d[i] = ((s / 0x7fffffff) * 2 - 1) * (1 - i / n);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t0);
  }

  play(name) {
    switch (name) {
      case 'step': this.noise(0.05, { gain: 0.05, freq: 700 }); break;
      case 'bump': this.tone(140, 0.12, { type: 'triangle', gain: 0.18, slide: -40 }); break;
      case 'collect': this.tone(880, 0.12, { gain: 0.16 }); this.tone(1320, 0.18, { gain: 0.14, at: 0.07 }); break;
      case 'unlock': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.22, { gain: 0.13, at: i * 0.08 })); break;
      case 'locked': this.tone(220, 0.14, { type: 'square', gain: 0.06 }); this.tone(196, 0.16, { type: 'square', gain: 0.06, at: 0.1 }); break;
      case 'hazard': this.tone(110, 0.4, { type: 'sawtooth', gain: 0.12, slide: -50 }); this.noise(0.3, { gain: 0.08, freq: 400 }); break;
      case 'win': [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.3, { type: 'triangle', gain: 0.14, at: i * 0.09 })); break;
      case 'loss': [392, 330, 262].forEach((f, i) => this.tone(f, 0.32, { type: 'triangle', gain: 0.13, at: i * 0.14 })); break;
      case 'start': this.tone(440, 0.12, { gain: 0.1 }); this.tone(660, 0.16, { gain: 0.1, at: 0.08 }); break;
      case 'tick': this.tone(1200, 0.04, { gain: 0.05 }); break;
      case 'refuse': this.tone(180, 0.18, { type: 'square', gain: 0.05 }); break;
      default: break;
    }
  }
}
