import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { soundOn, setSound, readPref, writePref } from '../src/store.js';
import { tourStep, offerDue, shouldPulse, veilRects, OFFER_AFTER_MS } from '../src/tour.js';
import { placeTip } from '../src/ui.js';
import { describeRoom, announce, endCardWords, ruleRow, stepsAway } from '../src/words.js';
import { FREE_PLAY } from '../src/road.js';
import { loadRoom } from '../src/rooms.js';
import { buildLevel, inputFromRoom } from '../src/level.js';
import { createRound } from '../src/play.js';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    size: () => m.size,
  };
}
function useStorage(s) {
  Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
}

test('sound is on for a fresh device, and a choice is stored only after a change', () => {
  const s = memoryStorage();
  useStorage(s);
  assert.equal(soundOn(), true);
  assert.equal(s.size(), 0, 'nothing stored before the person changes it');
  setSound(false);
  assert.equal(soundOn(), false);
  setSound(true);
  assert.equal(soundOn(), true);
  assert.equal(readPref('sound', null), true);
});

test('with storage blocked, every visit starts fresh and sound is on', () => {
  useStorage({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });
  assert.equal(soundOn(), true);
  assert.equal(writePref('x', 1), false);
  assert.equal(readPref('road', 'fresh'), 'fresh');
  useStorage(memoryStorage());
});

test('the tour has a line and a lit control for every road state', () => {
  for (let s = 1; s <= FREE_PLAY; s++) {
    const t = tourStep(s);
    assert.ok(t && t.line.length > 10 && ['primary', 'room-card', 'chip'].includes(t.target), `step ${s}`);
  }
});

test('the offer appears once per visit, after the wait, never over the tour or a card', () => {
  const base = { now: 100000, lastProgress: 100000 - OFFER_AFTER_MS, offered: false, tourOn: false, cardOpen: false };
  assert.equal(offerDue(base), true);
  assert.equal(offerDue({ ...base, offered: true }), false);
  assert.equal(offerDue({ ...base, tourOn: true }), false);
  assert.equal(offerDue({ ...base, cardOpen: true }), false);
  assert.equal(offerDue({ ...base, lastProgress: base.now - 1000 }), false);
  assert.equal(offerDue({ ...base, step: 3, notOn: 3 }), false, 'not again on a step where it did not fit');
  assert.equal(offerDue({ ...base, step: 4, notOn: 3 }), true, 'tried again on a later step');
});

test('Take the tour pulses once on a first visit, never under reduced motion', () => {
  assert.equal(shouldPulse({ firstVisit: true, reducedMotion: false }), true);
  assert.equal(shouldPulse({ firstVisit: true, reducedMotion: true }), false);
  assert.equal(shouldPulse({ firstVisit: false, reducedMotion: false }), false);
});

test('the tour veil covers everything but the lit control, exactly once', () => {
  const W = 300, H = 200;
  const ctrl = { left: 100, top: 80, right: 160, bottom: 124 };
  const rects = veilRects(W, H, ctrl, 6);
  const covered = (x, y) => rects.filter(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh).length;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const inHole = x >= 94 && x < 166 && y >= 74 && y < 130;
      assert.equal(covered(x, y), inHole ? 0 : 1, `${x},${y}`);
    }
  }
  // a control at the very edge: rectangles stay inside the area
  for (const [x, y, w, h] of veilRects(W, H, { left: -4, top: 190, right: 40, bottom: 230 })) {
    assert.ok(x >= 0 && y >= 0 && x + w <= W && y + h <= H && w > 0 && h > 0);
  }
});

test('a tooltip goes where it covers no control, or is not shown', () => {
  const ctrl = { left: 100, top: 100, right: 200, bottom: 144, width: 100, height: 44 };
  const size = { w: 120, h: 40 };
  const above = placeTip(ctrl, size, 800, 600, []);
  assert.ok(above.bottom <= ctrl.top);
  const blockAbove = { left: 60, top: 40, right: 240, bottom: 95 };
  const below = placeTip(ctrl, size, 800, 600, [blockAbove]);
  assert.ok(below.top >= ctrl.bottom);
  const everywhere = [{ left: 0, top: 0, right: 800, bottom: 99 }, { left: 0, top: 145, right: 800, bottom: 600 }, { left: 0, top: 0, right: 99, bottom: 600 }, { left: 201, top: 0, right: 800, bottom: 600 }];
  assert.equal(placeTip(ctrl, size, 800, 600, everywhere), null);
});

