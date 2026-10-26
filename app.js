// FRAME//PLAY entry module: the road and its screens, the settings drawer,
// sound (on by default), the opt-in tour, welcome back and history.
import { loadRoom } from './src/rooms.js';
import { paintRoom } from './src/painter.js';
import { buildLevel, inputFromRoom, objectWords, validateLevel } from './src/level.js';
import { pictureFromRGBA } from './src/render.js';
import { mountPlay, mountReveal } from './src/game.js';
import { Synth } from './src/audio.js';
import { readPref, writePref, soundOn, setSound } from './src/store.js';
import * as S from './src/store.js';
import { el, showCard, cardOpen, initTooltips, speak, hideTip, holdBar } from './src/ui.js';
import * as R from './src/road.js';
import { tourStep, offerDue, shouldPulse, veilRects } from './src/tour.js';
import { describeRoom, stepsAway, ROLE_WORDS } from './src/words.js';
import { acceptReply, inputFromReply, readSummary, boxRings } from './src/reply.js';
import { readPhoto, sendPhoto, canvasJpeg, decodeToCanvas, pixelsOf } from './src/photo.js';
import { traceInBox } from './src/trace_in_box.js';

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
  tour: { on: false, offered: false, lastProgress: Date.now() },
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
// Each object's outline: traced inside SAM's exact box, or the box itself
// when the trace is not tight enough. The page yields between objects so
// the progress words stay live.
async function outlinesFor(reply, pixels) {
  const out = [];
  for (const o of reply.objects) {
    try {
      const t = traceInBox(pixels, o.box, o.seeds || []);
      out.push({ source: t.source, rings: t.rings });
    } catch {
      out.push({ source: 'box', rings: boxRings(o.box) });
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

async function levelFromReply(reply, picture, pictureRef) {
  const outlines = await outlinesFor(reply, pixelsOf(picture));
  const built = buildLevel(inputFromReply(reply, pictureRef, (o, k) => outlines[k]));
  return { picture, built, summary: readSummary(reply) };
}

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

async function runLivePath(slot, panel, make) {
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
    A.live.set(refKey(ref), entry);
    setBusy(false);
    setRoad(R.chooseRoom(A.road, slot, ref));
  } catch (e) {
    setBusy(false);
    progressPanel(panel, LIVE_LINES, step, `${e.message} You can try another photo, or play a sample room below.`);
    say(e.message);
  }
}

async function readThroughServer(blob, copy, picture, pictureRef, onWords) {
  const reply = await sendPhoto(blob, (m) => onWords(m.words));
  const ok = acceptReply(A.mode, reply, copy);
  if (!ok.ok) throw new Error(ok.why);
  onWords('Tracing the outlines');
  await new Promise((r) => setTimeout(r, 0)); // let the words show
  return levelFromReply(reply, picture, pictureRef);
}

function choosePhoto(slot, file, panel) {
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
  });
}

