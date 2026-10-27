// The marking board (Your marks): the photo with the player's boxes over
// it, drawn and changed with a pointer (mouse, pen or touch) or with the
// keyboard alone. It touches the page; the rules for boxes are in
// src/marks.js, and the words and buttons around the board are
// src/screens.js markView.
//
// Pointer: pick what a box is, then drag over the photo to draw one (a new
// box takes the role picked and is not selected, so the next pick is for
// the next box); press a box to select it (a pick then changes it), and
// drag the selected box to move it (a drag anywhere else draws). Keyboard
// (the board has the focus): a box cursor moves with the arrow keys and
// Shift with an arrow resizes it; Enter adds it; Space selects the box
// under it, whose arrows then move it and Shift with an arrow resizes it;
// Delete or Backspace removes it, Escape lets it go; 1 to 4 pick what a box
// is; Ctrl+Z undoes.
import { el, floorW } from './ui.js';
import { fitSize, ROLE_STYLE } from './render.js';
import * as M from './marks.js';

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const CURSOR = '#ffd75e';
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// view: markView's parts; picture: the canvas shown (the very pixels the
// tracer reads); marks: the boxes to start from; say(text): the live
// region; maxHeight(): the picture's height, as the reveal's;
// onChange(marks): after every change; busy(): true while the page works
export function mountMarker(view, { picture, marks = [], say = () => {}, maxHeight, onChange = () => {}, busy = () => false }) {
  const W = picture.width, H = picture.height;
  const canvas = el('canvas', { 'aria-hidden': 'true' });
  const board = el('div', {
    class: 'mark-board', tabindex: '0', role: 'application',
    'aria-label': 'Your photo, to mark. Arrow keys move the box cursor, Shift with an arrow resizes it, Enter adds it, Space selects the box under it. Tab leaves.',
  }, [canvas]);
  view.pic.replaceChildren(board);
  const g = canvas.getContext('2d');
  const side = Math.max(M.MIN_SIDE, Math.round(Math.min(W, H) / 6));
  const st = {
    marks: marks.map((m) => ({ role: m.role, box: m.box.slice() })),
    sel: -1, role: 'collect', history: [], drag: null, focused: false, keyboard: false, error: null,
    cursor: M.clampBox([(W - side) / 2, (H - side) / 2, (W + side) / 2, (H + side) / 2], W, H),
  };
  let css = { w: 0, h: 0, s: 1, dpr: 1 };

  // ---- drawing ----
  const rectOf = (b) => [b[0] * css.s, b[1] * css.s, (b[2] - b[0]) * css.s, (b[3] - b[1]) * css.s];
  function strokeBox(b, color, width, dash = []) {
    g.setLineDash(dash);
    g.lineWidth = width;
    g.strokeStyle = color;
    g.strokeRect(...rectOf(b));
    g.setLineDash([]);
  }
  function draw() {
    if (!css.w) return;
    g.setTransform(css.dpr, 0, 0, css.dpr, 0, 0);
    g.clearRect(0, 0, css.w, css.h);
    g.drawImage(picture, 0, 0, css.w, css.h);
    const names = M.markNames(st.marks);
    st.marks.forEach((m, k) => {
      const color = ROLE_STYLE[m.role].color;
      const [x, y, w, h] = rectOf(m.box);
      g.globalAlpha = 0.16;
      g.fillStyle = color;
      g.fillRect(x, y, w, h);
      g.globalAlpha = 1;
      if (k === st.sel) strokeBox(m.box, '#111316', 6);
      strokeBox(m.box, color, k === st.sel ? 3.5 : 2, m.role === 'avoid' ? [7, 5] : []);
      // its name, in a small tag inside the top-left corner
      g.font = '600 13px system-ui, sans-serif';
      const tw = (g.measureText(names[k]) || {}).width || 0;
      g.fillStyle = 'rgba(17, 19, 22, 0.82)';
      g.fillRect(x + 2, y + 2, tw + 8, 18);
      g.fillStyle = color;
      g.fillText(names[k], x + 6, y + 15);
    });
    if (st.drag && st.drag.kind === 'draw') strokeBox(st.drag.box, ROLE_STYLE[st.role].color, 2, [6, 4]);
    // the box cursor: shown while the keyboard has the board
    if (st.focused && st.keyboard && st.sel < 0) strokeBox(st.cursor, CURSOR, 2.5, [6, 4]);
  }
  function fit() {
    const w = floorW(view.pic);
    const h = maxHeight ? maxHeight() : (w * H) / W;
    const f = fitSize(Math.max(80, w), Math.max(60, h), W, H);
    css = { w: f.cssW, h: f.cssH, s: f.cssW / W, dpr: globalThis.devicePixelRatio || 1 };
    canvas.style.width = `${f.cssW}px`;
    canvas.style.height = `${f.cssH}px`;
    canvas.width = Math.max(1, Math.round(f.cssW * css.dpr));
    canvas.height = Math.max(1, Math.round(f.cssH * css.dpr));
    draw();
  }

  // ---- the words and buttons beside the board ----
  function panel() {
    const names = M.markNames(st.marks);
    const role = st.sel >= 0 ? st.marks[st.sel].role : st.role;
    for (const b of view.roles) b.setAttribute('aria-pressed', String(b.getAttribute('data-role') === role));
    const need = M.needs(st.marks);
    view.needsLine.textContent = st.error || need.line;
    view.needsLine.classList.toggle('error', !!st.error);
    view.remove.disabled = st.sel < 0 || busy();
    view.undo.disabled = !st.history.length || busy();
    view.boxesSummary.textContent = `Your boxes (${st.marks.length})`;
    view.chips.replaceChildren(...st.marks.map((m, k) => el('button', {
      type: 'button', class: `chip chip-${m.role}`, 'aria-pressed': String(k === st.sel), text: names[k],
      tip: `Selects ${names[k]}: ${M.roleOf(m.role).words}`, onclick: () => { select(k === st.sel ? -1 : k); },
    })));
  }
  // after every change: the panel (its height may change), then the board
  function changed() {
    st.error = null;
    panel();
    fit();
    onChange(st.marks);
  }

  // ---- changes ----
  const snapshot = () => { st.history.push(st.marks.map((m) => ({ role: m.role, box: m.box.slice() }))); };
  const nameOf = (k) => M.markNames(st.marks)[k];
  function add(box, { selectIt }) {
    if (st.marks.length >= M.MAX_MARKS) { say(`At most ${M.MAX_MARKS} boxes.`); return; }
    snapshot();
    st.marks.push({ role: st.role, box });
    st.sel = selectIt ? st.marks.length - 1 : -1;
    changed();
    say(`${nameOf(st.marks.length - 1)} added: ${M.roleOf(st.role).words}. ${M.needs(st.marks).line}`);
  }
  function select(k) {
    st.sel = k;
    panel();
    draw();
    if (k >= 0) say(`${nameOf(k)} selected: ${M.roleOf(st.marks[k].role).words}.`);
  }
  function setRole(role) {
    st.role = role;
    if (st.sel >= 0 && st.marks[st.sel].role !== role) {
      snapshot();
      st.marks[st.sel].role = role;
      changed();
      say(`The box is now ${M.roleOf(role).words}: ${nameOf(st.sel)}. ${M.needs(st.marks).line}`);
      return;
    }
    panel();
    draw();
    say(`New boxes are ${M.roleOf(role).words}.`);
  }
  function remove() {
    if (st.sel < 0) return;
    const name = nameOf(st.sel);
    snapshot();
    st.marks.splice(st.sel, 1);
    st.sel = -1;
    changed();
    say(`${name} removed. ${M.needs(st.marks).line}`);
  }
  function undo() {
    if (!st.history.length) return;
    st.marks = st.history.pop();
    st.sel = -1;
    changed();
    say(`Undone. ${M.needs(st.marks).line}`);
  }

  // ---- pointer: mouse, pen and touch alike ----
  const toPicture = (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = r.width ? W / r.width : 1, sy = r.height ? H / r.height : 1;
    return [clamp((e.clientX - r.left) * sx, 0, W), clamp((e.clientY - r.top) * sy, 0, H)];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (busy() || (e.button != null && e.button > 0)) return;
    e.preventDefault();
    st.keyboard = false;
    if (board.focus) board.focus({ preventScroll: true });
    const [x, y] = toPicture(e);
    const k = M.markAt(st.marks, x, y);
    // the selected box moves; anywhere else a drag draws (objects often
    // stand inside each other's boxes), and a press that does not drag
    // selects the box under it
    if (k >= 0 && k === st.sel) st.drag = { kind: 'move', k, x, y, from: st.marks[k].box.slice(), moved: false };
    else st.drag = { kind: 'draw', x, y, box: M.clampBox([x, y, x, y], W, H), under: k };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not every pointer can be captured */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    const d = st.drag;
    if (!d) return;
    const [x, y] = toPicture(e);
    if (d.kind === 'draw') {
      d.box = M.clampBox([d.x, d.y, x, y], W, H);
    } else {
      const box = M.moveBox(d.from, x - d.x, y - d.y, W, H);
      if (!d.moved && (box[0] !== d.from[0] || box[1] !== d.from[1])) { d.moved = true; snapshot(); }
      if (d.moved) st.marks[d.k].box = box;
    }
    draw();
  });
  const release = (e, cancelled) => {
    const d = st.drag;
    if (!d) return;
    st.drag = null;
    if (d.kind === 'draw') {
      if (!cancelled && e.clientX != null) d.box = M.clampBox([d.x, d.y, ...toPicture(e)], W, H);
      if (!cancelled && M.bigEnough(d.box)) add(d.box, { selectIt: false });
      else if (!cancelled) select(d.under);
      else draw();
    } else if (d.moved) {
      changed();
      say(`${nameOf(d.k)} moved.`);
    }
  };
  canvas.addEventListener('pointerup', (e) => release(e, false));
  canvas.addEventListener('pointercancel', (e) => release(e, true));

  // ---- keyboard ----
  board.addEventListener('focus', () => { st.focused = true; draw(); });
  board.addEventListener('blur', () => { st.focused = false; st.keyboard = false; draw(); });
  board.addEventListener('keydown', (e) => {
    if (busy() || e.altKey) return;
    const step = Math.max(2, Math.round(Math.max(W, H) / 64));
    const dir = ARROWS[e.key];
    const done = () => { e.preventDefault(); st.keyboard = true; };
    if (dir) {
      done();
      const [dx, dy] = [dir[0] * step, dir[1] * step];
      if (st.sel >= 0) {
        const b = st.marks[st.sel].box;
        const next = e.shiftKey ? M.resizeBox(b, dx, dy, W, H) : M.moveBox(b, dx, dy, W, H);
        if (next.some((v, i) => v !== b[i])) { snapshot(); st.marks[st.sel].box = next; changed(); }
        say(where(nameOf(st.sel), st.marks[st.sel].box));
      } else {
        st.cursor = e.shiftKey ? M.resizeBox(st.cursor, dx, dy, W, H) : M.moveBox(st.cursor, dx, dy, W, H);
        draw();
        say(where('Cursor', st.cursor));
      }
      return;
    }
    if (e.key === 'Enter') {
      done();
      if (st.sel >= 0) select(-1);
      else add(st.cursor.slice(), { selectIt: false });
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      done();
      const c = st.cursor;
      const k = M.markAt(st.marks, (c[0] + c[2]) / 2, (c[1] + c[3]) / 2);
      if (k >= 0) select(k); else say('No box under the cursor.');
      draw();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { done(); remove(); return; }
    if (e.key === 'Escape' && st.sel >= 0) { done(); select(-1); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { done(); undo(); return; }
    const r = M.MARK_ROLES.find((x) => x.key === e.key);
    if (r && !e.ctrlKey && !e.metaKey) { done(); setRole(r.role); }
  });
  const where = (name, b) => `${name}: ${Math.round(((b[0] + b[2]) / 2 / W) * 100)}% across, ${Math.round(((b[1] + b[3]) / 2 / H) * 100)}% down, ${b[2] - b[0]} by ${b[3] - b[1]} px.`;

  const ro = globalThis.ResizeObserver ? new ResizeObserver(fit) : null;
  if (ro) {
    ro.observe(view.pic);
    const host = view.pic.closest('main');
    if (host) ro.observe(host);
  }
  panel();
  fit();
  return {
    get marks() { return st.marks.map((m) => ({ role: m.role, box: m.box.slice() })); },
    // the room could not be made: why, in the line under the roles
    showError(words) { st.error = words; panel(); fit(); },
    // work under way, in the same line
    status(words) { view.needsLine.textContent = words; view.needsLine.classList.remove('error'); },
    setRole, select, remove, undo, add: (box) => add(M.clampBox(box, W, H), { selectIt: true }),
    focus() { if (board.focus) board.focus({ preventScroll: true }); },
    redraw: draw, fit, panel,
    destroy() { if (ro) ro.disconnect(); },
  };
}
