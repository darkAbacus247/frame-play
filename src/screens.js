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
import { MARK_ROLES, markedWords } from './marks.js';

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
    // any picture: the browser's decoder decides (src/photo.js), so a
    // desktop file dialog does not grey out a phone's HEIC photos
    type: 'file', accept: 'image/*', capture: camera ? 'environment' : null,
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
  // for the floor (or surface) and one per kind of object, up to 11 kinds:
  // 1 + 12 = 13 (server/config.py, SPARK_CALLS_PER_PHOTO and SAM_CALLS_PER_PHOTO)
  live: 'In LIVE mode your photo is shrunk on this device and its camera data is removed. It then goes through this app’s server to Meta’s Model API for this one read: one Muse Spark call, then one SAM 3.1 call for the surface and one for each kind of object on it, at most 13 calls in all, each carrying the photo (a failed call may be sent one more time). This app does not store it.',
  rehearsal: 'This page is in REHEARSAL mode: a local stand-in answers, not Meta, and no photo leaves this machine.',
};
// The key points: each one short line, none weaker than the full notice.
const WHERE_SHORT = {
  mock: 'MOCK mode: no photo is sent anywhere; sample rooms are drawn by code.',
  live: 'LIVE mode: your photo goes to Meta’s Model API to be read; this app keeps none.',
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
export const TAGS = { mock: 'MOCK · sample room', live: 'LIVE · your photo', rehearsal: 'REHEARSAL · stand-in', marked: 'MARKED · by you' };

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
  traced_at_points: 'SAM did not find it: traced by code around Muse Spark’s points',
  points_box: 'SAM did not find it: a region around Muse Spark’s points (the trace did not hold)',
};
// a room marked by hand: the boxes are the player's
export const MARKED_SOURCE_WORDS = {
  traced_in_box: 'traced by code inside your box',
  box: 'your box (the trace was not tight enough)',
};
const sourceWords = (level, src) => (level.origin === 'marked' ? MARKED_SOURCE_WORDS[src] : null) || SOURCE_WORDS[src];

const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

// How many objects came from Muse Spark's points because SAM did not find
// them, from the level's own counts.
export const fromPoints = (level) => {
  const c = level.provenance.outline_sources || {};
  return (c.traced_at_points || 0) + (c.points_box || 0);
};

// How the outlines of a read were made, from the level's own counts (never
// the number of objects): "traced 8 outlines inside SAM’s boxes and kept 1
// as a box".
export function tracedWords(level) {
  const c = level.provenance.outline_sources || {};
  return `traced ${plural(c.traced_in_box || 0, 'outline', 'outlines')} inside SAM’s boxes and kept ${plural(c.box || 0, 'as a box', 'as boxes')}`;
}

// What SAM found, and what code traced around Muse Spark's points instead:
// "SAM 3.1 found 5; for 4 more, code traced around Muse Spark’s points".
export function foundWords(level, sam = 'SAM 3.1') {
  const m = fromPoints(level);
  const n = level.objects.length - m;
  if (!m) return `${sam} found ${n}`;
  const kept = (level.provenance.outline_sources || {}).points_box || 0;
  return `${sam} found ${n}; for ${m} more, code traced around Muse Spark’s points${kept ? ` (and kept ${plural(kept, 'as a region around them', 'as regions around them')})` : ''}`;
}

export function summaryLine(level, summary) {
  if (level.origin === 'mock') {
    return 'This sample room was drawn by code: no model was called, and its outlines are the exact shapes code painted. Code proved the room can be won.';
  }
  if (level.origin === 'marked') return `${markedWords(level)} Code proved the room can be won.`;
  const n = level.objects.length;
  const named = summary ? summary.named : n;
  const who = level.origin === 'rehearsal' ? ['The local stand-in for Muse Spark (not Meta)', 'The stand-in for SAM 3.1'] : ['Muse Spark', 'SAM 3.1'];
  if (fromPoints(level)) {
    return `${who[0]} named ${plural(named, 'thing', 'things')} and gave each a role. ${foundWords(level, who[1])}. Code ${tracedWords(level)}, then proved the room can be won.`;
  }
  return `${who[0]} named ${plural(named, 'thing', 'things')} and gave each a role. ${who[1]} found ${n} of them. Code ${tracedWords(level)}, then proved the room can be won.`;
}

