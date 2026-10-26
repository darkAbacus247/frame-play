// FRAME//PLAY entry module: the road and its screens, the settings drawer,
// sound (on by default), the opt-in tour, welcome back and history.
import { loadRoom } from './src/rooms.js';
import { paintRoom } from './src/painter.js';
import { buildLevel, inputFromRoom, validateLevel } from './src/level.js';
import { pictureFromRGBA, fitSize } from './src/render.js';
import { mountPlay, mountReveal } from './src/game.js';
import { Synth } from './src/audio.js';
import { readPref, writePref, soundOn, setSound } from './src/store.js';
import * as S from './src/store.js';
import { el, showCard, cardOpen, initTooltips, speak, hideTip, holdBar, reserveHeight, ceilH, floorW, spaceH } from './src/ui.js';
import * as R from './src/road.js';
import { tourStep, offerDue, offerFits, shouldPulse, veilRects } from './src/tour.js';
import { describeRoom, stepsAway } from './src/words.js';
import { acceptReply } from './src/reply.js';
import { readPhoto, previewPhoto, sendPhoto, canvasJpeg, decodeToCanvas, pixelsOf } from './src/photo.js';
import { levelFromReply, makeOwnRoom, signature } from './src/own.js';
import {
  welcomeView, pickView, roomCardView, foundView, revealHeight, compareView, roomSumView, roomGoneView,
  freeView, ownView, ownResult, closingRooms, closingView, more, photoInput,
} from './src/screens.js';

const $ = (id) => document.getElementById(id);
const SAMPLES = [
  { id: 'desk', file: 'rooms/desk.json' },
  { id: 'living', file: 'rooms/living.json' },
];
export const DISCLOSURE = 'FRAME//PLAY was built during the Meta Global AI Developer Hackathon (October 26 to Nov. 4, 2026). An earlier prototype informed the design; no prototype code is included. Built with AI assistance: Claude Code (Anthropic) wrote the code under my direction. Live rooms are read by Meta’s muse-spark-1.3 and sam-3.1 through the Meta Model API; sample rooms are drawn by code and labeled MOCK.';

const mq = (q) => (globalThis.matchMedia ? globalThis.matchMedia(q) : { matches: false, addEventListener() {} });
const sysReduced = mq('(prefers-reduced-motion: reduce)');
const sysContrast = mq('(prefers-contrast: more)');

const A = {
  mode: 'mock',
  modeWhy: '',
  road: R.newRoad(),
  samples: new Map(),
  live: new Map(), // levels made through the live path this visit, by refKey
  busy: false,
  view: null,
  reveals: [],
  free: null,
  renderToken: 0,
  drawerOpen: false,
  firstVisit: false,
  pulsed: false,
  headerStep: 0, // the step the header was last drawn for
  missingWhy: null, // the header's reason while a room's level is missing
  tour: { on: false, offered: false, lastProgress: Date.now(), notOn: null },
};

const audio = new Synth();
audio.setOn(soundOn());
const unlock = () => audio.unlock();
document.addEventListener('pointerdown', unlock, { capture: true });
document.addEventListener('keydown', unlock, { capture: true });

// ---- settings ----
const reducedMotion = () => S.reducedMotion(sysReduced.matches);
const highContrast = () => S.highContrast(sysContrast.matches);
const outlinesOn = () => S.outlinesWhilePlaying();
function uiFlags() { return { outlines: outlinesOn(), reducedMotion: reducedMotion(), highContrast: highContrast(), dim: highContrast() }; }
function applyClasses() {
  // on the root, so the end cards and tooltips outside #app follow too
  document.documentElement.classList.toggle('rm', reducedMotion());
  document.documentElement.classList.toggle('hc', highContrast());
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
    // how its picture looks, so a rehearsal knows the sample's own picture
    sig: signature({ width: room.width, height: room.height, data: painted.rgba }),
  };
  A.samples.set(id, entry);
  return entry;
}

function refKey(ref) {
  return ref.kind === 'photo' ? `photo:${ref.sha256}` : `${ref.kind}:${ref.id}`;
}

