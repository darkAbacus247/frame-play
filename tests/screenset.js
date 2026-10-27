// The road's screens as the page builds them, in a mode, with the header
// each step really draws: shared by tests/fit.test.js (100% zoom) and
// tests/zoom.test.js (150% and 200%).
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './fakedom.js';
import { el } from '../src/ui.js';
import * as V from '../src/screens.js';
import * as R from '../src/road.js';
import { loadRoom } from '../src/rooms.js';
import { buildLevel, inputFromRoom, LABELS } from '../src/level.js';
import { inputFromReply, readSummary, REPLY_SCHEMA } from '../src/reply.js';
import { MOCK_WORDS } from '../src/own.js';
import { markedReply } from '../src/marks.js';
import { KEY_WORDS } from '../src/reply.js';
import { header } from './layoutmodel.js';

const doc = installFakeDocument();
doc.body.append(el('div', { id: 'tips' }));

const BAND = 'REHEARSAL · local stand-in, not Meta. No photo leaves this machine.';
const noop = () => {};

const rooms = {};
for (const id of ['desk', 'living', 'apartment']) rooms[id] = loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
export const mockLevel = (id) => buildLevel(inputFromRoom(rooms[id], '2026-10-27T10:00:00Z')).level;

// a LIVE read of the desk with every extra line the reveal can show
export function liveRead() {
  const r = rooms.desk;
  const box = (b) => [Math.max(0, Math.round(b.x0)), Math.max(0, Math.round(b.y0)), Math.min(r.width, Math.round(b.x1)), Math.min(r.height, Math.round(b.y1))];
  const reply = {
    schema: REPLY_SCHEMA, request_id: 'r1', status: 'ok',
    provenance: { mode: 'live', label: LABELS.live, models: ['muse-spark-1.3', 'sam-3.1'], calls: [] },
    received: { width: r.width, height: r.height },
    scene: { title: 'A morning desk with a mug and three coins', theme_line: '', people_present: false, scenery: [{ name: 'picture frame' }, { name: 'window' }] },
    surface: null,
    objects: r.objects.filter((o) => o.on_surface).map((o, k) => ({ id: `o${k + 1}`, name: o.name, instance: o.instance, role: o.role, reason: o.reason, on_surface: true, box: box(o.bounds), confidence: 0.9, seeds: [] })),
    warnings: ['not found: teapot', 'not found: stapler'],
  };
  return { level: buildLevel(inputFromReply(reply, { kind: 'photo', sha256: 'ab'.repeat(32) }, undefined, '2026-10-27T10:00:00Z')).level, summary: readSummary(reply) };
}

export function headFor(step, mode, road = {}) {
  const r = { ...R.newRoad(), consent: step > 1, ...road, step };
  const fw = R.canForward(r);
  return header({
    lap: R.lapText(r), counter: R.counterText(r),
    why: fw.ok || r.step >= R.FREE_PLAY ? '' : (road.why || fw.why),
    band: mode === 'rehearsal' ? BAND : null,
  });
}

function card(id) {
  return V.roomCardView({ title: rooms[id].title, origin: 'mock', onPick: noop });
}

const canvas = (w, h) => el('canvas', { width: String(w), height: String(h) });

// your own room marked by hand: the desk's objects as boxes, made with box
// outlines (the fit does not depend on how they were traced)
const SHA = 'ab'.repeat(32);
export function markedLevel() {
  const r = rooms.desk;
  const marks = r.objects.filter((o) => o.on_surface).map((o) => ({ role: o.role === 'flat' ? 'solid' : o.role, box: [o.bounds.x0 - 8, o.bounds.y0 - 8, o.bounds.x1 + 8, o.bounds.y1 + 8].map(Math.round) }));
  return buildLevel(inputFromReply(markedReply(marks, r.width, r.height), { kind: 'marked', sha256: SHA }, undefined, '2026-10-27T10:00:00Z')).level;
}
const SAMPLE_REFS = [{ kind: 'sample', id: 'desk' }, { kind: 'sample', id: 'living' }, { kind: 'sample', id: 'apartment' }];
const ownRooms = (own) => [...SAMPLE_REFS, own];

