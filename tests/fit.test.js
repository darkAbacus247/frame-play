// Every screen fits main without scrolling at 100% zoom in an 839x945 and
// a 1259x1418 window, where content allows. Laid out by tests/layoutmodel.js
// with the stylesheet's own cascade and text a little wider than the real
// font, under the header each step really draws.
//
// Explicit exceptions, by design: what the player opens (a disclosure,
// Describe this room, the settings drawer, the tour once the player starts
// it) may make main scroll; screens are measured as they first appear. The
// tour offer opens by itself, so it is no exception: the page takes it back
// where it would not fit (tested below). The play screen is laid out by its
// own model in tests/layout.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './fakedom.js';
import { el, ceilH, spaceH } from '../src/ui.js';
import { offerFits } from '../src/tour.js';
import * as V from '../src/screens.js';
import * as R from '../src/road.js';
import { loadRoom } from '../src/rooms.js';
import { buildLevel, inputFromRoom, LABELS } from '../src/level.js';
import { inputFromReply, readSummary, REPLY_SCHEMA } from '../src/reply.js';
import { MOCK_WORDS } from '../src/own.js';
import { header, mainSpace, screenHeight, styleOf, MAIN_CHAIN } from './layoutmodel.js';

const doc = installFakeDocument();
doc.body.append(el('div', { id: 'tips' }));

const WINDOWS = [[839, 945], [1259, 1418]];
const BAND = 'REHEARSAL · local stand-in, not Meta. No photo leaves this machine.';
const noop = () => {};

const rooms = {};
for (const id of ['desk', 'living']) rooms[id] = loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
const mockLevel = (id) => buildLevel(inputFromRoom(rooms[id], '2026-10-27T10:00:00Z')).level;

