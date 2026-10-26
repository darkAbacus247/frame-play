// Screens built from plain data, so their words and their fit are tested
// in Node (tests/closing.test.js, tests/layout.test.js). The page hands in
// what to show and what each button does; nothing here fetches or draws.
import { el } from './ui.js';
import { OWN_STEP } from './road.js';

// ---- the closing screen ----
// Each room on the road, with one line of what happened and one sentence
// of what the AI did. `levels` holds the three rooms' levels (null when not
// made or not in memory), `summaries` the live reads' summaries.
export function closingRooms({ road, levels, summaries = [], mode }) {
  return [0, 1, 2].map((slot) => {
    const level = levels[slot] || null;
    const ref = road.rooms[slot] || null;
    const heading = ['First room', 'Second room', 'Your own room'][slot];
    if (slot === 2 && (!ref || road.own === 'skipped')) {
      return {
        slot, heading, title: null, ref: null, playable: false,
        result: 'Not made',
        ai: mode === 'live' || mode === 'rehearsal'
          ? 'No room was made from a photo of your own this time.'
          : 'Reading a real photo needs the live AI (Meta’s models); this copy runs without it, so no model was called and nothing was invented.',
      };
    }
    return {
      slot, heading, ref, playable: !!level,
      title: level ? level.title : null,
      result: resultLine(road, slot),
      ai: level ? aiLine(level, summaries[slot]) : `Its level is not in memory on this visit; pick the same photo again on Step ${OWN_STEP} to see it.`,
    };
  });
}

export function resultLine(road, slot) {
  const best = road.best[slot];
  if (best != null) return best <= 1.05 ? 'Won · by the shortest route' : `Won · best route ${best.toFixed(1)} times the shortest`;
  if (road.finished[slot]) return 'Lost · not won yet';
  return 'Not played yet';
}

export function aiLine(level, summary) {
  const n = level.objects.length;
  const things = (k) => `${k} ${k === 1 ? 'thing' : 'things'}`;
  if (level.origin === 'mock') return 'Sample room drawn by code; no model was called.';
  if (level.origin === 'rehearsal') return `The local stand-in (not Meta) answered for its sample picture; code traced ${n} outlines and proved the room can be won.`;
  const named = summary ? summary.named : n;
  return `Muse Spark named ${things(named)} in your photo and gave each a role, SAM 3.1 found ${n} of them, and code traced the outlines and proved the room can be won.`;
}

// actions: { freePlay, playAgain(ref, title), ownRoom, startOver }
export function closingView({ rooms, mode, primaryLabel, actions }) {
  const sends = mode === 'live' || mode === 'rehearsal';
  const made = rooms.filter((r) => r.title).length;
  return el('section', { class: 'screen closing' }, [
    el('h1', { text: 'You’ve completed FRAME//PLAY' }),
    el('p', { class: 'lede', text: `That is the whole road: ${made === 3 ? 'three rooms' : made === 2 ? 'two rooms' : `${made} ${made === 1 ? 'room' : 'rooms'}`}, and what the AI did in each.` }),
    el('ul', { class: 'closing-rooms', 'aria-label': 'The rooms you played' }, rooms.map((r) => el('li', {}, [
      el('div', { class: 'closing-text' }, [
        el('h2', { class: 'small-h', text: r.title ? `${r.heading}: ${r.title}` : r.heading }),
        el('p', { class: 'result', text: r.result }),
        el('p', { class: 'ai', text: r.ai }),
      ]),
      r.playable ? el('button', {
        type: 'button', class: 'btn', text: 'Play again', 'aria-label': `Play ${r.title} again`,
        tip: `Play ${r.title} again in free play`, onclick: () => actions.playAgain(r.ref, r.title),
      }) : null,
    ]))),
    el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', text: primaryLabel, tip: 'Play any room as often as you like', onclick: actions.freePlay }),
      sends ? el('button', { type: 'button', class: 'btn', text: 'Try your own room', tip: `Back to Step ${OWN_STEP}, to make a room from a photo of your own`, onclick: actions.ownRoom }) : null,
      el('button', { type: 'button', class: 'btn', text: 'Start over', tip: 'Starts the road again from Step 1. Saved levels stay', onclick: actions.startOver }),
    ]),
    sends ? null : el('p', { class: 'why', text: 'Your own room needs the live AI (Meta’s models). This copy runs without it.' }),
  ]);
}