// Where the play area came from, as the level says it (src/level.js and
// floorFromReply in src/trace_in_box.js word it by mode: drawn by code, or
// grown from Muse Spark's or the stand-in's points, or the horizon). A level
// kept on this device before floors has no words: that is said plainly.
export function floorLine(level) {
  const f = level.provenance && level.provenance.floor;
  if (f && typeof f.words === 'string' && f.words) return f.words;
  return 'This level was kept on this device before floors were traced, so it does not say where its play area came from.';
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

const changeCount = (n) => (n === 0 ? 'none' : n === 1 ? '1 change' : `${n} changes`);

// A clear way out of a room, on its reveal and play steps: back to the step
// where the room was picked, to pick again. Always a secondary (primaries
// only move forward), and never a tour target.
export const LEAVE_WORDS = ['Choose a different room', 'Choose a different room', 'Choose a different photo'];
export const LEAVE_CARD = { title: 'Leave this room?', line: 'Your round so far is not kept.', leave: 'Leave', stay: 'Keep playing' };
export function leaveButton(slot, onClick) {
  return el('button', {
    type: 'button', class: 'btn', text: LEAVE_WORDS[slot],
    tip: slot === 2 ? `Back to Step ${PICK_STEPS[slot]}, to choose another photo or continue to the end` : `Back to Step ${PICK_STEPS[slot]}, to pick another room`,
    onclick: onClick,
  });
}

// actions: { play, describe(desc, button), walls(on), remark (a marked room),
// leave (back to the room's pick step), or null }; slot: the room's slot
export function foundView({ level, summary, fromDevice, actions, slot = 0 }) {
  const marked = level.origin === 'marked';
  const pic = el('div', { class: 'found-pic' });
  const list = el('ol', { class: 'obj-list' });
  level.objects.forEach((o, k) => {
    const conf = marked ? 'marked by you' : o.confidence != null ? `confidence ${Math.round(o.confidence * 100)}%`
      : /points/.test(o.outline.source) ? 'no confidence score (SAM did not find it)' : 'no confidence score (drawn by code)';
    list.append(el('li', {}, [
      el('span', { class: 'num', 'aria-hidden': 'true', text: String(k + 1) }),
      el('span', { class: 'obj' }, [
        el('strong', { text: objectWords(level, k) }),
        el('span', { text: ` · ${o.on_surface ? ROLE_WORDS[o.role] : 'scenery, out of reach'}` }),
        el('span', { class: 'reason', text: `“${o.reason}”` }),
        el('small', { text: `${sourceWords(level, o.outline.source)} · ${conf}` }),
      ]),
    ]));
  });
  const desc = el('section', { class: 'describe', id: 'describe-room', hidden: true, 'aria-live': 'polite' });
  const describeBtn = el('button', {
    type: 'button', class: 'btn', text: 'Describe this room', 'aria-expanded': 'false', 'aria-controls': 'describe-room',
    tip: 'Every object, its role and where it is, in words', onclick: () => actions.describe(desc, describeBtn),
  });
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
  // what the page left out for bad boxes leads the warnings (a summary kept
  // on this device before it said so has no leftOut)
  const leftOut = summary && typeof summary.leftOut === 'string' && summary.leftOut ? [summary.leftOut] : [];
  const warnings = summary ? [...leftOut, ...summary.warnings] : [];
  const info = el('div', { class: 'found-info' }, [
    el('p', { class: 'summary', text: summaryLine(level, summary) }),
    fromDevice ? el('p', { class: 'why', text: 'Loaded from this device: no model was called this time.' }) : null,
    el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', tip: 'Start playing this room', text: 'Play this room', onclick: actions.play }),
      describeBtn,
      wallsBtn,
      marked && actions.remark ? el('button', { type: 'button', class: 'btn', text: 'Change your marks', tip: 'Back to your boxes, to move, change or remove them', onclick: actions.remark }) : null,
      actions.leave ? leaveButton(slot, actions.leave) : null,
    ]),
    desc,
    more(`${marked ? 'Objects you marked' : 'Objects found'} (${level.objects.length})`, [
      list,
      scenery.length ? el('p', { text: `Also seen, as scenery (never a wall, never sent to SAM): ${scenery.join(', ')}.` }) : null,
      warnings.length ? el('ul', { class: 'changes' }, warnings.map((w) => el('li', { text: w }))) : null,
    ], 'objects'),
    more(`Proof and changes by code (${changeCount(level.changes_by_code.length)})`, [
      el('p', { class: 'proof', text: proofLine(level) }),
      el('h2', { class: 'small-h', text: 'Play area' }),
      el('p', { class: 'floor-words', text: floorLine(level) }),
      el('h2', { class: 'small-h', text: 'Changes by code' }),
      changes,
    ], 'proof-more'),
    el('p', { class: 'level-label', text: level.label }),
  ]);
  const section = el('section', { class: 'screen found' }, [
    el('h1', { text: marked ? 'Your room, from your marks' : 'What the AI found' }),
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
  live: 'LIVE: your photo is shrunk on this device and its camera data removed, then read by Meta’s Model API (Muse Spark, then SAM 3.1). This app keeps none.',
  rehearsal: 'REHEARSAL: a local stand-in answers, not Meta. It only knows its sample room’s own picture.',
  mock: MOCK_WORDS,
};
const REHEARSAL_MORE = 'Save the sample picture with the button, then choose it as your photo: it goes through the same path a live photo takes, with the stand-in answering. Any other photo, or a copy edited enough for the check to see, is refused in words, nothing is sent, and no level is made from it; an edit of a few pixels can pass, and the stand-in answers with its sample’s own places. A refused photo can still become your room: you mark it yourself, and nothing more is sent.';

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
  return { section, panel, shown, choose, onward };
}

