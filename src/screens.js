// Screens built from plain data, so their words and their fit are tested
// in Node (tests/closing.test.js, tests/fit.test.js). The page hands in
// what to show and what each button does; nothing here fetches or draws.
//
// Text is kept compact so a screen fits without scrolling: one short line
// up front, short labelled facts, and the long text in a disclosure that
// starts closed with its summary in view.
import { el } from './ui.js';
import { OWN_STEP, OWN_SLOT, PICK_STEPS, SAMPLE_FOUND } from './road.js';
import { objectWords } from './level.js';
import { ROLE_WORDS } from './words.js';
import { MOCK_WORDS, REPLAY_WORDS } from './own.js';
import { MARK_ROLES, markedWords } from './marks.js';
import { POSTCARD_BUTTON, POSTCARD_TIP } from './postcard.js';

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
// Meta's Billing page for the demo's key: "While using free credits your
// content may be used for product improvement."
export const META_USE = 'While this demo runs on Meta’s free hackathon credits, Meta may use the photos it receives to improve its products.';
export const WHERE = {
  mock: 'This page is in MOCK mode: no photo is sent anywhere, and you play sample rooms drawn by code.',
  // what server/pipeline.py does: one Muse Spark call, then one SAM call
  // for the floor (or surface) and one per kind of object, up to 11 kinds,
  // then Ask the room's one more Muse Spark call (server/riddles.py):
  // 1 + 12 + 1 = 14 (server/config.py, SPARK_CALLS_PER_PHOTO,
  // SAM_CALLS_PER_PHOTO and RIDDLE_SPARK_CALLS)
  live: 'In LIVE mode your photo is shrunk on this device and its camera data is removed. It then goes through this app’s server to Meta’s Model API for this one read: one Muse Spark call, then one SAM 3.1 call for the surface and one for each kind of object on it; then, while you play, one more Muse Spark call writes up to 3 riddles about it. At most 14 calls in all, each carrying the photo (a failed call may be sent one more time, a busy one two more times). If you ask for a postcard, the same shrunk photo goes to Muse Image one more time, about one cent, counted in the server’s daily spending stop. A riddle answered aloud (Say it, when this server has it on) sends about five seconds of your voice to Muse Voice Transcribe, no photo, under a tenth of a cent, counted in the daily spending stop; this app keeps no clip. This app does not store it. ' + META_USE,
  rehearsal: 'This page is in REHEARSAL mode: a local stand-in answers, not Meta, and no photo leaves this machine.',
};
// The key points: each one short line, none weaker than the full notice.
const WHERE_SHORT = {
  mock: 'MOCK mode: no photo is sent anywhere; sample rooms are drawn by code.',
  live: 'LIVE mode: Meta reads your photo and may use it; this app keeps none.',
  rehearsal: 'REHEARSAL mode: a local stand-in answers; no photo leaves this machine.',
};
export const PEOPLE = 'Keep people and anything private out of the photo.';
export const AGE = 'You must be 18 or over to send a photo (Meta’s terms).';
// what this app keeps; in LIVE, Meta's own use is said beside it (META_USE)
export const KEPT_SHORT = 'Kept by this app: no photo. Levels and choices stay on this device.';
// the host of a public copy keeps its own access log, which is not this app's
// to promise away; there is no photo to delete, and the levels on the device
// go with the site's data
export const KEPT = 'Kept by this app: no photo, on this device or on its server. Levels made from your photos (outlines, names and roles, never the photo) stay on this device, with your step, sound and tour choices. The service hosting this copy may keep its own access log. This app keeps no photo, so it has nothing to delete; your levels stay on this device until you clear this site’s data.';

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
      // the quickest look at Meta's models (the author's choice on 10-28): true in every mode,
      // since our kitchen is read fresh in LIVE and Meta's recorded answer is replayed elsewhere
      el('p', { class: 'ours-hint', text: OURS_HINT }),
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