// The marking board's screen as the page fills it: n boxes, so n chips.
export function markingScreen(n) {
  const v = V.markView({ actions: { role: noop, make: noop, undo: noop, remove: noop, keep: null } });
  v.needsLine.textContent = n ? 'Ready: 3 coins, the exit and 5 other boxes. Make the room, and code checks it can be won.' : 'Draw a box over an object to mark it. The room needs at least one coin and an exit.';
  v.pic.append(el('div', { class: 'mark-board', tabindex: '0', role: 'application' }, [canvas(1024, 768)]));
  const names = ['obstacle 1', 'coin 1', 'obstacle 2', 'obstacle 3', 'obstacle 4', 'hazard', 'coin 2', 'exit', 'coin 3', 'obstacle 5', 'obstacle 6', 'coin 4'];
  v.chips.append(...names.slice(0, n).map((t) => el('button', { type: 'button', class: 'chip chip-collect', 'aria-pressed': 'false', text: t })));
  v.roles[0].setAttribute('aria-pressed', 'true');
  v.boxesSummary.textContent = `Your boxes (${n})`;
  return v;
}

// The page's showOwnResult: Mark your room becomes the one primary.
function demote(section) {
  for (const p of section.all().filter((e) => e.attrs && e.hasAttribute('data-primary'))) { p.removeAttribute('data-primary'); p.classList.remove('primary'); }
}

