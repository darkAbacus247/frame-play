import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { barMode, holdBar, boardRoom } from '../src/ui.js';
import { fitSize } from '../src/render.js';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const SCREENS = readFileSync(new URL('../src/screens.js', import.meta.url), 'utf8');
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `styles.css has a rule for ${selector}`);
  return m[1];
}

// A bar in flow below its own scroll box, the way the pinned layout stacks
// them: main's content box holds the body box, then the bar. Returns the
// rectangles in main's content coordinates.
function stackPinned(spaceH, barH) {
  const body = { top: 0, bottom: spaceH - barH };
  const bar = { top: body.bottom, bottom: spaceH };
  return { body, bar };
}

test('no bar can be an overlay: nothing sticky or fixed anywhere in the stylesheet', () => {
  assert.ok(!/position\s*:\s*(sticky|fixed)/.test(css));
});

test('focus rings are for keyboard focus only; script-focused headings show none', () => {
  assert.match(rule(':focus-visible'), /outline:\s*3px solid/);
  assert.match(rule('[tabindex="-1"]:focus, [tabindex="-1"]:focus-visible'), /outline:\s*none/);
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /h\.tabIndex = -1; h\.focus\(/, 'the heading still takes focus for screen readers');
  for (const m of css.matchAll(/([^{}]*):focus(?!-visible)([^{}]*)\{([^}]*)\}/g)) {
    assert.ok(/tabindex="-1"/.test(m[1]) || !/outline:\s*[^n]/.test(m[3]), `a ring on plain :focus: ${m[0].trim()}`);
  }
});

test('the consent text lines up with its bullets: left-aligned, and nothing later centres it', () => {
  assert.match(rule('.consent'), /text-align:\s*left/);
  assert.match(rule('.welcome > .bar-body'), /text-align:\s*left/);
  const at = css.indexOf('\n.welcome > .bar-body');
  assert.ok(at > css.indexOf('\n.with-bar > .bar-body'), 'the welcome rule comes after the centred default it overrides');
  for (const m of css.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    if (/\.welcome|\.consent/.test(m[1])) assert.doesNotMatch(m[2], /text-align:\s*center/, m[1].trim());
  }
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /screen sparse welcome/, 'the welcome screen does not take the centred sparse layout');
});

test('short windows: the board may shrink, the pad keeps full-size targets, all in flow', () => {
  const at = css.indexOf('@media (max-height: 40rem) {');
  assert.ok(at > 0, 'a rule set for short windows');
  const block = css.slice(at, css.indexOf('\n}', at));
  assert.match(block, /\.play \{[^}]*--stage-min: 8rem/, 'the board may shrink to 8rem before the page scrolls');
  assert.match(block, /\.pad-btn \{[^}]*height: var\(--target\)/, 'pad buttons keep the 2.75rem target');
  assert.match(block, /\.pad \{[^}]*repeat\(3, var\(--target\)\)/);
  assert.doesNotMatch(block, /position|overflow:\s*hidden/, 'nothing taken out of flow or clipped');
  assert.match(rule('.play'), /min-height:\s*fit-content/, 'the play grid never squeezes its rows over each other');
});