export const OURS_HINT = 'Quickest look at what Meta’s models make of a real photo: Our kitchen, the first card on the next step.';

// ---- picking a sample room (steps 2, 5 and 8) ----
// ours: our kitchen read fresh in LIVE (it is not the player's photo)
export const TAGS = { mock: 'MOCK · sample room', live: 'LIVE · your photo', rehearsal: 'REHEARSAL · stand-in', marked: 'MARKED · by you', replay: 'REPLAY · recorded answer', ours: 'LIVE · our photo' };

// chosen: this card's room is the one on the road at this step; tip: its
// own tip in place of "Play <title>" (a disabled card's tip is its why);
// cls: more classes; primary: the one emphasized control on its screen
export function roomCardView({ title, origin, disabledWhy = null, onPick, draw, tour = true, chosen = false, tip = null, cls = '', primary = false }) {
  const thumb = el('canvas', { class: 'thumb', width: '320', height: '240', 'aria-hidden': 'true' });
  if (draw) draw(thumb);
  return el('button', {
    type: 'button', class: ['room-card', chosen ? 'chosen' : '', primary ? 'primary-card' : '', cls].filter(Boolean).join(' '),
    'data-tour': primary ? 'primary' : tour ? 'room-card' : null, 'data-primary': primary ? 'true' : null, disabled: !!disabledWhy,
    'aria-current': chosen ? 'true' : null,
    tip: tip || disabledWhy || `Play ${title}`, onclick: onPick,
  }, [
    thumb,
    el('span', { class: 'room-title', text: title }),
    el('span', { class: `tag ${origin}`, text: TAGS[origin] }),
    disabledWhy ? el('span', { class: 'why', text: disabledWhy }) : chosen ? el('span', { class: 'why', text: 'On your road' }) : null,
  ]);
}

// Why the photo picker on Steps 2, 5 and 8 is off, by mode.
export const OFF_WORDS = {
  rehearsal: 'Off here in REHEARSAL: the stand-in knows only its own sample room. On Step 12 you can send its saved picture.',
  mock: 'Off in MOCK mode: no live connection, so the page plays sample rooms drawn by code, and our kitchen from Meta’s recorded answer.',
};

export const PICK_HEADINGS = ['Your room: pick a photo', 'Another room: pick a second photo', 'A third room: pick a third photo'];

// The room already chosen on a pick step (the road chooses the next sample
// room as it goes on): said in one line, with the one primary going on with
// it. Any card below still picks another room.
export function chosenLine({ title, onContinue }) {
  return el('div', { class: 'actions chosen-row' }, [
    el('p', { class: 'chosen-line', text: `On your road: ${title}. Pick another below, or go on with it.` }),
    el('button', {
      type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary',
      tip: `Go on with ${title} to what is in it`, text: `Continue with ${title}`, onclick: onContinue,
    }),
  ]);
}

// off: why the photo picker is off, or null; rehearse: { label, tip, onClick } or null
// chosen: { title, onContinue } when this step already holds a room, or null
// The file input exists only while the picker is on: an off picker has
// nothing a photo could reach.
export function pickView({ slot, off, onFile, rehearse = null, chosen = null }) {
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
    el('h1', { text: PICK_HEADINGS[slot] }),
    chosen ? chosenLine(chosen) : el('p', { class: 'advice', text: 'Objects with clear edges on a plain floor or desk work best. No people.' }),
    actions,
    panel,
    el('h2', { text: 'Sample rooms' }),
    cards,
  ]);
  return { section, cards, panel, actions };
}

