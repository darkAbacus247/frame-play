// The play screen: wires the round (play.js) to the canvas (render.js), the
// keyboard, the on-screen pad, tap-to-move, the Walk to chips, sound and
// the announcements. It touches the page; the rules live in play.js.
import { createRound, stepRound, walkToObject, walkToPoint, nextGoal, routeRatio, DT } from './play.js';
import { Renderer, fitSize, unlockPulse, ROLE_STYLE } from './render.js';
import { bounds } from './geom.js';
import { Fx } from './fx.js';
import { ruleRow, announce, endCardWords, RIDDLE_WORDS } from './words.js';
import { objectWords } from './level.js';
import { pickForRiddle, gradePick, newRiddleState, fillCount, riddleSlack, thingWords, answerChoices, riddleLabel, MISSES } from './riddle.js';
import { el, boardRoom, capBoard, ceilH, ceilW, floorW, spaceH } from './ui.js';
import { emit } from './events.js';

const KEY_DIRS = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
  W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
};

// The reveal picture: outlines drawing in one by one (all at once with
// reduced motion), numbered badges clear of every outline, Show walls.
export function mountReveal(root, { level, rt, picture, ui, maxHeight, onFit }) {
  const canvas = el('canvas', { 'aria-hidden': 'true' });
  // the particles' layer lies over the picture, out of the flow
  const fx = new Fx(canvas, level.picture, { reduced: () => !!ui().reducedMotion });
  root.classList.add('fx-host');
  root.replaceChildren(canvas, fx.layer);
  const renderer = new Renderer(canvas, picture, level, rt);
  const n = level.objects.length;
  let count = ui().reducedMotion ? n : 0;
  let walls = false;
  let timer = 0;
  const draw = () => renderer.draw(null, { ...ui(), reveal: true, outlineCount: count, walls });
  const fit = () => {
    const w = floorW(root);
    const h = maxHeight ? maxHeight() : (w * level.picture.height) / level.picture.width;
    const f = fitSize(Math.max(80, w), Math.max(60, h), level.picture.width, level.picture.height);
    renderer.resize(f.cssW, f.cssH, globalThis.devicePixelRatio || 1);
    fx.fit(f.cssW, f.cssH, globalThis.devicePixelRatio || 1);
    if (onFit) onFit(f, { w: Math.max(80, w), h: Math.max(60, h) });
    draw();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(root);
  // main too: when the tour strip or the settings drawer takes height from
  // it, the reveal gives way, and grows back when they close
  const host = root.closest('main');
  if (host) ro.observe(host);
  if (count < n) {
    timer = setInterval(() => {
      count++;
      draw();
      emit('reveal', { k: count - 1, of: n });
      const o = level.objects[count - 1];
      const st = o.on_surface || o.role === 'flat' ? ROLE_STYLE[o.role] : null;
      fx.burst('trace', 0, 0, { rings: o.outline.rings, color: st ? st.color : '#f3efe6' });
      if (count >= n) clearInterval(timer);
    }, 170);
  }
  return {
    fx,
    setWalls(v) { walls = !!v; draw(); },
    redraw: draw,
    destroy() { clearInterval(timer); ro.disconnect(); fx.destroy(); },
  };
}

// The page's primary buttons click softly and the closing screen gets the
// music's sting. Watched here, from the outside, so the screens need not
// know about sound; installed once per page.
export function watchPage(doc) {
  if (!doc || doc.fpWatched || typeof doc.addEventListener !== 'function') return false;
  doc.fpWatched = true;
  doc.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('[data-primary]')) emit('ui', { kind: 'primary' });
  }, true);
  const MO = globalThis.MutationObserver;
  if (typeof MO === 'function' && doc.body) {
    let shown = false;
    new MO(() => {
      const now = !!doc.querySelector('.screen.closing');
      if (now && !shown) emit('closing');
      shown = now;
    }).observe(doc.body, { childList: true, subtree: true });
  }
  return true;
}
if (globalThis.document) watchPage(globalThis.document);