// The way on from a photo no model can read here: the player marks it.
export function markButton(actions) {
  return el('button', {
    type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', text: 'Mark your room',
    tip: 'Draw a box over each object and say what it is; code traces the outlines. Nothing is sent', onclick: actions.mark,
  });
}

// What became of a photo that made no room: kept here (MOCK), the photo
// shown on this device only; refused, why, in words. actions: { mark }
// when the photo can be marked by hand instead (MOCK, or a read refused or
// failed), or null.
export function ownResult(r, actions = null) {
  const mark = actions ? el('div', { class: 'actions' }, [markButton(actions)]) : null;
  if (r.kind !== 'kept') return [el('p', { class: 'error', role: 'alert', text: r.words }), mark];
  if (!r.picture) return [];
  r.picture.setAttribute('role', 'img');
  r.picture.setAttribute('aria-label', 'Your photo');
  return [el('figure', { class: 'own-pic' }, [
    r.picture,
    el('figcaption', { text: 'Your photo, on this device only. Nothing was sent, and no level was made from it.' }),
  ]), mark];
}

// ---- your marks ----
// The marking screen: the photo on the left (above, when narrow), sized
// like the reveal, and beside it what a box is, what the room still needs,
// the ways on and the boxes so far. The board itself is src/marker.js.
export const MARK_HELP = [
  'Mouse, pen or touch: pick what the box is, then drag over the object to draw it. Press a box to select it: a pick then changes it, and dragging it moves it.',
  'Keyboard: Tab to the photo. The arrow keys move the box cursor, Shift with an arrow makes it larger or smaller, and Enter adds it. Space selects the box under the cursor; the arrows then move it and Shift with an arrow resizes it. Delete removes it, Escape lets it go, 1 to 4 pick Coin, Obstacle, Hazard or Exit, and Ctrl+Z undoes.',
];
// actions: { role(role), make, undo, remove, keep (a made room: leave it as it was), or null }
export function markView({ actions }) {
  const pic = el('div', { class: 'found-pic mark-pic' });
  const roles = MARK_ROLES.map((r) => el('button', {
    type: 'button', class: 'btn', 'data-role': r.role, 'aria-pressed': 'false', text: r.button,
    tip: `A new box, or the selected one, is ${r.words} (key ${r.key})`, onclick: () => actions.role(r.role),
  }));
  const needsLine = el('p', { class: 'needs', 'aria-live': 'polite' });
  const make = el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', text: 'Make the room', tip: 'Code traces each outline inside your box, builds the room and proves it can be won', onclick: actions.make });
  const undo = el('button', { type: 'button', class: 'btn', text: 'Undo', tip: 'Undoes your last change to the boxes', onclick: actions.undo });
  const remove = el('button', { type: 'button', class: 'btn', text: 'Remove the box', tip: 'Removes the selected box', onclick: actions.remove });
  const keep = actions.keep ? el('button', { type: 'button', class: 'btn', text: 'Keep the room as it was', tip: 'Back to the room made from your marks, unchanged', onclick: actions.keep }) : null;
  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Your boxes' });
  // the list grows with every box, so it is folded; the boxes themselves are
  // on the photo
  const boxes = more('Your boxes (0)', [chips]);
  const info = el('div', { class: 'found-info' }, [
    el('p', { class: 'summary', text: 'Pick what a box is, then drag one over each object. Nothing is sent.' }),
    el('div', { class: 'actions', role: 'group', 'aria-label': 'What a box is' }, roles),
    needsLine,
    el('div', { class: 'actions' }, [make, undo, remove, keep]),
    boxes,
    more('Keyboard and touch', MARK_HELP.map((t) => el('p', { text: t }))),
  ]);
  const section = el('section', { class: 'screen found marking' }, [
    el('h1', { text: 'Your marks' }),
    el('div', { class: 'found-grid' }, [pic, info]),
  ]);
  return { section, pic, info, roles, needsLine, make, undo, remove, chips, boxesSummary: boxes.children[0] };
}

