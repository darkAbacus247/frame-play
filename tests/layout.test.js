import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { barMode, holdBar } from '../src/ui.js';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
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
  assert.match(block, /\.play \{[^}]*minmax\(8rem, 1fr\)/, 'the stage row may shrink to 8rem; the board scales to it');
  assert.match(block, /\.pad-btn \{[^}]*height: var\(--target\)/, 'pad buttons keep the 2.75rem target');
  assert.match(block, /\.pad \{[^}]*repeat\(3, var\(--target\)\)/);
  assert.doesNotMatch(block, /position|overflow:\s*hidden/, 'nothing taken out of flow or clipped');
  const narrow = css.indexOf('@media (max-height: 40rem) and (max-width: 719px)');
  assert.ok(narrow > at, 'the one-column layout gets the same shrinkable stage, after the general rule');
  assert.match(css.slice(narrow, css.indexOf('\n}', narrow)), /minmax\(8rem, 1fr\) auto auto/);
  assert.match(rule('.play'), /min-height:\s*fit-content/, 'the play grid never squeezes its rows over each other');
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