// ---- picture screens: a small layout model read from the real cascade ----
const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
const RULES = [];
(function parse(text, media) {
  let pos = 0;
  for (;;) {
    const open = text.indexOf('{', pos);
    if (open < 0) return;
    const prelude = text.slice(pos, open).trim();
    let depth = 1, j = open + 1;
    while (depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
    const body = text.slice(open + 1, j - 1);
    if (prelude.startsWith('@media')) parse(body, prelude);
    else if (!prelude.startsWith('@')) RULES.push({ sels: prelude.split(',').map((s) => s.trim()), body, media });
    pos = j;
  }
})(flat, null);
const px = (v) => (v.endsWith('rem') ? parseFloat(v) * 16 : parseFloat(v));
function mediaHolds(media, vw, vh) {
  if (!media) return true;
  return [...media.matchAll(/\((min|max)-(width|height):\s*([\d.]+(?:px|rem))\)/g)].every(([, mm, dim, v]) => {
    const have = dim === 'width' ? vw : vh;
    return mm === 'min' ? have >= px(v) : have <= px(v);
  });
}
const VARS = { '--s1': 4, '--s2': 8, '--s3': 12, '--s4': 16, '--s5': 24, '--s6': 32, '--s7': 48 };
function cascade(selector, vw, vh) {
  const out = {};
  for (const r of RULES) {
    if (!r.sels.includes(selector) || !mediaHolds(r.media, vw, vh)) continue;
    for (const d of r.body.split(';')) {
      const k = d.indexOf(':');
      if (k > 0) out[d.slice(0, k).trim()] = d.slice(k + 1).trim();
    }
  }
  return out;
}
function length(v, vw, vh) {
  if (v == null) return 0;
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m) {
    if (VARS[m[1]] != null) return VARS[m[1]];
    return length(cascade(':root', vw, vh)[m[1]], vw, vh);
  }
  return px(v);
}
function gaps(decl, vw, vh) {
  const [row, col = row] = (decl.gap || '0').split(/\s+(?![^(]*\))/);
  return {
    rowGap: length(decl['row-gap'] || row, vw, vh),
    colGap: length(decl['column-gap'] || col, vw, vh),
  };
}
const tracks = (v) => v.trim().split(/\s+(?![^(]*\))/);
const flexible = (t) => /fr\b/.test(t);
const centred = (d) => /center/.test(`${d['place-items'] || ''} ${d['align-items'] || ''} ${d['align-content'] || ''} ${d['place-content'] || ''}`);

