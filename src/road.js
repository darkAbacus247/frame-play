// The road: one road of 15 steps and one counter, then Free play. Three
// sample rooms in a row (The Desk Top, The Living Room, The Apartment), the
// three side by side, your own room, then the closing screen that says the
// circuit is complete. Back moves one step left; Forward one step right,
// only when allowed, and it says why when it waits. Primary buttons only
// ever move forward. Pure logic.
//
// The sample rooms follow one another: when a round ends, the end card's
// primary goes straight on to the next room's reveal, its pick step passed
// with the next room already chosen there (continueAfterRound). Forward
// onto a pick step chooses that next room there too. The pick steps stay on
// the road, so Back (or Choose a different room) still reaches them, and
// any room can be picked there.
//
// Your own room may be passed by (in MOCK it cannot be read at all):
// Forward from its step then goes straight past its reveal and play steps,
// and Back from there comes straight home to it. A room made and played is
// never passed by: Continue to the end keeps it on the road.
//
// Any room may also be ours: our kitchen, a real photo, offered beside the
// sample rooms and beside Choose a photo. In LIVE it is read as a photo is;
// elsewhere its recorded answer is replayed, and the slot holds
// { kind: 'replay', id: 'kitchen' }. In a sample room's slot it is played as
// a sample room is.
//
// Your own room may also be marked by hand (src/marks.js): its slot then
// holds { kind: 'marked', sha256, made }. Choosing to mark a photo puts it
// on the road unmade, and Step 13 (named Your marks) is where the marks are
// drawn; Forward waits there until the room is made from them. Only a made
// room counts as made.

export const STEP_NAMES = [
  null,
  'Welcome',
  'Your room',
  'What the AI found',
  'Play',
  'Another room',
  'What the AI found',
  'Play',
  'A third room',
  'What the AI found',
  'Play',
  'Your three rooms',
  'Your own room',
  'What the AI found',
  'Play',
  'The end',
  'Free play',
];
// the sample rooms, in the order the road plays them
export const SAMPLE_ORDER = ['desk', 'living', 'apartment'];
export const SAMPLE_SLOTS = SAMPLE_ORDER.length;
export const THREE_STEP = 11;
export const OWN_STEP = 12;
export const LAST_STEP = 15;
export const FREE_PLAY = 16;
// where the road goes on after your own room, made or skipped
export const AFTER_OWN = OWN_STEP + 3;
// the step on which each room slot is picked: three sample rooms, then
// your own room
export const PICK_STEPS = [2, 5, 8, OWN_STEP];
export const SLOTS = PICK_STEPS.length;
export const OWN_SLOT = SLOTS - 1;
export const ROAD_VERSION = 4;

export function newRoad() {
  return {
    v: ROAD_VERSION, step: 1, reached: 1, consent: false, own: null,
    rooms: [null, null, null, null], finished: [false, false, false, false], best: [null, null, null, null],
  };
}

// Which room slot a step belongs to (0 to 3), or -1.
export function slotOf(step) {
  return PICK_STEPS.findIndex((p) => step >= p && step <= p + 2);
}

// What a step shows: welcome, pick, found, play, three, own, end, free.
export function stepKind(step) {
  if (step === 1) return 'welcome';
  if (step === THREE_STEP) return 'three';
  if (step === OWN_STEP) return 'own';
  if (step === LAST_STEP) return 'end';
  if (step >= FREE_PLAY) return 'free';
  const slot = slotOf(step);
  if (slot < 0) return 'free';
  return ['pick', 'found', 'play'][step - PICK_STEPS[slot]];
}

const PICK_WHY = ['Pick a room to continue', 'Pick a second room to continue', 'Pick a third room to continue'];
const FINISH_WHY = 'Finish a round, win or lose, to continue';

export function canForward(road) {
  const s = road.step;
  if (s >= FREE_PLAY) return { ok: false, why: 'This is the end of the road' };
  if (s === 1 && !road.consent) return { ok: false, why: 'Agree on this screen to continue' };
  const slot = slotOf(s);
  if (slot >= 0 && slot < SAMPLE_SLOTS) {
    const at = s - PICK_STEPS[slot];
    if (at === 0 && !road.rooms[slot]) return { ok: false, why: PICK_WHY[slot] };
    if (at === 2 && !road.finished[slot]) return { ok: false, why: FINISH_WHY };
  }
  if (s === OWN_STEP && !road.rooms[OWN_SLOT] && road.own !== 'skipped') return { ok: false, why: 'Choose a photo, or continue to the end' };
  if (s === OWN_STEP + 1 && marking(road)) return { ok: false, why: 'Make the room from your marks to go on' };
  if (s === OWN_STEP + 2 && !road.finished[OWN_SLOT]) return { ok: false, why: FINISH_WHY };
  return { ok: true, why: '' };
}

