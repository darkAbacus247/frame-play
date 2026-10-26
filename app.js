// FRAME//PLAY entry module: the road and its screens, the settings drawer,
// sound (on by default), the opt-in tour, welcome back and history.
import { loadRoom } from './src/rooms.js';
import { paintRoom } from './src/painter.js';
import { buildLevel, inputFromRoom, objectWords } from './src/level.js';
import { pictureFromRGBA } from './src/render.js';
import { mountPlay, mountReveal } from './src/game.js';
import { Synth } from './src/audio.js';
import { readPref, writePref, soundOn, setSound } from './src/store.js';
import { el, showCard, cardOpen, initTooltips, speak, hideTip } from './src/ui.js';
import * as R from './src/road.js';
import { tourStep, offerDue, shouldPulse } from './src/tour.js';
import { describeRoom, stepsAway, ROLE_WORDS } from './src/words.js';

const $ = (id) => document.getElementById(id);
const SAMPLES = [
  { id: 'desk', file: 'rooms/desk.json' },
  { id: 'living', file: 'rooms/living.json' },
];
export const DISCLOSURE = 'FRAME//PLAY was built during the Meta Global AI Developer Hackathon (October 26 to November 4, 2026). An earlier prototype informed the design; no prototype code is included. Built with AI assistance: Claude Code (Anthropic) wrote the code under my direction. Live rooms are read by Meta’s muse-spark-1.3 and sam-3.1 through the Meta Model API; sample rooms are drawn by code and labeled MOCK.';

const mq = (q) => (globalThis.matchMedia ? globalThis.matchMedia(q) : { matches: false, addEventListener() {} });
const sysReduced = mq('(prefers-reduced-motion: reduce)');
const sysContrast = mq('(prefers-contrast: more)');

const A = {
  mode: 'mock',
  modeWhy: '',
  road: R.newRoad(),
  samples: new Map(),
  view: null,
  reveals: [],
  free: null,
  renderToken: 0,
  drawerOpen: false,
  firstVisit: false,
  pulsed: false,
  tour: { on: false, offered: false, lastProgress: Date.now() },
};

const audio = new Synth();
audio.setOn(soundOn());
const unlock = () => audio.unlock();
document.addEventListener('pointerdown', unlock, { capture: true });
document.addEventListener('keydown', unlock, { capture: true });

// ---- settings ----
function reducedMotion() { const p = readPref('motion', null); return p === null ? sysReduced.matches : p === 'off'; }
function highContrast() { const p = readPref('contrast', null); return p === null ? sysContrast.matches : p === 'on'; }
function outlinesOn() { return readPref('outlines', true) !== false; }
function uiFlags() { return { outlines: outlinesOn(), reducedMotion: reducedMotion(), highContrast: highContrast(), dim: highContrast() }; }
function applyClasses() {
  $('app').classList.toggle('rm', reducedMotion());
  $('app').classList.toggle('hc', highContrast());
}
function applySettings() {
  applyClasses();
  renderDock();
  renderDrawer();
  for (const r of A.reveals) r.redraw();
}
function setSoundOn(on) {
  audio.setOn(on);
  setSound(on);
  if (on) { audio.unlock(); audio.play('tick'); }
  renderDock();
  renderDrawer();
  say(on ? 'Sound on' : 'Sound off');
}

// ---- the live region ----
function say(text) {
  const live = $('live');
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
}

// ---- rooms ----
async function sample(id) {
  if (A.samples.has(id)) return A.samples.get(id);
  const meta = SAMPLES.find((s) => s.id === id);
  if (!meta) throw new Error('unknown sample room');
  const res = await fetch(meta.file);
  const room = loadRoom(await res.json());
  const painted = paintRoom(room);
  const entry = {
    room,
    picture: pictureFromRGBA(room.width, room.height, painted.rgba),
    built: buildLevel(inputFromRoom(room)),
  };
  A.samples.set(id, entry);
  return entry;
}

async function levelFor(ref) {
  if (ref && ref.kind === 'sample') return sample(ref.id);
  return null;
}

// ---- the road ----
function saveRoad() { writePref('road', A.road); }

