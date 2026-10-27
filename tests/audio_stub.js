// A stand-in AudioContext for Node: it builds no sound, it records the graph.
// Every node keeps what it connects to; every AudioParam keeps its calls and
// the highest value ever asked of it, so a test can read peaks and routes.
class Param {
  // the default value is not counted as asked for: only sets are
  constructor(v = 0) { this.v = v; this.calls = []; this.peak = 0; }
  get value() { return this.v; }
  set value(v) { this.v = v; if (v > this.peak) this.peak = v; }
  log(kind, v, t) { this.calls.push([kind, v, t]); if (typeof v === 'number' && v > this.peak) this.peak = v; return this; }
  setValueAtTime(v, t) { return this.log('set', v, t); }
  linearRampToValueAtTime(v, t) { return this.log('lin', v, t); }
  exponentialRampToValueAtTime(v, t) { return this.log('exp', v, t); }
  setTargetAtTime(v, t) { return this.log('target', v, t); }
  cancelScheduledValues(t) { this.calls.push(['cancel', null, t]); return this; }
  // the last value asked for (a set, a ramp or a target)
  get last() { const c = this.calls.filter((x) => x[0] !== 'cancel'); return c.length ? c[c.length - 1][1] : this.value; }
}

class Node {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.outs = []; ctx.nodes.push(this); }
  connect(n) { this.outs.push(n); return n; }
  disconnect() { this.outs = []; }
}

export class StubAudioContext {
  constructor() {
    this.nodes = [];
    this.state = 'running';
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.destination = new Node(this, 'destination');
    StubAudioContext.made.push(this);
  }
  createGain() { const n = new Node(this, 'gain'); n.gain = new Param(1); return n; }
  createOscillator() {
    const n = new Node(this, 'osc');
    n.type = 'sine';
    n.frequency = new Param(440);
    n.detune = new Param(0);
    n.start = (t) => { n.started = t; };
    n.stop = (t) => { n.stopped = t; };
    return n;
  }
  createBiquadFilter() { const n = new Node(this, 'filter'); n.type = 'lowpass'; n.frequency = new Param(350); n.Q = new Param(1); n.gain = new Param(0); return n; }
  createDelay() { const n = new Node(this, 'delay'); n.delayTime = new Param(0); return n; }
  createBuffer(ch, len, rate) { const d = new Float32Array(len); return { length: len, sampleRate: rate, getChannelData: () => d }; }
  createBufferSource() { const n = new Node(this, 'source'); n.start = (t) => { n.started = t; }; n.stop = () => {}; return n; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  of(kind) { return this.nodes.filter((n) => n.kind === kind); }
  // the gain nodes that shape one voice: fed by an oscillator or a source
  voiceGains() { return this.nodes.filter((n) => (n.kind === 'osc' || n.kind === 'source' || n.kind === 'filter') && n.outs.length).flatMap((n) => n.outs).filter((g) => g.kind === 'gain'); }
}
StubAudioContext.made = [];

// Installs the stand-in as the page's AudioContext; returns an undo.
export function installAudio() {
  const saved = globalThis.AudioContext;
  StubAudioContext.made = [];
  globalThis.AudioContext = StubAudioContext;
  return () => { if (saved === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = saved; };
}

// Timers a test drives by hand.
export function handTimers() {
  const live = new Set();
  return {
    every: (f) => { const t = { f }; live.add(t); return t; },
    clear: (t) => live.delete(t),
    run: () => { for (const t of [...live]) t.f(); },
    get count() { return live.size; },
  };
}
