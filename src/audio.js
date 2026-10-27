// Every sound is synthesised; there are no sound files. A browser lets sound
// start only after the first press or key, so the context is created then,
// and the background music (src/music.js) starts with it: never by itself,
// not after a reload until the next press or key.
import { Music } from './music.js';
import { on as listen } from './events.js';
import { musicOn, musicVolume, effectsOn } from './settings_fx.js';

// the soft steps are spaced at least this far apart, however fast the walk
export const STEP_GAP = 0.2;
// a five-note scale for the reveal's shimmer, one note per outline
const SHIMMER = [1175, 1319, 1480, 1760, 1976];

export class Synth {
  constructor() {
    this.ctx = null;
    this.on = true;
    this.master = null;
    this.music = null;
    // Music, its volume and Effects as saved on the device (src/settings_fx.js)
    this.musicOn = musicOn();
    this.musicVolume = musicVolume();
    this.mode = 'calm';
    this.effects = effectsOn();
    this.lastStep = -1;
    // what the game tells the bus with no sound of its own (src/game.js
    // plays the round's sounds itself)
    listen('reveal', (d) => this.play('shimmer', d));
    listen('ui', () => this.play('click'));
    listen('closing', () => this.sting());
    listen('settings', (st) => {
      this.effects = st.effects !== false;
      this.setMusic(st.music !== false, typeof st.volume === 'number' ? st.volume : this.musicVolume);
    });
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

  // name: a game sound; opts.k picks the shimmer's note
  play(name, opts = {}) {
    if (!this.effects) return;
    switch (name) {
      case 'step': {
        // a soft scuff, never two closer than STEP_GAP, each a little different
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        if (this.lastStep >= 0 && now - this.lastStep < STEP_GAP) return;
        this.lastStep = now;
        this.stepN = ((this.stepN || 0) + 1) % 4;
        this.noise(0.045, { gain: 0.04, freq: [620, 540, 680, 580][this.stepN] });
        break;
      }
      case 'bump': this.tone(140, 0.12, { type: 'triangle', gain: 0.18, slide: -40 }); break;
      case 'collect':
        // the coin: a bright two-note chime with a faint bell partial
        this.tone(1047, 0.14, { gain: 0.15 });
        this.tone(1568, 0.26, { gain: 0.13, at: 0.06 });
        this.tone(3136, 0.18, { gain: 0.03, at: 0.06 });
        break;
      case 'unlock':
        // the exit opening: a rising figure with a little air on top
        [587, 740, 880, 1175].forEach((f, i) => this.tone(f, 0.24, { type: 'triangle', gain: 0.12, at: i * 0.075 }));
        this.noise(0.35, { gain: 0.025, freq: 5200, at: 0.2 });
        break;
      case 'locked': this.tone(220, 0.14, { type: 'square', gain: 0.06 }); this.tone(196, 0.16, { type: 'square', gain: 0.06, at: 0.1 }); break;
      case 'hazard':
        // a bump into the hazard: a low thud and a puff
        this.tone(170, 0.28, { type: 'sine', gain: 0.16, slide: -100 });
        this.tone(95, 0.35, { type: 'triangle', gain: 0.1, at: 0.04, slide: -35 });
        this.noise(0.25, { gain: 0.07, freq: 320 });
        break;
      case 'win':
        // the win jingle: a short tune, then the chord it lands on
        [[587, 0], [740, 0.1], [880, 0.2], [740, 0.3], [880, 0.4], [1175, 0.5]]
          .forEach(([f, at]) => this.tone(f, 0.22, { type: 'triangle', gain: 0.13, at }));
        [587, 740, 880, 1175].forEach((f) => this.tone(f, 0.8, { gain: 0.05, at: 0.62, attack: 0.03 }));
        break;
      case 'loss':
        // the loss sting: three falling notes, the last one sagging
        [[440, 0], [370, 0.15], [294, 0.3]].forEach(([f, at], i) => this.tone(f, i === 2 ? 0.5 : 0.22, { type: 'triangle', gain: 0.12, at, slide: i === 2 ? -40 : 0 }));
        break;
      case 'start': this.tone(440, 0.12, { gain: 0.1 }); this.tone(660, 0.16, { gain: 0.1, at: 0.08 }); break;
      case 'tick': this.tone(1200, 0.04, { gain: 0.05 }); break;
      case 'refuse': this.tone(180, 0.18, { type: 'square', gain: 0.05 }); break;
      case 'shimmer': {
        // an outline drawing in on the reveal: a high glint and a breath of air
        const f = SHIMMER[(opts.k | 0) % SHIMMER.length];
        this.tone(f, 0.16, { gain: 0.035 });
        this.tone(f * 1.5, 0.12, { gain: 0.02, at: 0.04 });
        this.noise(0.12, { gain: 0.015, freq: 6500 });
        break;
      }
      case 'click': this.tone(880, 0.035, { type: 'triangle', gain: 0.04 }); this.tone(1320, 0.03, { gain: 0.02, at: 0.02 }); break;
      default: break;
    }
  }
}
