// Screens built from plain data, so their words and their fit are tested
// in Node (tests/closing.test.js, tests/fit.test.js). The page hands in
// what to show and what each button does; nothing here fetches or draws.
//
// Text is kept compact so a screen fits without scrolling: one short line
// up front, short labelled facts, and the long text in a disclosure that
// starts closed with its summary in view.
import { el } from './ui.js';
import { OWN_STEP, PICK_STEPS } from './road.js';
import { objectWords } from './level.js';
import { ROLE_WORDS } from './words.js';
import { MOCK_WORDS } from './own.js';

// A disclosure: its summary in view, its body one press away. Closed until
// the player opens it.
export function more(summary, kids, cls = '') {
  return el('details', { class: `more ${cls}`.trim() }, [
    el('summary', { text: summary }),
    el('div', { class: 'more-body' }, kids),
  ]);
}

export function photoInput(onFile, camera = false) {
  const input = el('input', {
    type: 'file', accept: 'image/jpeg,image/png,image/webp', capture: camera ? 'environment' : null,
    class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true',
  });
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.value = '';
    if (f) onFile(f);
  });
  return input;
}

// ---- welcome ----
// The consent as key points, the full notice one press away, and the
// button in its bar, in view without scrolling.
export const WHERE = {
  mock: 'This page is in MOCK mode: no photo is sent anywhere, and you play sample rooms drawn by code.',
  // what server/pipeline.py does: one Muse Spark call, then one SAM call
  // for the surface and one per kind of object (server/config.py caps them)
  live: 'In LIVE mode your photo is shrunk on this device and its camera data is removed. It then goes through this app’s server to Meta’s Model API for this one read: one Muse Spark call, then one SAM 3.1 call for the surface and one for each kind of object on it, at most 10 calls in all, each carrying the photo (a failed call may be sent one more time). This app does not store it.',
  rehearsal: 'This page is in REHEARSAL mode: a local stand-in answers, not Meta, and no photo leaves this machine.',
};
// The key points: each one short line, none weaker than the full notice.
const WHERE_SHORT = {
  mock: 'MOCK mode: no photo is sent anywhere; sample rooms are drawn by code.',
  live: 'LIVE mode: your photo goes to Meta’s Model API for this read only. Not stored.',
  rehearsal: 'REHEARSAL mode: a local stand-in answers; no photo leaves this machine.',
};
export const PEOPLE = 'Keep people and anything private out of the photo.';
export const AGE = 'You must be 18 or over to send a photo (Meta’s terms).';
export const KEPT_SHORT = 'Kept: no photo, anywhere. Levels and choices stay on this device.';
export const KEPT = 'Kept: no photo, anywhere. Levels made from your photos (outlines, names and roles, never the photo) stay on this device, with your step, sound and tour choices.';

export function welcomeView({ mode, primaryLabel, onConsent }) {
  const m = WHERE[mode] ? mode : 'mock';
  const bar = el('div', { class: 'bar-end welcome-bar' }, [
    el('button', {
      type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary',
      tip: 'Agree and go to Step 2', text: primaryLabel, onclick: onConsent,
    }),
  ]);
  const section = el('section', { class: 'screen welcome with-bar' }, [
    el('div', { class: 'bar-body' }, [
      el('h1', { text: 'Photograph your room. Play it.' }),
      el('p', { class: 'lede', text: 'One photo of a room or a desk top becomes a small game: its objects become walls, things to collect, a hazard and the exit.' }),
      el('ul', { class: 'consent', 'aria-label': 'Before you start' }, [
        el('li', { text: PEOPLE }),
        el('li', { text: AGE }),
        el('li', { text: WHERE_SHORT[m] }),
        el('li', { text: KEPT_SHORT }),
      ]),
      more('Read the full notice', [
        el('p', { text: 'FRAME//PLAY turns one photo of a room or a desk top into a small game. The outlines of the real objects become the walls you walk around, the things you collect, the hazard you avoid and the exit.' }),
        el('ul', { class: 'consent' }, [
          el('li', { text: PEOPLE }),
          el('li', { text: AGE }),
          el('li', { text: WHERE[m] }),
          el('li', { text: KEPT }),
        ]),
      ], 'notice-full'),
    ]),
    bar,
  ]);
  return { section, bar };
}

