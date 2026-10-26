// The road: one road of 12 steps and one counter, then Free play. Two
// sample rooms, the two side by side, your own room, then the closing
// screen that says the circuit is complete. Back moves one
// step left; Forward one step right, only when allowed, and it says why when
// it waits. Primary buttons only ever move forward. Pure logic.
//
// Your own room may be passed by (in MOCK it cannot be made at all):
// Forward from its step then goes straight past its reveal and play steps,
// and Back from there comes straight home to it. A room made and played is
// never passed by: Continue to the end keeps it on the road.

export const STEP_NAMES = [
  null,
  'Welcome',
  'Your room',
  'What the AI found',
  'Play',
  'Another room',
  'What the AI found',
  'Play',
  'Your two rooms',
  'Your own room',
  'What the AI found',
  'Play',
  'The end',
  'Free play',
];
export const OWN_STEP = 9;
export const LAST_STEP = 12;
export const FREE_PLAY = 13;
// where the road goes on after your own room, made or skipped
export const AFTER_OWN = OWN_STEP + 3;
// the step on which each room slot is picked
export const PICK_STEPS = [2, 5, OWN_STEP];
export const SLOTS = PICK_STEPS.length;

export function newRoad() {
  return {
    v: 3, step: 1, reached: 1, consent: false, own: null,
    rooms: [null, null, null], finished: [false, false, false], best: [null, null, null],
  };
}

// Which room slot a step belongs to (0, 1 or 2), or -1.
export function slotOf(step) {
  const k = PICK_STEPS.findIndex((p) => step >= p && step <= p + 2);
  return k;
}

// What a step shows: welcome, pick, found, play, two, own, end, free.
export function stepKind(step) {
  if (step === 1) return 'welcome';
  if (step === 8) return 'two';
  if (step === OWN_STEP) return 'own';
  if (step === LAST_STEP) return 'end';
  if (step >= FREE_PLAY) return 'free';
  const slot = slotOf(step);
  if (slot < 0) return 'free';
  return ['pick', 'found', 'play'][step - PICK_STEPS[slot]];
}

export function canForward(road) {
  const s = road.step;
  if (s >= FREE_PLAY) return { ok: false, why: 'This is the end of the road' };
  if (s === 1 && !road.consent) return { ok: false, why: 'Agree on this screen to continue' };
  if (s === 2 && !road.rooms[0]) return { ok: false, why: 'Pick a room to continue' };
  if (s === 4 && !road.finished[0]) return { ok: false, why: 'Finish a round, win or lose, to continue' };
  if (s === 5 && !road.rooms[1]) return { ok: false, why: 'Pick a second room to continue' };
  if (s === 7 && !road.finished[1]) return { ok: false, why: 'Finish a round, win or lose, to continue' };
  if (s === OWN_STEP && !road.rooms[2] && road.own !== 'skipped') return { ok: false, why: 'Choose a photo, or continue to the end' };
  if (s === OWN_STEP + 2 && !road.finished[2]) return { ok: false, why: 'Finish a round, win or lose, to continue' };
  return { ok: true, why: '' };
}

export function canBack(road) {
  return road.step > 1;
}

function go(road, step) {
  return { ...road, step, reached: Math.max(road.reached, step) };
}

