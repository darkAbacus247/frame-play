// A1: on Play the picture is drawn at the size it had on "What the AI
// found" for that room, never larger, with the side column beside it.
// Every reveal the road shows (the three sample rooms, a LIVE read, our
// kitchen, a marked room) at both strict windows: the reveal's picture as
// app.js sizes it, then the play board as game.js sizes it (boardRoom, then
// capBoard with the reveal's size).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardRoom, capBoard } from '../src/ui.js';
import { fitSize } from '../src/render.js';
import * as V from '../src/screens.js';
import { mainSpace, styleOf, MAIN_CHAIN } from './layoutmodel.js';
import { screens, headFor } from './screenset.js';

const WINDOWS = [[839, 945], [1259, 1418]];

function revealFit(s, L, width, space) {
  const { level } = s.reveal;
  const chain = [...MAIN_CHAIN, { tag: 'section', cls: ['screen', 'found'] }];
  const gridChain = [...chain, { tag: 'div', cls: ['found-grid'] }];
  const st = styleOf(gridChain, L.vw, L.vh);
  const kids = s.section.children[1].children;
  const cols = L.tracks(st, width, L.gaps(st).col, kids, gridChain, { size: 16, weight: 400, lh: 1.5 });
  const beside = cols.length > 1;
  const w = Math.floor(cols[0]);
  const infoH = Math.ceil(L.measure(s.reveal.v.info, gridChain, beside ? cols[1] : width).h);
  const headH = Math.ceil(L.measure(s.section.children[0], chain, width).h);
  const gap = L.gaps(styleOf(chain, L.vw, L.vh)).row;
  const { width: pw, height: ph } = level.picture;
  const h = V.revealHeight({ width: w, aspect: ph / pw, spaceH: Math.floor(space), headH, gap, infoH, beside });
  return fitSize(Math.max(80, w), Math.max(60, h), pw, ph);
}

// the play room as game.js reads it, the side column as layout.test.js
// fills it (chips, pad, Describe this room, End this round, Choose a
// different room)
function playRoom(L, width, space) {
  const play = styleOf([...MAIN_CHAIN, { tag: 'div', cls: ['play'] }], L.vw, L.vh);
  const g = L.gaps(play);
  const sideW = L.len(styleOf([...MAIN_CHAIN, { tag: 'div', cls: ['play'] }, { tag: 'div', cls: ['side'] }], L.vw, L.vh).width);
  return boardRoom({
    playW: Math.floor(width), spaceH: Math.floor(space), ruleH: 24, labelH: 24, rowGap: g.row, colGap: g.col,
    sideW, sideH: 3 * 44 + 2 * 8 + 16 + 3 * 56 + 8 + 3 * (16 + 44), sideBeside: /"stage side"/.test(play['grid-template-areas']), minH: 192,
  });
}

for (const [vw, vh] of WINDOWS) {
  test(`every room's board on Play is the size of its reveal at ${vw}x${vh}`, () => {
    let checked = 0, equal = 0;
    for (const mode of ['mock', 'live', 'rehearsal']) {
      for (const s of screens(mode).filter((x) => x.reveal && x.reveal.level.objects)) {
        const { space, width, layout } = mainSpace(vw, vh, headFor(s.step, mode, s.road), mode);
        const shown = revealFit(s, layout, width, space);
        const room = playRoom(layout, width, space);
        const board = capBoard(room, shown, s.reveal.level.picture.width, s.reveal.level.picture.height);
        const grown = fitSize(Math.max(80, room.w), Math.max(60, room.h), s.reveal.level.picture.width, s.reveal.level.picture.height);
        if (grown.cssW >= shown.cssW && grown.cssH >= shown.cssH) {
          // space for it: exactly the reveal's size, where it would have grown
          assert.deepEqual([board.cssW, board.cssH], [shown.cssW, shown.cssH], `${vw}x${vh} ${mode} · ${s.name}`);
          equal++;
        } else {
          // a picture wider than the space the side column leaves (our
          // kitchen at 839 px): never larger, as large as the room allows
          assert.ok(board.cssW <= shown.cssW && board.cssH <= shown.cssH, `${vw}x${vh} ${mode} · ${s.name}: never larger`);
          assert.deepEqual(board, grown, `${vw}x${vh} ${mode} · ${s.name}: fills the room it has`);
        }
        checked++;
      }
    }
    assert.ok(checked >= 5, `${checked} reveals checked`);
    assert.ok(equal >= 4, `${equal} of ${checked} reveals kept their very size`);
  });
}

test('capBoard: never larger than the reveal; a smaller room fits the picture to it', () => {
  const cap = fitSize(700, 500, 1024, 768);
  assert.deepEqual(capBoard({ w: 2000, h: 2000 }, cap, 1024, 768).cssW, cap.cssW);
  assert.deepEqual(capBoard({ w: 2000, h: 2000 }, cap, 1024, 768).cssH, cap.cssH);
  const small = capBoard({ w: 400, h: 2000 }, cap, 1024, 768);
  assert.ok(small.cssW <= 400 && small.cssH < cap.cssH);
  // no reveal seen: the room's own fit
  assert.deepEqual(capBoard({ w: 900, h: 600 }, null, 1024, 768), fitSize(900, 600, 1024, 768));
});

test('the page passes each room\'s reveal size to Play', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const game = readFileSync(new URL('../src/game.js', import.meta.url), 'utf8');
  assert.match(app, /onFit: \(f, box\) => \{ A\.boards\.set\(key/);
  assert.match(app, /cap: boardCap\(/);
  assert.match(game, /capBoard\(room, opts\.cap/);
  assert.match(game, /if \(onFit\) onFit\(f/);
});
