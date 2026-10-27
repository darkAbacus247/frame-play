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

// The level store: the last 12 levels made from photos, keyed by the photo
// file's sha256. Levels hold outlines, names and roles, never the photo. A
// damaged or foreign entry is dropped; with storage blocked nothing is kept.
export const LEVEL_STORE_SIZE = 12;
const LEVELS = 'levels';
const SHA = /^[0-9a-f]{64}$/;

function readLevels() {
  const list = readPref(LEVELS, []);
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && typeof e === 'object' && SHA.test(e.sha256) && e.level
    && e.level.schema === 'frameplay.level/2' && e.level.picture && e.level.picture.sha256 === e.sha256
    && (e.level.origin === 'live' || e.level.origin === 'rehearsal'));
}

export function saveLevel(sha256, level, extra = {}) {
  if (!SHA.test(sha256)) return false;
  const list = readLevels().filter((e) => e.sha256 !== sha256);
  list.unshift({ sha256, level, ...extra, saved: new Date().toISOString() });
  let keep = list.slice(0, LEVEL_STORE_SIZE);
  // a full device drops the oldest until the newest fits
  while (keep.length && !writePref(LEVELS, keep)) keep = keep.slice(0, -1);
  return keep.length > 0;
}

export function loadLevel(sha256) {
  return readLevels().find((e) => e.sha256 === sha256) || null;
}

export function storedLevelCount() {
  return readLevels().length;
}

// Your marks: the last 12 photos marked by hand, keyed by the photo file's
// sha256, each with its marks (roles and boxes) and the level made from
// them, or null while not made yet. Never the photo. A damaged or foreign
// entry is dropped (the marks themselves are checked again by the page,
// src/marks.js sanitizeMarks, against the photo's size).
const MARKED = 'marked';

function readMarkedList() {
  const list = readPref(MARKED, []);
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && typeof e === 'object' && SHA.test(e.sha256) && Array.isArray(e.marks)
    && (e.level === null || (e.level && e.level.schema === 'frameplay.level/2' && e.level.origin === 'marked'
      && e.level.picture && e.level.picture.kind === 'marked' && e.level.picture.sha256 === e.sha256)));
}

export function saveMarks(sha256, marks, level = null) {
  if (!SHA.test(sha256) || !Array.isArray(marks)) return false;
  const list = readMarkedList().filter((e) => e.sha256 !== sha256);
  list.unshift({ sha256, marks: marks.map((m) => ({ role: m.role, box: m.box.slice(0, 4) })), level: level || null, saved: new Date().toISOString() });
  let keep = list.slice(0, LEVEL_STORE_SIZE);
  while (keep.length && !writePref(MARKED, keep)) keep = keep.slice(0, -1);
  return keep.length > 0;
}

export function loadMarks(sha256) {
  return readMarkedList().find((e) => e.sha256 === sha256) || null;
}

export function outlinesWhilePlaying() {
  return readPref('outlines', true) !== false;
}

export function setOutlinesWhilePlaying(on) {
  return writePref('outlines', !!on);
}
