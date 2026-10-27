// Zoomed in (150%: 559x630 css px, 200%: 419x472): nothing placed inside
// main may reach outside main's own scroll box (the page itself would then
// scroll, and its scrollbar narrow the dock), and no control in the dock or
// the header may be squeezed narrower than its words. Laid out by
// tests/layoutmodel.js; it is a model, not a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as R from '../src/road.js';
import { Layout, styleOf, MAIN_CHAIN, dock, header } from './layoutmodel.js';
import { screens } from './screenset.js';

const ZOOMED = [[559, 630], [419, 472]];
const nodeOf = (e) => ({ tag: e.tagName.toLowerCase(), cls: (e.className || '').split(/\s+/).filter(Boolean) });
const placed = (st) => st.position === 'relative' || st.position === 'absolute';

test('everything placed absolutely inside main has a positioned ancestor inside main', () => {
  assert.equal(styleOf(MAIN_CHAIN, 839, 945).position, 'relative', 'main is the box they are placed in');
  let seen = 0;
  for (const mode of ['mock', 'live', 'rehearsal']) {
    for (const s of screens(mode)) {
      const walk = (e, chain) => {
        if (e.tagName === '#TEXT') return;
        const ch = [...chain, nodeOf(e)];
        for (const [vw, vh] of [[839, 945], ...ZOOMED]) {
          const st = styleOf(ch, vw, vh);
          assert.notEqual(st.position, 'fixed', `${mode} · ${s.name}: nothing fixed in main`);
          if (st.position !== 'absolute') continue;
          seen++;
          // from main (index 3 of the chain) to its parent
          const holder = ch.slice(3, -1).some((_, i) => placed(styleOf(ch.slice(0, 4 + i), vw, vh)));
          assert.ok(holder, `${mode} · ${s.name}: .${nodeOf(e).cls.join('.')} at ${vw}x${vh} has no positioned ancestor in main`);
        }
        for (const k of e.children) walk(k, ch);
      };
      walk(s.section, MAIN_CHAIN);
    }
  }
  assert.ok(seen >= 20, `the words for screen readers and the file inputs were seen (${seen})`);
  // and nothing in the scripts places an element by hand
  for (const f of ['app.js', 'src/screens.js', 'src/ui.js', 'src/game.js', 'src/play.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /style\.position\s*=|position:\s*(absolute|fixed)/, f);
  }
});

// a flex row's items at their own widths: on one line, or wrapping with
// none wider than the line and none allowed to shrink
function rowFits(L, row, chain, inner, where) {
  const st = styleOf(chain, L.vw, L.vh);
  const f = { size: 16, weight: 400, lh: 1.5 };
  const gap = L.gaps(st).col;
  const items = row.children.filter((k) => !L.hidden(k, styleOf([...chain, nodeOf(k)], L.vw, L.vh)));
  const ws = items.map((k) => L.natural(k, chain, f));
  const sum = ws.reduce((a, b) => a + b, 0) + gap * (ws.length - 1);
  if (sum <= inner) return;
  assert.match(st['flex-wrap'] || '', /wrap/, `${where}: ${sum.toFixed(1)} px of controls in ${inner} px, and the row does not wrap`);
  items.forEach((k, i) => {
    assert.ok(ws[i] <= inner, `${where}: ${k.textContent || k.className} is ${ws[i].toFixed(1)} px, wider than the line`);
    if (k.tagName === 'BUTTON') assert.equal(styleOf([...chain, nodeOf(k)], L.vw, L.vh)['flex-shrink'], '0', `${where}: a button that may shrink below its words`);
  });
}

const APP = MAIN_CHAIN.slice(0, 3);

test('zoomed in, the dock keeps every control as wide as its words, in every mode', () => {
  for (const [vw, vh] of ZOOMED) {
    for (const mode of ['mock', 'live', 'rehearsal']) {
      for (const sound of ['on', 'off']) {
        const L = new Layout(vw, vh);
        const d = dock(mode, sound);
        const pad = L.len('var(--pad)');
        rowFits(L, d, [...APP, nodeOf(d)], vw - 2 * pad, `${vw}x${vh} ${mode}, sound ${sound}`);
      }
    }
  }
});

test('zoomed in, the header’s buttons keep their own width', () => {
  for (const [vw, vh] of ZOOMED) {
    for (const band of [null, 'REHEARSAL · local stand-in, not Meta. No photo leaves this machine.']) {
      for (const step of [3, R.OWN_STEP + 1, R.LAST_STEP]) {
        const r = { ...R.newRoad(), consent: true, step };
        const h = header({ lap: R.lapText(r), counter: R.counterText(r), why: 'Send it through the stand-in to play this room', tourOn: true, band });
        const L = new Layout(vw, vh);
        const road = h.children.find((k) => k.className === 'road');
        const inner = vw - 2 * L.len('var(--pad)');
        rowFits(L, road, [...APP, nodeOf(h), nodeOf(road)], inner, `${vw}x${vh} header, step ${step}`);
      }
    }
  }
});