// Rehearsal: the stand-in's own sample picture goes through the live path,
// so a stand-in level is never drawn over a photo.
function rehearseRoom(slot, id, panel) {
  return runLivePath(slot, panel, async (onWords) => {
    const s = await sample(id);
    const blob = await canvasJpeg(s.picture);
    const picture = await decodeToCanvas(blob, s.room.width, s.room.height);
    const entry = await readThroughServer(blob, { width: s.room.width, height: s.room.height }, picture, { kind: 'sample', id }, onWords);
    return { ref: { kind: 'rehearsal', id }, entry };
  });
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
      sw('Motion', !reducedMotion(), () => { S.setMotion(reducedMotion()); applySettings(); }, 'Animations such as the outlines drawing in and the walk bob'),
      sw('High contrast', highContrast(), () => { S.setContrast(!highContrast()); applySettings(); }, 'Thicker lines, opaque badges and a dimmed picture'),
      sw('Show outlines while playing', outlinesOn(), () => { S.setOutlinesWhilePlaying(!outlinesOn()); applySettings(); }, 'Draws the outlines the AI found while you play'),
      el('button', { type: 'button', class: 'btn', text: 'Read this screen aloud', tip: 'Reads the main words on this screen', onclick: readScreen }),
      el('button', { type: 'button', class: 'btn', text: 'Start over from Step 1', tip: 'Starts the road again. Saved levels stay', onclick: startOver }),
    ]),
    el('h3', { text: 'About' }),
    el('p', { class: 'about', text: DISCLOSURE }),
    el('p', { class: 'about', text: 'MIT license. No accounts, cookies, analytics or trackers.' }),
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
  const bar = el('div', { class: 'bar-end welcome-bar' }, [
    el('button', {
      type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary',
      tip: 'Agree and go to Step 2', text: R.primaryLabel(A.road), onclick: () => setRoad(R.giveConsent(A.road)),
    }),
  ]);
  const section = el('section', { class: 'screen welcome with-bar' }, [
    el('div', { class: 'bar-body' }, [
      el('h1', { text: 'Photograph your room. Play it.' }),
      el('p', { text: 'FRAME//PLAY turns one photo of a room or a desk top into a small game. The outlines of the real objects become the walls you walk around, the things you collect, the hazard you avoid and the exit.' }),
      el('ul', { class: 'consent' }, [
        el('li', { text: 'Keep people and anything private out of the photo.' }),
        el('li', { text: 'You must be 18 or over to send a photo (Meta’s terms).' }),
        el('li', { text: where }),
        el('li', { text: 'Kept: no photo, anywhere. Levels made from your photos (outlines, names and roles, never the photo) stay on this device, with your step, sound and tour choices.' }),
      ]),
    ]),
    bar,
  ]);
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
  const panel = el('div', { class: 'progress', hidden: true, 'aria-live': 'polite' });
  const input = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.value = '';
    if (f) choosePhoto(slot, f, panel);
  });
  const choose = el('button', {
    type: 'button', class: 'btn', disabled: !!off, text: 'Choose a photo', 'data-tour': off ? null : 'room-card',
    tip: 'Pick a photo of a room or a desk top. It is shrunk on this device first', onclick: () => input.click(),
  });
  const rehearsal = A.mode === 'rehearsal' && A.health && A.health.rehearsal ? A.health.rehearsal.room : null;
  const actions = el('div', { class: 'actions' }, [choose, input, off ? el('span', { class: 'why', text: off }) : null]);
  if (rehearsal && SAMPLES.some((x) => x.id === rehearsal)) {
    actions.append(el('button', {
      type: 'button', class: 'btn', text: 'Rehearse the live path',
      tip: `Sends the ${rehearsal} sample picture to the local stand-in, not Meta, and builds its level the live way`,
      onclick: () => rehearseRoom(slot, rehearsal, panel),
    }));
  }
  main.replaceChildren(el('section', { class: 'screen' }, [
    el('h1', { text: slot === 0 ? 'Your room: pick a photo' : 'Another room: pick a second photo' }),
    el('p', { class: 'advice', text: 'Objects with clear edges on a plain floor or desk work best. No people.' }),
    actions,
    panel,
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
  if (A.busy) setBusy(true);
}

// A room on the road whose level is not in memory: a photo's level needs
// the same photo picked again (the photo is never stored); a rehearsal
// room is sent through the stand-in again.
function missingRoom(main, slot) {
  const ref = A.road.rooms[slot];
  const panel = el('div', { class: 'progress', hidden: true, 'aria-live': 'polite' });
  const back = () => { A.road = { ...A.road, step: slot === 0 ? 2 : 5 }; };
  const kids = [];
  if (ref && ref.kind === 'photo') {
    kids.push(el('h1', { text: 'Pick the same photo again' }),
      el('p', { text: 'The photo itself is never stored. Pick the same photo again and its level loads from this device, with no model call.' }));
    if (A.mode === 'live') {
      const input = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
      input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        input.value = '';
        if (f) { back(); choosePhoto(slot, f, panel); }
      });
      kids.push(el('div', { class: 'actions' }, [
        el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', text: 'Choose the photo again', tip: 'Pick the same photo; nothing is sent if its level is on this device', onclick: () => input.click() }),
        input,
      ]), panel);
    } else {
      kids.push(el('p', { class: 'why', text: 'This server is not live now. Go back one step and pick a sample room.' }));
    }
  } else if (ref && ref.kind === 'rehearsal' && A.mode === 'rehearsal') {
    kids.push(el('h1', { text: 'Rehearse this room again' }),
      el('p', { text: 'The stand-in’s level is made again on each visit.' }),
      el('div', { class: 'actions' }, [
        el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', text: 'Send it through the stand-in', tip: 'The local stand-in, not Meta', onclick: () => { back(); rehearseRoom(slot, ref.id, panel); } }),
      ]), panel);
  } else {
    kids.push(el('h1', { text: 'This room is not here any more' }), el('p', { text: 'Go back one step and pick a room.' }));
  }
  main.replaceChildren(el('section', { class: 'screen sparse' }, kids));
}