// ---- what the AI found ----
export const SOURCE_WORDS = {
  exact: 'exact outline, drawn by code',
  sam_mask: 'exact outline from SAM’s own mask',
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

// What Muse Spark named, against the things in the room: it names kinds
// (three coins are one), so a room with more things than kinds says both,
// "8 kinds of thing (12 things)"; with as many, or with kinds SAM did not
// find (our kitchen: 8 named, 5 found), the count alone, as things.
export function namedWords(kinds, things) {
  if (things > kinds) return `${plural(kinds, 'kind', 'kinds')} of thing (${plural(things, 'thing', 'things')})`;
  return plural(kinds, 'thing', 'things');
}

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

// The same, when SAM's masks gave outlines: "SAM 3.1’s masks gave 9 exact
// outlines; code traced 0", and where a mask did not decode, "code traced 1
// inside SAM’s box" (and kept any box). '' when no mask gave an outline.
export function maskWords(level, sam = 'SAM 3.1') {
  const c = level.provenance.outline_sources || {};
  if (!c.sam_mask) return '';
  const t = c.traced_in_box || 0, b = c.box || 0;
  const traced = t ? `code traced ${t} inside SAM’s ${t === 1 ? 'box' : 'boxes'}` : 'code traced 0';
  return `${sam}’s masks gave ${plural(c.sam_mask, 'exact outline', 'exact outlines')}; ${traced}${b ? ` and kept ${plural(b, 'as a box', 'as boxes')}` : ''}`;
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
  const masks = maskWords(level, who[1]);
  const outlines = masks ? `${masks}. Code then proved the room can be won.` : `Code ${tracedWords(level)}, then proved the room can be won.`;
  // ours (the sample kitchen photo): replayed (in LIVE, with why it was not
  // read live now), or read fresh in LIVE
  const instead = summary && summary.instead ? `${summary.instead} ` : '';
  const lead = level.origin === 'replay' ? `${instead}${REPLAY_WORDS} ` : summary && summary.ours ? 'Our kitchen photo, read by Meta’s models now. ' : '';
  if (fromPoints(level)) {
    return `${lead}${who[0]} named ${namedWords(named, n)} and gave each a role. ${foundWords(level, who[1])}. ${outlines}`;
  }
  return `${lead}${who[0]} named ${namedWords(named, n)} and gave each a role. ${who[1]} found ${n} of them. ${outlines}`;
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
export const LEAVE_WORDS = ['Choose a different room', 'Choose a different room', 'Choose a different room', 'Choose a different photo'];
export const LEAVE_CARD = { title: 'Leave this room?', line: 'Your round so far is not kept.', leave: 'Leave', stay: 'Keep playing' };
export function leaveButton(slot, onClick) {
  return el('button', {
    type: 'button', class: 'btn', text: LEAVE_WORDS[slot],
    tip: slot === OWN_SLOT ? `Back to Step ${PICK_STEPS[slot]}, to choose another photo or continue to the end` : `Back to Step ${PICK_STEPS[slot]}, to pick another room`,
    onclick: onClick,
  });
}

// A sure way on from any round on the road: it ends as played, not won, and
// the road goes on, after a true modal card (Keep playing focused, Escape
// never closes it). Always a secondary, never a tour target.
export const END_ROUND = 'End this round';
export const END_CARD = { title: 'End this round?', line: 'It counts as played, not won.', end: 'End it', stay: 'Keep playing' };
export function endRoundButton(onClick) {
  return el('button', {
    type: 'button', class: 'btn end-round', text: END_ROUND,
    tip: 'Ends this round as played, not won, so the road goes on', onclick: onClick,
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
    el('h1', { text: marked ? 'Your room, from your marks' : level.origin === 'mock' ? SAMPLE_FOUND : 'What the AI found' }),
    el('div', { class: 'found-grid' }, [
      pic,
      info,
    ]),
  ]);
  return { section, pic, info, desc };
}

// ---- your three rooms ----
export function compareView({ primaryLabel, onContinue }) {
  const cards = el('div', { class: 'three-rooms' });
  const section = el('section', { class: 'screen compare' }, [
    el('h1', { text: 'Your three rooms' }),
    cards,
    el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', tip: 'Go on to your own room: a photo of your own', text: primaryLabel, onclick: onContinue }),
    ]),
  ]);
  return { section, cards };
}