// a LIVE read of the desk with every extra line the reveal can show
function liveRead() {
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

function headFor(step, mode, road = {}) {
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
function screens(mode) {
  const out = [];
  const welcome = V.welcomeView({ mode, primaryLabel: R.primaryLabel(R.newRoad()), onConsent: noop });
  out.push({ name: 'Welcome', step: 1, section: welcome.section });
  for (const slot of [0, 1]) {
    const off = mode === 'live' ? null : mode === 'rehearsal' ? 'Off in REHEARSAL: the stand-in reads only its own sample room, so no photo is ever sent.' : 'Off in MOCK mode: there is no live connection, so the page plays sample rooms drawn by code.';
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
    ownStates.push(['with a photo refused', { kind: 'refused', picture: canvas(1024, 768), words: 'In REHEARSAL the local stand-in (not Meta) only knows the sample rooms’ own pictures, and this photo is not one of them. Nothing was sent, and no level is made from it.' }]);
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

// The reveal picture as app.js sizes it: revealHeight, from the space, the
// heading and the info laid out at its own column's width.
function revealPictures(s, L, width, space) {
  const { level } = s.reveal;
  const chain = [...MAIN_CHAIN, { tag: 'section', cls: ['screen', 'found'] }];
  const gridChain = [...chain, { tag: 'div', cls: ['found-grid'] }];
  const st = styleOf(gridChain, L.vw, L.vh);
  const kids = s.section.children[1].children;
  const cols = L.tracks(st, width, L.gaps(st).col, kids, gridChain, { size: 16, weight: 400, lh: 1.5 });
  const beside = cols.length > 1;
  // read as the page reads them (src/ui.js ceilH, spaceH)
  const infoH = Math.ceil(L.measure(s.reveal.v.info, gridChain, beside ? cols[1] : width).h);
  const headH = Math.ceil(L.measure(s.section.children[0], chain, width).h);
  const gap = L.gaps(styleOf(chain, L.vw, L.vh)).row;
  return {
    'found-pic': (w) => Math.floor(V.revealHeight({ width: Math.floor(w), aspect: level.picture.height / level.picture.width, spaceH: Math.floor(space), headH, gap, infoH, beside })),
  };
}

for (const [vw, vh] of WINDOWS) {
  test(`every road screen fits main without scrolling at ${vw}x${vh}, 100% zoom`, () => {
    const report = [];
    for (const mode of ['mock', 'live', 'rehearsal']) {
      for (const s of screens(mode)) {
        const head = headFor(s.step, mode, s.road);
        let { space, width, layout } = mainSpace(vw, vh, head, mode);
        if (s.reveal || s.pictures) {
          const pictures = s.reveal ? revealPictures(s, layout, width, space) : s.pictures;
          ({ space, width, layout } = mainSpace(vw, vh, head, mode, { pictures }));
        }
        const h = screenHeight(layout, s.section, width);
        report.push(`${mode} · ${s.name}: ${h.toFixed(2)} of ${space.toFixed(2)}px`);
        // no tolerance: a fraction of a pixel too much paints a scrollbar
        assert.ok(h <= space, `${vw}x${vh} ${mode} · ${s.name}: ${h.toFixed(2)}px of content in ${space.toFixed(2)}px of main\n${report.join('\n')}`);
        spare.push({ name: `${vw}x${vh} ${mode} · ${s.name}`, spare: space - h });
      }
    }
  });
}

// The page's own read helpers (src/ui.js) on a fake element with a
// fractional size.
const box = (height, width = 0) => ({ getBoundingClientRect: () => ({ height, width }) });

test('a fitted reveal never overshoots by a fraction of a pixel', () => {
  // h1 at 2rem x 1.2 (38.390625 at 1/64 px), main 729.77 px with 24 px padding
  globalThis.getComputedStyle = () => ({ paddingTop: '24px', paddingBottom: '24px' });
  const main = box(729.77);
  const lines = 25.59375;
  let checked = 0;
  for (const headH of [38.390625, 28.796875]) {
    for (let n = 1; n <= 4; n++) {
      for (const device of [false, true]) {
        // the summary, the device line, the buttons, two closed panels, the label, and their gaps
        const infoH = n * lines + (device ? lines + 16 : 0) + lines + 44 + 2 * 46 + 4 * 16;
        const pic = Math.floor(V.revealHeight({ width: 791, aspect: 0.75, spaceH: spaceH(main), headH: ceilH(box(headH)), gap: 24, infoH: ceilH(box(infoH)), beside: false }));
        const total = 24 + headH + 24 + pic + 24 + infoH + 24;
        assert.ok(total <= 729.77 && total <= Math.floor(729.77), `h1 ${headH}, ${n} lines${device ? ' + device line' : ''}: ${total.toFixed(3)}px in 729`);
        checked++;
      }
    }
  }
  assert.equal(checked, 16);
  // the old whole-pixel reads (38 and 302 for 38.39 and 302.375) overshoot
  const old = Math.floor(V.revealHeight({ width: 791, aspect: 0.75, spaceH: 729 - 48, headH: 38, gap: 24, infoH: 302, beside: false }));
  assert.ok(24 + 38.390625 + 24 + old + 24 + 302.375 + 24 > 729, 'the bug this guards against');
  assert.equal(Math.floor(V.revealHeight({ width: 791, aspect: 0.75, spaceH: 729 - 48, headH: 39, gap: 24, infoH: 303, beside: false })), old - 2);
  delete globalThis.getComputedStyle;
});

test('no picture that fills the space left reads a rounded size', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const game = readFileSync(new URL('../src/game.js', import.meta.url), 'utf8');
  const reveal = app.slice(app.indexOf('async function screenFound'), app.indexOf('async function screenPlay'));
  const sizing = game.slice(game.indexOf('export function mountReveal'), game.indexOf('const ro = new ResizeObserver(fit)'))
    + game.slice(game.indexOf('let fitted ='), game.indexOf('for (const e of [root, wrap, rule, label, side])'));
  for (const [where, src] of [['app.js screenFound', reveal], ['src/game.js sizing', sizing]]) {
    assert.ok(src.length > 200, `${where} was found`);
    assert.doesNotMatch(src, /\.(offsetHeight|offsetWidth|clientHeight|clientWidth)\b/, `${where} reads a rounded size`);
  }
});

// The tour offer opens by itself (after 45 s) and takes its height from
// main. It is 68 px tall at both windows; on every screen with less to
// spare the page takes it back before it is painted.
const spare = [];
test('the tour offer never makes a fitted screen scroll', () => {
  const strip = el('div', { class: 'tour-strip' }, [el('div', { class: 'inner offer' }, [
    el('p', { text: 'New here? Take the tour.' }),
    el('button', { type: 'button', class: 'btn', text: 'Take the tour' }),
    el('button', { type: 'button', class: 'btn quiet', text: 'Not now' }),
  ])]);
  for (const [vw, vh] of WINDOWS) {
    const L = mainSpace(vw, vh, headFor(1, 'mock'), 'mock').layout;
    const h = L.measure(strip, [MAIN_CHAIN[0], MAIN_CHAIN[1], MAIN_CHAIN[2]], vw).h;
    assert.equal(Math.round(h), 68, `${vw}x${vh}: the offer strip`);
  }
  const tight = spare.filter((s) => s.spare < 68);
  assert.ok(tight.length >= 4, `the screens with too little to spare are known: ${tight.map((s) => s.name).join(', ')}`);
  assert.equal(offerFits({ scrollH: 730, clientH: 729 }), false, 'one pixel over: taken back');
  assert.equal(offerFits({ scrollH: 729, clientH: 729 }), true);
  assert.equal(offerFits({ scrollH: 500, clientH: 729, barsOver: true }), false, 'a bar body that would scroll');
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const show = app.slice(app.indexOf('function showOffer'), app.indexOf('setInterval('));
  assert.match(show, /offerFits\(\{ scrollH: m\.scrollHeight, clientH: m\.clientHeight, barsOver \}\)/, 'the page measures main once the offer is in');
  assert.match(show, /\$\('tour-strip'\)\.replaceChildren\(\);\s*A\.tour\.notOn = A\.road\.step;\s*return;/, 'and takes it back, to try on a later step');
  assert.ok(app.includes('step: A.road.step, notOn: A.tour.notOn })) showOffer();'), 'not offered again on that step');
  const game = readFileSync(new URL('../src/game.js', import.meta.url), 'utf8');
  assert.match(game, /const host = root\.closest\('main'\);\s*if \(host\) ro\.observe\(host\);/, 'the reveal re-fits when main changes height');
});

test('the reveal picture gives way so the heading, the summary and the buttons stay in view', () => {
  // one column: the info's height comes off the picture; beside it, only the heading's
  const base = { width: 791, aspect: 0.75, spaceH: 700, headH: 38, gap: 24, infoH: 300 };
  assert.equal(V.revealHeight({ ...base, beside: false }), 700 - 38 - 24 - 24 - 300);
  assert.equal(V.revealHeight({ ...base, width: 400, beside: true }), 300, 'its own shape when that fits');
  assert.equal(V.revealHeight({ ...base, width: 1200, beside: true }), 700 - 38 - 24);
  assert.equal(V.revealHeight({ ...base, spaceH: 300, beside: false }), 192, 'never under 12rem: then main scrolls');
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /return revealHeight\(\{/, 'the page sizes the reveal with the same rule');
});

test('disclosures start closed, with their summary in view and a full-size target', () => {
  let seen = 0;
  for (const mode of ['mock', 'live', 'rehearsal']) {
    for (const s of screens(mode)) {
      for (const d of [s.section, ...s.section.all()].filter((e) => e.tagName === 'DETAILS')) {
        seen++;
        assert.equal(d.hasAttribute('open'), false, `${mode} · ${s.name}: starts closed`);
        const first = d.children[0];
        assert.equal(first.tagName, 'SUMMARY', `${mode} · ${s.name}: the summary comes first`);
        assert.ok(first.textContent.length >= 8, `${mode} · ${s.name}: the summary says what is inside`);
      }
    }
  }
  assert.ok(seen >= 6, 'the welcome notice, the found lists and the rehearsal notes are folded');
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.more > summary \{[^}]*min-height: var\(--target\)/);
});

test('the welcome notice: key points in view, every required statement one press away', () => {
  for (const mode of ['mock', 'live', 'rehearsal']) {
    const { section } = V.welcomeView({ mode, primaryLabel: 'I am 18 or over and I understand. Continue', onConsent: noop });
    const all = [section, ...section.all()];
    const details = all.find((e) => e.tagName === 'DETAILS');
    assert.equal(details.children[0].textContent, 'Read the full notice');
    const inside = details.all().map((e) => e.textContent).join(' ');
    for (const line of ['Keep people and anything private out of the photo.', 'You must be 18 or over to send a photo (Meta’s terms).', V.WHERE[mode], V.KEPT]) {
      assert.ok(inside.includes(line), `${mode}: "${line}" is in the full notice`);
    }
    const points = all.find((e) => e.tagName === 'UL' && e.getAttribute('aria-label') === 'Before you start');
    assert.equal(points.children.length, 4, 'the key points: people, age, where the photo goes, what is kept');
    assert.ok(points.children.every((li) => li.textContent.length <= 80), 'each key point is one short line');
    const button = all.find((e) => e.tagName === 'BUTTON' && e.hasAttribute('data-primary'));
    assert.equal(button.parentNode.className, 'bar-end welcome-bar', 'the consent button sits in the bar, outside the text');
  }
});

test('a calm reading column: text never wider than about 65 characters, with generous lines', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /\np \{ margin: 0; max-width: 65ch; \}/);
  assert.match(css, /\.screen li, \.screen figcaption \{ max-width: 65ch; \}/);
  assert.match(css, /\.screen p, \.screen li \{ line-height: 1\.6; \}/);
  for (const m of css.matchAll(/max-width:\s*(\d+)ch/g)) assert.ok(+m[1] <= 65, `max-width: ${m[1]}ch`);
});
