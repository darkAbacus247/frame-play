// A tiny event bus. The play screen (src/game.js) tells it what happened —
// a step, a coin, a hazard, the exit opening, a win, a loss, an outline
// drawn on the reveal, the closing screen, a primary button — and the
// sound, the music and the particles listen. A listener that throws never
// stops the game or the other listeners.
export const EVENTS = ['step', 'coin', 'hazard', 'exit', 'win', 'lose', 'reveal', 'closing', 'ui', 'settings'];

const listeners = new Map();

// on(type, fn) -> off(): fn(detail, type) on every emit of type
export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => off(type, fn);
}

export function off(type, fn) {
  const set = listeners.get(type);
  if (set) set.delete(fn);
}

// returns how many listeners heard it
export function emit(type, detail = {}) {
  const set = listeners.get(type);
  if (!set || !set.size) return 0;
  let n = 0;
  for (const fn of [...set]) {
    try { fn(detail, type); n++; } catch { /* one listener's failure is its own */ }
  }
  return n;
}

export function listenerCount(type) {
  const set = listeners.get(type);
  return set ? set.size : 0;
}

// for tests: forget every listener
export function clearListeners() {
  listeners.clear();
}
