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
import { header } from './layoutmodel.js';

const doc = installFakeDocument();
doc.body.append(el('div', { id: 'tips' }));

const BAND = 'REHEARSAL · local stand-in, not Meta. No photo leaves this machine.';
const noop = () => {};

const rooms = {};
for (const id of ['desk', 'living']) rooms[id] = loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
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
    why: fw.ok || r.step >= R.FREE_PLAY ? '' : fw.why,
    band: mode === 'rehearsal' ? BAND : null,
  });
}

function card(id) {
  return V.roomCardView({ title: rooms[id].title, origin: 'mock', onPick: noop });
}

const canvas = (w, h) => el('canvas', { width: String(w), height: String(h) });

// The screens, as the page builds them. Each: { name, step, mode, section, pictures? }
export function screens(mode) {
  const out = [];
  const welcome = V.welcomeView({ mode, primaryLabel: R.primaryLabel(R.newRoad()), onConsent: noop });
  out.push({ name: 'Welcome', step: 1, section: welcome.section });
  for (const slot of [0, 1]) {
    const off = mode === 'live' ? null : V.OFF_WORDS[mode];
    const v = V.pickView({ slot, off, onFile: noop, rehearse: mode === 'rehearsal' ? { label: 'Rehearse the live path', tip: 't', onClick: noop } : null });
    v.cards.append(card('desk'), slot === 1 ? V.roomCardView({ title: rooms.living.title, origin: 'mock', disabledWhy: 'Already your first room', onPick: noop }) : card('living'));
    out.push({ name: `Pick room ${slot + 1}`, step: R.PICK_STEPS[slot], section: v.section, road: { rooms: slot ? [{ kind: 'sample', id: 'desk' }, null, null] : [null, null, null] } });
  }
  const found = mode === 'live'
    ? [{ ...liveRead(), fromDevice: true, step: R.OWN_STEP + 1 }]
    : [{ level: mockLevel('desk'), step: 3 }, { level: mockLevel('living'), step: 6 }];
  for (const f of found) {
    const v = V.foundView({ level: f.level, summary: f.summary || null, fromDevice: !!f.fromDevice, actions: { play: noop, describe: noop, walls: noop } });
    out.push({ name: `What the AI found (${f.level.title})`, step: f.step, section: v.section, reveal: { v, level: f.level } });
  }
  const cmp = V.compareView({ primaryLabel: R.primaryLabel({ step: 8 }), onContinue: noop });
  for (const [k, id] of ['desk', 'living'].entries()) cmp.cards.append(V.roomSumView({ level: mockLevel(id), best: k ? null : 1.24 }).article);
  out.push({ name: 'Your two rooms', step: 8, section: cmp.section, pictures: { 'two-pic': (w) => (w * 768) / 1024 } });
  const ownStates = [['as it opens', null]];
  if (mode === 'mock') {
    ownStates.push(['with a landscape photo kept here', { kind: 'kept', picture: canvas(1024, 768), words: MOCK_WORDS }]);
    ownStates.push(['with a portrait photo kept here', { kind: 'kept', picture: canvas(768, 1024), words: MOCK_WORDS }]);
  } else {
    // a refused photo is not shown: only the words (src/screens.js ownResult)
    ownStates.push(['with a photo refused', { kind: 'refused', picture: null, words: 'In REHEARSAL the local stand-in (not Meta) only knows the sample rooms’ own pictures, and this photo is not one of them. Nothing was sent, and no level is made from it.' }]);
  }
  for (const [what, result] of ownStates) {
    const v = V.ownView({
      mode, primaryLabel: R.primaryLabel({ step: R.OWN_STEP }), camera: true,
      sampleLink: mode === 'rehearsal' ? el('a', { class: 'btn', href: '#', text: 'Save the sample picture' }) : null,
      actions: { file: noop, skip: noop },
    });
    if (result) { v.shown.replaceChildren(...V.ownResult(result).filter(Boolean)); v.shown.hidden = false; v.shown.removeAttribute('hidden'); }
    out.push({ name: `Your own room, ${what}`, step: R.OWN_STEP, section: v.section });
  }
  const own = mode !== 'mock';
  const road = { rooms: [{ kind: 'sample', id: 'desk' }, { kind: 'sample', id: 'living' }, own ? { kind: 'photo', sha256: 'ab'.repeat(32) } : null], own: own ? null : 'skipped', finished: [true, true, own], best: [1.24, null, own ? 1.6 : null] };
  const closing = V.closingRooms({ road, mode, levels: [mockLevel('desk'), mockLevel('living'), own ? liveRead().level : null], summaries: [null, null, { named: 9 }] });
  out.push({ name: 'The end', step: R.LAST_STEP, section: V.closingView({ rooms: closing, mode, primaryLabel: 'Free play', actions: {} }), road });
  const free = V.freeView();
  free.cards.append(card('desk'), card('living'));
  if (own) free.cards.append(V.roomCardView({ title: 'A morning desk with a mug and three coins', origin: mode, onPick: noop }));
  out.push({ name: 'Free play', step: R.FREE_PLAY, section: free.section });
  return out;
}