async function levelFor(ref) {
  if (!ref) return null;
  if (ref.kind === 'sample') return sample(ref.id);
  return A.live.get(refKey(ref)) || null;
}

// ---- the live path (and its rehearsal) ----
// A level kept on this device for this photo: validated again (a stored
// proof is never trusted) against the very copy just made.
function storedEntry(photo) {
  const kept = S.loadLevel(photo.sha256);
  if (!kept) return null;
  const level = kept.level;
  if (level.picture.width !== photo.width || level.picture.height !== photo.height) return null;
  const v = validateLevel(level);
  if (!v.ok) return null;
  level.proof = v.proof;
  return { picture: photo.picture, built: { level, rt: v.rt }, summary: kept.summary || null, fromDevice: true };
}

function setBusy(on) {
  A.busy = on;
  for (const b of document.querySelectorAll('#main button, #road button')) {
    if (on) { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; } else if (b.dataset.wasDisabled === '') b.disabled = false;
  }
}

function progressPanel(panel, lines, current, error) {
  panel.hidden = false;
  panel.replaceChildren(
    el('ol', { class: 'progress-lines' }, lines.map((t, i) => el('li', {
      class: i < current ? 'done' : i === current && !error ? 'now' : 'todo',
      text: `${t}${i < current ? ' · done' : i === current && !error ? '…' : ''}`,
    }))),
    error ? el('p', { class: 'error', role: 'alert', text: error }) : null,
  );
}

const LIVE_LINES = ['Reading your room', 'Finding every object', 'Tracing the outlines'];

const NOT_SAME = 'That is not the photo this room was made from.';

// inPlace: the room is already on the road (its level was not in memory):
// it is made again on the same step, never by moving the counter back.
async function runLivePath(slot, panel, make, { inPlace = false } = {}) {
  if (A.busy) return;
  setBusy(true);
  let step = 0;
  progressPanel(panel, LIVE_LINES, step);
  try {
    const { ref, entry } = await make((words) => {
      const i = LIVE_LINES.indexOf(words);
      if (i >= 0) { step = i; progressPanel(panel, LIVE_LINES, step); say(words); }
    });
    if (entry.built.error) throw new Error(entry.built.error);
    if (inPlace && !R.sameRef(ref, A.road.rooms[slot])) throw new Error(`${NOT_SAME} Pick the same photo, or use ← to go back to Step ${R.PICK_STEPS[slot]} for another room.`);
    A.live.set(refKey(ref), entry);
    setBusy(false);
    if (inPlace) render();
    else setRoad(R.chooseRoom(A.road, slot, ref));
  } catch (e) {
    setBusy(false);
    progressPanel(panel, LIVE_LINES, step, inPlace ? e.message : `${e.message} You can try another photo, or play a sample room below.`);
    say(e.message);
  }
}

async function readThroughServer(blob, copy, picture, pictureRef, onWords) {
  const reply = await sendPhoto(blob, (m) => onWords(m.words));
  const ok = acceptReply(A.mode, reply, copy);
  if (!ok.ok) throw new Error(ok.why);
  onWords('Tracing the outlines');
  await new Promise((r) => setTimeout(r, 0)); // let the words show
  return levelFromReply(reply, picture, pixelsOf(picture), pictureRef);
}

function choosePhoto(slot, file, panel, opts) {
  return runLivePath(slot, panel, async (onWords) => {
    const photo = await readPhoto(file);
    const ref = { kind: 'photo', sha256: photo.sha256 };
    const kept = storedEntry(photo);
    if (kept) {
      say('This photo’s level was on this device: no model was called.');
      return { ref, entry: kept };
    }
    const entry = await readThroughServer(photo.blob, photo, photo.picture, { kind: 'photo', sha256: photo.sha256 }, onWords);
    if (!entry.built.error) S.saveLevel(photo.sha256, entry.built.level, { summary: entry.summary });
    return { ref, entry };
  }, opts);
}