test('Describe this room and every announcement are in words', () => {
  const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
  const { level, rt } = buildLevel(inputFromRoom(room, 'x'));
  const state = createRound(level, rt);
  const lines = describeRoom(level, rt, state, stepsAway(level, rt, ...level.start));
  assert.match(lines[0], /You walk on the desk/);
  assert.ok(lines.some((l) => /^Cactus: avoid it; .*steps away\.$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^Cardboard box: the exit, locked/.test(l)));
  assert.ok(lines.some((l) => /^Picture frame: scenery, out of reach\.$/.test(l)));
  assert.equal(lines.length, level.objects.length + 1);
  const k = (id) => level.objects.findIndex((o) => o.id === id);
  assert.equal(announce(level, { type: 'collect', k: k('coin2'), left: 2 }), 'Coin 2 collected. 2 left.');
  assert.equal(announce(level, { type: 'unlock' }), 'The cardboard box is open.');
  assert.equal(announce(level, { type: 'locked', left: 2 }), 'Locked: collect 2 more.');
  assert.equal(announce(level, { type: 'bump', k: k('lamp') }), 'Blocked by the desk lamp');
  assert.equal(announce(level, { type: 'bump', k: -1 }, 'desk'), 'Blocked by the edge of the desk');
  assert.equal(announce(level, { type: 'lose', k: k('cactus') }), 'The cactus got you.');
  assert.equal(announce(level, { type: 'win' }), 'Room cleared!');
  assert.equal(announce(level, { type: 'step' }), null);
  assert.equal(ruleRow(level, state), 'Collected 0 of 3 · Avoid: cactus · Cardboard box: locked');
  assert.equal(endCardWords(level, { status: 'won' }, 1.3).body, 'Your route: 1.3 times the shortest.');
  assert.equal(endCardWords(level, { status: 'lost', lostTo: k('cactus') }, null).title, 'The cactus got you.');
});

// Every el('button', {...}) in a file, as the text of its attributes.
function buttonAttrs(src) {
  const out = [];
  for (let i = src.indexOf("el('button', {"); i >= 0; i = src.indexOf("el('button', {", i + 1)) {
    let depth = 0, j = src.indexOf('{', i);
    const start = j;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      if (src[j] === '}' && --depth === 0) break;
    }
    out.push(src.slice(start, j + 1));
  }
  return out;
}

test('no primary button moves the counter back: none sets the step or calls back()', () => {
  let primaries = 0;
  for (const f of ['../app.js', '../src/screens.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const attrs of buttonAttrs(src)) {
      if (!/'data-primary':[^,]*'true'/.test(attrs)) continue;
      primaries++;
      const onclick = attrs.slice(attrs.indexOf('onclick:'));
      assert.ok(attrs.includes('onclick:'), `${f}: a primary with no action: ${attrs}`);
      assert.doesNotMatch(onclick, /\bstep\s*:/, `${f}: a primary sets the step: ${onclick}`);
      assert.doesNotMatch(onclick, /\bback\(\)/, `${f}: a primary goes back: ${onclick}`);
    }
  }
  assert.ok(primaries >= 8, `the primaries were found (${primaries})`);
});

test('Escape and modifier keys never create the sound context; disclosure markers stay out of names', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /NOT_ACTIVATION = new Set\(\['Escape', 'Esc', 'Shift', 'Control', 'Alt', 'Meta'/);
  assert.match(app, /addEventListener\('keydown', \(e\) => \{ if \(!NOT_ACTIVATION\.has\(e\.key\)\) unlock\(\); \}/);
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  for (const m of css.matchAll(/summary::before \{ content: ([^;]+);/g)) assert.match(m[1], /^"[▸▾]" \/ ""$/, m[0]);
});

test('the tests’ own PNG CRC-32 matches the standard one, on any Node', async () => {
  const { crc32, encodePNG, decodePNG } = await import('./png.js');
  assert.equal(crc32(Buffer.from('IEND', 'latin1')), 0xae426082);
  assert.equal(crc32(Buffer.from('123456789', 'latin1')), 0xcbf43926);
  const px = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);
  assert.deepEqual(decodePNG(encodePNG(px, 2, 1)).data, px);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '>=20.6', 'the Node floor is stated');
});

test('the page shell: in-flow grid, no inline styles or scripts, labels in place', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!/<style/i.test(html) && !/\sstyle=/i.test(html) && !/<script(?![^>]*src=)/i.test(html));
  for (const id of ['top', 'main', 'tour-strip', 'drawer', 'dock', 'live', 'card']) assert.ok(html.includes(`id="${id}"`), id);
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(app.includes('Built with AI assistance: Claude Code (Anthropic) wrote the code under my direction.'));
});