export function canBack(road) {
  return road.step > 1;
}

function go(road, step) {
  return { ...road, step, reached: Math.max(road.reached, step) };
}

// The sample room the road plays next in a sample slot: the first in the
// road's order that no other sample slot holds.
export function nextSample(road, slot) {
  const held = new Set(road.rooms.slice(0, SAMPLE_SLOTS).filter((r, k) => k !== slot && r && r.kind === 'sample').map((r) => r.id));
  const id = SAMPLE_ORDER.find((x) => !held.has(x)) || SAMPLE_ORDER[slot];
  return { kind: 'sample', id };
}

// A sample slot with no room yet gets the next sample room (its round not
// played yet). Slots that hold a room keep it.
function prefill(road, slot) {
  if (slot < 0 || slot >= SAMPLE_SLOTS || road.rooms[slot]) return road;
  const rooms = road.rooms.slice();
  rooms[slot] = nextSample(road, slot);
  return { ...road, rooms };
}

export function forward(road) {
  if (!canForward(road).ok) return road;
  if (road.step === OWN_STEP && road.own === 'skipped') return go(road, AFTER_OWN);
  const next = road.step + 1;
  // a sample room's pick step comes with the next room already chosen
  const slot = slotOf(next);
  const r = stepKind(next) === 'pick' && slot > 0 ? prefill(road, slot) : road;
  return go(r, next);
}

export function back(road) {
  if (!canBack(road)) return road;
  if (road.step === AFTER_OWN && road.own === 'skipped') return { ...road, step: OWN_STEP };
  return { ...road, step: road.step - 1 };
}

// Primary actions. Each one moves forward.
export function giveConsent(road) {
  if (road.step !== 1) return road;
  return go({ ...road, consent: true }, 2);
}

// A room picked on its step. A room another sample slot already holds (a
// sample room, or our kitchen) trades places with this slot's room (each
// keeps its own results), so every room stays pickable and no room is on
// the road twice.
export function chooseRoom(road, slot, ref) {
  const step = PICK_STEPS[slot];
  if (step == null || road.step !== step) return road;
  const rooms = road.rooms.slice();
  const finished = road.finished.slice();
  const best = road.best.slice();
  // a room marked again from scratch starts its results again too
  const same = rooms[slot] && sameRef(rooms[slot], ref) && !(ref.kind === 'marked' && !ref.made);
  const j = !same && slot < SAMPLE_SLOTS && ref.kind !== 'marked'
    ? rooms.findIndex((r, k) => k !== slot && k < SAMPLE_SLOTS && sameRef(r, ref)) : -1;
  if (j >= 0) {
    // the two slots trade rooms, each room with its own results
    [rooms[j], finished[j], best[j]] = [rooms[slot], rooms[slot] ? finished[slot] : false, rooms[slot] ? best[slot] : null];
    [rooms[slot], finished[slot], best[slot]] = [ref, road.finished[j], road.best[j]];
    return go({ ...road, rooms, finished, best }, step + 1);
  }
  rooms[slot] = ref;
  if (!same) {
    finished[slot] = false;
    best[slot] = null;
  }
  const own = slot === OWN_SLOT ? null : road.own;
  return go({ ...road, own, rooms, finished, best }, step + 1);
}

// Your own room counts as made whenever its slot holds a room. 'skipped'
// is only a routing flag (Forward and Back pass its reveal and play steps);
// it never means "not made".
// A room marked by hand counts only once it was made from its marks.
export function ownMade(road) {
  return !!road.rooms[OWN_SLOT] && !marking(road);
}

// Your own room is on the road as marks not made into a room yet.
export function marking(road) {
  const r = road.rooms[OWN_SLOT];
  return !!r && r.kind === 'marked' && !r.made;
}