// header and dock as in the zoom cases above; the side column's height as
// the sample rooms fill it (three chips, the pad, Describe this room)
const HEADER = 61, DOCK = 61, RULE_H = 24, LABEL_H = 24;
function layPlay(vw, vh, chrome = HEADER + DOCK) {
  const pad = length('var(--pad)', vw, vh);
  const spaceH = vh - chrome - 2 * pad;
  const playW = vw - 2 * pad;
  const play = cascade('.play', vw, vh);
  const stage = cascade('.stage', vw, vh);
  const { rowGap, colGap } = gaps(play, vw, vh);
  const areas = [...play['grid-template-areas'].matchAll(/"([^"]+)"/g)].map((m) => m[1].trim().split(/\s+/));
  const rows = tracks(play['grid-template-rows']);
  assert.equal(rows.length, areas.length, `${vw}x${vh}: one track per row of areas`);
  const rowsOf = (name) => areas.flatMap((r, i) => (r.includes(name) ? [i] : []));
  const sideBeside = areas.some((r) => r.includes('stage') && r.includes('side'));
  const short = vh <= 640;
  const sideW = sideBeside ? length(cascade('.side', vw, vh).width, vw, vh) : playW;
  const padH = short ? 3 * 44 + 2 * 4 : 3 * 56 + 2 * 4;
  const sideH = sideBeside ? 3 * 44 + 2 * 8 + 16 + padH + 16 + 44 : padH + 16 + 44;
  const minH = length(play['--stage-min'] || '12rem', vw, vh);
  const room = boardRoom({ playW, spaceH, ruleH: RULE_H, labelH: LABEL_H, rowGap, colGap, sideW, sideH, sideBeside, minH });
  const board = fitSize(Math.max(80, room.w), Math.max(60, room.h), 1024, 768);
  // row heights: single-row items size auto rows; a definite-height grid
  // hands what is left to its fr rows, and a side column taller than the
  // rows it spans grows the fr rows among them
  const content = { rule: RULE_H, stage: board.cssH, label: LABEL_H };
  const h = rows.map((t, i) => {
    if (flexible(t)) return 0;
    const names = areas[i].filter((n) => n !== '.' && rowsOf(n).length === 1);
    return Math.max(0, ...names.map((n) => content[n] || 0));
  });
  const flex = rows.flatMap((t, i) => (flexible(t) ? [i] : []));
  const total = () => h.reduce((a, b) => a + b, 0) + rowGap * (rows.length - 1);
  if (play.height === '100%' && flex.length) {
    const left = Math.max(0, spaceH - total());
    for (const i of flex) h[i] = Math.max(length(/minmax\(([^,]+),/.exec(rows[i])?.[1] || '0', vw, vh), left / flex.length);
  }
  const sideRows = rowsOf('side');
  const spanned = sideRows.reduce((a, i) => a + h[i], 0) + rowGap * (sideRows.length - 1);
  const flexIn = sideRows.filter((i) => flexible(rows[i]));
  if (sideH > spanned && flexIn.length) for (const i of flexIn) h[i] += (sideH - spanned) / flexIn.length;
  const top = (i) => h.slice(0, i).reduce((a, b) => a + b, 0) + rowGap * i;
  const si = rowsOf('stage')[0];
  const cell = { top: top(si), h: h[si] };
  const boardTop = cell.top + (centred(stage) ? (cell.h - board.cssH) / 2 : 0);
  const li = rowsOf('label')[0];
  return {
    sideBeside, playW, spaceH, fit: board, room, minH,
    rule: { top: top(rowsOf('rule')[0]), bottom: top(rowsOf('rule')[0]) + RULE_H },
    board: { top: boardTop, bottom: boardTop + board.cssH, left: 0, right: board.cssW },
    side: { top: top(sideRows[0]), bottom: top(sideRows[0]) + sideH, left: sideBeside ? board.cssW + colGap : 0, right: sideBeside ? board.cssW + colGap + sideW : playW },
    label: { top: top(li), bottom: top(li) + LABEL_H },
  };
}

// 1259 by 1418 (the reported window) at 67, 100, 150 and 200%, the spec's
// 1280 by 720, the 150% and 200% cases above, and a phone on its side
const VIEWS = [
  ...[0.67, 1, 1.5, 2].map((z) => ({ name: `1259x1418 at ${Math.round(z * 100)}%`, vw: Math.round(1259 / z), vh: Math.round(1418 / z) })),
  { name: '1280x720', vw: 1280, vh: 720 },
  { name: '150%', vw: 559, vh: 630 },
  { name: '200%', vw: 420, vh: 472 },
  { name: 'landscape phone', vw: 568, vh: 320 },
];

test('play: the board starts under the status line, level with the side column, its line right under it', () => {
  for (const v of VIEWS) {
    const L = layPlay(v.vw, v.vh);
    const band = L.board.top - L.rule.bottom;
    assert.ok(band <= 32, `${v.name}: ${band}px of empty band between the status line and the board`);
    if (L.sideBeside) {
      assert.ok(Math.abs(L.board.top - L.side.top) <= 8, `${v.name}: board top ${L.board.top}, side column top ${L.side.top}`);
      assert.ok(L.board.right <= L.side.left, `${v.name}: the side column sits beside the board, not over it`);
      assert.ok(L.side.right <= L.playW, `${v.name}: the side column stays in main`);
    } else {
      assert.ok(L.side.top >= L.label.bottom, `${v.name}: the side column flows below the board and its line`);
    }
    const under = L.label.top - L.board.bottom;
    assert.ok(under >= 0 && under <= 32, `${v.name}: the line under the board is ${under}px below it`);
    assert.ok(L.board.right <= L.playW, `${v.name}: the board fits main's width`);
    if (L.room.h > L.minH) assert.ok(L.label.bottom <= L.spaceH, `${v.name}: when it can, the board and its line fit above the dock`);
  }
  // wide windows: the board takes the whole width beside the side column or
  // the whole height, whichever runs out first
  const wide = layPlay(1880, 2116);
  assert.ok(wide.fit.cssW >= wide.room.w - 1 || wide.fit.cssH >= wide.room.h - 1);
});

test('play: no stretched or centred row can float the board; side and line follow it', () => {
  for (const v of VIEWS) {
    const play = cascade('.play', v.vw, v.vh);
    assert.ok(!centred(play) && !centred(cascade('.stage', v.vw, v.vh)), `${v.name}: nothing centres the board vertically`);
    assert.notEqual(play.height, '100%', `${v.name}: the play grid is as tall as its content`);
    assert.match(play['align-content'] || '', /start/, v.name);
  }
  assert.doesNotMatch(flat, /position\s*:\s*(sticky|fixed)/);
  const game = readFileSync(new URL('../src/game.js', import.meta.url), 'utf8');
  assert.match(game, /boardRoom\(/, 'the board is sized from the space, not from a stretched stage');
});

test('reveal and compare: the picture sits right under the heading, top-aligned with its column', () => {
  assert.match(SCREENS, /'found-grid' \}, \[\s*pic,/, 'the reveal picture leads its grid');
  assert.match(SCREENS, /'room-sum' \}, \[\s*pic,/, 'each compare picture leads its card');
  assert.match(SCREENS, /class: 'screen compare'/);
  for (const v of VIEWS) {
    const screen = cascade('.screen', v.vw, v.vh);
    assert.match(screen['align-content'], /start/, v.name);
    const found = cascade('.found-grid', v.vw, v.vh);
    assert.match(found['align-items'], /start/, `${v.name}: the reveal picture and its column share a top`);
    assert.ok(!centred(cascade('.found-pic', v.vw, v.vh)) && !cascade('.found-pic', v.vw, v.vh)['margin-top']);
    const revealBand = gaps(screen, v.vw, v.vh).rowGap;
    assert.ok(revealBand <= 32, `${v.name}: reveal band ${revealBand}px`);
    const compare = { ...screen, ...cascade('.compare', v.vw, v.vh) };
    const card = cascade('.room-sum', v.vw, v.vh);
    assert.match(card['align-content'], /start/, v.name);
    assert.match(cascade('.two-rooms', v.vw, v.vh)['align-items'] || '', /start/, `${v.name}: the two cards share a top`);
    const compareBand = gaps(compare, v.vw, v.vh).rowGap + 1 + length(card.padding, v.vw, v.vh);
    assert.ok(compareBand <= 32, `${v.name}: compare band ${compareBand}px`);
  }
  for (const r of RULES) {
    if (r.sels.some((s) => /found|two-|room-sum|compare|\.play|\.stage/.test(s))) {
      assert.doesNotMatch(r.body, /margin-top:\s*auto|(align|place)-(items|content):\s*center/, r.sels.join(', '));
    }
  }
});

test('pinned, the body scrolls in its own box and the bar takes its own height in flow', () => {
  const screen = rule('.with-bar');
  assert.match(screen, /display:\s*flex/);
  assert.match(screen, /flex-direction:\s*column/);
  assert.match(screen, /height:\s*100%/);
  const body = rule('.with-bar > .bar-body');
  assert.match(body, /overflow:\s*auto/);
  assert.match(body, /min-height:\s*0/);
  const bar = rule('.with-bar > .bar-end');
  assert.match(bar, /flex:\s*none/, 'the bar never shrinks, so its whole height is reserved');
  assert.doesNotMatch(bar, /position/);
  assert.doesNotMatch(rule('.with-bar[data-bar="flow"] > .bar-end'), /padding|border|height/, 'the bar keeps its size in both modes');
  assert.match(rule('.with-bar[data-bar="flow"] > .bar-body'), /overflow:\s*visible/);
});

test('the reported zoom cases: the bar never covers the body, and very short spaces flow', () => {
  // 150% (559x630) and 200% (420x472) with generous header, dock and a
  // two-line bar; then a phone on its side and a tiny window
  const cases = [
    { name: '150%', viewH: 630, chrome: 61 + 61 + 32, barH: 92, want: 'pinned' },
    { name: '200%', viewH: 472, chrome: 61 + 61 + 32, barH: 92, want: 'pinned' },
    { name: '200%, tall header', viewH: 472, chrome: 140 + 61 + 32, barH: 92, want: 'flow' },
    { name: 'landscape phone', viewH: 320, chrome: 50 + 61 + 32, barH: 68, want: 'flow' },
  ];
  for (const c of cases) {
    const space = c.viewH - c.chrome;
    const mode = barMode(space, c.barH, 160);
    assert.equal(mode, c.want, c.name);
    if (mode === 'pinned') {
      const { body, bar } = stackPinned(space, c.barH);
      assert.ok(body.bottom <= bar.top, `${c.name}: the body box ends where the bar starts`);
      assert.ok(body.bottom - body.top >= 160, `${c.name}: the body keeps room to read`);
      assert.equal(bar.bottom, space, `${c.name}: the bar ends inside main, with main's own padding below it`);
    }
  }
});

test('holdBar measures main and the bar, sets the mode, and follows resizes', () => {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.targets = []; this.off = false; observers.push(this); }
    observe(t) { this.targets.push(t); }
    disconnect() { this.off = true; }
  };
  globalThis.getComputedStyle = (e) => e.cs;
  globalThis.document = { documentElement: { cs: { fontSize: '16px' } } };
  const main = { clientHeight: 500, cs: { paddingTop: '16px', paddingBottom: '16px' } };
  const bar = { offsetHeight: 68 };
  const section = { parentElement: main, isConnected: true, dataset: {} };
  try {
    const ro = holdBar(section, bar);
    assert.deepEqual(ro.targets, [main, bar], 'both sizes are watched');
    assert.equal(section.dataset.bar, 'pinned');
    main.clientHeight = 250; // 218 of space, 150 left for the body
    ro.cb();
    assert.equal(section.dataset.bar, 'flow');
    main.clientHeight = 300;
    bar.offsetHeight = 140; // the button wrapped
    ro.cb();
    assert.equal(section.dataset.bar, 'flow');
    bar.offsetHeight = 68;
    ro.cb();
    assert.equal(section.dataset.bar, 'pinned');
    section.isConnected = false;
    ro.cb();
    assert.equal(ro.off, true, 'it lets go once the screen is gone');
  } finally {
    delete globalThis.ResizeObserver;
    delete globalThis.getComputedStyle;
    delete globalThis.document;
  }
});