function progress() {
  A.tour.lastProgress = Date.now();
  hideOffer();
}

function setRoad(next, { push = true } = {}) {
  if (!next || next === A.road) return;
  const changed = next.step !== A.road.step;
  A.road = next;
  saveRoad();
  progress();
  if (changed) {
    if (push) try { history.pushState({ step: next.step }, '', `#step-${next.step}`); } catch { /* history blocked */ }
    render();
  } else {
    renderHeader();
  }
}

function stopViews() {
  if (A.view) { A.view.destroy(); A.view = null; }
  for (const r of A.reveals) r.destroy();
  A.reveals = [];
}

function renderHeader() {
  const r = A.road;
  $('lap').textContent = R.lapText(r);
  const fw = R.canForward(r);
  const back = el('button', {
    type: 'button', class: 'btn icon-btn', 'aria-label': 'Back one step', tip: 'Back one step on the road',
    disabled: !R.canBack(r), onclick: () => setRoad(R.back(A.road)),
  }, [el('span', { 'aria-hidden': 'true', text: '←' })]);
  const counter = el('span', { class: 'counter', text: R.counterText(r) });
  const next = el('button', {
    type: 'button', class: 'btn icon-btn', 'aria-label': 'Forward one step', tip: 'Forward one step on the road',
    disabled: !fw.ok, onclick: () => setRoad(R.forward(A.road)),
  }, [el('span', { 'aria-hidden': 'true', text: '→' })]);
  const why = el('span', { class: 'why', text: fw.ok || r.step >= R.FREE_PLAY ? '' : fw.why });
  const pulse = !A.pulsed && shouldPulse({ firstVisit: A.firstVisit, reducedMotion: reducedMotion() });
  A.pulsed = true;
  const tourBtn = el('button', {
    type: 'button', class: `btn quiet tour-btn${pulse ? ' pulse-once' : ''}`, 'aria-pressed': String(A.tour.on),
    tip: A.tour.on ? 'Ends the tour' : 'A short guided tour, one step at a time',
    text: A.tour.on ? 'End the tour' : 'Take the tour', onclick: toggleTour,
  });
  $('road').replaceChildren(back, counter, next, why, tourBtn);
}

function renderDock() {
  $('dock').replaceChildren(
    el('button', {
      type: 'button', class: 'btn', 'aria-expanded': String(A.drawerOpen), 'aria-controls': 'drawer',
      tip: A.drawerOpen ? 'Close the settings' : 'Open the settings', onclick: toggleDrawer,
    }, [el('span', { 'aria-hidden': 'true', text: '⚙' }), el('span', { text: 'Settings' })]),
    el('button', {
      type: 'button', class: 'btn', 'aria-pressed': String(audio.on), tip: 'Turns every sound on or off',
      onclick: () => setSoundOn(!audio.on), text: `Sound: ${audio.on ? 'on' : 'off'}`,
    }),
    el('span', { class: `mode-chip ${A.mode}`, text: A.mode.toUpperCase() }),
    el('span', { class: 'mark', text: 'FRAME//PLAY' }),
  );
}

function toggleDrawer() {
  A.drawerOpen = !A.drawerOpen;
  renderDock();
  renderDrawer();
  if (A.drawerOpen) $('drawer').querySelector('button')?.focus();
}

function sw(label, on, onToggle, tipText) {
  return el('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(on), tip: tipText, onclick: onToggle }, [
    el('span', { class: 'switch-label', text: label }),
    el('span', { class: 'switch-state', text: on ? 'On' : 'Off' }),
  ]);
}

