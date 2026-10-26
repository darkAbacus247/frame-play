// The opt-in tour: one plain line and one lit control for every road
// state, the once-per-visit offer after about 45 s without progress, and
// the one-time pulse. Pure logic; the page draws the veil and the strip.
import { FREE_PLAY } from './road.js';

export const OFFER_AFTER_MS = 45000;

const LINES = {
  1: { target: 'primary', line: 'Read the words, then press the Continue button to agree.' },
  2: { target: 'room-card', line: 'Pick a room to play: press one of the room cards.' },
  3: { target: 'primary', line: 'These outlines are what the AI found. Press Play this room.' },
  4: { target: 'chip', line: 'Press a Walk to button or tap the picture. Collect every star, then reach the exit.' },
  5: { target: 'room-card', line: 'Pick a second room, different from the first.' },
  6: { target: 'primary', line: 'A new room makes new walls. Press Play this room.' },
  7: { target: 'chip', line: 'Same rules, new shapes: collect every star, then reach the exit.' },
  8: { target: 'primary', line: 'Your two rooms, side by side. Press Free play to keep playing.' },
  [FREE_PLAY]: { target: 'room-card', line: 'Free play: pick any room to play it again.' },
};

export function tourStep(step) {
  return LINES[step] || null;
}

export function allTourSteps() {
  return Object.keys(LINES).map(Number);
}

// The small offer appears once per visit, after OFFER_AFTER_MS without
// progress, never while the tour runs or a card is up.
export function offerDue({ now, lastProgress, offered, tourOn, cardOpen }) {
  return !offered && !tourOn && !cardOpen && now - lastProgress >= OFFER_AFTER_MS;
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