// Rehearsal: the stand-in's own sample picture goes through the live path,
// so a stand-in level is never drawn over a photo.
function rehearseRoom(slot, id, panel, opts) {
  return runLivePath(slot, panel, async (onWords) => {
    const s = await sample(id);
    const blob = await canvasJpeg(s.picture);
    const picture = await decodeToCanvas(blob, s.room.width, s.room.height);
    const entry = await readThroughServer(blob, { width: s.room.width, height: s.room.height }, picture, { kind: 'sample', id }, onWords);
    return { ref: { kind: 'rehearsal', id }, entry };
  }, opts);
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
  // on the same step (a round ending, the tour switched) the header keeps
  // its height, so the board and the end card over it do not move
  reserveHeight($('top'), A.headerStep === r.step);
  A.headerStep = r.step;
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
  // a room whose level is missing names the way on that this screen offers
  const why = el('span', { class: 'why', text: fw.ok || r.step >= R.FREE_PLAY ? '' : A.missingWhy || fw.why });
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
      sw('Motion', !reducedMotion(), () => { S.setMotion(reducedMotion()); applySettings(); }, 'Animations such as the outlines drawing in and the walk bob'),
      sw('High contrast', highContrast(), () => { S.setContrast(!highContrast()); applySettings(); }, 'Thicker lines, opaque badges and a dimmed picture'),
      sw('Show outlines while playing', outlinesOn(), () => { S.setOutlinesWhilePlaying(!outlinesOn()); applySettings(); }, 'Draws the outlines the AI found while you play'),
      el('button', { type: 'button', class: 'btn', text: 'Read this screen aloud', tip: 'Reads the main words on this screen', onclick: readScreen }),
      el('button', { type: 'button', class: 'btn', text: 'Start over from Step 1', tip: 'Starts the road again. Saved levels stay', onclick: startOver }),
    ]),
    more('About FRAME//PLAY', [
      el('p', { class: 'about', text: DISCLOSURE }),
      el('p', { class: 'about', text: 'MIT license. No accounts, cookies, analytics or trackers.' }),
    ], 'about-more'),
    el('div', { class: 'actions' }, [el('button', { type: 'button', class: 'btn', text: 'Close settings', tip: 'Closes this drawer', onclick: toggleDrawer })]),
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
  // a free-play replay lasts only while Free play is on screen: every way
  // off it (←, the browser's Back and Forward, the welcome-back card) ends it
  if (A.road.step !== R.FREE_PLAY) A.free = null;
  stopViews();
  hideTip();
  A.missingWhy = null;
  renderHeader();
  renderDock();
  renderDrawer();
  const main = $('main');
  main.scrollTop = 0;
  const token = ++A.renderToken;
  const s = A.road.step;
  const kind = R.stepKind(s);
  const slot = R.slotOf(s);
  try {
    if (kind === 'welcome') screenWelcome(main);
    else if (kind === 'pick') await screenRoom(main, slot, token);
    else if (kind === 'found') await screenFound(main, slot, token);
    else if (kind === 'play') await screenPlay(main, slot, null, token);
    else if (kind === 'two') await screenTwo(main, token);
    else if (kind === 'own') await screenOwn(main, token);
    else if (kind === 'end') await screenEnd(main, token);
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
  const { section, bar } = welcomeView({ mode: A.mode, primaryLabel: R.primaryLabel(A.road), onConsent: () => setRoad(R.giveConsent(A.road)) });
  main.replaceChildren(section);
  holdBar(section, bar);
}

function photoOffWords() {
  if (A.mode === 'live') return null;
  if (A.mode === 'rehearsal') return 'Off in REHEARSAL: the stand-in reads only its own sample room, so no photo is ever sent.';
  if (!A.health) return `Off: ${A.modeWhy}`;
  return 'Off in MOCK mode: there is no live connection, so the page plays sample rooms drawn by code.';
}

function roomCard(entry, { disabledWhy, onPick, tour = true }) {
  const level = entry.built.level;
  return roomCardView({
    title: entry.room ? entry.room.title : level.title, origin: level.origin, disabledWhy, onPick, tour,
    draw: (thumb) => {
      // a photo of another shape keeps its shape, centred
      const f = fitSize(320, 240, entry.picture.width, entry.picture.height);
      thumb.getContext('2d').drawImage(entry.picture, (320 - f.cssW) / 2, (240 - f.cssH) / 2, f.cssW, f.cssH);
    },
  });
}