// The room is made from its marks, on Step 13 or, in place, on Step 14: the
// step stays, and its results start again (a new level, a new round).
export function makeMarked(road) {
  const r = road.rooms[OWN_SLOT];
  if (!r || r.kind !== 'marked' || road.step < OWN_STEP + 1 || road.step > OWN_STEP + 2) return road;
  const rooms = road.rooms.slice();
  const finished = road.finished.slice();
  const best = road.best.slice();
  rooms[OWN_SLOT] = { kind: 'marked', sha256: r.sha256, made: true };
  finished[OWN_SLOT] = false;
  best[OWN_SLOT] = null;
  return { ...road, rooms, finished, best };
}

// Continue to the end, from your own room's steps (12, 13 or 14). A room
// made and played stays on the road, and Back walks home through it; a
// room not made (anyone may pass it by) or not played yet is passed by,
// straight on past its reveal and play steps.
export function passOwnRoom(road) {
  if (road.step < OWN_STEP || road.step > OWN_STEP + 2) return road;
  if (ownMade(road) && road.finished[OWN_SLOT]) return go(road, AFTER_OWN);
  return go({ ...road, own: 'skipped' }, AFTER_OWN);
}
export const skipOwnRoom = passOwnRoom;

export function startPlay(road) {
  if (stepKind(road.step) !== 'found') return road;
  return go(road, road.step + 1);
}

export function finishRound(road, slot, result) {
  const finished = road.finished.slice();
  const best = road.best.slice();
  if (slot >= 0) {
    finished[slot] = true;
    if (result && result.status === 'won' && result.ratio != null) {
      best[slot] = best[slot] == null ? result.ratio : Math.min(best[slot], result.ratio);
    }
  }
  return { ...road, finished, best };
}

// After a round on a play step, the end card's primary moves on: from the
// first and second sample rooms straight to the next room's reveal (its
// pick step passed, the next room chosen there unless one already is);
// from the third, on to Your three rooms; from your own room, to the end.
export function continueAfterRound(road) {
  if (stepKind(road.step) !== 'play' || !canForward(road).ok) return road;
  const slot = slotOf(road.step);
  if (slot >= 0 && slot < SAMPLE_SLOTS - 1) {
    const r = prefill(go(road, PICK_STEPS[slot + 1]), slot + 1);
    return go(r, PICK_STEPS[slot + 1] + 1);
  }
  return forward(road);
}

// From Your three rooms on to Your own room.
export function toOwnRoom(road) {
  if (road.step !== THREE_STEP) return road;
  return forward(road);
}

export function startFreePlay(road) {
  if (road.step !== LAST_STEP) return road;
  return go(road, FREE_PLAY);
}

// The browser's Back and Forward: walk the road toward a step, one step at
// a time, never past a step that is not allowed yet.
export function towardStep(road, step) {
  let r = road;
  while (r.step > step && canBack(r)) r = back(r);
  while (r.step < step && canForward(r).ok) {
    const n = forward(r);
    if (n.step > step) break;
    r = n;
  }
  return r;
}

export function sameRef(a, b) {
  return !!a && !!b && a.kind === b.kind && (a.kind === 'photo' || a.kind === 'marked' ? a.sha256 === b.sha256 : a.id === b.id);
}

export function counterText(road) {
  if (road.step >= FREE_PLAY) return 'Free play';
  return `Step ${road.step} of ${LAST_STEP}: ${stepName(road, road.step)}`;
}

// A sample room drawn by code is never headed as what the AI found.
export const SAMPLE_FOUND = 'What is in this room';

// A step's name on this road: a room marked by hand shows its marks, and a
// sample room what is in it, where a read room shows what the AI found.
export function stepName(road, step) {
  const r = road.rooms && road.rooms[OWN_SLOT];
  if (step === OWN_STEP + 1 && r && r.kind === 'marked') return 'Your marks';
  const slot = slotOf(step);
  const room = road.rooms && slot >= 0 ? road.rooms[slot] : null;
  if (stepKind(step) === 'found' && room && room.kind === 'sample') return SAMPLE_FOUND;
  return STEP_NAMES[step];
}

export function lapText(road) {
  if (road.step <= 4) return 'One photo, one room';
  if (road.step <= 7) return 'A second room';
  if (road.step <= 10) return 'A third room';
  if (road.step === THREE_STEP) return 'Three rooms';
  if (road.step <= OWN_STEP + 2) return 'Your own room';
  if (road.step === LAST_STEP) return 'Circuit complete';
  return 'Free play';
}