const SOURCE_WORDS = {
  exact: 'exact outline, drawn by code',
  sam_mask: 'SAM’s own mask',
  traced_in_box: 'traced by code inside SAM’s box',
  box: 'SAM’s box (the trace was not tight enough)',
};

function summaryLine(level, summary) {
  if (level.origin === 'mock') {
    return 'This sample room was drawn by code: no model was called, and its outlines are the exact shapes code painted. Code proved the room can be won.';
  }
  const c = level.provenance.outline_sources || {};
  const n = level.objects.length;
  const named = summary ? summary.named : n;
  const who = level.origin === 'rehearsal' ? ['The local stand-in for Muse Spark (not Meta)', 'The stand-in for SAM 3.1'] : ['Muse Spark', 'SAM 3.1'];
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  return `${who[0]} named ${plural(named, 'thing', 'things')} and gave each a role. ${who[1]} found ${n} of them. Code traced ${plural(c.traced_in_box || 0, 'outline', 'outlines')} inside SAM’s boxes and kept ${plural(c.box || 0, 'as a box', 'as boxes')}, then proved the room can be won.`;
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
  if (!entry) return missingRoom(main, slot);
  if (entry.built.error) {
    main.replaceChildren(el('section', { class: 'screen sparse' }, [el('h1', { text: 'No level from this picture' }), el('p', { text: entry.built.error })]));
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
        el('p', { class: 'summary', text: summaryLine(level, entry.summary) }),
        entry.fromDevice ? el('p', { class: 'why', text: 'Loaded from this device: no model was called this time.' }) : null,
        el('div', { class: 'actions' }, [
          el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', 'data-tour': 'primary', tip: 'Start playing this room', text: 'Play this room', onclick: () => setRoad(R.startPlay(A.road)) }),
          el('button', { type: 'button', class: 'btn', text: 'Describe this room', tip: 'Every object, its role and where it is, in words', onclick: () => describeSection(desc, level, rt, null) }),
          wallsBtn,
        ]),
        desc,
        list,
        entry.summary && entry.summary.scenery.length
          ? el('p', { text: `Also seen, as scenery (never a wall, never sent to SAM): ${entry.summary.scenery.join(', ')}.` }) : null,
        entry.summary && entry.summary.warnings.length
          ? el('ul', { class: 'changes' }, entry.summary.warnings.map((w) => el('li', { text: w }))) : null,
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
    if (!entry || entry.built.error) {
      cards.append(el('article', { class: 'room-sum' }, [
        el('h2', { text: slot === 0 ? 'Your first room' : 'Your second room' }),
        el('p', { text: ref && ref.kind === 'photo' ? 'The photo is never stored: pick it again on its step to see this room here.' : 'This room is not in memory on this visit.' }),
      ]));
      continue;
    }
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

function showOffer() {
  A.tour.offered = true;
  $('tour-strip').replaceChildren(el('div', { class: 'inner offer' }, [
    el('p', { text: 'New here? Take the tour.' }),
    el('button', { type: 'button', class: 'btn', text: 'Take the tour', tip: 'A short guided tour, one step at a time', onclick: startTour }),
    el('button', { type: 'button', class: 'btn quiet', text: 'Not now', tip: 'Hides this offer for this visit', onclick: hideOffer }),
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