// ---- picking a sample room (steps 2 and 5) ----
export const TAGS = { mock: 'MOCK · sample room', live: 'LIVE · your photo', rehearsal: 'REHEARSAL · stand-in' };

export function roomCardView({ title, origin, disabledWhy = null, onPick, draw, tour = true }) {
  const thumb = el('canvas', { class: 'thumb', width: '320', height: '240', 'aria-hidden': 'true' });
  if (draw) draw(thumb);
  return el('button', {
    type: 'button', class: 'room-card', 'data-tour': tour ? 'room-card' : null, disabled: !!disabledWhy,
    tip: disabledWhy || `Play ${title}`, onclick: onPick,
  }, [
    thumb,
    el('span', { class: 'room-title', text: title }),
    el('span', { class: `tag ${origin}`, text: TAGS[origin] }),
    disabledWhy ? el('span', { class: 'why', text: disabledWhy }) : null,
  ]);
}

// Why the photo picker on Steps 2 and 5 is off, by mode.
export const OFF_WORDS = {
  rehearsal: 'Off here in REHEARSAL: the stand-in knows only its own sample room. On Step 9 you can send its saved picture.',
  mock: 'Off in MOCK mode: there is no live connection, so the page plays sample rooms drawn by code.',
};

// off: why the photo picker is off, or null; rehearse: { label, tip, onClick } or null
// The file input exists only while the picker is on: an off picker has
// nothing a photo could reach.
export function pickView({ slot, off, onFile, rehearse = null }) {
  const cards = el('div', { class: 'room-cards' });
  const panel = el('div', { class: 'progress', hidden: true, 'aria-live': 'polite' });
  const input = off ? null : photoInput(onFile);
  const choose = el('button', {
    type: 'button', class: 'btn', disabled: !!off, text: 'Choose a photo', 'data-tour': off ? null : 'room-card',
    tip: 'Pick a photo of a room or a desk top. It is shrunk on this device first', onclick: () => input && input.click(),
  });
  const actions = el('div', { class: 'actions' }, [
    choose, input, off ? el('span', { class: 'why', text: off }) : null,
    rehearse ? el('button', { type: 'button', class: 'btn', text: rehearse.label, tip: rehearse.tip, onclick: rehearse.onClick }) : null,
  ]);
  const section = el('section', { class: 'screen' }, [
    el('h1', { text: slot === 0 ? 'Your room: pick a photo' : 'Another room: pick a second photo' }),
    el('p', { class: 'advice', text: 'Objects with clear edges on a plain floor or desk work best. No people.' }),
    actions,
    panel,
    el('h2', { text: 'Sample rooms' }),
    cards,
  ]);
  return { section, cards, panel };
}

// ---- what the AI found ----
export const SOURCE_WORDS = {
  exact: 'exact outline, drawn by code',
  sam_mask: 'SAM’s own mask',
  traced_in_box: 'traced by code inside SAM’s box',
  box: 'SAM’s box (the trace was not tight enough)',
};

const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

// How the outlines of a read were made, from the level's own counts (never
// the number of objects): "traced 8 outlines inside SAM’s boxes and kept 1
// as a box".
export function tracedWords(level) {
  const c = level.provenance.outline_sources || {};
  return `traced ${plural(c.traced_in_box || 0, 'outline', 'outlines')} inside SAM’s boxes and kept ${plural(c.box || 0, 'as a box', 'as boxes')}`;
}

export function summaryLine(level, summary) {
  if (level.origin === 'mock') {
    return 'This sample room was drawn by code: no model was called, and its outlines are the exact shapes code painted. Code proved the room can be won.';
  }
  const n = level.objects.length;
  const named = summary ? summary.named : n;
  const who = level.origin === 'rehearsal' ? ['The local stand-in for Muse Spark (not Meta)', 'The stand-in for SAM 3.1'] : ['Muse Spark', 'SAM 3.1'];
  return `${who[0]} named ${plural(named, 'thing', 'things')} and gave each a role. ${who[1]} found ${n} of them. Code ${tracedWords(level)}, then proved the room can be won.`;
}