// ---- grid places stay under their own grid ----
const PLACE = /(?:^|;)\s*grid-(area|row|column|row-start|row-end|column-start|column-end)\s*:/;
test('every grid place is scoped to its own grid: no rule can pull another screen into a stray column', () => {
  const grids = RULES.filter((r) => /display:\s*grid/.test(r.body));
  let seen = 0;
  for (const r of RULES) {
    if (!PLACE.test(r.body)) continue;
    for (const s of r.sels) {
      seen++;
      const m = /^(\S+)\s*>\s*(\S+)$/.exec(s);
      assert.ok(m, `${s}: a grid place must be written as "grid > child"`);
      assert.ok(grids.some((g) => g.sels.includes(m[1])), `${s}: ${m[1]} is a grid`);
      const area = /grid-area:\s*([a-z][\w-]*)\s*(?:;|$)/.exec(r.body);
      if (area) {
        const named = RULES.some((g) => g.sels.includes(m[1]) && new RegExp(`grid-template-areas:[^;]*\\b${area[1]}\\b`).test(g.body));
        assert.ok(named, `${s}: ${m[1]} names the area ${area[1]}`);
      }
    }
  }
  assert.ok(seen >= 9, 'the page grid and the play grid both place their parts');
  assert.doesNotMatch(flat, /(?:^|\n)\.level-label\s*\{[^}]*grid-area/, 'the line under a room never takes a grid area by itself');
});