export function bestWords(best) {
  if (best == null) return 'Your best: not won yet';
  return best <= 1.05 ? 'Your best: the shortest route' : `Your best: ${best.toFixed(1)} times the shortest`;
}

// title: the room's own name in place of its level's (our kitchen)
export function roomSumView({ level, best, title = null }) {
  const pic = el('div', { class: 'sum-pic' });
  const article = el('article', { class: 'room-sum' }, [
    pic,
    el('h2', { text: title || level.title }),
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
    el('h2', { text: ['Your first room', 'Your second room', 'Your third room'][slot] }),
    el('p', { text: isPhoto ? 'The photo is never stored: pick it again on its step to see this room here.' : 'This room is not in memory on this visit.' }),
  ]);
}

// ---- free play ----
export const FREE_LINE = 'Pick any room: the three sample rooms, our kitchen once it is on your road, and your own room once it is made. Rounds here do not change your road.';
export function freeView() {
  const cards = el('div', { class: 'room-cards' });
  const section = el('section', { class: 'screen' }, [
    el('h1', { text: 'Free play' }),
    el('p', { text: FREE_LINE }),
    cards,
  ]);
  return { section, cards };
}

// ---- your own room ----
// What each mode does with a photo: the plain line in view; in REHEARSAL
// the details one press away.
// the postcard sentence (src/postcard.js): the same photo, one more send,
// only when asked for, at about one cent inside the server's daily stop;
// the screen says it only where this server has postcards on (ownNotice)
export const POSTCARD_SENTENCE = 'If you ask for a postcard, the same shrunk photo goes to Muse Image one more time, about one cent, counted in the daily stop. ';
export const OWN_NOTICE = {
  live: 'LIVE: your photo is shrunk on this device and its camera data removed, then read by Meta’s Model API (Muse Spark and SAM 3.1). This app keeps none. ' + POSTCARD_SENTENCE + META_USE,
  rehearsal: 'REHEARSAL: a local stand-in answers, not Meta. It only knows its sample room’s own picture.',
  mock: MOCK_WORDS,
};
// The notice as Step 12 shows it: in LIVE the postcard sentence only when
// this server has postcards on (health.postcard; the full notice shapes Say
// it the same way, "when this server has it on"); else the mode's words.
export function ownNotice(mode, { postcard = false } = {}) {
  const m = OWN_NOTICE[mode] ? mode : 'mock';
  if (m === 'live' && !postcard) return OWN_NOTICE.live.replace(POSTCARD_SENTENCE, '');
  return OWN_NOTICE[m];
}
const REHEARSAL_MORE = 'Save the sample picture with the button, then choose it as your photo: it goes through the same path a live photo takes, with the stand-in answering. Any other photo, or a copy edited enough for the check to see, is refused in words, nothing is sent, and no level is made from it; an edit of a few pixels can pass, and the stand-in answers with its sample’s own places. A refused photo can still become your room: you mark it yourself, and nothing more is sent.';

// Our kitchen: the author's own kitchen photo, as a card beside Choose a
// photo and beside the sample rooms. What it does, by the way it is read here.
export const OURS_WORDS = {
  fresh: 'No photo of your own? Use ours: the author’s own photo of a real kitchen, read fresh by Meta’s models, as a photo you choose is.',
  replay: 'No photo of your own? Use ours: the author’s own photo of a real kitchen. Meta’s models read it on Oct 27, 2026; this copy replays their recorded answer, and no model is called now.',
};
export const OURS_TITLE = 'Our kitchen (a real photo)';
const OURS_TIPS = {
  fresh: 'The author’s kitchen photo, read by Meta’s models as your photo would be',
  replay: 'The author’s kitchen photo, with Meta’s recorded answer replayed; no model is called now',
};

