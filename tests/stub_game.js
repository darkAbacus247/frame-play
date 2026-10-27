// The play screen and the reveal, stood in for when tests/apphost.js boots
// app.js in Node: no canvas, no frames. The last round's options are kept
// so a test can end a round the way the real board would, and the last
// view, so a test can set the round's state. The side column's extras are
// placed as the real board places them.
import { el } from '../src/ui.js';

export const played = { last: null, view: null };

export function mountReveal() {
  return { setWalls() {}, redraw() {}, destroy() {} };
}

export function mountPlay(root, opts) {
  root.replaceChildren(el('div', { class: 'play' }, [
    el('div', { class: 'game' }),
    el('div', { class: 'side' }, opts.sideExtras || []),
  ]));
  played.last = opts;
  played.view = { state: null, focused: 0, focusGame() { this.focused++; }, walkTo() {}, restart() {}, destroy() {} };
  return played.view;
}