// opts: { level, rt, picture, ui: () => ({outlines, reducedMotion, highContrast, walls}),
//         audio, say(text), onEnd({status, ratio, travelled, words}),
//         paused(): true while the round must hold still }
export function mountPlay(root, opts) {
  const { level, rt, picture, audio, say } = opts;
  let state = createRound(level, rt);
  const surfaceName = level.surface ? level.surface.name : 'floor';
  const held = new Set();
  let padDir = null;
  let marker = null;
  let raf = 0, last = 0, acc = 0, ended = false, destroyed = false, unlockAt = 0;

  const rule = el('p', { class: 'rule-row', id: 'rule-row' });
  const canvas = el('canvas', { 'aria-hidden': 'true' });
  const fx = new Fx(canvas, level.picture, { reduced: () => !!(opts.ui && opts.ui().reducedMotion) });
  const game = el('div', {
    class: 'game', tabindex: '0', role: 'application',
    'aria-label': `The game: ${level.title || 'your room'}. Arrow keys or W A S D steer. N walks to the next goal. Tab leaves.`,
    'aria-describedby': 'rule-row',
  }, [canvas, fx.layer]);
  const stage = el('div', { class: 'stage' }, [game]);
  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Walk to' });
  const padBtn = (label, dir, cls) => {
    const b = el('button', { type: 'button', class: `pad-btn ${cls}`, 'aria-label': `Move ${label}`, tip: `Hold to move ${label}` }, [el('span', { 'aria-hidden': 'true', text: { up: '▲', down: '▼', left: '◀', right: '▶' }[label] })]);
    const start = (e) => { e.preventDefault(); padDir = dir; b.setPointerCapture && e.pointerId !== undefined && b.setPointerCapture(e.pointerId); };
    const stop = () => { if (padDir === dir) padDir = null; };
    b.addEventListener('pointerdown', start);
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('lostpointercapture', stop);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); padDir = dir; }
    });
    b.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') stop(); });
    b.addEventListener('blur', stop);
    return b;
  };
  const pad = el('div', { class: 'pad', role: 'group', 'aria-label': 'Move' }, [
    padBtn('up', [0, -1], 'pad-up'), padBtn('left', [-1, 0], 'pad-left'),
    padBtn('right', [1, 0], 'pad-right'), padBtn('down', [0, 1], 'pad-down'),
  ]);
  const side = el('div', { class: 'side' }, [chips, pad, ...(opts.sideExtras || [])]);
  const label = el('p', { class: 'level-label', text: level.label });
  const wrap = el('div', { class: 'play' }, [rule, stage, side, label]);
  root.replaceChildren(wrap);

  const renderer = new Renderer(canvas, picture, level, rt);
  // the music turns softer while a round is played
  const music = (mode) => audio && audio.musicMode && audio.musicMode(mode);

  // "Walk to coin 2" when there are several, "Walk to the lamp" for one
  function walkWords(k) {
    const o = level.objects[k];
    const many = level.objects.filter((x) => x.name === o.name).length > 1;
    return many ? `Walk to ${objectWords(level, k)}` : `Walk to the ${objectWords(level, k)}`;
  }

  function goalChips() {
    chips.replaceChildren();
    const order = (level.proof && level.proof.order) || [];
    const ids = [...order];
    level.objects.forEach((o) => { if ((o.role === 'collect' || o.role === 'exit') && !ids.includes(o.id)) ids.push(o.id); });
    for (const id of ids) {
      const k = level.objects.findIndex((o) => o.id === id);
      if (k < 0) continue;
      const o = level.objects[k];
      const done = o.role === 'collect' && state.collected[k];
      const b = el('button', {
        type: 'button', class: `chip chip-${o.role}`, 'data-k': String(k), 'data-tour': 'chip',
        tip: o.role === 'exit' ? 'Walks to the exit. It opens once everything is collected' : `Walks to the ${objectWords(level, k)} to collect it`,
        disabled: done || state.status !== 'playing',
        onclick: () => walkObject(k),
      }, [el('span', { text: done ? `${objectWords(level, k)}: collected` : walkWords(k) })]);
      chips.append(b);
    }
  }

  function refreshRule() {
    rule.textContent = `${ruleRow(level, state)}`;
  }

  function walkObject(k) {
    if (ended) return;
    const res = walkToObject(state, level, rt, k);
    if (!res.ok) { audio && audio.play('refuse'); say(res.reason); return; }
    const end = res.path[res.path.length - 1];
    marker = { x: end[0], y: end[1], refused: false, t: performance.now() };
    audio && audio.play('tick');
  }

  // an object's middle, in picture pixels, for its particles
  const middle = (k) => { const b = bounds(level.objects[k].outline.rings); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]; };
  const exitK = level.objects.findIndex((o) => o.role === 'exit');

  function handleEvents(events) {
    let chipsDirty = false;
    for (const ev of events) {
      const words = announce(level, ev, surfaceName);
      switch (ev.type) {
        case 'step': audio && audio.play('step'); fx.burst('dust', ...state.pos); emit('step', { at: [...state.pos] }); break;
        case 'bump': audio && audio.play('bump'); break;
        case 'collect': audio && audio.play('collect'); chipsDirty = true; fx.burst('coin', ...middle(ev.k)); emit('coin', { k: ev.k, left: ev.left }); break;
        case 'unlock': audio && audio.play('unlock'); chipsDirty = true; unlockAt = performance.now(); if (exitK >= 0) fx.burst('exit', ...middle(exitK)); emit('exit', { k: exitK }); break;
        case 'locked': audio && audio.play('locked'); break;
        case 'lose': audio && audio.play('hazard'); fx.burst('hazard', ...state.pos); emit('hazard', { k: ev.k, at: [...state.pos] }); break;
        case 'win': audio && audio.play('win'); fx.burst('win'); emit('win', { k: ev.k, travelled: ev.travelled }); break;
        default: break;
      }
      if (words) say(words);
    }
    if (events.some((e) => e.type === 'collect' || e.type === 'unlock')) refreshRule();
    if (chipsDirty) goalChips();
  }

  function steering() {
    let x = 0, y = 0;
    for (const k of held) { x += KEY_DIRS[k][0]; y += KEY_DIRS[k][1]; }
    if (padDir) { x += padDir[0]; y += padDir[1]; }
    return [x, y];
  }

  function frame(t) {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    if (!last) last = t;
    acc += Math.min(0.25, (t - last) / 1000);
    last = t;
    // while a card or the settings are open the round holds still, so a
    // walk under them never ends the round (nor puts its card over theirs)
    if (opts.paused && opts.paused()) acc = 0;
    let steps = 0;
    while (acc >= DT && steps < 8 && !ended) {
      const events = stepRound(state, level, rt, { dir: steering() });
      if (events.length) handleEvents(events);
      acc -= DT;
      steps++;
      if (state.status !== 'playing') {
        ended = true;
        music('calm');
        if (state.status !== 'won') emit('lose', { status: state.status });
        goalChips();
        const ratio = routeRatio(state, level);
        opts.onEnd && opts.onEnd({ status: state.status, ratio, travelled: state.travelled, words: endCardWords(level, state, ratio) });
      }
    }
    if (acc > 1) acc = 0;
    if (marker && t - marker.t > 900) marker = null;
    const ui = opts.ui ? opts.ui() : {};
    renderer.draw(state, { ...ui, marker, pulse: unlockPulse(unlockAt, t, ui.reducedMotion), riddle: riddleView(t) });
  }

  // ---- Ask the room: riddle mode, on the same screen after a round ----
  // The round is over and stays over: the explorer stands where it ended, a
  // tap picks a thing instead of walking, and the Walk to chips and the pad
  // give way to "Answer with". Graded by code on the things' own outlines
  // (src/riddle.js); the road is never touched from here.
  let riddle = null;
  const RIGHT_MS = 1200, WRONG_MS = 1200;
  const gameWords = game.getAttribute('aria-label');

  function riddleView(now) {
    if (!riddle) return null;
    return { marks: riddle.marks, now, reduced: !!(opts.ui && opts.ui().reducedMotion) };
  }

  function setStatus() {
    if (riddle) riddle.status.textContent = RIDDLE_WORDS.status(riddle.i + 1, riddle.list.length, riddle.rs, MISSES);
  }

  function startRiddle(list, i, handlers = {}) {
    if (!ended || !list || !list[i]) return false;
    if (riddle) clearPanel();
    const r = list[i];
    const status = el('p', { class: 'riddle-status', id: 'riddle-status' });
    const select = el('select', { id: 'answer-with' });
    for (const c of answerChoices(level)) select.append(el('option', { value: c.id, text: c.text }));
    const panel = el('div', { class: 'riddle-panel', role: 'group', 'aria-label': 'The riddle' }, [
      status,
      el('label', { for: 'answer-with', class: 'answer-label', text: 'Answer with' }),
      el('div', { class: 'answer-row' }, [
        select,
        el('button', { type: 'button', class: 'btn', text: 'Pick it', onclick: () => pickId(select.value, false) }),
      ]),
      el('button', { type: 'button', class: 'btn', text: 'Skip this riddle', tip: 'Ends this riddle without an answer', onclick: () => finish('skipped') }),
      el('button', { type: 'button', class: 'btn', text: 'Stop the riddle', tip: 'Back to the end of the round', onclick: () => stopRiddle(true) }),
    ]);
    riddle = { list, i, rs: newRiddleState(r), marks: [], text: fillCount(r.text, r.n), handlers, panel, status, select, timer: 0 };
    chips.hidden = true;
    pad.hidden = true;
    wrap.classList.add('riddle-on');
    side.prepend(panel);
    rule.textContent = `“${riddle.text}”`;
    rule.classList.add('riddle-row');
    label.textContent = riddleLabel(r);
    game.setAttribute('aria-label', RIDDLE_WORDS.gameLabel);
    setStatus();
    say(RIDDLE_WORDS.start(i + 1, list.length, riddle.text));
    audio && audio.play('tick');
    game.focus({ preventScroll: true });
    return true;
  }

  function clearPanel() {
    clearTimeout(riddle.timer);
    riddle.panel.remove();
  }

  // Back to the round's own screen: chips, pad, rule row and label as they
  // were. With `toCard`, the end card comes back too (Stop the riddle, Esc).
  function stopRiddle(toCard = false) {
    if (!riddle) return;
    const { handlers } = riddle;
    clearPanel();
    riddle = null;
    chips.hidden = false;
    pad.hidden = false;
    wrap.classList.remove('riddle-on');
    rule.classList.remove('riddle-row');
    refreshRule();
    label.textContent = level.label;
    game.setAttribute('aria-label', gameWords);
    if (toCard && handlers.onStop) handlers.onStop();
  }

  function finish(outcome) {
    if (!riddle || riddle.done) return;
    riddle.done = outcome;
    const r = riddle.list[riddle.i];
    if (outcome === 'missed') {
      // every answer shows itself once, behind the card
      const t = performance.now();
      for (const id of r.answers) {
        const k = level.objects.findIndex((o) => o.id === id);
        if (k >= 0) riddle.marks.push({ k, kind: 'right', t });
      }
    }
    const { handlers, i, list, rs } = riddle;
    const reduced = !!(opts.ui && opts.ui().reducedMotion);
    riddle.timer = setTimeout(() => {
      if (handlers.onEnd) handlers.onEnd({ outcome, i, total: list.length, riddle: r, found: [...rs.found] });
    }, outcome === 'skipped' ? 0 : reduced ? 400 : 1000);
  }

  function pickId(id, near) {
    if (!riddle || riddle.done) return;
    const k = level.objects.findIndex((o) => o.id === id);
    if (k < 0) return;
    const thing = thingWords(level, k);
    const res = gradePick(riddle.rs, id);
    const t = performance.now();
    let words = '';
    switch (res.kind) {
      case 'solved':
        riddle.marks.push({ k, kind: 'right', t });
        words = riddle.rs.riddle.rule === 'all' ? RIDDLE_WORDS.found(thing, riddle.rs.found.length, riddle.rs.riddle.n) : RIDDLE_WORDS.right(thing);
        audio && audio.play('collect');
        fx.burst('coin', ...middle(k));
        break;
      case 'found':
        riddle.marks.push({ k, kind: 'right', t });
        words = RIDDLE_WORDS.found(thing, res.count, riddle.rs.riddle.n);
        audio && audio.play('collect');
        fx.burst('coin', ...middle(k));
        break;
      case 'already': words = RIDDLE_WORDS.already(thing); break;
      case 'again': words = RIDDLE_WORDS.again(thing); break;
      case 'wrong':
      case 'missed':
        riddle.marks.push({ k, kind: 'wrong', t });
        words = res.kind === 'wrong' ? RIDDLE_WORDS.wrong(thing, res.left) : `Not ${thing}.`;
        audio && audio.play('refuse');
        break;
      default: return;
    }
    say(near ? `${RIDDLE_WORDS.taken(thing)} ${words}` : words);
    setStatus();
    if (riddle.rs.done) finish(riddle.rs.done);
  }

  function riddleTap(e) {
    game.focus({ preventScroll: true });
    if (riddle.done) return;
    const [x, y] = renderer.toPicture(e.clientX, e.clientY);
    const p = pickForRiddle(level, riddle.list[riddle.i], x, y, riddleSlack(level, renderer.px(1)));
    if (!p) {
      marker = { x, y, refused: true, t: performance.now() };
      audio && audio.play('refuse');
      say(RIDDLE_WORDS.nothing);
      return;
    }
    pickId(level.objects[p.k].id, p.near);
  }

  game.addEventListener('pointerdown', (e) => {
    if (riddle && e.button === 0) { riddleTap(e); return; }
    if (ended || e.button > 0) return;
    game.focus({ preventScroll: true });
    const [x, y] = renderer.toPicture(e.clientX, e.clientY);
    const res = walkToPoint(state, level, rt, x, y);
    if (res.ok) {
      const end = res.path[res.path.length - 1];
      marker = { x: end[0], y: end[1], refused: false, t: performance.now() };
      audio && audio.play('tick');
    } else {
      marker = { x, y, refused: true, t: performance.now() };
      audio && audio.play('refuse');
      say(res.reason);
    }
  });
  game.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (riddle) {
      // the round is over: keys do not steer; Esc goes back to the end card
      if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); stopRiddle(true); }
      return;
    }
    if (KEY_DIRS[e.key]) {
      e.preventDefault();
      held.add(e.key);
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      if (!ended) walkObject(nextGoal(state, level));
    }
  });
  game.addEventListener('keyup', (e) => { held.delete(e.key); });
  game.addEventListener('blur', () => held.clear());

  // the board sits at the top of its cell; its size comes from the space
  // (ui.js boardRoom), not from a stretched row it would float in
  let fitted = '';
  const ro = new ResizeObserver(() => {
    if (!wrap.isConnected) return;
    const ps = getComputedStyle(wrap);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    // the space rounded down, what is taken from it rounded up (ui.js)
    const room = boardRoom({
      playW: floorW(wrap),
      spaceH: spaceH(root),
      ruleH: ceilH(rule),
      labelH: ceilH(label),
      rowGap: parseFloat(ps.rowGap) || 0,
      colGap: parseFloat(ps.columnGap) || 0,
      sideW: ceilW(side),
      sideH: ceilH(side),
      sideBeside: /"stage side"/.test(ps.gridTemplateAreas),
      minH: (parseFloat(ps.getPropertyValue('--stage-min')) || 12) * rem,
    });
    // never larger than the picture was on "What the AI found" (ui.js capBoard)
    const f = capBoard(room, opts.cap, level.picture.width, level.picture.height);
    const dpr = globalThis.devicePixelRatio || 1;
    const key = `${f.cssW}x${f.cssH}@${dpr}`;
    if (key === fitted) return;
    fitted = key;
    renderer.resize(f.cssW, f.cssH, dpr);
    fx.fit(f.cssW, f.cssH, dpr);
  });
  for (const e of [root, wrap, rule, label, side]) ro.observe(e);

  refreshRule();
  goalChips();
  audio && audio.play('start');
  music('play');
  raf = requestAnimationFrame(frame);

  return {
    get state() { return state; },
    get fx() { return fx; },
    focusGame() { game.focus({ preventScroll: true }); },
    walkTo(k) { walkObject(k); },
    // Ask the room: riddle i of the list, after the round has ended;
    // handlers.onEnd({outcome, i, total, riddle, found}) when it is solved,
    // missed or skipped; handlers.onStop() when the player stops it
    startRiddle(list, i = 0, handlers = {}) { return startRiddle(list, i, handlers); },
    stopRiddle() { stopRiddle(false); },
    get riddleOn() { return !!riddle; },
    get riddleState() { return riddle ? riddle.rs : null; },
    restart() {
      stopRiddle(false);
      state = createRound(level, rt);
      ended = false; acc = 0; last = 0; marker = null; unlockAt = 0;
      fx.clear();
      refreshRule();
      goalChips();
      audio && audio.play('start');
      music('play');
    },
    destroy() {
      destroyed = true;
      if (riddle) clearTimeout(riddle.timer);
      music('calm');
      cancelAnimationFrame(raf);
      ro.disconnect();
      fx.destroy();
    },
  };
}