// Our kitchen's card. ours: { replay (its recorded answer is replayed; else
// it is read fresh), off (why it cannot be used here, or null), short (the
// same in a few words, for the card) }; draw(canvas): its thumbnail;
// held: why it is not picked here (another step holds it), or null; wide:
// the thumbnail beside the words, with its own button, Use our kitchen
// (beside Choose a photo): primary makes that button the screen's one
// filled primary, else it is a plain secondary
export const OURS_USE = 'Use our kitchen';
export function oursCardView({ ours, onPick, draw, chosen = false, held = null, primary = false, wide = false }) {
  const why = held || (ours.off ? ours.short || ours.off : null);
  const tip = held ? null : ours.off || OURS_TIPS[ours.replay ? 'replay' : 'fresh'];
  const origin = ours.replay ? 'replay' : 'ours';
  if (!wide) return roomCardView({ title: OURS_TITLE, origin, disabledWhy: why, onPick, draw, chosen, tip, primary, cls: 'ours-card' });
  const thumb = el('canvas', { class: 'thumb', width: '320', height: '240', 'aria-hidden': 'true' });
  if (draw) draw(thumb);
  const on = primary && !why;
  return el('div', { class: ['room-card', 'ours-card', 'wide', why ? 'off' : ''].filter(Boolean).join(' ') }, [
    thumb,
    el('span', { class: 'card-text' }, [
      el('span', { class: 'room-title', text: OURS_TITLE }),
      el('span', { class: `tag ${origin}`, text: TAGS[origin] }),
      why ? el('span', { class: 'why', text: why }) : null,
      el('button', {
        type: 'button', class: on ? 'btn primary ours-use' : 'btn ours-use', 'data-primary': on ? 'true' : null, 'data-tour': on ? 'primary' : null,
        disabled: !!why, text: OURS_USE, tip: tip || why, onclick: onPick,
      }),
    ]),
  ]);
}