function renderDrawer() {
  const d = $('drawer');
  d.hidden = !A.drawerOpen;
  if (!A.drawerOpen) { d.replaceChildren(); return; }
  d.replaceChildren(
    el('h2', { text: 'Settings' }),
    el('div', { class: 'settings' }, [
      sw('Sound', audio.on, () => setSoundOn(!audio.on), 'Turns every sound on or off'),
      sw('Motion', !reducedMotion(), () => { writePref('motion', reducedMotion() ? 'on' : 'off'); applySettings(); }, 'Animations such as the outlines drawing in and the walk bob'),
      sw('High contrast', highContrast(), () => { writePref('contrast', highContrast() ? 'off' : 'on'); applySettings(); }, 'Thicker lines, opaque badges and a dimmed picture'),
      sw('Show outlines while playing', outlinesOn(), () => { writePref('outlines', !outlinesOn()); applySettings(); }, 'Draws the outlines the AI found while you play'),
      el('button', { type: 'button', class: 'btn', text: 'Read this screen aloud', tip: 'Reads the main words on this screen', onclick: readScreen }),
      el('button', { type: 'button', class: 'btn', text: 'Start over from Step 1', tip: 'Starts the road again. Saved levels stay', onclick: startOver }),
    ]),
    el('h3', { text: 'About' }),
    el('p', { class: 'about', text: DISCLOSURE }),
    el('p', { class: 'about', text: 'MIT license. No accounts, cookies, analytics or trackers.' }),
    el('div', { class: 'actions' }, [el('button', { type: 'button', class: 'btn', text: 'Close settings', onclick: toggleDrawer })]),
  );
}

function readScreen() {
  const text = $('main').innerText.replace(/\s+/g, ' ').trim().slice(0, 2400);
  if (!speak(text)) say('Reading aloud is not available in this browser.');
}

function startOver() {
  stopTour();
  A.free = null;
  A.drawerOpen = false;
  setRoad(R.newRoad());
  renderDock();
  renderDrawer();
  say('Started over from Step 1.');
}

// ---- screens ----
async function render() {
  stopViews();
  hideTip();
  renderHeader();
  renderDock();
  renderDrawer();
  const main = $('main');
  main.scrollTop = 0;
  const token = ++A.renderToken;
  const s = A.road.step;
  try {
    if (s === 1) screenWelcome(main);
    else if (s === 2 || s === 5) await screenRoom(main, s === 2 ? 0 : 1, token);
    else if (s === 3 || s === 6) await screenFound(main, s === 3 ? 0 : 1, token);
    else if (s === 4 || s === 7) await screenPlay(main, s === 4 ? 0 : 1, null, token);
    else if (s === 8) await screenTwo(main, token);
    else await screenFree(main, token);
  } catch (e) {
    if (token === A.renderToken) main.replaceChildren(el('p', { text: `Something went wrong: ${e.message}` }));
  }
  if (token !== A.renderToken) return;
  const h = main.querySelector('h1');
  if (h && !main.querySelector('.game')) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  updateTour();
}

function screenWelcome(main) {
  const where = {
    mock: 'This page is in MOCK mode: no photo is sent anywhere, and you play sample rooms drawn by code.',
    live: 'In LIVE mode your photo is shrunk on this device and its camera data is removed. It is then sent once, through this app’s server, to Meta’s Model API to read the room. It is not stored.',
    rehearsal: 'This page is in REHEARSAL mode: a local stand-in answers, not Meta, and no photo leaves this machine.',
  }[A.mode];
  main.replaceChildren(el('section', { class: 'screen sparse welcome' }, [
    el('h1', { text: 'Photograph your room. Play it.' }),
    el('p', { text: 'FRAME//PLAY turns one photo of a room or a desk top into a small game. The outlines of the real objects become the walls you walk around, the things you collect, the hazard you avoid and the exit.' }),
    el('ul', { class: 'consent' }, [
      el('li', { text: 'Keep people and anything private out of the photo.' }),
      el('li', { text: 'You must be 18 or over to send a photo (Meta’s terms).' }),
      el('li', { text: where }),
      el('li', { text: 'Kept: no photo, anywhere. Levels made from your photos (outlines, names and roles, never the photo) stay on this device, with your step, sound and tour choices.' }),
    ]),
    el('div', { class: 'welcome-bar' }, [
      el('button', {
        type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary',
        tip: 'Agree and go to Step 2', text: R.primaryLabel(A.road), onclick: () => setRoad(R.giveConsent(A.road)),
      }),
    ]),
  ]));
}

function photoOffWords() {
  if (A.mode === 'live') return null;
  if (A.mode === 'rehearsal') return 'Off in REHEARSAL: the stand-in reads only its own sample room.';
  return 'Off in MOCK mode: there is no live connection, so the page plays sample rooms drawn by code.';
}

