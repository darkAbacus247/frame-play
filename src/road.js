// The road: one road of 8 steps and one counter, then Free play. Back moves
// one step left; Forward one step right, only when allowed, and it says why
// when it waits. Primary buttons only ever move forward. Pure logic.

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
  'Free play',
];
export const LAST_STEP = 8;
export const FREE_PLAY = 9;

export function newRoad() {
  return { v: 2, step: 1, reached: 1, consent: false, rooms: [null, null], finished: [false, false], best: [null, null] };
}

// Which room slot a step belongs to (0 or 1), or -1.
export function slotOf(step) {
  if (step >= 2 && step <= 4) return 0;
  if (step >= 5 && step <= 7) return 1;
  return -1;
}

export function canForward(road) {
  const s = road.step;
  if (s >= FREE_PLAY) return { ok: false, why: 'This is the end of the road' };
  if (s === 1 && !road.consent) return { ok: false, why: 'Agree on this screen to continue' };
  if (s === 2 && !road.rooms[0]) return { ok: false, why: 'Pick a room to continue' };
  if (s === 4 && !road.finished[0]) return { ok: false, why: 'Finish a round, win or lose, to continue' };
  if (s === 5 && !road.rooms[1]) return { ok: false, why: 'Pick a second room to continue' };
  if (s === 7 && !road.finished[1]) return { ok: false, why: 'Finish a round, win or lose, to continue' };
  return { ok: true, why: '' };
}

export function canBack(road) {
  return road.step > 1;
}

function go(road, step) {
  return { ...road, step, reached: Math.max(road.reached, step) };
}

export function forward(road) {
  return canForward(road).ok ? go(road, road.step + 1) : road;
}

export function back(road) {
  return canBack(road) ? { ...road, step: road.step - 1 } : road;
}

// Primary actions. Each one moves exactly one step forward.
export function giveConsent(road) {
  if (road.step !== 1) return road;
  return go({ ...road, consent: true }, 2);
}

export function chooseRoom(road, slot, ref) {
  const step = slot === 0 ? 2 : 5;
  if (road.step !== step) return road;
  const rooms = road.rooms.slice();
  const finished = road.finished.slice();
  const best = road.best.slice();
  const same = rooms[slot] && sameRef(rooms[slot], ref);
  rooms[slot] = ref;
  if (!same) {
    finished[slot] = false;
    best[slot] = null;
  }
  return go({ ...road, rooms, finished, best }, step + 1);
}

export function startPlay(road) {
  if (road.step !== 3 && road.step !== 6) return road;
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

// After a round on step 4 or 7, the end card's primary moves on.
export function continueAfterRound(road) {
  if (road.step === 4 || road.step === 7) return forward(road);
  return road;
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
  while (r.step < step && canForward(r).ok) r = forward(r);
  return r;
}

export function sameRef(a, b) {
  return !!a && !!b && a.kind === b.kind && (a.kind === 'sample' ? a.id === b.id : a.sha256 === b.sha256);
}

export function counterText(road) {
  if (road.step >= FREE_PLAY) return 'Free play';
  return `Step ${road.step} of ${LAST_STEP}: ${STEP_NAMES[road.step]}`;
}

export function lapText(road) {
  if (road.step <= 4) return 'One photo, one room';
  if (road.step <= 7) return 'A second room';
  return 'Two rooms';
}

export function primaryLabel(road) {
  switch (road.step) {
    case 1: return 'I am 18 or over and I understand. Continue';
    case 3: case 6: return 'Play this room';
    case 4: return 'Continue: another room';
    case 7: return 'Continue: your two rooms';
    case 8: return 'Free play';
    default: return null;
  }
}

// A road read back from the device: anything damaged or foreign is dropped.
export function sanitizeRoad(o) {
  if (!o || typeof o !== 'object' || o.v !== 2) return null;
  const step = Number.isInteger(o.step) && o.step >= 1 && o.step <= FREE_PLAY ? o.step : null;
  if (!step) return null;
  const ref = (r) => {
    if (!r || typeof r !== 'object') return null;
    if (r.kind === 'sample' && typeof r.id === 'string' && /^[a-z0-9_-]{1,32}$/.test(r.id)) return { kind: 'sample', id: r.id };
    if (r.kind === 'photo' && typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256)) return { kind: 'photo', sha256: r.sha256 };
    return null;
  };
  const road = {
    v: 2,
    step,
    reached: Number.isInteger(o.reached) ? Math.min(Math.max(o.reached, step), FREE_PLAY) : step,
    consent: o.consent === true,
    rooms: [ref(o.rooms && o.rooms[0]), ref(o.rooms && o.rooms[1])],
    finished: [!!(o.finished && o.finished[0]), !!(o.finished && o.finished[1])],
    best: [num(o.best && o.best[0]), num(o.best && o.best[1])],
  };
  // a step is only valid if the road leading to it holds
  let s = 1;
  let probe = { ...road, step: 1 };
  while (s < road.step && canForward(probe).ok) { s++; probe = { ...probe, step: s }; }
  road.step = s;
  return road;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v < 100 ? v : null;
}