async function screenRoom(main, slot, token) {
  const rehearsal = A.mode === 'rehearsal' && A.health && A.health.rehearsal ? A.health.rehearsal.room : null;
  const view = pickView({
    slot, off: photoOffWords(), onFile: (f) => choosePhoto(slot, f, view.panel),
    rehearse: rehearsal && SAMPLES.some((x) => x.id === rehearsal) ? {
      label: 'Rehearse the live path',
      tip: `Sends the ${rehearsal} sample picture to the local stand-in, not Meta, and builds its level the live way`,
      onClick: () => rehearseRoom(slot, rehearsal, view.panel),
    } : null,
  });
  main.replaceChildren(view.section);
  const other = slot === 1 ? A.road.rooms[0] : null;
  for (const s of SAMPLES) {
    const entry = await sample(s.id);
    if (token !== A.renderToken) return;
    const used = other && other.kind === 'sample' && other.id === s.id;
    view.cards.append(roomCard(entry, {
      disabledWhy: used ? 'Already your first room' : null,
      onPick: () => setRoad(R.chooseRoom(A.road, slot, { kind: 'sample', id: s.id })),
    }));
  }
  if (A.busy) setBusy(true);
}

// A room on the road whose level is not in memory. It is made again here,
// on this same step, in the way this mode allows: a photo picked again (the
// photo itself is never stored), a rehearsal room sent through the stand-in
// again. Nothing here moves the counter back; where this mode cannot make
// the room, the way on is forward.
function missingRoom(main, slot) {
  const ref = A.road.rooms[slot];
  const panel = el('div', { class: 'progress', hidden: true, 'aria-live': 'polite' });
  const shown = el('div', { class: 'own-result', hidden: true });
  const sends = A.mode === 'live' || A.mode === 'rehearsal';
  const kids = [];
  const chooseAgain = (onFile, tip) => {
    const input = photoInput(onFile);
    return el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', text: 'Choose the same photo', tip, onclick: () => input.click() }),
      input,
    ]);
  };
  let why = null;
  if (ref && ref.kind === 'photo' && slot === 2 && sends) {
    // your own room, with every check its mode makes (src/own.js)
    kids.push(el('h1', { text: 'Pick your photo again' }),
      el('p', { text: A.mode === 'live'
        ? 'The photo itself is never stored. Choose the same photo: if its level was kept on this device it loads with no model call; if not, the photo is read again.'
        : 'The photo itself is never stored. Choose the same picture: if its level was kept on this device it loads from here; if not, the local stand-in reads it again.' }),
      chooseAgain((f) => ownPhoto(f, panel, shown, { inPlace: true }), 'Pick the same photo you made this room from'),
      panel, shown);
    why = 'Pick the same photo to play this room';
  } else if (ref && ref.kind === 'photo' && slot === 2) {
    kids.push(el('h1', { text: 'This room cannot load here' }),
      el('p', { text: 'This room was made with the live AI or the local stand-in. This copy runs in MOCK, so its level cannot load here.' }),
      el('div', { class: 'actions' }, [
        el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', text: 'Continue to the end', tip: 'On to the closing screen; your own room stays on the road', onclick: () => setRoad(R.passOwnRoom(A.road)) }),
      ]));
    why = 'Continue to the end to go on';
  } else if (ref && ref.kind === 'photo' && A.mode === 'live') {
    kids.push(el('h1', { text: 'Pick the same photo again' }),
      el('p', { text: 'The photo itself is never stored. Choose the same photo: if its level was kept on this device it loads with no model call; if not, the photo is read again.' }),
      chooseAgain((f) => choosePhoto(slot, f, panel, { inPlace: true }), 'Pick the same photo; nothing is sent if its level is on this device'),
      panel);
    why = 'Pick the same photo to play this room';
  } else if (ref && ref.kind === 'rehearsal' && A.mode === 'rehearsal') {
    kids.push(el('h1', { text: 'Rehearse this room again' }),
      el('p', { text: 'The stand-in’s level is made again on each visit.' }),
      el('div', { class: 'actions' }, [
        el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', text: 'Send it through the stand-in', tip: 'The local stand-in, not Meta', onclick: () => rehearseRoom(slot, ref.id, panel, { inPlace: true }) }),
      ]), panel);
    why = 'Send it through the stand-in to play this room';
  } else {
    kids.push(el('h1', { text: 'This room cannot load here' }),
      el('p', { text: `This copy cannot make this room again. Use ← to go back to Step ${R.PICK_STEPS[slot]} and pick a sample room.` }));
    why = `Go back to Step ${R.PICK_STEPS[slot]} to pick a room`;
  }
  main.replaceChildren(el('section', { class: 'screen sparse' }, kids));
  A.missingWhy = why;
  renderHeader();
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
  if (!entry) return missingRoom(main, slot);
  if (entry.built.error) {
    main.replaceChildren(el('section', { class: 'screen sparse' }, [el('h1', { text: 'No level from this picture' }), el('p', { text: entry.built.error })]));
    return;
  }
  const { level, rt } = entry.built;
  const { section, pic, info } = foundView({
    level, summary: entry.summary, fromDevice: entry.fromDevice,
    actions: {
      play: () => setRoad(R.startPlay(A.road)),
      describe: (desc) => describeSection(desc, level, rt, null),
      walls: (on) => { for (const r of A.reveals) r.setWalls(on); },
    },
  });
  main.replaceChildren(section);
  // the heading, the picture and the info's first lines fit main together
  // (src/ui.js: the space rounded down, what is taken from it rounded up,
  // so the picture never overshoots by a fraction of a pixel)
  const maxHeight = () => {
    const gap = parseFloat(getComputedStyle(section).rowGap) || 0;
    return revealHeight({
      width: floorW(pic), aspect: level.picture.height / level.picture.width,
      spaceH: spaceH($('main')),
      headH: ceilH(section.querySelector('h1')), gap,
      infoH: ceilH(info), beside: info.getBoundingClientRect().left > pic.getBoundingClientRect().left + 1,
    });
  };
  A.reveals.push(mountReveal(pic, { level, rt, picture: entry.picture, ui: uiFlags, maxHeight }));
}