export function proofLine(level) {
  const names = level.proof.order.map((id) => objectWords(level, level.objects.findIndex((o) => o.id === id)));
  const last = names.pop();
  return `Proof: every goal can be reached. The shortest route that collects everything and then exits is ${level.proof.route_length.toLocaleString('en')} px: ${names.join(', ')}, then the ${last}.`;
}

// The reveal picture's height: its own shape at its column's width, held
// so that the heading, the picture and, when the info sits below it, the
// info's summary, buttons and closed panels fit main without scrolling.
// Never under `min` (then main scrolls, and the picture stays readable).
export function revealHeight({ width, aspect, spaceH, headH, gap, infoH, beside, min = 192 }) {
  const natural = width * aspect;
  const room = spaceH - headH - gap - (beside ? 0 : gap + infoH);
  return Math.min(natural, Math.max(min, room));
}

// actions: { play, describe(desc), walls(on) }
export function foundView({ level, summary, fromDevice, actions }) {
  const pic = el('div', { class: 'found-pic' });
  const list = el('ol', { class: 'obj-list' });
  level.objects.forEach((o, k) => {
    const conf = o.confidence == null ? 'no confidence score (drawn by code)' : `confidence ${Math.round(o.confidence * 100)}%`;
    list.append(el('li', {}, [
      el('span', { class: 'num', 'aria-hidden': 'true', text: String(k + 1) }),
      el('span', { class: 'obj' }, [
        el('strong', { text: objectWords(level, k) }),
        el('span', { text: ` · ${o.on_surface ? ROLE_WORDS[o.role] : 'scenery, out of reach'}` }),
        el('span', { class: 'reason', text: `“${o.reason}”` }),
        el('small', { text: `${SOURCE_WORDS[o.outline.source]} · ${conf}` }),
      ]),
    ]));
  });
  const desc = el('section', { class: 'describe', hidden: true, 'aria-live': 'polite' });
  let walls = false;
  const wallsBtn = el('button', {
    type: 'button', class: 'btn', 'aria-pressed': 'false', text: 'Show walls',
    tip: 'Shows where the explorer can stand and the proven winning route',
    onclick: () => {
      walls = !walls;
      wallsBtn.setAttribute('aria-pressed', String(walls));
      wallsBtn.textContent = walls ? 'Hide walls' : 'Show walls';
      actions.walls(walls);
    },
  });
  const changes = level.changes_by_code.length
    ? el('ul', { class: 'changes' }, level.changes_by_code.map((c) => el('li', { text: `${c.what}: ${c.why}.` })))
    : el('p', { text: 'None: the room could be won as read.' });
  const scenery = summary && summary.scenery.length ? summary.scenery : [];
  const warnings = summary && summary.warnings.length ? summary.warnings : [];
  const info = el('div', { class: 'found-info' }, [
    el('p', { class: 'summary', text: summaryLine(level, summary) }),
    fromDevice ? el('p', { class: 'why', text: 'Loaded from this device: no model was called this time.' }) : null,
    el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', tip: 'Start playing this room', text: 'Play this room', onclick: actions.play }),
      el('button', { type: 'button', class: 'btn', text: 'Describe this room', tip: 'Every object, its role and where it is, in words', onclick: () => actions.describe(desc) }),
      wallsBtn,
    ]),
    desc,
    more(`Objects found (${level.objects.length})`, [
      list,
      scenery.length ? el('p', { text: `Also seen, as scenery (never a wall, never sent to SAM): ${scenery.join(', ')}.` }) : null,
      warnings.length ? el('ul', { class: 'changes' }, warnings.map((w) => el('li', { text: w }))) : null,
    ], 'objects'),
    more('Proof and changes by code', [
      el('p', { class: 'proof', text: proofLine(level) }),
      el('h2', { class: 'small-h', text: 'Changes by code' }),
      changes,
    ], 'proof-more'),
    el('p', { class: 'level-label', text: level.label }),
  ]);
  const section = el('section', { class: 'screen found' }, [
    el('h1', { text: 'What the AI found' }),
    el('div', { class: 'found-grid' }, [
      pic,
      info,
    ]),
  ]);
  return { section, pic, info, desc };
}