function roomCard(entry, { disabledWhy, onPick, tour = true }) {
  const thumb = el('canvas', { class: 'thumb', width: '320', height: '240', 'aria-hidden': 'true' });
  thumb.getContext('2d').drawImage(entry.picture, 0, 0, 320, 240);
  return el('button', {
    type: 'button', class: 'room-card', 'data-tour': tour ? 'room-card' : null, disabled: !!disabledWhy,
    tip: disabledWhy || `Play ${entry.room.title}`, onclick: onPick,
  }, [
    thumb,
    el('span', { class: 'room-title', text: entry.room.title }),
    el('span', { class: 'tag mock', text: 'MOCK · sample room' }),
    disabledWhy ? el('span', { class: 'why', text: disabledWhy }) : null,
  ]);
}

async function screenRoom(main, slot, token) {
  const off = photoOffWords();
  const cards = el('div', { class: 'room-cards' });
  main.replaceChildren(el('section', { class: 'screen' }, [
    el('h1', { text: slot === 0 ? 'Your room: pick a photo' : 'Another room: pick a second photo' }),
    el('p', { class: 'advice', text: 'Objects with clear edges on a plain floor or desk work best. No people.' }),
    el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn', disabled: !!off, text: 'Choose a photo', tip: 'Pick a photo of a room or a desk top' }),
      off ? el('span', { class: 'why', text: off }) : null,
    ]),
    el('h2', { text: 'Sample rooms' }),
    cards,
  ]));
  const other = slot === 1 ? A.road.rooms[0] : null;
  for (const s of SAMPLES) {
    const entry = await sample(s.id);
    if (token !== A.renderToken) return;
    const used = other && other.kind === 'sample' && other.id === s.id;
    cards.append(roomCard(entry, {
      disabledWhy: used ? 'Already your first room' : null,
      onPick: () => setRoad(R.chooseRoom(A.road, slot, { kind: 'sample', id: s.id })),
    }));
  }
}

const SOURCE_WORDS = {
  exact: 'exact outline, drawn by code',
  sam_mask: 'SAM’s own mask',
  traced_in_box: 'traced by code inside SAM’s box',
  box: 'SAM’s box (the trace was not tight enough)',
};

function summaryLine(level) {
  if (level.origin === 'mock') {
    return 'This sample room was drawn by code: no model was called, and its outlines are the exact shapes code painted. Code proved the room can be won.';
  }
  const c = level.provenance.outline_sources || {};
  const n = level.objects.length;
  return `Muse Spark named the things in your room and gave each a role. SAM 3.1 found ${n} of them. Code traced ${c.traced_in_box || 0} outlines inside SAM’s boxes and kept ${c.box || 0} as boxes, then proved the room can be won.`;
}

function proofLine(level) {
  const names = level.proof.order.map((id) => objectWords(level, level.objects.findIndex((o) => o.id === id)));
  const last = names.pop();
  return `Proof: every goal can be reached. The shortest route that collects everything and then exits is ${level.proof.route_length.toLocaleString('en')} px: ${names.join(', ')}, then the ${last}.`;
}

function describeSection(section, level, rt, state) {
  if (!section.hidden) { section.hidden = true; return; }
  const pos = state ? state.pos : level.start;
  const lines = describeRoom(level, rt, state, stepsAway(level, rt, pos[0], pos[1]));
  section.replaceChildren(
    el('h3', { text: 'This room, in words' }),
    el('ul', {}, lines.map((t) => el('li', { text: t }))),
    el('button', { type: 'button', class: 'btn', text: 'Read aloud', tip: 'Reads the description aloud', onclick: () => { if (!speak(lines.join(' '))) say('Reading aloud is not available in this browser.'); } }),
  );
  section.hidden = false;
}

