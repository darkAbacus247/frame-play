// Roads as the page saves them (src/road.js, version 4), for the tests
// that boot the page on a step: the three sample rooms in the road's
// order, then your own room.
import { OWN_STEP, LAST_STEP } from '../src/road.js';

export const DESK = { kind: 'sample', id: 'desk' };
export const LIVING = { kind: 'sample', id: 'living' };
export const APARTMENT = { kind: 'sample', id: 'apartment' };
export const SAMPLE_ROOMS = [DESK, LIVING, APARTMENT];

export function roadAt(step, { rooms = [null, null, null, null], finished = [false, false, false, false], best = [null, null, null, null], own = null } = {}) {
  return { v: 4, step, reached: step, consent: true, own, rooms, finished, best };
}

// Step 12, Your own room: the three sample rooms played (the first won at 1.24)
export const AT_OWN = roadAt(OWN_STEP, { rooms: [...SAMPLE_ROOMS, null], finished: [true, true, true, false], best: [1.24, null, null, null] });
// Step 15, The end, your own room passed by
export const AT_END = roadAt(LAST_STEP, { rooms: [...SAMPLE_ROOMS, null], finished: [true, true, true, false], best: [1.24, null, null, null], own: 'skipped' });