// ---- your two rooms ----
export function compareView({ primaryLabel, onContinue }) {
  const cards = el('div', { class: 'two-rooms' });
  const section = el('section', { class: 'screen compare' }, [
    el('h1', { text: 'Your two rooms' }),
    cards,
    el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', tip: 'Go on to the third room: a photo of your own', text: primaryLabel, onclick: onContinue }),
    ]),
  ]);
  return { section, cards };
}

export function bestWords(best) {
  if (best == null) return 'Your best: not won yet';
  return best <= 1.05 ? 'Your best: the shortest route' : `Your best: ${best.toFixed(1)} times the shortest`;
}

export function roomSumView({ level, best }) {
  const pic = el('div', { class: 'two-pic' });
  const article = el('article', { class: 'room-sum' }, [
    pic,
    el('h2', { text: level.title }),
    el('ul', { class: 'facts' }, [
      el('li', { text: `Objects found: ${level.objects.length}` }),
      el('li', { text: `Shortest route: ${level.proof.route_length.toLocaleString('en')} px` }),
      el('li', { text: bestWords(best) }),
    ]),
    el('p', { class: 'level-label', text: level.label }),
  ]);
  return { article, pic };
}

export function roomGoneView(slot, isPhoto) {
  return el('article', { class: 'room-sum' }, [
    el('h2', { text: slot === 0 ? 'Your first room' : 'Your second room' }),
    el('p', { text: isPhoto ? 'The photo is never stored: pick it again on its step to see this room here.' : 'This room is not in memory on this visit.' }),
  ]);
}

// ---- free play ----
export function freeView() {
  const cards = el('div', { class: 'room-cards' });
  const section = el('section', { class: 'screen' }, [
    el('h1', { text: 'Free play' }),
    el('p', { text: 'Pick any room. Rounds here do not change your road.' }),
    cards,
  ]);
  return { section, cards };
}

// ---- your own room ----
// What each mode does with a photo: the plain line in view; in REHEARSAL
// the details one press away.
export const OWN_NOTICE = {
  live: 'LIVE: your photo is shrunk on this device and its camera data removed, then read by Meta’s Model API (Muse Spark, then SAM 3.1). Not stored.',
  rehearsal: 'REHEARSAL: a local stand-in answers, not Meta. It only knows its sample room’s own picture.',
  mock: MOCK_WORDS,
};
const REHEARSAL_MORE = 'Save the sample picture with the button, then choose it as your photo: it goes through the same path a live photo takes, with the stand-in answering. Any other photo is refused in words, nothing is sent, and no level is made from it.';

// actions: { file(f), skip }; camera: offer the camera; sampleLink: the
// REHEARSAL picture to save, or null; made: a room is already made here
export function ownView({ mode, primaryLabel, camera = false, sampleLink = null, made = false, actions }) {
  const m = OWN_NOTICE[mode] ? mode : 'mock';
  const sends = m !== 'mock';
  const panel = el('div', { class: 'progress', hidden: true, 'aria-live': 'polite' });
  const shown = el('div', { class: 'own-result', hidden: true });
  const fileIn = photoInput(actions.file);
  const camIn = camera ? photoInput(actions.file, true) : null;
  const choose = el('button', {
    type: 'button', class: sends ? 'btn primary' : 'btn', 'data-primary': sends ? 'true' : null, 'data-tour': sends ? 'primary' : null,
    text: 'Choose a photo', onclick: () => fileIn.click(),
    tip: sends ? 'Pick a photo of a room or a desk top. It is shrunk on this device first' : 'Pick a photo to see it here. It stays on this device',
  });
  const cam = camIn ? el('button', {
    type: 'button', class: 'btn', text: 'Take a photo', onclick: () => camIn.click(),
    tip: sends ? 'Use the camera. The photo is shrunk on this device first' : 'Use the camera. The photo stays on this device',
  }) : null;
  const onward = el('button', {
    type: 'button', class: sends ? 'btn' : 'btn primary', 'data-primary': sends ? null : 'true', 'data-tour': sends ? null : 'primary',
    text: primaryLabel, tip: made ? 'Your own room stays as it is' : 'Go on without your own room', onclick: actions.skip,
  });
  const section = el('section', { class: 'screen own' }, [
    el('h1', { text: 'Your own room' }),
    el('p', { class: 'advice', text: 'A photo of your own room or desk top: clear edges on a plain floor or desk work best. No people.' }),
    el('p', { class: `notice ${m}`, text: OWN_NOTICE[m] }),
    m === 'rehearsal' ? more('More about this', [el('p', { text: REHEARSAL_MORE })]) : null,
    el('div', { class: 'actions' }, [choose, cam, fileIn, camIn, sampleLink, onward]),
    panel,
    shown,
  ]);
  return { section, panel, shown };
}