async function screenFound(main, slot, token) {
  const entry = await levelFor(A.road.rooms[slot]);
  if (token !== A.renderToken) return;
  if (!entry || entry.built.error) {
    main.replaceChildren(el('section', { class: 'screen sparse' }, [el('h1', { text: 'No level from this picture' }), el('p', { text: entry ? entry.built.error : 'This room is not on this device any more.' })]));
    return;
  }
  const { level, rt } = entry.built;
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
      for (const r of A.reveals) r.setWalls(walls);
    },
  });
  const changes = level.changes_by_code.length
    ? el('ul', { class: 'changes' }, level.changes_by_code.map((c) => el('li', { text: `${c.what}: ${c.why}.` })))
    : el('p', { text: 'None: the room could be won as read.' });
  main.replaceChildren(el('section', { class: 'screen found' }, [
    el('h1', { text: 'What the AI found' }),
    el('div', { class: 'found-grid' }, [
      pic,
      el('div', { class: 'found-info' }, [
        el('p', { class: 'summary', text: summaryLine(level) }),
        el('div', { class: 'actions' }, [
          el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', tip: 'Start playing this room', text: 'Play this room', onclick: () => setRoad(R.startPlay(A.road)) }),
          el('button', { type: 'button', class: 'btn', text: 'Describe this room', tip: 'Every object, its role and where it is, in words', onclick: () => describeSection(desc, level, rt, null) }),
          wallsBtn,
        ]),
        desc,
        list,
        el('p', { class: 'proof', text: proofLine(level) }),
        el('h2', { class: 'small-h', text: 'Changes by code' }),
        changes,
        el('p', { class: 'level-label', text: level.label }),
      ]),
    ]),
  ]));
  A.reveals.push(mountReveal(pic, { level, rt, picture: entry.picture, ui: uiFlags, maxHeight: () => Math.max(220, $('main').clientHeight - 120) }));
}

async function screenPlay(main, slot, ref, token) {
  const entry = await levelFor(ref || A.road.rooms[slot]);
  if (token !== A.renderToken) return;
  if (!entry || entry.built.error) {
    main.replaceChildren(el('p', { text: entry ? entry.built.error : 'This room is not on this device any more.' }));
    return;
  }
  const { level, rt } = entry.built;
  const desc = el('section', { class: 'describe', hidden: true, 'aria-live': 'polite' });
  const describeBtn = el('button', {
    type: 'button', class: 'btn', text: 'Describe this room', tip: 'Every object, its role, where it is and how far, in words',
    onclick: () => describeSection(desc, level, rt, A.view && A.view.state),
  });
  A.view = mountPlay(main, {
    level, rt, picture: entry.picture, audio,
    say: (t) => { say(t); progress(); },
    ui: uiFlags,
    sideExtras: [describeBtn, desc],
    onEnd: (r) => endOfRound(slot, r, level),
  });
  A.view.focusGame();
}

function endOfRound(slot, r, level) {
  progress();
  if (r.status !== 'won') audio.play('loss');
  say(r.words.title);
  const free = A.road.step === R.FREE_PLAY;
  if (!free) {
    A.road = R.finishRound(A.road, slot, r);
    saveRoad();
    renderHeader();
  }
  const again = {
    label: r.status === 'won' ? 'Play this room again' : 'Try again',
    onClick: () => { if (A.view) { A.view.restart(); A.view.focusGame(); } updateTour(); },
  };
  const pickOther = {
    label: A.mode === 'live' ? 'New photo' : 'Pick another room',
    onClick: () => {
      if (free) { A.free = null; render(); return; }
      setRoad({ ...A.road, step: slot === 0 ? 2 : 5 });
    },
  };
  const primary = free
    ? { label: 'Back to free play', onClick: () => { A.free = null; render(); } }
    : { label: R.primaryLabel(A.road), onClick: () => setRoad(R.continueAfterRound(A.road)) };
  showCard($('card'), { title: r.words.title, lines: [r.words.body], label: level.label, primary, secondary: [again, pickOther] });
  clearVeil();
}