// ---- the closing screen ----
// Each room on the road, with one line of what happened and one sentence
// of what the AI did. `levels` holds the three rooms' levels (null when not
// made or not in memory), `summaries` the live reads' summaries, `room`
// the room the running stand-in answers for (REHEARSAL), or null, `kept`
// the origin of each photo room's level kept on this device, or null.
export function closingRooms({ road, levels, summaries = [], mode, room = null, kept = [] }) {
  return [0, 1, 2].map((slot) => {
    const level = levels[slot] || null;
    const ref = road.rooms[slot] || null;
    const heading = ['First room', 'Second room', 'Your own room'][slot];
    // made means its slot holds a room; passing it by never unmakes it
    // marks not made into a room yet are not a room
    if (slot === 2 && (!ref || (ref.kind === 'marked' && !ref.made))) {
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
      title: ref && ref.kind === 'marked' ? 'marked by you' : level ? level.title : null,
      result: resultLine(road, slot),
      ai: level ? aiLine(level, summaries[slot]) : missingLine(slot, ref, mode, room, kept[slot] || null),
    };
  });
}

// A room on the road whose level is not in memory: how to see it again, on
// the step where it was picked, only when this copy can make it again (a
// stand-in room only by the stand-in started for that same room).
// kept: the origin of the level kept on this device for a photo room, or
// null; one from the other mode cannot load here.
export function missingLine(slot, ref, mode, room = null, kept = null) {
  const gone = 'Its level is not in memory on this visit';
  // marked by hand: any mode makes it again from the marks on this device
  if (ref && ref.kind === 'marked') return `${gone}; choose the same photo again on Step ${OWN_STEP + 1} to load it from your marks on this device.`;
  const otherMode = kept && kept !== mode;
  if (ref && ref.kind === 'photo' && mode === 'live' && !otherMode) {
    return `${gone}; pick the same photo again on Step ${PICK_STEPS[slot]} to see it.`;
  }
  if (ref && ref.kind === 'photo' && slot === 2 && mode === 'rehearsal' && !otherMode) {
    return `${gone}; pick the same photo again on Step ${PICK_STEPS[slot]} to see it (here only the stand-in’s own sample picture can be made again).`;
  }
  if (ref && ref.kind === 'rehearsal' && mode === 'rehearsal' && ref.id === room) {
    return `${gone}; send it through the stand-in again on Step ${PICK_STEPS[slot]} to see it.`;
  }
  return `${gone}, and this copy cannot make it again.`;
}

export function resultLine(road, slot) {
  const best = road.best[slot];
  if (best != null) return best <= 1.05 ? 'Won · by the shortest route' : `Won · best route ${best.toFixed(1)} times the shortest`;
  // the road's own round; a replay in Free play never changes it
  if (road.finished[slot]) return 'Lost on the road';
  return 'Not played yet';
}

export function aiLine(level, summary) {
  const n = level.objects.length;
  const things = (k) => `${k} ${k === 1 ? 'thing' : 'things'}`;
  if (level.origin === 'mock') return 'Sample room drawn by code; no model was called.';
  if (level.origin === 'marked') return `${markedWords(level)} Code proved the room can be won.`;
  if (level.origin === 'rehearsal') {
    // its zero_matches drill places every thing by Muse Spark's points
    const found = fromPoints(level) ? `${foundWords(level, 'the stand-in for SAM 3.1')}; ` : '';
    return `The local stand-in (not Meta) answered for its sample picture; ${found}code ${tracedWords(level)}, and proved the room can be won.`;
  }
  const named = summary ? summary.named : n;
  if (fromPoints(level)) return `Muse Spark named ${things(named)} in your photo and gave each a role; ${foundWords(level)}; and code ${tracedWords(level)}, then proved the room can be won.`;
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
      // the visible words begin the accessible name: "Play again: The Desk
      // Top" (your own room by its row, as in REHEARSAL it carries a
      // sample's title)
      r.playable ? el('button', {
        type: 'button', class: 'btn', tip: `Play ${r.slot === 2 ? 'your own room' : r.title} again in free play`,
        onclick: () => actions.playAgain(r.ref, r.title),
      }, ['Play again', el('span', { class: 'sr-only', text: `: ${r.slot === 2 ? 'your own room' : r.title}` })]) : null,
    ]))),
    el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', text: primaryLabel, tip: 'Play any room as often as you like', onclick: actions.freePlay }),
      el('button', { type: 'button', class: 'btn', text: 'Try your own room', tip: `Back to Step ${OWN_STEP}, to make a room from a photo of your own`, onclick: actions.ownRoom }),
      el('button', { type: 'button', class: 'btn', text: 'Start over', tip: 'Starts the road again from Step 1. Saved levels stay', onclick: actions.startOver }),
    ]),
    sends || rooms[2].ref ? null : el('p', { class: 'why', text: 'In MOCK no model reads a photo: your own room is a photo you mark yourself.' }),
  ]);
}