export function forward(road) {
  if (!canForward(road).ok) return road;
  if (road.step === OWN_STEP && road.own === 'skipped') return go(road, AFTER_OWN);
  return go(road, road.step + 1);
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

export function chooseRoom(road, slot, ref) {
  const step = PICK_STEPS[slot];
  if (step == null || road.step !== step) return road;
  const rooms = road.rooms.slice();
  const finished = road.finished.slice();
  const best = road.best.slice();
  const same = rooms[slot] && sameRef(rooms[slot], ref);
  rooms[slot] = ref;
  if (!same) {
    finished[slot] = false;
    best[slot] = null;
  }
  const own = slot === 2 ? null : road.own;
  return go({ ...road, own, rooms, finished, best }, step + 1);
}

// Your own room counts as made whenever its slot holds a room. 'skipped'
// is only a routing flag (Forward and Back pass its reveal and play steps);
// it never means "not made".
export function ownMade(road) {
  return !!road.rooms[2];
}

// Continue to the end, from your own room's steps (9, 10 or 11). A room
// made and played stays on the road, and Back walks home through it; a
// room not made (MOCK cannot make one; anyone may pass it by) or not played
// yet is passed by, straight on past its reveal and play steps.
export function passOwnRoom(road) {
  if (road.step < OWN_STEP || road.step > OWN_STEP + 2) return road;
  if (road.rooms[2] && road.finished[2]) return go(road, AFTER_OWN);
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

// After a round on a play step, the end card's primary moves on.
export function continueAfterRound(road) {
  if (stepKind(road.step) === 'play') return forward(road);
  return road;
}

// From Your two rooms on to Your own room.
export function toOwnRoom(road) {
  if (road.step !== 8) return road;
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
  return !!a && !!b && a.kind === b.kind && (a.kind === 'photo' ? a.sha256 === b.sha256 : a.id === b.id);
}

export function counterText(road) {
  if (road.step >= FREE_PLAY) return 'Free play';
  return `Step ${road.step} of ${LAST_STEP}: ${STEP_NAMES[road.step]}`;
}

export function lapText(road) {
  if (road.step <= 4) return 'One photo, one room';
  if (road.step <= 7) return 'A second room';
  if (road.step === 8) return 'Two rooms';
  if (road.step <= OWN_STEP + 2) return 'Your own room';
  if (road.step === LAST_STEP) return 'Circuit complete';
  return 'Free play';
}

export function primaryLabel(road) {
  switch (road.step) {
    case 1: return 'I am 18 or over and I understand. Continue';
    case 3: case 6: case OWN_STEP + 1: return 'Play this room';
    case 4: return 'Continue: another room';
    case 7: return 'Continue: your two rooms';
    case 8: return 'Continue: your own room';
    case OWN_STEP: return 'Continue to the end';
    case OWN_STEP + 2: return 'Continue: the end';
    case LAST_STEP: return 'Free play';
    default: return null;
  }
}

// A road read back from the device: anything damaged or foreign is dropped.
// A road from before your own room (v 2) is read with that room not yet made.
export function sanitizeRoad(o) {
  if (!o || typeof o !== 'object' || (o.v !== 2 && o.v !== 3)) return null;
  const step = Number.isInteger(o.step) && o.step >= 1 && o.step <= FREE_PLAY ? o.step : null;
  if (!step) return null;
  const ref = (r) => {
    if (!r || typeof r !== 'object') return null;
    if ((r.kind === 'sample' || r.kind === 'rehearsal') && typeof r.id === 'string' && /^[a-z0-9_-]{1,32}$/.test(r.id)) return { kind: r.kind, id: r.id };
    if (r.kind === 'photo' && typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256)) return { kind: 'photo', sha256: r.sha256 };
    return null;
  };
  const at = (list, k, f) => f(Array.isArray(list) ? list[k] : undefined);
  const slots = [0, 1, 2];
  const rooms = slots.map((k) => (o.v === 2 && k === 2 ? null : at(o.rooms, k, ref)));
  const finished = slots.map((k) => (o.v === 2 && k === 2 ? false : at(o.finished, k, (v) => !!v)));
  const road = {
    v: 3,
    step,
    reached: Number.isInteger(o.reached) ? Math.min(Math.max(o.reached, step), FREE_PLAY) : step,
    consent: o.consent === true,
    // a room made and played is never passed by (roads saved before this
    // rule heal here)
    own: o.v === 3 && o.own === 'skipped' && !(rooms[2] && finished[2]) ? 'skipped' : null,
    rooms,
    finished,
    best: slots.map((k) => (o.v === 2 && k === 2 ? null : at(o.best, k, num))),
  };
  // a step is only valid if the road leading to it holds
  let probe = { ...road, step: 1 };
  while (probe.step < road.step) {
    const n = forward(probe);
    if (n.step === probe.step || n.step > road.step) break;
    probe = n;
  }
  road.step = probe.step;
  return road;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v < 100 ? v : null;
}
