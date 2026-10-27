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
import { acceptReply, photoRefusal } from './src/reply.js';
import { readPhoto, previewPhoto, sendPhoto, canvasJpeg, decodeToCanvas, pixelsOf, sha256Hex } from './src/photo.js';
import { mountFxSettings } from './src/settings_fx.js';
import { makeMarkedRoom, keptMarkedEntry, sanitizeMarks, needs } from './src/marks.js';
import { mountMarker } from './src/marker.js';
import { levelFromReply, makeOwnRoom, signature, fineGrid, objectBoxes, keptLevel, standInReplyRefusal, NOT_SAME_WORDS } from './src/own.js';
import {
  welcomeView, pickView, roomCardView, foundView, revealHeight, compareView, roomSumView, roomGoneView,
  freeView, ownView, ownResult, closingRooms, closingView, photoInput, OFF_WORDS, markView, leaveButton, LEAVE_CARD,
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
  live: new Map(), // levels made through the live path (or from marks) this visit, by refKey
  marking: new Map(), // photos being marked this visit, by sha256: { picture, marks }
  remark: null, // the sha256 of a made room whose marks are open again
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
// Escape and the modifier keys do not count as a press that may start
// sound, so they never create the sound context (it would stay suspended)
const NOT_ACTIVATION = new Set(['Escape', 'Esc', 'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);
document.addEventListener('keydown', (e) => { if (!NOT_ACTIVATION.has(e.key)) unlock(); }, { capture: true });

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
    // and where its objects sit, finely, so an edited copy is refused
    fine: fineGrid({ width: room.width, height: room.height, data: painted.rgba }),
    boxes: objectBoxes(room),
  };
  A.samples.set(id, entry);
  return entry;
}

async function sampleTitle(id) {
  return SAMPLES.some((s) => s.id === id) ? (await sample(id)).room.title : id || 'no room';
}

// The mode that made a photo room's level kept on this device, or null.
function keptOrigin(ref) {
  const kept = ref && ref.kind === 'photo' ? S.loadLevel(ref.sha256) : null;
  return kept ? kept.level.origin : null;
}

function refKey(ref) {
  return ref.kind === 'photo' || ref.kind === 'marked' ? `${ref.kind}:${ref.sha256}` : `${ref.kind}:${ref.id}`;
}

async function levelFor(ref) {
  if (!ref) return null;
  if (ref.kind === 'sample') return sample(ref.id);
  return A.live.get(refKey(ref)) || null;
}

// ---- the live path (and its rehearsal) ----
// A level kept on this device for this photo: validated again (a stored
// proof is never trusted) against the very copy just made.
// Only a level made in this mode (a REHEARSAL level is never passed off as
// LIVE; both modes may share this page's address).
function storedEntry(photo) {
  const kept = S.loadLevel(photo.sha256);
  const level = keptLevel(kept, photo, A.mode);
  if (!level) return null;
  const v = validateLevel(level);
  if (!v.ok) return null;
  level.proof = v.proof;
  return { picture: photo.picture, built: { level, rt: v.rt }, summary: kept.summary || null, fromDevice: true };
}

// While busy every button waits; the one that had the focus gets it back
// after (disabling it dropped the focus to the page).
function setBusy(on) {
  A.busy = on;
  if (on) A.busyFocus = document.activeElement;
  for (const b of document.querySelectorAll('#main button, #road button')) {
    if (b.hasAttribute('data-busy-ok')) continue; // Cancel: the one way out of a read
    if (on) { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; } else if (b.dataset.wasDisabled === '') b.disabled = false;
  }
  const f = A.busyFocus;
  if (!on && f && f.isConnected && !f.disabled && f.focus) f.focus({ preventScroll: true });
  if (!on) A.busyFocus = null;
}

// While reading, the panel's Cancel stays pressable (setBusy passes over a
// button marked data-busy-ok). After a failure, again: the read once more.
// error: the words; cancel(): stop the read; again: { retry, tip } or null;
// note: a line under the steps while reading (the wait for a free reader)
function progressPanel(panel, lines, current, error, { cancel = null, again = null, note = null } = {}) {
  panel.hidden = false;
  // never a null child: the page's own replaceChildren would write 'null'
  const kids = [el('ol', { class: 'progress-lines' }, lines.map((t, i) => el('li', {
    class: i < current ? 'done' : i === current && !error ? 'now' : 'todo',
    text: `${t}${i < current ? ' · done' : i === current && !error ? '…' : ''}`,
  })))];
  if (!error && note) kids.push(el('p', { class: 'progress-note', text: note }));
  if (error) kids.push(el('p', { class: 'error', role: 'alert', text: error }));
  if (!error && cancel) {
    kids.push(el('div', { class: 'actions' }, [el('button', {
      type: 'button', class: 'btn', 'data-busy-ok': 'true', text: 'Cancel', tip: 'Stops waiting for this read', onclick: cancel,
    })]));
  }
  if (error && again) {
    demotePrimaries();
    kids.push(el('div', { class: 'actions' }, [retryButton(again)]));
  }
  panel.replaceChildren(...kids);
}

// One primary on the screen: the others become plain buttons.
function demotePrimaries(root = $('main')) {
  for (const p of root.querySelectorAll('[data-primary]')) {
    p.removeAttribute('data-primary');
    p.classList.remove('primary');
    if (p.getAttribute('data-tour') === 'primary') p.removeAttribute('data-tour');
  }
}

// The same photo read once more: no new pick, no file dialog.
function retryButton(again) {
  return el('button', {
    type: 'button', class: 'btn primary', 'data-primary': 'true', text: 'Try this photo again', tip: again.tip, onclick: again.retry,
  });
}

const FREE_WORDS = 'Rounds in Free play do not change your road.';
const LIVE_LINES = ['Reading your room', 'Finding every object', 'Tracing the outlines'];

// A read's words on its panel, for Steps 2 and 5 and your own room alike:
// its three steps, and while every reader on the server is busy (stage
// 'waiting', from sendPhoto) the countdown under them, changed in place so
// Cancel keeps the focus, and said aloud once per wait. onStep(i): the step
// now shown. Nothing after Cancel.
function readWords(panel, signal, onStep) {
  let step = 0;
  let waiting = false;
  return (words, stage) => {
    if (signal.aborted) return;
    const i = LIVE_LINES.indexOf(words);
    if (i >= 0) {
      step = i;
      waiting = false;
      onStep(i);
      progressPanel(panel, LIVE_LINES, step, null, { cancel: cancelRead });
      say(words);
    } else if (stage === 'waiting' && typeof words === 'string' && words) {
      const shown = panel.querySelector('.progress-note');
      if (shown) shown.textContent = words;
      else progressPanel(panel, LIVE_LINES, step, null, { cancel: cancelRead, note: words });
      if (!waiting) say(words);
      waiting = true;
    }
  };
}

// Words joined as whole sentences: the first one ends as a sentence ends
// (the server's own words may not), so the next one reads on.
function sentences(...parts) {
  return parts.filter(Boolean).map((p) => String(p).trim()).filter(Boolean)
    .map((p, i, all) => (i < all.length - 1 && !/[.!?]$/.test(p) ? `${p}.` : p)).join(' ');
}

// What a failed read says about itself, from the reply's error or from what
// the send's error carries (absent-safe: a server or a send that says
// nothing of these gives { code: null, retrySame: false }).
function failureOf(e, reply = null) {
  const er = (reply && reply.error) || (e && (e.error || (e.reply && e.reply.error))) || {};
  return {
    code: er.code || (e && e.code) || null,
    retrySame: !!(er.retry_same || (e && (e.retry_same || e.retrySame))),
    keyRefused: er.status === 401,
  };
}

// A read stopped with Cancel: the page stops waiting at once (and the send
// is aborted where sendPhoto takes the signal); nothing from it is used.
const CANCEL_WORDS = 'Cancelled: this page stopped waiting for the read, and nothing from it is used.';
function cancelled() {
  const e = new Error(CANCEL_WORDS);
  e.cancelled = true;
  e.retrySame = true;
  return e;
}

// Runs a read that Cancel can stop: make(signal) races the press. A read
// that finishes after Cancel is dropped (the race is already over).
function cancellable(make) {
  const ctl = new AbortController();
  A.cancelRead = ctl;
  const stopped = new Promise((_, reject) => ctl.signal.addEventListener('abort', () => reject(cancelled()), { once: true }));
  return Promise.race([make(ctl.signal), stopped]).finally(() => { if (A.cancelRead === ctl) A.cancelRead = null; });
}

function cancelRead() {
  if (A.cancelRead && !A.cancelRead.signal.aborted) A.cancelRead.abort();
}

// A reply made while calls were failing (an object not looked for): played,
// never kept on this device, so the same photo is read again next time.
function degradedReply(reply) {
  const p = reply && reply.provenance;
  const calls = (p && Array.isArray(p.calls)) ? p.calls : [];
  const warnings = (reply && Array.isArray(reply.warnings)) ? reply.warnings : [];
  return calls.some((c) => c && c.status !== 200) || warnings.some((w) => typeof w === 'string' && /^not looked for: /.test(w));
}

// inPlace: the room is already on the road (its level was not in memory):
// it is made again on the same step, never by moving the counter back.
// again: reads the same photo once more, offered when a failure says so.
async function runLivePath(slot, panel, make, { inPlace = false, again = null } = {}) {
  if (A.busy) return;
  setBusy(true);
  let step = 0;
  const lines = (error, more) => progressPanel(panel, LIVE_LINES, step, error, more);
  lines(null, { cancel: cancelRead });
  try {
    const { ref, entry } = await cancellable((signal) => make(readWords(panel, signal, (i) => { step = i; }), signal));
    if (entry.built.error) throw new Error(entry.built.error);
    A.live.set(refKey(ref), entry);
    setBusy(false);
    if (inPlace) render();
    else setRoad(R.chooseRoom(A.road, slot, ref));
  } catch (e) {
    setBusy(false);
    const f = failureOf(e, e.reply);
    const retry = again && f.retrySame;
    const ways = inPlace ? null : retry ? 'You can also pick another photo, or play a sample room below.' : 'You can try another photo, or play a sample room below.';
    lines(sentences(e.message, ways), { again: retry ? { retry: again, tip: 'Sends the same photo again; no need to pick it' } : null });
    say(e.message);
    if (!e.cancelled) liveFailed(e, f);
  }
}

// standInRoom: in REHEARSAL, the room the answer must be for. A refused
// reply rides on the error (e.reply), so its code and retry_same can be read.
// signal: Cancel's, for sendPhoto.
async function readThroughServer(blob, copy, picture, pictureRef, onWords, standInRoom = null, signal = null) {
  const reply = await sendPhoto(blob, (m) => onWords(m.words, m.stage), undefined, { signal });
  const ok = acceptReply(A.mode, reply, copy);
  if (!ok.ok) throw Object.assign(new Error(ok.why), { reply });
  const other = standInRoom ? standInReplyRefusal(reply, standInRoom) : null;
  if (other) throw new Error(other);
  onWords('Tracing the outlines');
  await new Promise((r) => setTimeout(r, 0)); // let the words show
  const entry = await levelFromReply(reply, picture, pixelsOf(picture), pictureRef);
  entry.degraded = degradedReply(reply);
  return entry;
}

// Steps 2 and 5: only LIVE reads a photo here (MOCK and REHEARSAL have no
// picker on these steps, and this says so again).
// In place (opts.inPlace), only the photo the room was made from: compared
// by its sha256 before anything is looked up, sent or saved.
function choosePhoto(slot, file, panel, opts) {
  if (A.mode !== 'live') return null;
  const want = opts && opts.inPlace ? A.road.rooms[slot] : null;
  return runLivePath(slot, panel, async (onWords, signal) => {
    const photo = await readPhoto(file);
    if (want && photo.sha256 !== want.sha256) throw new Error(`${NOT_SAME_WORDS} Pick the same photo, or use ← to go back to Step ${R.PICK_STEPS[slot]} for another room.`);
    const ref = { kind: 'photo', sha256: photo.sha256 };
    const kept = storedEntry(photo);
    if (kept) {
      say('This photo’s level was on this device: no model was called.');
      return { ref, entry: kept };
    }
    const entry = await readThroughServer(photo.blob, photo, photo.picture, { kind: 'photo', sha256: photo.sha256 }, onWords, null, signal);
    // a cancelled read is not used, so not kept either; nor one made while
    // calls were failing
    if (!entry.built.error && !entry.degraded && !signal.aborted) S.saveLevel(photo.sha256, entry.built.level, { summary: entry.summary });
    return { ref, entry };
  }, { ...opts, again: () => choosePhoto(slot, file, panel, opts) });
}

// Rehearsal: the stand-in's own sample picture goes through the live path,
// so a stand-in level is never drawn over a photo. Only the picture of the
// room the running stand-in answers for is sent, and only its answer for
// that room is used.
function rehearseRoom(slot, id, panel, opts) {
  return runLivePath(slot, panel, async (onWords, signal) => {
    const room = rehearsalRoom();
    if (id !== room) {
      throw new Error(`The local stand-in was started for ${await sampleTitle(room)}, not ${await sampleTitle(id)}, so it would answer for the wrong room. Nothing was sent.`);
    }
    const s = await sample(id);
    const blob = await canvasJpeg(s.picture);
    const picture = await decodeToCanvas(blob, s.room.width, s.room.height);
    const entry = await readThroughServer(blob, { width: s.room.width, height: s.room.height }, picture, { kind: 'sample', id }, onWords, room, signal);
    return { ref: { kind: 'rehearsal', id }, entry };
  }, { ...opts, again: () => rehearseRoom(slot, id, panel, opts) });
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
    A.remark = null;
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
  // a room whose level is missing names the way on that this screen offers;
  // in MOCK no photo can make your own room, so its step names the one way on
  const mockOwn = r.step === R.OWN_STEP && A.mode !== 'live' && A.mode !== 'rehearsal';
  const why = el('span', { class: 'why', text: fw.ok || r.step >= R.FREE_PLAY ? '' : A.missingWhy || (mockOwn ? 'Continue to the end to go on' : fw.why) });
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
      sw('High contrast', highContrast(), () => { S.setContrast(!highContrast()); applySettings(); }, 'Thicker lines, opaque badges and a dimmed picture'),
      sw('Show outlines while playing', outlinesOn(), () => { S.setOutlinesWhilePlaying(!outlinesOn()); applySettings(); }, 'Draws the outlines the AI found while you play'),
      el('button', { type: 'button', class: 'btn', text: 'Read this screen aloud', tip: 'Reads the main words on this screen', onclick: readScreen }),
      el('button', { type: 'button', class: 'btn', text: 'Start over from Step 1', tip: 'Starts the road again, after you confirm. Saved levels stay', onclick: confirmStartOver }),
    ]),
    // shown, never folded: the disclosure is always in view in Settings
    el('h3', { text: 'About FRAME//PLAY' }),
    el('p', { class: 'about', text: DISCLOSURE }),
    el('p', { class: 'about', text: 'MIT license. No accounts, cookies, analytics or trackers.' }),
    el('div', { class: 'actions' }, [el('button', { type: 'button', class: 'btn', text: 'Close settings', tip: 'Closes this drawer', onclick: toggleDrawer })]),
  );
  // Music, its volume, Effects and Reduce motion (the one motion switch: it saves the same setting the page reads)
  mountFxSettings(d.querySelector('.settings'));
}

