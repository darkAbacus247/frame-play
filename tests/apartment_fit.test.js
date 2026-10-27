// W1d: Steps 2, 5 and 8 (and Free play) offer The Apartment beside the
// other sample rooms without breaking a layout rule: no scroll in main at
// 839x945 and 1259x1418, 100% zoom, laid out by tests/layoutmodel.js as
// tests/fit.test.js lays out every road screen (the same model, no
// tolerance). The page lists its sample rooms in app.js (SAMPLES); M5 added
// the apartment there, and the cards laid out here are the ones it lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as V from '../src/screens.js';
import * as R from '../src/road.js';
import { loadRoom } from '../src/rooms.js';
import { mainSpace, screenHeight } from './layoutmodel.js';
import { headFor } from './screenset.js';

const WINDOWS = [[839, 945], [1259, 1418]];
const noop = () => {};
// the page's own list, read from app.js (importing it would start the page)
const SAMPLES_SRC = /const SAMPLES = \[([\s\S]*?)\];/.exec(readFileSync(new URL('../app.js', import.meta.url), 'utf8'))[1];
const IDS = [...SAMPLES_SRC.matchAll(/\{ id: '(\w+)', file: 'rooms\/(\w+)\.json' \}/g)].map((m) => { assert.equal(m[1], m[2]); return m[1]; });

test('the page offers three sample rooms: The Desk Top, The Living Room and The Apartment', () => {
  assert.deepEqual(IDS, ['desk', 'living', 'apartment']);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(readme, /still offers the first two/, 'the README no longer says the page offers two');
});

const titles = Object.fromEntries(IDS.map((id) => [id, loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8'))).title]));

function pickScreens(mode) {
  const out = [];
  for (const slot of [0, 1]) {
    const off = mode === 'live' ? null : V.OFF_WORDS[mode];
    const v = V.pickView({ slot, off, onFile: noop, rehearse: mode === 'rehearsal' ? { label: 'Rehearse the live path', tip: 't', onClick: noop } : null });
    for (const id of IDS) {
      const used = slot === 1 && id === 'desk';
      v.cards.append(V.roomCardView({ title: titles[id], origin: 'mock', disabledWhy: used ? 'Already your first room' : null, onPick: noop }));
    }
    out.push({ name: `Pick room ${slot + 1}`, step: R.PICK_STEPS[slot], section: v.section, road: { rooms: slot ? [{ kind: 'sample', id: 'desk' }, null, null] : [null, null, null] } });
  }
  const free = V.freeView();
  for (const id of IDS) free.cards.append(V.roomCardView({ title: titles[id], origin: 'mock', onPick: noop }));
  free.cards.append(V.roomCardView({ title: 'A morning desk with a mug and three coins', origin: mode === 'mock' ? 'marked' : mode, onPick: noop }));
  out.push({ name: 'Free play', step: R.FREE_PLAY, section: free.section, road: { finished: [true, true, true], reached: R.FREE_PLAY } });
  return out;
}

for (const [vw, vh] of WINDOWS) {
  test(`three sample rooms on Steps 2 and 5 and in Free play fit main at ${vw}x${vh}, 100% zoom`, () => {
    for (const mode of ['mock', 'live', 'rehearsal']) {
      for (const s of pickScreens(mode)) {
        const head = headFor(s.step, mode, s.road);
        const { space, width, layout } = mainSpace(vw, vh, head, mode);
        const h = screenHeight(layout, s.section, width);
        assert.ok(h <= space, `${vw}x${vh} ${mode} · ${s.name}: ${h.toFixed(2)}px of content in ${space.toFixed(2)}px of main`);
      }
    }
  });
}
