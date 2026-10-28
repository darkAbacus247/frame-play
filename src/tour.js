// The opt-in tour: one plain line and one lit control for every road
// state, the once-per-visit offer after about 45 s without progress, and
// the one-time pulse. Pure logic; the page draws the veil and the strip.
import { FREE_PLAY, OWN_STEP } from './road.js';

export const OFFER_AFTER_MS = 45000;

const LINES = {
  1: { target: 'primary', line: 'Read the words, then press the Continue button to agree.' },
  2: { target: 'room-card', line: 'Pick a room to play: press one of the room cards.' },
  3: { target: 'primary', line: 'These outlines show what is in this room. Press Play this room.' },
  4: { target: 'chip', line: 'Press a Walk to button or tap the picture. Collect every star, then reach the exit.' },
  5: { target: 'primary', line: 'The next room is chosen for you. Go on with it, or pick another room.' },
  6: { target: 'primary', line: 'A new room makes new walls. Press Play this room.' },
  7: { target: 'chip', line: 'Same rules, new shapes: collect every star, then reach the exit.' },
  8: { target: 'primary', line: 'The third room is chosen for you. Go on with it, or pick another room.' },
  9: { target: 'primary', line: 'A third room, with its own walls. Press Play this room.' },
  10: { target: 'chip', line: 'The third room: collect every star, then reach the exit.' },
  11: { target: 'primary', line: 'Your three rooms, side by side. Press Continue: your own room.' },
  12: { target: 'primary', line: 'Try a photo of your own room, use ours, or continue to the end.' },
  13: { target: 'primary', line: 'These outlines come from a photo of a real room. Press Play this room.' },
  14: { target: 'chip', line: 'Your own room: collect every star, then reach the exit.' },
  15: { target: 'primary', line: 'You have completed the road. Press Free play, or play a room again.' },
  [FREE_PLAY]: { target: 'room-card', line: 'Free play: pick any room to play it again.' },
};

// Your own room marked by hand: its Step 13 is the marking board, then the
// room made from the marks.
const MARKED = {
  marking: { target: 'primary', line: 'Pick what a box is, drag one over each object, then press Make the room.' },
  made: { target: 'primary', line: 'Code traced these outlines inside your boxes. Press Play this room.' },
};

// own: 'marking' or 'made' while your own room is marked by hand, or null
export function tourStep(step, own = null) {
  if (step === OWN_STEP + 1 && MARKED[own]) return MARKED[own];
  return LINES[step] || null;
}

export function allTourSteps() {
  return Object.keys(LINES).map(Number);
}

// The small offer appears once per visit, after OFFER_AFTER_MS without
// progress, never while the tour runs or a card is up, and not again on a
// step where it did not fit (step, notOn).
export function offerDue({ now, lastProgress, offered, tourOn, cardOpen, step = 0, notOn = null }) {
  return !offered && !tourOn && !cardOpen && step !== notOn && now - lastProgress >= OFFER_AFTER_MS;
}

// The offer takes its height from main (the page grid's tour row). It may
// stay only if main and any bar body still fit without scrolling, measured
// in whole pixels the moment it is drawn; otherwise it is taken back before
// it is painted and offered again on a later step.
export function offerFits({ scrollH, clientH, barsOver = false }) {
  return scrollH <= clientH && !barsOver;
}

// The veil: four rectangles around the lit control (grown by a margin),
// covering the rest of a W by H area exactly once. Rectangles are
// [x, y, w, h], all clipped to the area.
export function veilRects(W, H, ctrl, margin = 6) {
  const cl = (v, hi) => Math.max(0, Math.min(hi, v));
  const l = cl(ctrl.left - margin, W), r = cl(ctrl.right + margin, W);
  const t = cl(ctrl.top - margin, H), b = cl(ctrl.bottom + margin, H);
  return [
    [0, 0, W, t],
    [0, b, W, H - b],
    [0, t, l, b - t],
    [r, t, W - r, b - t],
  ].filter(([, , w, h]) => w > 0 && h > 0);
}

// Take the tour pulses once on the first visit, never with reduced motion.
export function shouldPulse({ firstVisit, reducedMotion }) {
  return !!firstVisit && !reducedMotion;
}
