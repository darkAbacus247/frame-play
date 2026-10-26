// Safe device storage. Every read and write is wrapped: with storage blocked
// (private windows, cleared site data) the page simply starts fresh.
const PREFIX = 'frameplay.';

export function readPref(key, fallback) {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removePref(key) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.removeItem(PREFIX + key);
  } catch {
    /* storage blocked: nothing to remove */
  }
}

// Sound is on for every fresh visitor. A stored choice exists only after the
// person changed it.
export function soundOn() {
  const v = readPref('sound', null);
  return v === null ? true : v === true;
}

export function setSound(on) {
  return writePref('sound', !!on);
}

// Motion and High contrast follow the system setting until the person flips
// the page's own switch; then their choice wins.
export function reducedMotion(systemReduced) {
  const p = readPref('motion', null);
  return p === null ? !!systemReduced : p === 'off';
}

export function setMotion(on) {
  return writePref('motion', on ? 'on' : 'off');
}

export function highContrast(systemMore) {
  const p = readPref('contrast', null);
  return p === null ? !!systemMore : p === 'on';
}

export function setContrast(on) {
  return writePref('contrast', on ? 'on' : 'off');
}

export function outlinesWhilePlaying() {
  return readPref('outlines', true) !== false;
}

export function setOutlinesWhilePlaying(on) {
  return writePref('outlines', !!on);
}