// A selector matcher for the plain selectors this stylesheet uses (tags,
// classes, descendant and child combinators), and the column count of a grid
// as its children place themselves: the explicit tracks, plus one implicit
// column when a child names an area the grid does not have.
function compoundMatches(c, e) {
  if (/[:[]/.test(c)) return false;
  const [tag, ...cls] = c.split('.');
  return (!tag || tag === '*' || tag === e.tag) && cls.every((k) => e.cls.includes(k));
}
function selectorMatches(sel, chain) {
  const parts = sel.split(/\s*(>)\s*|\s+/).filter((p) => p !== undefined && p !== '');
  let i = chain.length - 1;
  if (!compoundMatches(parts.pop(), chain[i])) return false;
  while (parts.length) {
    const child = parts[parts.length - 1] === '>';
    if (child) parts.pop();
    const c = parts.pop();
    if (child) {
      i--;
      if (i < 0 || !compoundMatches(c, chain[i])) return false;
      continue;
    }
    do i--; while (i >= 0 && !compoundMatches(c, chain[i]));
    if (i < 0) return false;
  }
  return true;
}
const node = (tag, cls = '') => ({ tag, cls: cls.split(/\s+/).filter(Boolean) });
function styleOf(chain, vw, vh) {
  const out = {};
  for (const r of RULES) {
    if (!mediaHolds(r.media, vw, vh) || !r.sels.some((s) => selectorMatches(s, chain))) continue;
    for (const d of r.body.split(';')) {
      const k = d.indexOf(':');
      if (k > 0) out[d.slice(0, k).trim()] = d.slice(k + 1).trim();
    }
  }
  return out;
}
function columnsOf(chain, kids, vw, vh) {
  const g = styleOf(chain, vw, vh);
  if (!/grid/.test(g.display || '')) return 1;
  const names = new Set([...(g['grid-template-areas'] || '').matchAll(/[\w-]+/g)].map((m) => m[0]));
  let n = g['grid-template-columns'] ? tracks(g['grid-template-columns']).length : 1;
  let extra = 0;
  for (const k of kids) {
    const d = styleOf([...chain, k], vw, vh);
    const place = (d['grid-area'] || d['grid-column'] || '').split('/')[0].trim();
    if (/^[a-z][\w-]*$/i.test(place) && place !== 'auto' && !names.has(place)) extra = 1;
    const col = parseInt(place, 10);
    if (col > n) n = col;
  }
  return n + extra;
}

test('the fit checks hold with no tolerance, as the README says', () => {
  for (const f of ['./layout.test.js', './fit.test.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /<= (L\.)?(spaceH|space|playW) \+ [\d.]/, `${f} allows a tolerance`);
  }
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(readme, /both with a layout model built on the stylesheet's own rules and no tolerance/);
});

test('the matcher: a play-screen rule never reaches a compare card', () => {
  const label = node('p', 'level-label');
  assert.ok(selectorMatches('.play > .level-label', [node('div', 'play'), label]));
  assert.ok(!selectorMatches('.play > .level-label', [node('div', 'play'), node('div', 'side'), label]));
  assert.ok(!selectorMatches('.play > .level-label', [node('article', 'room-sum'), label]));
  assert.ok(selectorMatches('.found-pic canvas', [node('div', 'found-pic'), node('div'), node('canvas')]));
  assert.ok(selectorMatches('main', [node('main')]));
  // the old global rule made a second, stray column in a plain grid
  const was = [{ sels: ['.level-label'], body: 'grid-area: label', media: null }];
  RULES.push(...was);
  try {
    assert.equal(columnsOf([node('article', 'room-sum')], [node('div', 'two-pic'), label], 839, 900), 2);
  } finally {
    RULES.splice(RULES.length - was.length, was.length);
  }
});

const NARROW = [...VIEWS, { name: '839x900 (the reported window)', vw: 839, vh: 900 }, { name: '839x560', vw: 839, vh: 560 }];
const COMPARE = [node('section', 'screen compare'), node('div', 'two-rooms')];
const CARD = [...COMPARE, node('article', 'room-sum')];
const CARD_KIDS = [node('div', 'two-pic'), node('h2'), node('ul', 'facts'), node('p', 'level-label')];

test('compare: each card is one column, its picture across the card, its facts one per line', () => {
  assert.match(SCREENS, /'room-sum' \}, \[\s*pic,\s*el\('h2'[^\n]*\n\s*el\('ul', \{ class: 'facts' \}, \[\s*el\('li'[^\n]*\n\s*el\('li'[^\n]*\n\s*el\('li'/,
    'picture, title, then the three facts as one list');
  const call = /A\.reveals\.push\(mountReveal\(pic, \{[^\n]*\}\)\);\n\s*\}\n\}\n\nasync function screenFree/.exec(APP);
  assert.ok(call, 'the compare screen mounts its pictures');
  assert.doesNotMatch(call[0], /maxHeight/, 'nothing caps a compare picture below the card width');
  for (const v of NARROW) {
    const pad = length('var(--pad)', v.vw, v.vh);
    const two = styleOf(COMPARE, v.vw, v.vh);
    const n = columnsOf(COMPARE, [node('article', 'room-sum'), node('article', 'room-sum')], v.vw, v.vh);
    assert.equal(n, v.vw >= 720 ? 2 : 1, `${v.name}: side by side on wide windows, stacked on narrow ones`);
    const cardW = (v.vw - 2 * pad - gaps(two, v.vw, v.vh).colGap * (n - 1)) / n;
    const card = styleOf(CARD, v.vw, v.vh);
    const inner = cardW - 2 * length(card.padding, v.vw, v.vh) - 2;
    const cols = columnsOf(CARD, CARD_KIDS, v.vw, v.vh);
    const picW = fitSize(inner / cols, (inner / cols) * (768 / 1024), 1024, 768).cssW;
    assert.ok(picW >= 0.6 * inner, `${v.name}: the picture is ${picW}px of a ${Math.round(inner)}px card`);
    assert.equal(cols, 1, `${v.name}: the card is one column`);
    assert.equal(columnsOf([...CARD, node('ul', 'facts')], [node('li'), node('li'), node('li')], v.vw, v.vh), 1, `${v.name}: the facts are one column`);
  }
});

const FOUND = [node('section', 'screen found'), node('div', 'found-grid')];
const INFO_KIDS = ['p summary', 'p why', 'div actions', 'section describe', 'details more objects', 'details more proof-more', 'p level-label']
  .map((t) => { const [tag, ...cls] = t.split(' '); return node(tag, cls.join(' ')); });

test('reveal: the picture first, its info beside it on wide windows or below it, no stray column', () => {
  assert.match(SCREENS, /'found-grid' \}, \[\s*pic,\s*info,\s*\]/);
  assert.match(SCREENS, /const info = el\('div', \{ class: 'found-info' \}/);
  for (const v of [...NARROW, { name: '1280x900', vw: 1280, vh: 900 }]) {
    const grid = styleOf(FOUND, v.vw, v.vh);
    const want = tracks(grid['grid-template-columns']).length;
    assert.equal(want, v.vw >= 900 ? 2 : 1, `${v.name}: beside on wide windows, below on narrow ones`);
    assert.equal(columnsOf(FOUND, [node('div', 'found-pic'), node('div', 'found-info')], v.vw, v.vh), want, `${v.name}: no stray column in the reveal`);
    assert.equal(columnsOf([...FOUND, node('div', 'found-info')], INFO_KIDS, v.vw, v.vh), 1, `${v.name}: the info reads as one column`);
  }
});

test('the play grid still places its own four parts', () => {
  const PLAY = [node('main'), node('div', 'play')];
  const KIDS = [node('p', 'rule-row'), node('div', 'stage'), node('div', 'side'), node('p', 'level-label')];
  const AREAS = ['rule', 'stage', 'side', 'label'];
  for (const v of VIEWS) {
    KIDS.forEach((k, i) => assert.equal(styleOf([...PLAY, k], v.vw, v.vh)['grid-area'], AREAS[i], `${v.name}: .${k.cls[0]}`));
    assert.equal(columnsOf(PLAY, KIDS, v.vw, v.vh), v.vw >= 720 ? 2 : 1, v.name);
  }
});

// The play screen in the reported windows, under the header the play step
// really draws (tests/layoutmodel.js): the board, its line and the side
// column all fit main, so the window never scrolls while playing.
test('play fits main without scrolling at 839x945 and 1259x1418, 100% zoom', async () => {
  const { installFakeDocument } = await import('./fakedom.js');
  installFakeDocument();
  const { header, mainSpace } = await import('./layoutmodel.js');
  try {
    for (const [vw, vh] of [[839, 945], [1259, 1418]]) {
      for (const band of [null, 'REHEARSAL · local stand-in, not Meta. No photo leaves this machine.']) {
        const head = header({ lap: 'One photo, one room', counter: 'Step 11 of 12: Play', why: 'Finish a round, win or lose, to continue', band });
        const m = mainSpace(vw, vh, head, band ? 'rehearsal' : 'mock');
        const L = layPlay(vw, vh, m.header + m.dock);
        assert.ok(L.room.h > L.minH, `${vw}x${vh}: the board has room above its minimum`);
        const bottom = Math.max(L.label.bottom, L.side.bottom);
        assert.ok(bottom <= L.spaceH, `${vw}x${vh}${band ? ' rehearsal' : ''}: ${Math.round(bottom)}px of play in ${Math.round(L.spaceH)}px`);
      }
    }
  } finally {
    delete globalThis.document;
  }
});