async function screenTwo(main, token) {
  const cards = el('div', { class: 'two-rooms' });
  main.replaceChildren(el('section', { class: 'screen' }, [
    el('h1', { text: 'Your two rooms' }),
    cards,
    el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', tip: 'Play any room as often as you like', text: 'Free play', onclick: () => setRoad(R.startFreePlay(A.road)) }),
    ]),
  ]));
  for (const slot of [0, 1]) {
    const ref = A.road.rooms[slot];
    const entry = await levelFor(ref);
    if (token !== A.renderToken) return;
    if (!entry || entry.built.error) continue;
    const { level, rt } = entry.built;
    const best = A.road.best[slot];
    const pic = el('div', { class: 'two-pic' });
    cards.append(el('article', { class: 'room-sum' }, [
      pic,
      el('h2', { text: level.title }),
      el('p', { text: `Objects found: ${level.objects.length} · Shortest route: ${level.proof.route_length.toLocaleString('en')} px` }),
      el('p', { text: best == null ? 'Your best: not won yet' : best <= 1.05 ? 'Your best: the shortest route' : `Your best: ${best.toFixed(1)} times the shortest` }),
      el('p', { class: 'level-label', text: level.label }),
      el('div', { class: 'actions' }, [
        el('button', { type: 'button', class: 'btn', text: 'Play again', tip: `Play ${level.title} again in free play`, onclick: () => { A.free = ref; setRoad(R.startFreePlay(A.road)); } }),
      ]),
    ]));
    A.reveals.push(mountReveal(pic, { level, rt, picture: entry.picture, ui: uiFlags, maxHeight: () => Math.max(160, Math.min(320, $('main').clientHeight - 260)) }));
  }
}

async function screenFree(main, token) {
  if (A.free) return screenPlay(main, -1, A.free, token);
  const cards = el('div', { class: 'room-cards' });
  main.replaceChildren(el('section', { class: 'screen' }, [
    el('h1', { text: 'Free play' }),
    el('p', { text: 'Pick any room. Rounds here do not change your road.' }),
    cards,
  ]));
  for (const s of SAMPLES) {
    const entry = await sample(s.id);
    if (token !== A.renderToken) return;
    cards.append(roomCard(entry, { onPick: () => { A.free = { kind: 'sample', id: s.id }; render(); } }));
  }
}

// ---- the tour ----
let veil = [];
function clearVeil() {
  for (const v of veil) v.remove();
  veil = [];
  for (const e of document.querySelectorAll('.tour-lit')) e.classList.remove('tour-lit');
}

function lightControl() {
  if (!A.tour.on) { clearVeil(); return; }
  if (cardOpen()) { clearVeil(); return; }
  const t = tourStep(A.road.step);
  if (!t) return;
  const sel = t.target === 'primary' ? '#main [data-primary]' : `#main [data-tour="${t.target}"]:not([disabled])`;
  const c = document.querySelector(sel);
  clearVeil();
  if (!c) return;
  c.classList.add('tour-lit');
  const app = $('app').getBoundingClientRect();
  const r = c.getBoundingClientRect();
  const m = 6;
  const hole = { l: r.left - m - app.left, t: r.top - m - app.top, r: r.right + m - app.left, b: r.bottom + m - app.top };
  const W = app.width, H = app.height;
  const parts = [
    [0, 0, W, Math.max(0, hole.t)],
    [0, hole.b, W, Math.max(0, H - hole.b)],
    [0, hole.t, Math.max(0, hole.l), hole.b - hole.t],
    [hole.r, hole.t, Math.max(0, W - hole.r), hole.b - hole.t],
  ];
  for (const [x, y, w, h] of parts) {
    const v = el('div', { class: 'veil', 'aria-hidden': 'true' });
    v.style.left = `${x}px`; v.style.top = `${y}px`; v.style.width = `${w}px`; v.style.height = `${h}px`;
    $('app').append(v);
    veil.push(v);
  }
}

function updateTour() {
  const strip = $('tour-strip');
  if (!A.tour.on) {
    if (!strip.querySelector('.offer')) strip.replaceChildren();
    clearVeil();
    return;
  }
  const t = tourStep(A.road.step);
  strip.replaceChildren(el('div', { class: 'inner' }, [
    el('p', { class: 'tour-line', text: t ? t.line : '' }),
    el('button', { type: 'button', class: 'btn', text: 'Speak this line', tip: 'Reads this line aloud', onclick: () => { if (!speak(t.line)) say(t.line); } }),
    el('button', { type: 'button', class: 'btn', text: 'Skip the tour', tip: 'Ends the tour', onclick: stopTour }),
  ]));
  requestAnimationFrame(lightControl);
}