// actions: { file(f), skip, ours }; camera: offer the camera; sampleLink:
// the REHEARSAL picture to save, or null; made: a room is already made here;
// ours: { replay, off, short, draw (its thumbnail), held } as oursCardView
// takes them, or null; postcard: this server has postcards on (the LIVE
// notice then says the postcard sentence)
export function ownView({ mode, primaryLabel, camera = false, sampleLink = null, made = false, ours = null, postcard = false, actions }) {
  const m = OWN_NOTICE[mode] ? mode : 'mock';
  const sends = m !== 'mock';
  // the one primary: our kitchen wherever its answer is replayed (MOCK,
  // REHEARSAL, the live AI unavailable) and it can be; else Choose a photo
  // where a photo is sent; else Continue to the end
  const oursFirst = !!ours && ours.replay && !ours.off && !ours.held;
  const chooseFirst = sends && !oursFirst;
  const panel = el('div', { class: 'progress', hidden: true, 'aria-live': 'polite' });
  const shown = el('div', { class: 'own-result', hidden: true });
  const fileIn = photoInput(actions.file);
  const camIn = camera ? photoInput(actions.file, true) : null;
  const choose = el('button', {
    type: 'button', class: chooseFirst ? 'btn primary' : 'btn', 'data-primary': chooseFirst ? 'true' : null, 'data-tour': chooseFirst ? 'primary' : null,
    text: 'Choose a photo', onclick: () => fileIn.click(),
    tip: sends ? 'Pick a photo of a room or a desk top. It is shrunk on this device first' : 'Pick a photo to see it here. It stays on this device',
  });
  const cam = camIn ? el('button', {
    type: 'button', class: 'btn', text: 'Take a photo', onclick: () => camIn.click(),
    tip: sends ? 'Use the camera. The photo is shrunk on this device first' : 'Use the camera. The photo stays on this device',
  }) : null;
  const onward = el('button', {
    type: 'button', class: chooseFirst || oursFirst ? 'btn' : 'btn primary', 'data-primary': chooseFirst || oursFirst ? null : 'true', 'data-tour': chooseFirst || oursFirst ? null : 'primary',
    text: primaryLabel, tip: made ? 'Your own room stays as it is' : 'Go on without your own room', onclick: actions.skip,
  });
  const oursBtn = ours ? oursCardView({ ours, onPick: actions.ours, draw: ours.draw, held: ours.held || null, primary: oursFirst, wide: true }) : null;
  const oursLine = ours && !ours.held ? el('p', { class: 'why ours-line', text: ours.off || OURS_WORDS[ours.replay ? 'replay' : 'fresh'] }) : null;
  const section = el('section', { class: 'screen own' }, [
    el('h1', { text: 'Your own room' }),
    el('p', { class: 'advice', text: 'A photo of your own room or desk top: clear edges on a plain floor or desk work best. No people.' }),
    el('p', { class: `notice ${m}`, text: ownNotice(m, { postcard }) }),
    m === 'rehearsal' ? more('More about this', [el('p', { text: REHEARSAL_MORE })]) : null,
    el('div', { class: 'actions' }, [choose, cam, oursBtn, fileIn, camIn, sampleLink, onward]),
    oursLine,
    panel,
    shown,
  ]);
  return { section, panel, shown, choose, onward, ours: oursBtn };
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
// of what the AI did. `levels` holds the four rooms' levels (null when not
// made or not in memory), `summaries` the live reads' summaries, `room`
// the room the running stand-in answers for (REHEARSAL), or null, `kept`
// the origin of each photo room's level kept on this device, or null.
// canReplay: this server can replay the sample kitchen photo's answer.
// postcards: per slot, whether the page offers a room postcard for its level
// (src/postcard.js postcardEligible: the switch on, a LIVE read of a photo).
export function closingRooms({ road, levels, summaries = [], mode, room = null, kept = [], canReplay = false, postcards = [] }) {
  return [0, 1, 2, OWN_SLOT].map((slot) => {
    const level = levels[slot] || null;
    const ref = road.rooms[slot] || null;
    const heading = ['First room', 'Second room', 'Third room', 'Your own room'][slot];
    // made means its slot holds a room; passing it by never unmakes it
    // marks not made into a room yet are not a room
    if (slot === OWN_SLOT && (!ref || (ref.kind === 'marked' && !ref.made))) {
      return {
        slot, heading, title: null, ref: null, playable: false,
        result: 'Not made',
        // in MOCK the screen's last line says why, a single time
        ai: mode === 'live' || mode === 'rehearsal'
          ? 'No room was made from a photo of your own this time.'
          : 'No room was made from a photo of your own, and nothing was invented.',
      };
    }
    // our kitchen, replayed or read fresh, in any slot
    const ours = !!ref && (ref.kind === 'replay' || (!!summaries[slot] && summaries[slot].ours === true));
    return {
      slot, heading, ref, playable: !!level, won: road.best[slot] != null,
      postcard: !!level && postcards[slot] === true,
      title: ref && ref.kind === 'marked' ? 'marked by you' : ours ? 'our kitchen' : level ? level.title : null,
      result: resultLine(road, slot),
      ai: level ? aiLine(level, summaries[slot]) : missingLine(slot, ref, mode, room, kept[slot] || null, canReplay),
    };
  });
}

// A room on the road whose level is not in memory: how to see it again, on
// the step where it was picked, only when this copy can make it again (a
// stand-in room only by the stand-in started for that same room).
// kept: the origin of the level kept on this device for a photo room, or
// null; one from the other mode cannot load here.
export function missingLine(slot, ref, mode, room = null, kept = null, canReplay = false) {
  const gone = 'Its level is not in memory on this visit';
  // ours, replayed: any mode replays it again, where the server can
  if (ref && ref.kind === 'replay') return canReplay ? `${gone}; replay it again on Step ${PICK_STEPS[slot]} to see it.` : `${gone}, and this copy cannot replay it.`;
  // marked by hand: any mode makes it again from the marks on this device
  if (ref && ref.kind === 'marked') return `${gone}; choose the same photo again on Step ${OWN_STEP + 1} to load it from your marks on this device.`;
  const otherMode = kept && kept !== mode;
  if (ref && ref.kind === 'photo' && mode === 'live' && !otherMode) {
    return `${gone}; pick the same photo again on Step ${PICK_STEPS[slot]} to see it.`;
  }
  if (ref && ref.kind === 'photo' && slot === OWN_SLOT && mode === 'rehearsal' && !otherMode) {
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
  const things = (k) => namedWords(k, n);
  if (level.origin === 'mock') return 'Sample room drawn by code; no model was called.';
  if (level.origin === 'marked') return `${markedWords(level)} Code proved the room can be won.`;
  if (level.origin === 'replay') {
    // kept short: four rooms share the closing screen
    const masks = maskWords(level);
    return `${REPLAY_WORDS} ${masks || `${foundWords(level)}; code ${tracedWords(level)}`}; code proved the room can be won.`;
  }
  if (level.origin === 'rehearsal') {
    // its zero_matches drill places every thing by Muse Spark's points
    const found = fromPoints(level) ? `${foundWords(level, 'the stand-in for SAM 3.1')}; ` : '';
    const masks = maskWords(level, 'the stand-in for SAM 3.1');
    if (masks) return `The local stand-in (not Meta) answered for its sample picture; ${found}${masks}; and code proved the room can be won.`;
    return `The local stand-in (not Meta) answered for its sample picture; ${found}code ${tracedWords(level)}, and proved the room can be won.`;
  }
  const named = summary ? summary.named : n;
  const masks = maskWords(level);
  // ours, read fresh in LIVE, is not the player's photo
  const photo = summary && summary.ours ? 'in our kitchen photo' : 'in your photo';
  if (masks) {
    const found = fromPoints(level) ? foundWords(level) : `SAM 3.1 found ${n} of them`;
    return `Muse Spark named ${things(named)} ${photo} and gave each a role; ${found}; ${masks}; and code proved the room can be won.`;
  }
  if (fromPoints(level)) return `Muse Spark named ${things(named)} ${photo} and gave each a role; ${foundWords(level)}; and code ${tracedWords(level)}, then proved the room can be won.`;
  return `Muse Spark named ${things(named)} ${photo} and gave each a role, SAM 3.1 found ${n} of them, and code ${tracedWords(level)}, then proved the room can be won.`;
}

// The closing screen's one line of what was won: the rooms on the road
// (whether or not their levels are in memory) and how many were won there.
const COUNT = ['no', 'one', 'two', 'three', 'four'];
export function wonLine(rooms) {
  const n = rooms.filter((r) => r.ref).length;
  const won = rooms.filter((r) => r.ref && r.won).length;
  if (!n) return 'No rooms were on your road this time.';
  if (n === 1) return won ? 'You won your one room.' : 'You did not win your one room.';
  if (won === n) return `You won all ${COUNT[n]} rooms.`;
  return `You won ${COUNT[won] === 'no' ? 'none' : COUNT[won]} of your ${COUNT[n]} rooms.`;
}

// The thank-you screen's one line: the rooms played and how many were won.
export function doneLine(rooms) {
  const n = rooms.filter((r) => r.ref).length;
  const won = rooms.filter((r) => r.ref && r.won).length;
  if (!n) return 'You walked the road without playing a room.';
  if (n === 1) return won ? 'You played one room and won it.' : 'You played one room.';
  return `You played ${COUNT[n]} rooms and won ${won === n ? `all ${COUNT[n]}` : won ? COUNT[won] : 'none'}.`;
}

// "I'm done": thank you, the one line, a soft fade (none with Reduce motion,
// by the stylesheet's .rm). The app window closes after; where the browser
// keeps an ordinary tab open, `open` is true and the screen says so and
// offers the ways back. actions: { freePlay, startOver }
export const CLOSE_TAB = 'You can close this tab now.';
export function doneView({ rooms, open = false, actions }) {
  return el('section', { class: 'screen done' }, [
    el('h1', { text: 'Thank you for playing' }),
    el('p', { class: 'lede done-line', text: doneLine(rooms) }),
    open ? el('p', { class: 'done-tab', text: CLOSE_TAB }) : null,
    open ? el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', text: 'Free play', tip: 'Play any room as often as you like', onclick: actions.freePlay }),
      el('button', { type: 'button', class: 'btn', text: 'Start over', tip: 'Starts the road again from Step 1. Saved levels stay', onclick: actions.startOver }),
    ]) : null,
  ]);
}

