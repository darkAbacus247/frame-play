// The play screen and the reveal, stood in for when tests/apphost.js boots
// app.js in Node: no canvas, no frames. The last round's options are kept
// so a test can end a round the way the real board would.
import { el } from '../src/ui.js';

export const played = { last: null };

export function mountReveal() {
  return { setWalls() {}, redraw() {}, destroy() {} };
}

export function mountPlay(root, opts) {
  root.replaceChildren(el('div', { class: 'game' }));
  played.last = opts;
  return { state: null, focusGame() {}, walkTo() {}, restart() {}, destroy() {} };
}