function startTour() {
  A.tour.on = true;
  writePref('tour', true);
  hideOffer();
  renderHeader();
  updateTour();
  say('Tour on. ' + (tourStep(A.road.step) || { line: '' }).line);
}

function stopTour() {
  if (!A.tour.on) return;
  A.tour.on = false;
  writePref('tour', false);
  clearVeil();
  $('tour-strip').replaceChildren();
  renderHeader();
}

function toggleTour() {
  if (A.tour.on) stopTour(); else startTour();
}

function hideOffer() {
  const o = $('tour-strip').querySelector('.offer');
  if (o) $('tour-strip').replaceChildren();
}

function showOffer() {
  A.tour.offered = true;
  $('tour-strip').replaceChildren(el('div', { class: 'inner offer' }, [
    el('p', { text: 'New here? Take the tour.' }),
    el('button', { type: 'button', class: 'btn', text: 'Take the tour', onclick: startTour }),
    el('button', { type: 'button', class: 'btn quiet', text: 'Not now', onclick: hideOffer }),
  ]));
}

setInterval(() => {
  if (offerDue({ now: Date.now(), lastProgress: A.tour.lastProgress, offered: A.tour.offered, tourOn: A.tour.on, cardOpen: cardOpen() })) showOffer();
  if (A.tour.on) lightControl();
}, 1000);
addEventListener('resize', () => { if (A.tour.on) lightControl(); });
$('main').addEventListener('scroll', () => { if (A.tour.on) lightControl(); }, { passive: true });

// ---- history: Back and Forward follow the road ----
addEventListener('popstate', (e) => {
  const s = e.state && e.state.step;
  if (!s || s === A.road.step || cardOpen()) return;
  let r = A.road;
  if (s < r.step) r = { ...r, step: s };
  else while (r.step < s && R.canForward(r).ok) r = R.forward(r);
  if (r.step !== A.road.step) setRoad(r, { push: false });
});

// ---- mode ----
async function detectMode() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch('api/health', { signal: ctl.signal, headers: { 'X-FramePlay-Request': '1' } });
    clearTimeout(t);
    if (!res.ok) throw new Error('no health');
    const h = await res.json();
    if (h && ['mock', 'live', 'rehearsal'].includes(h.mode)) {
      A.mode = h.mode;
      A.modeWhy = h.reason || '';
      A.health = h;
      return;
    }
    throw new Error('unknown health');
  } catch {
    A.mode = 'mock';
    A.modeWhy = 'No server answered, so this page runs MOCK only: the sample rooms drawn by code.';
  }
}

// ---- boot ----
async function boot() {
  initTooltips(() => A.tour.on);
  A.firstVisit = readPref('visited', null) === null;
  writePref('visited', true);
  A.tour.on = readPref('tour', false) === true;
  applyClasses();
  await detectMode();
  const saved = R.sanitizeRoad(readPref('road', null));
  if (saved && saved.step > 1) {
    A.road = R.newRoad();
    await render();
    showCard($('card'), {
      title: 'Welcome back',
      lines: ['Your road is saved on this device.'],
      primary: {
        label: `Continue where you left off (${R.counterText(saved)})`,
        onClick: () => { A.road = saved; saveRoad(); replaceHistory(); render(); },
      },
      secondary: [{
        label: 'Start fresh',
        onClick: () => { A.tour.on = false; writePref('tour', false); A.road = R.newRoad(); saveRoad(); replaceHistory(); render(); },
      }],
    });
    return;
  }
  replaceHistory();
  await render();
}

function replaceHistory() {
  try { history.replaceState({ step: A.road.step }, '', `#step-${A.road.step}`); } catch { /* history blocked */ }
}

sysReduced.addEventListener && sysReduced.addEventListener('change', applySettings);
sysContrast.addEventListener && sysContrast.addEventListener('change', applySettings);

boot().catch((e) => {
  $('main').textContent = `Something went wrong while loading: ${e.message}`;
});