async function screenPlay(main, slot, ref, token) {
  const entry = await levelFor(ref || A.road.rooms[slot]);
  if (token !== A.renderToken) return;
  if (!entry && slot >= 0) return missingRoom(main, slot);
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
    label: A.mode === 'live' || slot === 2 ? 'New photo' : 'Pick another room',
    onClick: () => {
      if (free) { A.free = null; render(); return; }
      setRoad({ ...A.road, step: R.PICK_STEPS[slot] });
    },
  };
  const primary = free
    ? { label: 'Back to free play', onClick: () => { A.free = null; render(); } }
    : { label: R.primaryLabel(A.road), onClick: () => setRoad(R.continueAfterRound(A.road)) };
  showCard($('card'), { title: r.words.title, lines: [r.words.body], label: level.label, primary, secondary: [again, pickOther] });
  clearVeil();
}

async function screenTwo(main, token) {
  const { section, cards } = compareView({ primaryLabel: R.primaryLabel(A.road), onContinue: () => setRoad(R.toOwnRoom(A.road)) });
  main.replaceChildren(section);
  for (const slot of [0, 1]) {
    const ref = A.road.rooms[slot];
    const entry = await levelFor(ref);
    if (token !== A.renderToken) return;
    if (!entry || entry.built.error) {
      cards.append(roomGoneView(slot, ref && ref.kind === 'photo'));
      continue;
    }
    const { level, rt } = entry.built;
    const { article, pic } = roomSumView({ level, best: A.road.best[slot] });
    cards.append(article);
    // the whole card width, keeping the picture's aspect
    A.reveals.push(mountReveal(pic, { level, rt, picture: entry.picture, ui: uiFlags }));
  }
}

async function screenFree(main, token) {
  if (A.free) return screenPlay(main, -1, A.free, token);
  const { section, cards } = freeView();
  main.replaceChildren(section);
  for (const s of SAMPLES) {
    const entry = await sample(s.id);
    if (token !== A.renderToken) return;
    cards.append(roomCard(entry, { onPick: () => { A.free = { kind: 'sample', id: s.id }; render(); } }));
  }
  const own = A.road.rooms[2];
  const ownEntry = R.ownMade(A.road) ? await levelFor(own) : null;
  if (token !== A.renderToken) return;
  if (ownEntry && !ownEntry.built.error) cards.append(roomCard(ownEntry, { onPick: () => { A.free = own; render(); } }));
}