function readScreen() {
  const text = $('main').innerText.replace(/\s+/g, ' ').trim().slice(0, 2400);
  if (!speak(text)) say('Reading aloud is not available in this browser.');
}

// A true modal card: nothing is cleared until the player says so; Keep my
// road has the focus, and Escape never closes it (src/ui.js showCard).
function confirmStartOver() {
  showCard($('card'), {
    title: 'Start over?',
    lines: ['This clears your road on this device.'],
    primary: { label: 'Keep my road', onClick: () => {} },
    secondary: [{ label: 'Start over', onClick: startOver }],
  });
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
  if (A.mode === 'live') return liveOff();
  if (A.mode === 'rehearsal') return liveOff() || OFF_WORDS.rehearsal;
  if (!A.health) return `Off: ${A.modeWhy}`;
  return OFF_WORDS.mock;
}

function roomCard(entry, { disabledWhy, onPick, tour = true, title = null }) {
  const level = entry.built.level;
  return roomCardView({
    title: title || (entry.room ? entry.room.title : level.title), origin: level.origin, disabledWhy, onPick, tour,
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
    // not while the stand-in's key drill holds the picker off
    rehearse: rehearsal && !liveOff() && SAMPLES.some((x) => x.id === rehearsal) ? {
      label: 'Rehearse the live path',
      tip: `Sends the ${rehearsal} sample picture to the local stand-in, not Meta, and builds its level the live way`,
      onClick: () => rehearseRoom(slot, rehearsal, view.panel),
    } : null,
  });
  const check = checkAgainButton();
  if (check) view.section.querySelector('.actions').append(check);
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
// again (only by the stand-in started for that room). Nothing here moves
// the counter back; where this copy cannot make your own room, the way on
// is forward; a first or second room is picked again on its own step, with ←.
async function missingRoom(main, slot, token) {
  const ref = A.road.rooms[slot];
  const panel = el('div', { class: 'progress', hidden: true, 'aria-live': 'polite' });
  const shown = el('div', { class: 'own-result', hidden: true });
  const sends = A.mode === 'live' || A.mode === 'rehearsal';
  const kids = [];
  // your own room's way forward: on to the end, the room staying on the road
  const onward = (primary) => el('button', {
    type: 'button', class: primary ? 'btn primary' : 'btn', 'data-primary': primary ? 'true' : null, text: 'Continue to the end',
    tip: 'On to the closing screen; your own room stays on the road', onclick: () => setRoad(R.passOwnRoom(A.road)),
  });
  const chooseAgain = (onFile, tip, more = null) => {
    const input = photoInput(onFile);
    return el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', text: 'Choose the same photo', tip, onclick: () => input.click() }),
      input, more,
    ]);
  };
  // a level kept here from the other mode cannot load, and this copy
  // cannot make that room again (src/own.js keptLevel)
  const kept = keptOrigin(ref);
  const otherMode = kept && kept !== A.mode;
  let why = null;
  if (ref && ref.kind === 'marked') {
    // marked by hand: made again in any mode from the marks kept here,
    // and nothing is sent
    if (A.marking.has(ref.sha256)) return screenMarking(main, ref);
    kids.push(el('h1', { text: 'Pick your photo again' }),
      el('p', { text: 'The photo itself is never stored. Choose the same photo: your marks, and the room made from them, load from this device. Nothing is sent.' }),
      chooseAgain((f) => restoreMarked(f, shown), 'Pick the same photo you marked; it stays on this device', onward(false)),
      shown);
    why = 'Pick the same photo to see your marks';
  } else if (ref && ref.kind === 'photo' && slot === 2 && sends && !otherMode) {
    // your own room, with every check its mode makes (src/own.js)
    kids.push(el('h1', { text: 'Pick your photo again' }),
      el('p', { text: A.mode === 'live'
        ? 'The photo itself is never stored. Choose the same photo: if its level was kept on this device it loads with no model call; if not, the photo is read again.'
        : 'The photo itself is never stored. Choose the same picture: if its level was kept on this device it loads from here; if not, the local stand-in reads it again, and only its own sample picture can be made again here.' }),
      chooseAgain((f) => ownPhoto(f, panel, shown, { inPlace: true }), 'Pick the same photo you made this room from', onward(false)),
      panel, shown);
    why = 'Pick the same photo to play this room';
  } else if (ref && ref.kind === 'photo' && slot === 2) {
    kids.push(el('h1', { text: 'This room cannot load here' }),
      el('p', { text: otherMode
        ? `This room was made in ${kept.toUpperCase()}. This copy runs in ${A.mode.toUpperCase()}, so its level cannot load here, and this copy cannot make it again.`
        : 'This room was made with the live AI or the local stand-in. This copy runs in MOCK, so its level cannot load here.' }),
      el('div', { class: 'actions' }, [onward(true)]));
    why = 'Continue to the end to go on';
  } else if (ref && ref.kind === 'photo' && A.mode === 'live') {
    kids.push(el('h1', { text: 'Pick the same photo again' }),
      el('p', { text: 'The photo itself is never stored. Choose the same photo: if its level was kept on this device it loads with no model call; if not, the photo is read again.' }),
      chooseAgain((f) => choosePhoto(slot, f, panel, { inPlace: true }), 'Pick the same photo; nothing is sent if its level is on this device'),
      panel);
    why = 'Pick the same photo to play this room';
  } else if (ref && ref.kind === 'rehearsal' && A.mode === 'rehearsal' && ref.id !== rehearsalRoom()) {
    // another sample's stand-in made it: this stand-in would answer for its
    // own room, so nothing is offered that sends
    const made = await sampleTitle(ref.id), here = await sampleTitle(rehearsalRoom());
    if (token !== A.renderToken) return;
    kids.push(el('h1', { text: 'This room cannot load here' }),
      el('p', { text: `This room was rehearsed with the stand-in for ${made}. This stand-in answers for ${here}, so it cannot make it here. Use ← to go back to Step ${R.PICK_STEPS[slot]} and pick a room.` }));
    why = `Go back to Step ${R.PICK_STEPS[slot]} to pick a room`;
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

function describeSection(section, level, rt, state, button) {
  const shown = (on) => { section.hidden = !on; if (button) button.setAttribute('aria-expanded', String(on)); };
  if (!section.hidden) { shown(false); return; }
  const pos = state ? state.pos : level.start;
  const lines = describeRoom(level, rt, state, stepsAway(level, rt, pos[0], pos[1]));
  section.replaceChildren(
    el('h3', { text: 'This room, in words' }),
    el('ul', {}, lines.map((t) => el('li', { text: t }))),
    el('button', { type: 'button', class: 'btn', text: 'Read aloud', tip: 'Reads the description aloud', onclick: () => { if (!speak(lines.join(' '))) say('Reading aloud is not available in this browser.'); } }),
  );
  shown(true);
}

const NO_LEVEL = 'No level from this picture';
const withoutHeading = (words) => String(words).replace(new RegExp(`^${NO_LEVEL}:\\s*`), '');

async function screenFound(main, slot, token) {
  const ref = A.road.rooms[slot];
  // marks not made into a room yet, or opened again: the marking board
  if (ref && ref.kind === 'marked' && A.marking.has(ref.sha256) && (A.remark === ref.sha256 || !A.live.has(refKey(ref)))) {
    return screenMarking(main, ref);
  }
  const entry = await levelFor(ref);
  if (token !== A.renderToken) return;
  if (!entry) return missingRoom(main, slot, token);
  if (entry.built.error) {
    // the heading says it once: the words under it start with the reason
    main.replaceChildren(el('section', { class: 'screen sparse' }, [el('h1', { text: NO_LEVEL }), el('p', { text: withoutHeading(entry.built.error) })]));
    return;
  }
  const { level, rt } = entry.built;
  const { section, pic, info } = foundView({
    level, summary: entry.summary, fromDevice: entry.fromDevice, slot,
    actions: {
      leave: () => leaveRoom(slot),
      play: () => setRoad(R.startPlay(A.road)),
      describe: (desc, button) => describeSection(desc, level, rt, null, button),
      walls: (on) => { for (const r of A.reveals) r.setWalls(on); },
      remark: ref.kind === 'marked' ? () => {
        if (!A.marking.has(ref.sha256)) A.marking.set(ref.sha256, { picture: entry.picture, marks: entry.marks || [] });
        A.remark = ref.sha256;
        render();
      } : null,
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
  if (!entry && slot >= 0) return missingRoom(main, slot, token);
  if (!entry || entry.built.error) {
    main.replaceChildren(el('p', { text: entry ? entry.built.error : 'This room is not on this device any more.' }));
    return;
  }
  const { level, rt } = entry.built;
  const desc = el('section', { class: 'describe', id: 'describe-room', hidden: true, 'aria-live': 'polite' });
  const describeBtn = el('button', {
    type: 'button', class: 'btn', text: 'Describe this room', 'aria-expanded': 'false', 'aria-controls': 'describe-room',
    tip: 'Every object, its role, where it is and how far, in words',
    onclick: () => describeSection(desc, level, rt, A.view && A.view.state, describeBtn),
  });
  // a room on the road (never a replay in Free play) can be left for another
  const leave = slot >= 0 && A.road.step !== R.FREE_PLAY ? leaveButton(slot, () => leaveRoom(slot)) : null;
  A.view = mountPlay(main, {
    level, rt, picture: entry.picture, audio,
    say: (t) => { say(t); progress(); },
    ui: uiFlags,
    sideExtras: leave ? [describeBtn, leave, desc] : [describeBtn, desc],
    // a card (Start over?, welcome back) or the settings drawer holds the round
    paused: () => cardOpen() || A.drawerOpen,
    onEnd: (r) => endOfRound(slot, r, level),
  });
  A.view.focusGame();
}

// Choose a different room (or photo): back to the step where this room was
// picked. A round under way is not dropped without asking: a true modal
// card, Keep playing focused, and Escape never closes it (src/ui.js
// showCard); the round holds still under it.
function leaveRoom(slot) {
  if (A.busy) return;
  const go = () => setRoad({ ...A.road, step: R.PICK_STEPS[slot] });
  if (!roundUnderWay()) { go(); return; }
  showCard($('card'), {
    title: LEAVE_CARD.title,
    lines: [LEAVE_CARD.line],
    primary: { label: LEAVE_CARD.stay, onClick: () => { if (A.view) A.view.focusGame(); } },
    secondary: [{ label: LEAVE_CARD.leave, onClick: go }],
  });
}

// A round started and not over: the explorer has moved, collected or set
// off on a walk.
function roundUnderWay() {
  const s = A.view && A.view.state;
  return !!s && s.status === 'playing' && (s.travelled > 0 || !!s.auto || (Array.isArray(s.collected) && s.collected.some(Boolean)));
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
  // a replay's card says plainly that it leaves the road as it was
  const lines = free ? [r.status === 'won' ? r.words.body : null, FREE_WORDS] : [r.words.body];
  showCard($('card'), { title: r.words.title, lines, label: level.label, primary, secondary: [again, pickOther] });
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
  // titled by its row: in REHEARSAL it carries the sample's own title
  if (ownEntry && !ownEntry.built.error) cards.append(roomCard(ownEntry, { title: ownTitle(ownEntry.built.level), onPick: () => { A.free = own; render(); } }));
}

const ownTitle = (level) => `Your own room: ${level.origin === 'marked' ? 'marked by you' : level.title}`;

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
    road: A.road, mode: A.mode, room: rehearsalRoom(),
    kept: A.road.rooms.map(keptOrigin),
    levels: entries.map((e) => (e ? e.built.level : null)),
    summaries: entries.map((e) => (e ? e.summary : null)),
  });
  main.replaceChildren(closingView({
    rooms, mode: A.mode, primaryLabel: R.primaryLabel(A.road),
    actions: {
      freePlay: () => setRoad(R.startFreePlay(A.road)),
      playAgain: (ref) => { A.free = ref; setRoad(R.startFreePlay(A.road)); },
      ownRoom: () => setRoad({ ...A.road, step: R.OWN_STEP }),
      startOver: confirmStartOver,
    },
  }));
}

// ---- your own room ----
// The third room: a photo of the player's own, made in the way this
// server's mode allows (src/own.js), and never faked: MOCK shows the photo
// on this device and makes nothing; REHEARSAL takes only the stand-in's own
// sample picture; LIVE sends it to Meta's models.
const coarsePointer = mq('(pointer: coarse)');

// signal: Cancel's; seen.reply: the server's reply, once one came (its
// error's code and retry_same, and whether it was made while calls were
// failing)
function ownDeps(signal = null, seen = {}) {
  return {
    preview: previewPhoto,
    readPhoto: async (f) => { const p = await readPhoto(f); return { ...p, pixels: pixelsOf(p.picture) }; },
    send: async (blob, onWords) => {
      seen.reply = await sendPhoto(blob, (m) => onWords(m.words, m.stage), undefined, { signal });
      return seen.reply;
    },
    samples: [...A.samples].map(([id, s]) => ({ id, title: s.room.title, sig: s.sig, fine: s.fine, boxes: s.boxes })),
    stored: storedEntry,
    // the photo of your own room marked by hand: made again from the marks
    // kept here, never read again
    marked: (photo) => {
      const own = A.road.rooms[2];
      if (!own || own.kind !== 'marked' || !own.made || own.sha256 !== photo.sha256) return null;
      const entry = A.live.get(refKey(own)) || keptMarkedEntry(S.loadMarks(photo.sha256), photo.sha256, photo.picture);
      return entry ? { ref: own, entry } : null;
    },
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
  const off = liveOff();
  const view = ownView({
    mode: ownMode(), primaryLabel: R.primaryLabel(A.road), camera: coarsePointer.matches,
    sampleLink: room ? samplePictureLink(room) : null, made: R.ownMade(A.road),
    actions: { file: (f) => ownPhoto(f, view.panel, view.shown), skip: () => setRoad(R.passOwnRoom(A.road)) },
  });
  // the live AI unavailable: said in place of MOCK's notice; a photo is
  // shown here and can be marked, and nothing is sent
  if (off) ownOffInPlace(view.section);
  main.replaceChildren(view.section);
  if (A.busy) setBusy(true);
}

// Your own room's screen with the live AI unavailable: the notice says so
// and Check again is offered, without drawing the screen again (a refusal
// just shown, and its Mark your room, stay).
function ownOffInPlace(section) {
  const notice = section.querySelector('.notice');
  if (notice) {
    notice.textContent = sentences(A.mode === 'rehearsal'
      ? 'REHEARSAL, but the local stand-in answered as the live AI does for an account or model problem'
      : 'LIVE, but the live AI is unavailable on this server right now', A.liveDown.reason, 'A photo you choose stays on this device and you can mark your room yourself; nothing is sent. The sample rooms still work.');
  }
  const actions = section.querySelector('.actions');
  const has = actions && [...actions.querySelectorAll('button')].some((b) => b.textContent === 'Check again');
  const check = has ? null : checkAgainButton();
  if (check && actions) actions.append(check);
}

// inPlace: your own room is already on the road and only its level is
// missing (missingRoom): made again on this same step, and
// only from the same photo.
const IN_PLACE_WAYS = 'Pick the same photo, or continue to the end.';
// after a photo no model can read here (MOCK, or a read refused or failed)
const MARK_WAYS = 'You can mark the room yourself instead, try another photo, or continue to the end.';
// and when the failure says the same photo may work again
const RETRY_MARK_WAYS = 'You can try this photo again, mark the room yourself instead, try another photo, or continue to the end.';
const RETRY_WAYS = 'You can try this photo again, try another photo, or continue to the end.';
async function ownPhoto(file, panel, shown, { inPlace = false } = {}) {
  if (A.busy) return;
  setBusy(true);
  // with the live AI unavailable, a photo is shown here and can be marked,
  // as in MOCK: nothing is sent
  const mode = ownMode();
  const sends = mode === 'live' || mode === 'rehearsal';
  let step = 0;
  shown.hidden = true;
  if (sends) progressPanel(panel, LIVE_LINES, step, null, { cancel: cancelRead });
  // the photo can be marked by hand instead (never in place: that is a
  // room read from this photo, made again)
  const marking = (picture, sha256) => (!inPlace && picture ? () => markPhoto({ file, picture, sha256 }) : null);
  const again = { retry: () => ownPhoto(file, panel, shown, { inPlace }), tip: 'Sends the same photo again; no need to pick it' };
  const seen = { reply: null };
  try {
    // the samples' fingerprints, for a rehearsal's check (a return visit
    // may reach this without any sample room drawn yet)
    for (const s of SAMPLES) await sample(s.id);
    const r = await cancellable((signal) => makeOwnRoom({
      mode, rehearsalRoom: rehearsalRoom(), file, deps: ownDeps(signal, seen),
      sameAs: inPlace ? A.road.rooms[2].sha256 : null,
      onWords: readWords(panel, signal, (i) => { step = i; }),
    }));
    setBusy(false);
    if (r.notSame) r.words = sentences(r.words, IN_PLACE_WAYS);
    if (r.kind === 'built') {
      if (r.ref.kind === 'marked') say('Your marks for this photo were on this device: nothing was sent.');
      else if (r.entry.fromDevice) say('This photo’s level was on this device: no model was called.');
      else if (!degradedReply(seen.reply)) S.saveLevel(r.ref.sha256, r.entry.built.level, { summary: r.entry.summary });
      A.live.set(refKey(r.ref), r.entry);
      if (inPlace) render();
      else setRoad(R.chooseRoom(A.road, 2, r.ref));
      return;
    }
    panel.hidden = true;
    const onMark = r.markable ? marking(r.picture, r.sha256 || null) : null;
    const retry = r.kind === 'refused' && failureOf(null, seen.reply).retrySame;
    if (r.kind === 'refused' && !r.notSame) r.words = sentences(r.words, onMark ? (retry ? RETRY_MARK_WAYS : MARK_WAYS) : retry && !inPlace ? RETRY_WAYS : null);
    showOwnResult(shown, r, onMark, retry ? again : null);
    say(r.kind === 'kept' ? 'Your photo is shown here and stays on this device. Nothing was sent. You can mark your room.' : r.words);
    if (r.kind === 'refused' && seen.reply) liveFailed(null, failureOf(null, seen.reply));
  } catch (e) {
    setBusy(false);
    const f = failureOf(e, e.reply);
    // a read that failed after the photo was read here (src/own.js): it
    // can be marked instead
    const onMark = e.photo ? marking(e.photo.picture, e.photo.sha256) : null;
    // only the ways this screen offers
    const ways = inPlace ? (f.retrySame ? null : IN_PLACE_WAYS) : onMark ? (f.retrySame ? RETRY_MARK_WAYS : MARK_WAYS) : f.retrySame ? RETRY_WAYS : 'You can try another photo, or continue to the end.';
    const words = sentences(e.message, ways);
    // MOCK sends nothing, so it shows no progress lines: only the words;
    // a read that can be marked instead says why, then the way on, as a
    // refusal does
    if (sends && !onMark) progressPanel(panel, LIVE_LINES, step, words, { again: f.retrySame ? again : null });
    else {
      panel.hidden = true;
      showOwnResult(shown, { kind: 'refused', words }, onMark, f.retrySame ? again : null);
    }
    say(e.message);
    if (!e.cancelled && sends) liveFailed(e, f);
  }
}

// onMark: the photo can be marked instead; its button becomes the one
// primary on the screen, right under the photo or the words. again: the
// same photo once more, then the primary (Mark your room stays beside it).
function showOwnResult(box, r, onMark = null, again = null) {
  if (onMark || again) {
    demotePrimaries();
    A.missingWhy = onMark ? 'Mark your room, or continue to the end' : A.missingWhy;
    renderHeader();
  }
  const kids = ownResult(r, onMark ? { mark: () => onMark() } : null).filter(Boolean);
  if (again) {
    for (const k of kids) demotePrimaries(k);
    const row = kids.find((k) => k.classList && k.classList.contains('actions'));
    if (row) row.replaceChildren(retryButton(again), ...row.children);
    else kids.push(el('div', { class: 'actions' }, [retryButton(again)]));
  }
  box.replaceChildren(...kids);
  box.hidden = false;
}

// Mark a photo: from Step 9 on to Step 10 (Your marks), with the photo and
// any marks kept on this device for it. The fingerprint is taken here, on
// this device, only to keep the marks with it; nothing is sent. When a room
// was made from this photo's marks before, it is back as it was.
// photo: { file, picture, sha256 (when the photo was read already) }
async function markPhoto(photo) {
  if (A.busy) return;
  setBusy(true);
  try {
    const sha = photo.sha256 || await sha256Hex(await photo.file.arrayBuffer());
    const { width, height } = photo.picture;
    const kept = S.loadMarks(sha);
    const ref = { kind: 'marked', sha256: sha };
    const entry = keptMarkedEntry(kept, sha, photo.picture) || A.live.get(refKey(ref)) || null;
    const marks = (kept && sanitizeMarks(kept.marks, width, height)) || (entry && entry.marks) || [];
    A.marking.set(sha, { picture: photo.picture, marks });
    if (entry) {
      A.live.set(refKey(ref), entry);
      say('Your marks for this photo were on this device: the room made from them is back. Nothing was sent.');
    }
    setBusy(false);
    setRoad(R.chooseRoom(A.road, 2, { ...ref, made: !!entry }));
  } catch (e) {
    setBusy(false);
    say(e.message);
    const box = $('main').querySelector('.own-result');
    if (box) box.prepend(el('p', { class: 'error', role: 'alert', text: e.message }));
  }
}

// The marking board: on Step 10, or in place on Step 11 when the level made
// from the marks is missing. Making the room keeps the step: the reveal (or
// the round) follows on the same step.
function screenMarking(main, ref) {
  const m = A.marking.get(ref.sha256);
  const made = A.live.get(refKey(ref)) || null;
  let marker = null;
  const view = markView({
    actions: {
      role: (role) => marker && marker.setRole(role),
      make: () => makeFromMarks(ref, marker),
      undo: () => marker && marker.undo(),
      remove: () => marker && marker.remove(),
      keep: made && R.ownMade(A.road) ? () => { A.remark = null; render(); } : null,
    },
  });
  main.replaceChildren(view.section);
  const section = view.section;
  // the heading, the board and the panel's first lines fit main together,
  // as the reveal's do (src/screens.js revealHeight)
  const maxHeight = () => revealHeight({
    width: floorW(view.pic), aspect: m.picture.height / m.picture.width,
    spaceH: spaceH($('main')), headH: ceilH(section.querySelector('h1')),
    gap: parseFloat(getComputedStyle(section).rowGap) || 0,
    infoH: ceilH(view.info), beside: view.info.getBoundingClientRect().left > view.pic.getBoundingClientRect().left + 1,
  });
  marker = mountMarker(view, {
    picture: m.picture, marks: m.marks, say, maxHeight, busy: () => A.busy,
    // every change is kept on this device under the photo's fingerprint
    // (never the photo), beside the room made from earlier marks
    onChange: (marks) => { m.marks = marks; S.saveMarks(ref.sha256, marks, made ? made.built.level : null); progress(); },
  });
  A.reveals.push(marker);
  if (A.busy) setBusy(true);
}

async function makeFromMarks(ref, marker) {
  if (A.busy || !marker) return;
  const m = A.marking.get(ref.sha256);
  const marks = marker.marks;
  const need = needs(marks);
  if (!need.ready) {
    marker.showError(`Not yet: ${need.line}`);
    say(need.line);
    return;
  }
  setBusy(true);
  marker.status('Tracing the outlines inside your boxes…');
  say('Tracing the outlines inside your boxes');
  await new Promise((r) => setTimeout(r, 0)); // let the words show
  let r;
  try {
    r = await makeMarkedRoom({ marks, picture: m.picture, pixels: pixelsOf(m.picture), sha256: ref.sha256 });
  } catch (e) {
    r = { ok: false, words: e.message };
  }
  setBusy(false);
  if (!r.ok) {
    marker.showError(r.words);
    say(r.words);
    return;
  }
  m.marks = r.entry.marks;
  S.saveMarks(ref.sha256, r.entry.marks, r.entry.built.level);
  A.live.set(refKey(ref), r.entry);
  A.remark = null;
  A.road = R.makeMarked(A.road);
  saveRoad();
  progress();
  say('The room is made from your marks.');
  render();
}

// Your marked room's photo picked again (its level is not in memory): only
// the very photo, known by its fingerprint taken on this device. Nothing is
// sent, in any mode.
const MARKED_NOT_SAME = 'That is not the photo you marked. Nothing was sent.';
async function restoreMarked(file, shown) {
  if (A.busy) return;
  const ref = A.road.rooms[2];
  setBusy(true);
  try {
    const why = photoRefusal(file);
    if (why) throw new Error(why);
    const sha = await sha256Hex(await file.arrayBuffer());
    if (sha !== ref.sha256) throw new Error(MARKED_NOT_SAME);
    const { picture } = await previewPhoto(file);
    const kept = S.loadMarks(sha);
    const entry = ref.made ? keptMarkedEntry(kept, sha, picture) : null;
    A.marking.set(sha, { picture, marks: (kept && sanitizeMarks(kept.marks, picture.width, picture.height)) || [] });
    if (entry) A.live.set(refKey(ref), entry);
    setBusy(false);
    say(entry ? 'Your marks, and the room made from them, were on this device. Nothing was sent.' : 'Your photo is back, with the marks kept on this device. Nothing was sent.');
    render();
  } catch (e) {
    setBusy(false);
    showOwnResult(shown, { kind: 'refused', words: `${e.message} ${IN_PLACE_WAYS}` });
    say(e.message);
  }
}

// ---- the tour ----
// this step's line: your own room marked by hand has its own on Step 10
function tourNow() {
  const own = A.road.rooms[2];
  const marked = own && own.kind === 'marked' ? (document.querySelector('#main .marking') ? 'marking' : 'made') : null;
  return tourStep(A.road.step, marked);
}

let veil = [];
function clearVeil() {
  for (const v of veil) v.remove();
  veil = [];
  for (const e of document.querySelectorAll('.tour-lit')) e.classList.remove('tour-lit');
}

function lightControl() {
  if (!A.tour.on) { clearVeil(); return; }
  if (cardOpen()) { clearVeil(); return; }
  const t = tourNow();
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
  const t = tourNow();
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
  say('Tour on. ' + (tourNow() || { line: '' }).line);
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
// The server's health, tried up to 3 times (a slow or waking host gets
// 4 s, then 6 s, then 8 s), and again with Check again.
const HEALTH_WAITS = [4000, 6000, 8000];
const NO_SERVER_WORDS = 'The server did not answer, so this page shows sample rooms only.';
async function healthOnce(ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch('api/health', { signal: ctl.signal, headers: { 'X-FramePlay-Request': '1' } });
    if (!res.ok) throw new Error('no health');
    const h = await res.json();
    if (h && ['mock', 'live', 'rehearsal'].includes(h.mode)) return h;
    throw new Error('unknown health');
  } finally {
    clearTimeout(t);
  }
}

async function detectMode() {
  for (const ms of HEALTH_WAITS) {
    try {
      const h = await healthOnce(ms);
      A.mode = h.mode;
      A.modeWhy = h.reason || '';
      A.health = h;
      // a send's live_unavailable holds until health says otherwise
      A.liveDown = h.live_state === 'unavailable' ? { reason: h.live_reason || '', wait: h.live_check_again_s || 0 } : null;
      return true;
    } catch { /* tried again, up to 3 times */ }
  }
  A.mode = 'mock';
  A.health = null;
  A.liveDown = null;
  A.modeWhy = NO_SERVER_WORDS;
  return false;
}

// LIVE, but the live AI is unavailable (an account or model problem the
// owner must fix): the words for an off picker, or null. Health says so
// (live_state), or a send was answered live_unavailable. In REHEARSAL the
// same, when the stand-in refused the key (its drill): the server does not
// latch on a drill, so the page does, until Check again.
function liveOff() {
  if ((A.mode !== 'live' && A.mode !== 'rehearsal') || !A.liveDown) return null;
  const { reason, wait } = A.liveDown;
  const mins = wait > 0 ? Math.max(1, Math.round(wait / 60)) : 0;
  return sentences(
    A.mode === 'rehearsal' ? 'Off: the local stand-in answered as the live AI does for an account or model problem' : 'Off: the live AI is unavailable on this server right now',
    reason,
    'The sample rooms still work, and on Step 9 you can mark your own room by hand; nothing is sent',
    mins ? `The server tries again in about ${mins} minute${mins === 1 ? '' : 's'}: press Check again then.` : 'Press Check again to ask the server once more.',
  );
}

// Your own room's mode: with the live AI unavailable, a photo is shown on
// this device and can be marked, as in MOCK.
function ownMode() {
  return liveOff() ? 'mock' : A.mode;
}

// After a failed live read: a live_unavailable answer, in a reply or as the
// server's own 503 (src/photo.js passes its code on, with its Retry-After),
// turns the picker off at once; a send that failed otherwise without a
// reply (e: no e.reply) asks health again, quietly, in case the server's
// latch closed. In REHEARSAL a refused key (the stand-in's 401 drill) turns
// the picker off the same way.
const DRILL_KEY_REASON = 'The local stand-in refused this server’s key, as a rehearsal of a refused key.';
function liveFailed(e, f) {
  if (A.mode !== 'live' && A.mode !== 'rehearsal') return;
  const keyDrill = A.mode === 'rehearsal' && f.keyRefused;
  if (f.code === 'live_unavailable' || keyDrill) {
    A.liveDown = { reason: keyDrill ? DRILL_KEY_REASON : '', wait: (!keyDrill && e && e.retryAfter) || 0 };
    offNow();
    return;
  }
  if (A.mode !== 'live' || !e || e.reply) return;
  const step = A.road.step;
  healthOnce(HEALTH_WAITS[0]).then((h) => {
    if (h.mode !== 'live' || h.live_state !== 'unavailable' || A.liveDown) return;
    A.health = h;
    A.liveDown = { reason: h.live_reason || '', wait: h.live_check_again_s || 0 };
    if (!A.busy && A.road.step === step) offNow();
  }).catch(() => { /* the failure's own words stay */ });
}

// The picker just went off: your own room's screen says so in place (what
// the failed read showed, and its Mark your room, stay); other screens are
// drawn again.
function offNow() {
  const main = $('main');
  if (A.road.step === R.OWN_STEP && main.querySelector('.notice')) ownOffInPlace(main);
  else render();
}

// Check again: health asked once more (3 tries); the screen drawn again
// in the mode it gives.
async function checkAgain(button) {
  if (A.busy || A.checking) return;
  A.checking = true;
  if (button) { button.disabled = true; button.textContent = 'Checking…'; }
  say('Checking the server again');
  const was = A.mode;
  const wasOff = !!liveOff();
  try {
    await detectMode();
  } finally {
    A.checking = false;
  }
  rehearsalBand();
  await render();
  say(A.mode === 'live' && !liveOff() ? 'The live AI is on: you can choose a photo.'
    : A.mode === 'live' ? 'The live AI is still unavailable.'
      : A.mode !== was ? `This page now runs in ${A.mode.toUpperCase()}.`
        : A.mode === 'rehearsal' && wasOff ? 'The stand-in is answering again: you can send its picture.'
          : A.health ? 'The server answered: no change.' : 'The server still did not answer.');
}

// LIVE off (no server answered, or the live AI unavailable): a way to ask
// again, on the screens that offer a photo
function checkAgainButton() {
  if (A.health && !liveOff()) return null;
  const b = el('button', {
    type: 'button', class: 'btn', text: 'Check again', tip: 'Asks the server again whether the live AI is on',
    onclick: () => checkAgain(b),
  });
  return b;
}

function rehearsalBand() {
  const band = $('top').querySelector('.band');
  if (A.mode === 'rehearsal' && !band) {
    // a band on every screen: nothing in a rehearsal comes from Meta
    $('top').append(el('p', { class: 'band', text: 'REHEARSAL · local stand-in, not Meta. No photo leaves this machine.' }));
  } else if (A.mode !== 'rehearsal' && band) band.remove();
}

// ---- boot ----
async function boot() {
  initTooltips(() => A.tour.on);
  A.firstVisit = readPref('visited', null) === null;
  writePref('visited', true);
  A.tour.on = readPref('tour', false) === true;
  applyClasses();
  await detectMode();
  rehearsalBand();
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