// actions: { freePlay, playAgain(ref, title), ownRoom, startOver, done,
// postcard(slot) (a room postcard, src/postcard.js; only for rooms that
// offer one) }; canReplay: this server can replay our kitchen photo's
// recorded answer
export function closingView({ rooms, mode, primaryLabel, actions, canReplay = false }) {
  const sends = mode === 'live' || mode === 'rehearsal';
  const roomName = (r) => (r.slot === OWN_SLOT ? 'your own room' : r.title);
  return el('section', { class: 'screen closing' }, [
    el('h1', { text: 'You’ve completed FRAME//PLAY' }),
    // what was won (the rooms on the road, whether or not their levels are
    // in memory), then what is below, in one line so four rooms still fit
    el('p', { class: 'lede' }, [
      el('strong', { class: 'won-line', text: wonLine(rooms) }),
      // a sample room on the road was drawn by code, so never "what the AI did"
      ' Here is how each was made.',
    ]),
    // the ways on, right under the won line: in the first view of a short
    // window (1280x800), before the four rooms
    el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', text: primaryLabel, tip: 'Play any room as often as you like', onclick: actions.freePlay }),
      el('button', { type: 'button', class: 'btn done-btn', text: 'I’m done', tip: 'Ends your visit with a thank-you, then closes the app', onclick: actions.done }),
      el('button', { type: 'button', class: 'btn', text: 'Try your own room', tip: `Back to Step ${OWN_STEP}, to make a room from a photo of your own, or use ours`, onclick: actions.ownRoom }),
      el('button', { type: 'button', class: 'btn', text: 'Start over', tip: 'Starts the road again from Step 1. Saved levels stay', onclick: actions.startOver }),
    ]),
    el('ul', { class: 'closing-rooms', 'aria-label': 'The rooms you played' }, rooms.map((r) => el('li', {}, [
      el('div', { class: 'closing-text' }, [
        // the room and what happened share a line where they fit, so four
        // rooms fit the screen
        el('div', { class: 'closing-head' }, [
          el('h2', { class: 'small-h', text: r.title ? `${r.heading}: ${r.title}` : r.heading }),
          el('p', { class: 'result', text: r.result }),
        ]),
        el('p', { class: 'ai', text: r.ai }),
      ]),
      // the visible words begin the accessible name: "Play again: The Desk
      // Top" (your own room by its row, as in REHEARSAL it carries a
      // sample's title)
      r.playable ? el('button', {
        type: 'button', class: 'btn', tip: `Play ${roomName(r)} again in free play`,
        onclick: () => actions.playAgain(r.ref, r.title),
      }, ['Play again', el('span', { class: 'sr-only', text: `: ${roomName(r)}` })]) : null,
      // a room postcard, a secondary beside Play again, never the primary
      r.postcard && actions.postcard ? el('button', {
        type: 'button', class: 'btn', tip: POSTCARD_TIP,
        onclick: () => actions.postcard(r.slot),
      }, [POSTCARD_BUTTON, el('span', { class: 'sr-only', text: `: ${roomName(r)}` })]) : null,
    ]))),
    sends || rooms[OWN_SLOT].ref ? null : el('p', { class: 'why', text: canReplay
      ? 'In MOCK no model reads a photo: your own room is a photo you mark yourself, or ours, with Meta’s recorded answer replayed.'
      : 'In MOCK no model reads a photo: your own room is a photo you mark yourself.' }),
  ]);
}