export function primaryLabel(road) {
  switch (road.step) {
    case 1: return 'I am 18 or over and I understand. Continue';
    case 3: case 6: case 9: case OWN_STEP + 1: return 'Play this room';
    case 4: return 'Continue: the second room';
    case 7: return 'Continue: the third room';
    case 10: return 'Continue: your three rooms';
    case THREE_STEP: return 'Continue: your own room';
    case OWN_STEP: return 'Continue to the end';
    case OWN_STEP + 2: return 'Continue: the end';
    case LAST_STEP: return 'Free play';
    default: return null;
  }
}

// A road saved by an earlier version of the page, read onto this road.
// Version 3 had 12 steps: two sample rooms (Steps 2 to 7), Your two rooms
// (8), your own room (9 to 11), the end (12), Free play (13); version 2 the
// same steps without your own room. Their two sample rooms stay the first
// two, the third sample room is new (not chosen, not played), and their own
// room is your own room here.
const OLD_STEP = (s) => (s <= 7 ? s : s === 8 ? THREE_STEP : s <= 11 ? s + 3 : s === 12 ? LAST_STEP : FREE_PLAY);

// A road read back from the device: anything damaged or foreign is dropped.
// A step is kept only as far as the road leading to it holds: a road from
// an earlier version stops where it meets a room it has not played yet
// (the third sample room, chosen for it there).
export function sanitizeRoad(o) {
  if (!o || typeof o !== 'object' || ![2, 3, ROAD_VERSION].includes(o.v)) return null;
  const old = o.v !== ROAD_VERSION;
  const last = old ? 13 : FREE_PLAY;
  const raw = Number.isInteger(o.step) && o.step >= 1 && o.step <= last ? o.step : null;
  if (!raw) return null;
  const step = old ? OLD_STEP(raw) : raw;
  const plainRef = (r) => {
    if (!r || typeof r !== 'object') return null;
    if ((r.kind === 'sample' || r.kind === 'rehearsal') && typeof r.id === 'string' && /^[a-z0-9_-]{1,32}$/.test(r.id)) return { kind: r.kind, id: r.id };
    if (r.kind === 'photo' && typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256)) return { kind: 'photo', sha256: r.sha256 };
    return null;
  };
  // our kitchen's replay in any slot
  const ref = (r) => {
    if (r && typeof r === 'object' && r.kind === 'replay' && r.id === 'kitchen') return { kind: 'replay', id: 'kitchen' };
    return plainRef(r);
  };
  // a marked room only in your own room's slot
  const ownRef = (r) => {
    if (r && typeof r === 'object' && r.kind === 'marked' && typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256)) return { kind: 'marked', sha256: r.sha256, made: r.made === true };
    return ref(r);
  };
  const at = (list, k, f) => f(Array.isArray(list) ? list[k] : undefined);
  // where each slot of this road is found in the saved one, or -1
  const from = o.v === 2 ? [0, 1, -1, -1] : old ? [0, 1, -1, 2] : [0, 1, 2, 3];
  const pick = (list, f, none) => from.map((k, slot) => (k < 0 ? none : at(list, k, slot === OWN_SLOT ? (f === ref ? ownRef : f) : f)));
  const rooms = pick(o.rooms, ref, null);
  const finished = pick(o.finished, (v) => !!v, false);
  const reached = Number.isInteger(o.reached) && o.reached >= 1 && o.reached <= last ? (old ? OLD_STEP(o.reached) : o.reached) : step;
  const road = {
    v: ROAD_VERSION,
    step,
    reached: Math.min(Math.max(reached, step), FREE_PLAY),
    consent: o.consent === true,
    // a room made and played is never passed by (roads saved before this
    // rule heal here)
    own: o.v !== 2 && o.own === 'skipped' && !(ownMade({ rooms }) && finished[OWN_SLOT]) ? 'skipped' : null,
    rooms,
    finished,
    best: pick(o.best, num, null),
  };
  // a step is only valid if the road leading to it holds (the walk may
  // choose the next sample room on a pick step it passes, as Forward does)
  let probe = { ...road, step: 1 };
  while (probe.step < road.step) {
    const n = forward(probe);
    if (n.step === probe.step || n.step > road.step) break;
    probe = n;
  }
  return { ...road, rooms: probe.rooms, step: probe.step };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v < 100 ? v : null;
}
