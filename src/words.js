// Every word the game says: the rule row, announcements for the live
// region, Describe this room, and the end cards. Pure logic.
import { objectWords, footDistance } from './level.js';

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const ROLE_WORDS = {
  collect: 'collect it',
  avoid: 'avoid it',
  exit: 'the exit',
  solid: 'solid: walk around it',
  flat: 'flat: walk over it',
};

export function exitIndex(level) {
  return level.objects.findIndex((o) => o.role === 'exit');
}

// The fixed-height line under the picture.
export function ruleRow(level, state) {
  const total = level.objects.filter((o) => o.role === 'collect').length;
  const got = level.objects.filter((o, k) => o.role === 'collect' && state.collected[k]).length;
  const avoid = level.objects.map((o, k) => (o.role === 'avoid' ? objectWords(level, k) : null)).filter(Boolean);
  const ex = exitIndex(level);
  const parts = [`Collected ${got} of ${total}`];
  if (avoid.length) parts.push(`Avoid: ${avoid.join(', ')}`);
  if (ex >= 0) parts.push(`${cap(objectWords(level, ex))}: ${state.doorOpen ? 'open' : 'locked'}`);
  return parts.join(' · ');
}

// One announcement per event that matters; never a stream of steps.
export function announce(level, ev, surfaceName) {
  switch (ev.type) {
    case 'collect': {
      const name = cap(objectWords(level, ev.k));
      return ev.left ? `${name} collected. ${ev.left} left.` : `${name} collected. That was the last one.`;
    }
    case 'unlock': {
      const ex = exitIndex(level);
      return `The ${objectWords(level, ex)} is open.`;
    }
    case 'locked': return `Locked: collect ${ev.left} more.`;
    case 'bump': return ev.k >= 0 ? `Blocked by the ${objectWords(level, ev.k)}` : `Blocked by the edge of the ${surfaceName || 'floor'}`;
    case 'lose': return `The ${objectWords(level, ev.k)} got you.`;
    case 'win': return 'Room cleared!';
    default: return null;
  }
}

function where(level, rt, x, y) {
  const W = level.picture.width, H = level.picture.height;
  const side = x < W / 3 ? 'on the left' : x > (2 * W) / 3 ? 'on the right' : 'in the centre';
  const top = rt ? rt.horizon : H * 0.4;
  const t = (y - top) / Math.max(1, H - top);
  const depth = t < 1 / 3 ? 'far' : t > 2 / 3 ? 'near' : 'middle';
  return `${depth}, ${side}`;
}

// Describe this room: the surface, then each object with its role, where it
// is and how many steps away, and the exit's state.
export function describeRoom(level, rt, state, pathSteps) {
  const lines = [];
  const surface = level.surface ? level.surface.name : 'floor';
  lines.push(`${level.title || 'This room'}. You walk on the ${surface}.`);
  level.objects.forEach((o, k) => {
    const words = objectWords(level, k);
    const box = o.box || [0, 0, 0, 0];
    const x = (box[0] + box[2]) / 2, y = o.baseline_y ?? box[3];
    if (!o.on_surface) {
      lines.push(`${cap(words)}: scenery, out of reach.`);
      return;
    }
    let role = ROLE_WORDS[o.role];
    if (o.role === 'collect' && state && state.collected[k]) role = 'collected';
    if (o.role === 'exit') role = state && state.doorOpen ? 'the exit, open' : 'the exit, locked';
    let steps = '';
    if (pathSteps && pathSteps[k] != null) steps = `, ${pathSteps[k]} steps away`;
    lines.push(`${cap(words)}: ${role}; ${where(level, rt, x, y)}${steps}.`);
  });
  return lines;
}

// How many steps (strides of 0.03 L) from a point to touch each object.
export function stepsAway(level, rt, x, y) {
  const L = Math.max(level.picture.width, level.picture.height);
  return level.objects.map((o, k) => {
    const t = rt.objs[k];
    if (!t.footprint) return null;
    const d = Math.max(0, footDistance(t.footprint, x, y) - rt.p.touch);
    return Math.round(d / (0.03 * L));
  });
}

export function endCardWords(level, state, ratio) {
  if (state.status === 'won') {
    const route = ratio == null ? '' : ratio <= 1.05 ? 'You took the shortest route.' : `Your route: ${ratio.toFixed(1)} times the shortest.`;
    return { title: 'Room cleared!', body: route };
  }
  const k = state.lostTo;
  return { title: k >= 0 ? `The ${objectWords(level, k)} got you.` : 'The round is over.', body: 'That round counts: win or lose, you can go on.' };
}