// The screens, as the page builds them. Each: { name, step, mode, section, pictures? }
export function screens(mode) {
  const out = [];
  const welcome = V.welcomeView({ mode, primaryLabel: R.primaryLabel(R.newRoad()), onConsent: noop });
  out.push({ name: 'Welcome', step: 1, section: welcome.section });
  // each pick step as it first opens (Step 2) and as the road reaches it
  // with its room already chosen (Steps 5 and 8, and any step gone back to)
  for (const [slot, chosen] of [[0, false], [0, true], [1, true], [2, true]]) {
    const off = mode === 'live' ? null : V.OFF_WORDS[mode];
    const here = chosen ? ['desk', 'living', 'apartment'][slot] : null;
    const v = V.pickView({
      slot, off, onFile: noop, rehearse: mode === 'rehearsal' ? { label: 'Rehearse the live path', tip: 't', onClick: noop } : null,
      chosen: here ? { title: rooms[here].title, onContinue: noop } : null,
    });
    const earlier = ['desk', 'living', 'apartment'].slice(0, slot);
    for (const id of ['desk', 'living', 'apartment']) {
      const used = earlier.indexOf(id);
      v.cards.append(V.roomCardView({ title: rooms[id].title, origin: 'mock', disabledWhy: used >= 0 ? `Already your ${['first', 'second'][used]} room` : null, chosen: id === here, onPick: noop }));
    }
    const roadRooms = [...SAMPLE_REFS.slice(0, slot + (chosen ? 1 : 0)), null, null, null, null].slice(0, 4);
    out.push({ name: `Pick room ${slot + 1}${chosen ? ', chosen' : ''}`, step: R.PICK_STEPS[slot], section: v.section, road: { rooms: roadRooms } });
  }
  const found = mode === 'live'
    ? [{ ...liveRead(), fromDevice: true, step: R.OWN_STEP + 1 }]
    : [{ level: mockLevel('desk'), step: 3 }, { level: mockLevel('living'), step: 6 }, { level: mockLevel('apartment'), step: 9 }];
  for (const f of found) {
    const v = V.foundView({ level: f.level, summary: f.summary || null, fromDevice: !!f.fromDevice, slot: R.slotOf(f.step), actions: { play: noop, describe: noop, walls: noop, leave: noop } });
    out.push({ name: `What the AI found (${f.level.title})`, step: f.step, section: v.section, reveal: { v, level: f.level } });
  }
  const cmp = V.compareView({ primaryLabel: R.primaryLabel({ step: R.THREE_STEP }), onContinue: noop });
  for (const [k, id] of ['desk', 'living', 'apartment'].entries()) cmp.cards.append(V.roomSumView({ level: mockLevel(id), best: [1.24, null, 2.31][k] }).article);
  out.push({ name: 'Your three rooms', step: R.THREE_STEP, section: cmp.section, pictures: { 'sum-pic': (w) => (w * 768) / 1024 }, road: { rooms: [...SAMPLE_REFS, null], finished: [true, true, true, false] } });
  const ownStates = [['as it opens', null]];
  if (mode === 'mock') {
    ownStates.push(['with a landscape photo kept here', { kind: 'kept', picture: canvas(1024, 768), words: MOCK_WORDS }, true]);
    ownStates.push(['with a portrait photo kept here', { kind: 'kept', picture: canvas(768, 1024), words: MOCK_WORDS }, true]);
  } else {
    // a refused photo is not shown: only the words (src/screens.js ownResult)
    ownStates.push(['with a photo refused', { kind: 'refused', picture: null, words: 'In REHEARSAL the local stand-in (not Meta) only knows the sample rooms’ own pictures, and this photo is not one of them. Nothing was sent, and no level is made from it. You can mark the room yourself instead, try another photo, or continue to the end.' }, true]);
    ownStates.push(['with the people refusal', { kind: 'refused', picture: null, words: 'This photo seems to show a person. Please use one with no people.' }, false]);
    ownStates.push(['with a refused key', { kind: 'refused', words: `${KEY_WORDS[mode]} You can mark the room yourself instead, try another photo, or continue to the end.` }, true]);
  }
  for (const [what, result, markable] of ownStates) {
    const v = V.ownView({
      mode, primaryLabel: R.primaryLabel({ step: R.OWN_STEP }), camera: true,
      sampleLink: mode === 'rehearsal' ? el('a', { class: 'btn', href: '#', text: 'Save the sample picture' }) : null,
      actions: { file: noop, skip: noop },
    });
    if (markable) demote(v.section);
    if (result) { v.shown.replaceChildren(...V.ownResult(result, markable ? { mark: noop } : null).filter(Boolean)); v.shown.hidden = false; v.shown.removeAttribute('hidden'); }
    out.push({ name: `Your own room, ${what}`, step: R.OWN_STEP, section: v.section, road: markable ? { why: 'Mark your room, or continue to the end' } : undefined });
  }
  // your marks: as it opens, and with a dozen boxes; then the room made from them
  for (const n of [0, 12]) {
    const v = markingScreen(n);
    out.push({ name: `Your marks (${n} boxes)`, step: R.OWN_STEP + 1, section: v.section, road: { rooms: ownRooms({ kind: 'marked', sha256: SHA, made: false }), finished: [true, true, true, false] }, reveal: { v, level: { picture: { width: 1024, height: 768 } } } });
  }
  {
    const level = markedLevel();
    const v = V.foundView({ level, summary: null, fromDevice: true, slot: R.OWN_SLOT, actions: { play: noop, describe: noop, walls: noop, remark: noop, leave: noop } });
    out.push({ name: 'Your room, from your marks', step: R.OWN_STEP + 1, section: v.section, road: { rooms: ownRooms({ kind: 'marked', sha256: SHA, made: true }), finished: [true, true, true, false] }, reveal: { v, level } });
  }
  const own = mode !== 'mock';
  const road = { rooms: ownRooms(own ? { kind: 'photo', sha256: 'ab'.repeat(32) } : null), own: own ? null : 'skipped', finished: [true, true, true, own], best: [1.24, null, 2.31, own ? 1.6 : null] };
  const samples = [mockLevel('desk'), mockLevel('living'), mockLevel('apartment')];
  const closing = V.closingRooms({ road, mode, levels: [...samples, own ? liveRead().level : null], summaries: [null, null, null, { named: 9 }] });
  out.push({ name: 'The end', step: R.LAST_STEP, section: V.closingView({ rooms: closing, mode, primaryLabel: 'Free play', actions: {} }), road });
  const markedRoad = { ...road, own: null, rooms: ownRooms({ kind: 'marked', sha256: SHA, made: true }), finished: [true, true, true, true], best: [1.24, null, 2.31, 1.1] };
  const markedRows = V.closingRooms({ road: markedRoad, mode, levels: [...samples, markedLevel()] });
  out.push({ name: 'The end, your own room marked', step: R.LAST_STEP, section: V.closingView({ rooms: markedRows, mode, primaryLabel: 'Free play', actions: {} }), road: markedRoad });
  const free = V.freeView();
  free.cards.append(card('desk'), card('living'), card('apartment'));
  if (own) free.cards.append(V.roomCardView({ title: 'A morning desk with a mug and three coins', origin: mode, onPick: noop }));
  out.push({ name: 'Free play', step: R.FREE_PLAY, section: free.section });
  const freeMarked = V.freeView();
  freeMarked.cards.append(card('desk'), card('living'), card('apartment'), V.roomCardView({ title: 'Your own room: marked by you', origin: 'marked', onPick: noop }));
  out.push({ name: 'Free play, your own room marked', step: R.FREE_PLAY, section: freeMarked.section });
  return out;
}