// What became of a photo that made no room: kept here (MOCK), the photo
// shown on this device only; refused, why, in words.
export function ownResult(r) {
  if (r.kind !== 'kept') return [el('p', { class: 'error', role: 'alert', text: r.words })];
  if (!r.picture) return [];
  r.picture.setAttribute('role', 'img');
  r.picture.setAttribute('aria-label', 'Your photo');
  return [el('figure', { class: 'own-pic' }, [
    r.picture,
    el('figcaption', { text: 'Your photo, on this device only. Nothing was sent, and no level was made from it.' }),
  ])];
}

// ---- the closing screen ----
// Each room on the road, with one line of what happened and one sentence
// of what the AI did. `levels` holds the three rooms' levels (null when not
// made or not in memory), `summaries` the live reads' summaries.
export function closingRooms({ road, levels, summaries = [], mode }) {
  return [0, 1, 2].map((slot) => {
    const level = levels[slot] || null;
    const ref = road.rooms[slot] || null;
    const heading = ['First room', 'Second room', 'Your own room'][slot];
    // made means its slot holds a room; passing it by never unmakes it
    if (slot === 2 && !ref) {
      return {
        slot, heading, title: null, ref: null, playable: false,
        result: 'Not made',
        // in MOCK the screen's last line says why, a single time
        ai: mode === 'live' || mode === 'rehearsal'
          ? 'No room was made from a photo of your own this time.'
          : 'No room was made from a photo of your own, and nothing was invented.',
      };
    }
    return {
      slot, heading, ref, playable: !!level,
      title: level ? level.title : null,
      result: resultLine(road, slot),
      ai: level ? aiLine(level, summaries[slot]) : missingLine(slot, ref, mode),
    };
  });
}

// A room on the road whose level is not in memory: how to see it again, on
// the step where it was picked, only when this mode can make it again.
export function missingLine(slot, ref, mode) {
  const gone = 'Its level is not in memory on this visit';
  if (ref && ref.kind === 'photo' && (mode === 'live' || (slot === 2 && mode === 'rehearsal'))) {
    return `${gone}; pick the same photo again on Step ${PICK_STEPS[slot]} to see it.`;
  }
  if (ref && ref.kind === 'rehearsal' && mode === 'rehearsal') {
    return `${gone}; send it through the stand-in again on Step ${PICK_STEPS[slot]} to see it.`;
  }
  return `${gone}, and this copy cannot make it again.`;
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
  if (level.origin === 'rehearsal') return `The local stand-in (not Meta) answered for its sample picture; code ${tracedWords(level)}, and proved the room can be won.`;
  const named = summary ? summary.named : n;
  return `Muse Spark named ${things(named)} in your photo and gave each a role, SAM 3.1 found ${n} of them, and code ${tracedWords(level)}, then proved the room can be won.`;
}

// actions: { freePlay, playAgain(ref, title), ownRoom, startOver }
export function closingView({ rooms, mode, primaryLabel, actions }) {
  const sends = mode === 'live' || mode === 'rehearsal';
  // the rooms on the road, whether or not their levels are in memory
  const made = rooms.filter((r) => r.ref).length;
  const count = ['no rooms', 'one room', 'two rooms', 'three rooms'][made];
  return el('section', { class: 'screen closing' }, [
    el('h1', { text: 'You’ve completed FRAME//PLAY' }),
    el('p', { class: 'lede', text: `That is the whole road: ${count}, and ${sends ? 'what the AI did in each' : 'how each was made'}.` }),
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