// ---- the closing screen ----
// The last step of the road: the circuit is complete, each room with what
// happened and what the AI did, then the ways on.
async function screenEnd(main, token) {
  const entries = [];
  for (const ref of A.road.rooms) {
    const entry = ref ? await levelFor(ref) : null;
    if (token !== A.renderToken) return;
    entries.push(entry && !entry.built.error ? entry : null);
  }
  const rooms = closingRooms({
    road: A.road, mode: A.mode,
    levels: entries.map((e) => (e ? e.built.level : null)),
    summaries: entries.map((e) => (e ? e.summary : null)),
  });
  main.replaceChildren(closingView({
    rooms, mode: A.mode, primaryLabel: R.primaryLabel(A.road),
    actions: {
      freePlay: () => setRoad(R.startFreePlay(A.road)),
      playAgain: (ref) => { A.free = ref; setRoad(R.startFreePlay(A.road)); },
      ownRoom: () => setRoad({ ...A.road, step: R.OWN_STEP }),
      startOver,
    },
  }));
}

// ---- your own room ----
// The third room: a photo of the player's own, made in the way this
// server's mode allows (src/own.js), and never faked: MOCK shows the photo
// on this device and makes nothing; REHEARSAL takes only the stand-in's own
// sample picture; LIVE sends it to Meta's models.
const coarsePointer = mq('(pointer: coarse)');

function ownDeps() {
  return {
    preview: previewPhoto,
    readPhoto: async (f) => { const p = await readPhoto(f); return { ...p, pixels: pixelsOf(p.picture) }; },
    send: (blob, onWords) => sendPhoto(blob, (m) => onWords(m.words)),
    samples: [...A.samples].map(([id, s]) => ({ id, title: s.room.title, sig: s.sig })),
    stored: storedEntry,
  };
}

function rehearsalRoom() {
  return A.mode === 'rehearsal' && A.health && A.health.rehearsal ? A.health.rehearsal.room : null;
}

// In REHEARSAL: the stand-in's own sample picture, to save and then pick.
function samplePictureLink(id) {
  const s = A.samples.get(id);
  if (!s) return null;
  const a = el('a', {
    class: 'btn', download: `${id}-sample-room.png`, href: '#', text: 'Save the sample picture',
    tip: `Saves ${s.room.title}’s own picture, the one the local stand-in knows, so you can choose it as your photo`,
  });
  s.picture.toBlob((b) => {
    if (!b) return;
    if (A.saveUrl) URL.revokeObjectURL(A.saveUrl);
    A.saveUrl = URL.createObjectURL(b);
    a.href = A.saveUrl;
  }, 'image/png');
  return a;
}

async function screenOwn(main, token) {
  for (const s of SAMPLES) await sample(s.id);
  if (token !== A.renderToken) return;
  const room = rehearsalRoom();
  const view = ownView({
    mode: A.mode, primaryLabel: R.primaryLabel(A.road), camera: coarsePointer.matches,
    sampleLink: room ? samplePictureLink(room) : null, made: R.ownMade(A.road),
    actions: { file: (f) => ownPhoto(f, view.panel, view.shown), skip: () => setRoad(R.passOwnRoom(A.road)) },
  });
  main.replaceChildren(view.section);
  if (A.busy) setBusy(true);
}

// inPlace: your own room is already on the road and only its level is
// missing (missingRoom): made again on this same step, and
// only from the same photo.
async function ownPhoto(file, panel, shown, { inPlace = false } = {}) {
  if (A.busy) return;
  setBusy(true);
  const sends = A.mode === 'live' || A.mode === 'rehearsal';
  let step = 0;
  shown.hidden = true;
  if (sends) progressPanel(panel, LIVE_LINES, step);
  try {
    const r = await makeOwnRoom({
      mode: A.mode, rehearsalRoom: rehearsalRoom(), file, deps: ownDeps(),
      onWords: (words) => {
        const i = LIVE_LINES.indexOf(words);
        if (i >= 0) { step = i; progressPanel(panel, LIVE_LINES, step); say(words); }
      },
    });
    setBusy(false);
    if (r.kind === 'built' && inPlace && !R.sameRef(r.ref, A.road.rooms[2])) {
      panel.hidden = true;
      const words = `${NOT_SAME} Pick the same photo, or use ← to go back to Your own room for a new one.`;
      showOwnResult(shown, { kind: 'refused', words });
      say(words);
      return;
    }
    if (r.kind === 'built') {
      if (r.entry.fromDevice) say('This photo’s level was on this device: no model was called.');
      else S.saveLevel(r.ref.sha256, r.entry.built.level, { summary: r.entry.summary });
      A.live.set(refKey(r.ref), r.entry);
      if (inPlace) render();
      else setRoad(R.chooseRoom(A.road, 2, r.ref));
      return;
    }
    panel.hidden = true;
    showOwnResult(shown, r);
    say(r.kind === 'kept' ? 'Your photo is shown here and stays on this device. Nothing was sent.' : r.words);
  } catch (e) {
    setBusy(false);
    progressPanel(panel, LIVE_LINES, step, `${e.message} You can try another photo, or continue to the end.`);
    say(e.message);
  }
}

function showOwnResult(box, r) {
  box.replaceChildren(...ownResult(r).filter(Boolean));
  box.hidden = false;
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
  const hole = { left: r.left - app.left, top: r.top - app.top, right: r.right - app.left, bottom: r.bottom - app.top };
  for (const [x, y, w, h] of veilRects(app.width, app.height, hole)) {
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

// Drawn, measured and, if it would make a fitted screen scroll, taken back
// in the same task, before anything is painted (src/tour.js offerFits).
function showOffer() {
  $('tour-strip').replaceChildren(el('div', { class: 'inner offer' }, [
    el('p', { text: 'New here? Take the tour.' }),
    el('button', { type: 'button', class: 'btn', text: 'Take the tour', tip: 'A short guided tour, one step at a time', onclick: startTour }),
    el('button', { type: 'button', class: 'btn quiet', text: 'Not now', tip: 'Hides this offer for this visit', onclick: hideOffer }),
  ]));
  const m = $('main');
  const barsOver = [...m.querySelectorAll('.bar-body')].some((b) => b.scrollHeight > b.clientHeight);
  if (!offerFits({ scrollH: m.scrollHeight, clientH: m.clientHeight, barsOver })) {
    $('tour-strip').replaceChildren();
    A.tour.notOn = A.road.step;
    return;
  }
  A.tour.offered = true;
}

setInterval(() => {
  if (offerDue({ now: Date.now(), lastProgress: A.tour.lastProgress, offered: A.tour.offered, tourOn: A.tour.on, cardOpen: cardOpen(), step: A.road.step, notOn: A.tour.notOn })) showOffer();
  if (A.tour.on) lightControl();
}, 1000);
addEventListener('resize', () => { if (A.tour.on) lightControl(); });
// a new width wraps the header differently: let it find its own height again
let headerWidth = innerWidth;
addEventListener('resize', () => {
  if (innerWidth !== headerWidth) { headerWidth = innerWidth; reserveHeight($('top'), false); }
});
$('main').addEventListener('scroll', () => { if (A.tour.on) lightControl(); }, { passive: true });

// ---- history: Back and Forward follow the road ----
addEventListener('popstate', (e) => {
  const s = e.state && e.state.step;
  if (!s || s === A.road.step) return;
  if (cardOpen()) { replaceHistory(); return; }
  const r = R.towardStep(A.road, s);
  if (r.step !== A.road.step) setRoad(r, { push: false });
  if (r.step !== s) replaceHistory();
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
  if (A.mode === 'rehearsal') {
    // a band on every screen: nothing in a rehearsal comes from Meta
    $('top').append(el('p', { class: 'band', text: 'REHEARSAL · local stand-in, not Meta. No photo leaves this machine.' }));
  }
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
