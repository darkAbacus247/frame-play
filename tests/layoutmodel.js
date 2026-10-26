// A small layout model for tests. It lays out an element tree built with
// ui.js `el` on tests/fakedom.js, using the real stylesheet's cascade, to
// tell how tall a screen is at a given window size. It is a model, not a
// browser: text wraps at an average glyph width a little wider than the
// page's system font (0.52 em, 0.56 em when bold), so it errs toward
// taller; it knows the block, flex (rows that wrap, columns) and grid
// layouts this stylesheet uses, padding, borders, min and max sizes.
import { readFileSync } from 'node:fs';
import { el } from '../src/ui.js';

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
export const RULES = [];
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
})(CSS, null);

const REM = 16;
// split a value at its top-level spaces, keeping nested brackets whole
function splitTop(v) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of String(v).trim()) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (/\s/.test(c) && !depth) { if (cur) out.push(cur); cur = ''; } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
const toPx = (v) => (v.endsWith('rem') ? parseFloat(v) * REM : v.endsWith('em') ? parseFloat(v) * REM : parseFloat(v));
export function mediaHolds(media, vw, vh) {
  if (!media) return true;
  return [...media.matchAll(/\((min|max)-(width|height):\s*([\d.]+(?:px|rem))\)/g)].every(([, mm, dim, v]) => {
    const have = dim === 'width' ? vw : vh;
    return mm === 'min' ? have >= toPx(v) : have <= toPx(v);
  });
}

function decls(body) {
  const out = {};
  for (const d of body.split(';')) {
    const k = d.indexOf(':');
    if (k > 0) out[d.slice(0, k).trim()] = d.slice(k + 1).trim().replace(/\s*!important$/, '');
  }
  return out;
}

function rootVars(vw, vh) {
  const out = {};
  for (const r of RULES) if (r.sels.includes(':root') && mediaHolds(r.media, vw, vh)) Object.assign(out, decls(r.body));
  return out;
}

// plain selectors: tags, classes, descendant and child combinators; any
// pseudo-class or attribute part never matches (hidden is handled apart)
function compoundMatches(c, e) {
  if (/[:[]/.test(c)) return false;
  const [tag, ...cls] = c.split('.');
  return (!tag || tag === '*' || tag === e.tag) && cls.every((k) => e.cls.includes(k));
}
export function selectorMatches(sel, chain) {
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
export function styleOf(chain, vw, vh) {
  const out = {};
  for (const r of RULES) {
    if (mediaHolds(r.media, vw, vh) && r.sels.some((s) => selectorMatches(s, chain))) Object.assign(out, decls(r.body));
  }
  return out;
}

const nodeOf = (e) => ({ tag: e.tagName.toLowerCase(), cls: (e.className || '').split(/\s+/).filter(Boolean) });
const BLOCK = new Set(['DIV', 'P', 'UL', 'OL', 'LI', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY', 'NAV', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'DIALOG']);
const ATOMIC = new Set(['BUTTON', 'CANVAS', 'INPUT', 'IMG']);
const BOLD = new Set(['H1', 'H2', 'H3', 'STRONG', 'B', 'TH']);
const HEAD_SIZE = { H1: 2, H2: 1.5, H3: 1.25 };

export class Layout {
  constructor(vw, vh, { pictures = {} } = {}) {
    this.vw = vw;
    this.vh = vh;
    this.pictures = pictures;
    this.vars = { '--s1': '0.25rem', '--s2': '0.5rem', '--s3': '0.75rem', '--s4': '1rem', '--s5': '1.5rem', '--s6': '2rem', '--s7': '3rem', ...rootVars(vw, vh) };
  }

  len(v, base = 0) {
    if (v == null || v === '' || v === 'auto' || v === 'none' || v === 'fit-content') return null;
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    if (m) return this.len(this.vars[m[1]], base);
    if (v.endsWith('%')) return (parseFloat(v) / 100) * base;
    if (v.endsWith('ch')) return parseFloat(v) * 0.55 * REM;
    if (v.endsWith('vh')) return (parseFloat(v) / 100) * this.vh;
    if (v.endsWith('vw')) return (parseFloat(v) / 100) * this.vw;
    if (/^-?[\d.]+(px|rem|em)?$/.test(v)) return toPx(v);
    const min = /^min\((.+),\s*(.+)\)$/.exec(v);
    if (min) return Math.min(this.len(min[1], base), this.len(min[2], base));
    return null;
  }

  sides(v, base) {
    if (!v) return null;
    const t = splitTop(v).map((x) => this.len(x, base) || 0);
    const [a, b = a, c = a, d = b] = t;
    return [a, b, c, d];
  }

  box(e, st, base) {
    const pad = this.sides(st.padding, base) || [0, 0, 0, 0];
    for (const [k, i] of [['padding-top', 0], ['padding-right', 1], ['padding-bottom', 2], ['padding-left', 3]]) if (st[k]) pad[i] = this.len(st[k], base) || 0;
    const bw = (v) => (v && !/none/.test(v) ? this.len(v.split(/\s+/)[0]) || 0 : 0);
    const brd = [0, 0, 0, 0];
    if (st.border) brd.fill(bw(st.border));
    for (const [k, i] of [['border-top', 0], ['border-right', 1], ['border-bottom', 2], ['border-left', 3]]) if (st[k] != null) brd[i] = bw(st[k]);
    // the browser's own list and figure spacing, unless the stylesheet sets it
    const mar = this.sides(st.margin, base) || [0, 0, 0, 0];
    if ((e.tagName === 'UL' || e.tagName === 'OL') && st.margin == null) mar[0] = mar[2] = REM;
    if ((e.tagName === 'UL' || e.tagName === 'OL') && st.padding == null && st['padding-left'] == null) pad[3] = 40;
    if (e.tagName === 'FIGURE' && st.margin == null) { mar[0] = mar[2] = REM; mar[1] = mar[3] = 40; }
    for (const [k, i] of [['margin-top', 0], ['margin-bottom', 2]]) if (st[k] && st[k] !== 'auto') mar[i] = this.len(st[k], base) || 0;
    return { pad, brd, mar };
  }

  font(e, st, inh) {
    let size = inh.size;
    if (HEAD_SIZE[e.tagName]) size = HEAD_SIZE[e.tagName] * REM;
    if (st['font-size']) size = this.len(st['font-size']) || size;
    let weight = BOLD.has(e.tagName) ? 700 : inh.weight;
    if (st['font-weight']) weight = parseInt(st['font-weight'], 10) || weight;
    let lh = inh.lh;
    if (st['line-height'] && /^[\d.]+$/.test(st['line-height'])) lh = parseFloat(st['line-height']);
    return { size, weight, lh };
  }

  hidden(e, st) {
    return e.tagName === '#TEXT' ? false : e.attrs.has('hidden') || e.hidden === true || st.display === 'none' || st.position === 'absolute' || st.position === 'fixed';
  }

  kids(e) {
    let k = e.children;
    if (e.tagName === 'DETAILS' && !e.attrs.has('open')) k = k.filter((c) => c.tagName === 'SUMMARY');
    return k;
  }

  text(e) {
    return e.children.length ? e.children.map((c) => this.text(c)).join('') : e.textContent || '';
  }

  isBox(e, st) {
    if (e.tagName === '#TEXT') return false;
    if (ATOMIC.has(e.tagName) || BLOCK.has(e.tagName)) return true;
    return /block|flex|grid/.test(st.display || '');
  }

  // the lines a run of text takes at a width
  lines(text, width, f) {
    const cw = f.size * (f.weight >= 600 ? 0.56 : 0.52);
    const per = Math.max(1, Math.floor(width / cw));
    let n = 0;
    for (const para of String(text).split('\n')) {
      let line = 0;
      n++;
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const need = line ? line + 1 + word.length : word.length;
        if (need <= per) line = need;
        else if (!line) { n += Math.ceil(word.length / per) - 1; line = word.length % per; } else { n++; line = word.length; }
      }
    }
    return n;
  }

  textWidth(text, f) {
    return String(text).length * f.size * (f.weight >= 600 ? 0.56 : 0.52);
  }

  // max-content width
  natural(e, chain, inh) {
    const ch = [...chain, nodeOf(e)];
    const st = e.tagName === '#TEXT' ? {} : styleOf(ch, this.vw, this.vh);
    if (this.hidden(e, st)) return 0;
    const f = this.font(e, st, inh);
    const { pad, brd } = this.box(e, st, this.vw);
    const extra = pad[1] + pad[3] + brd[1] + brd[3];
    const fixed = this.len(st.width);
    if (fixed != null && !String(st.width).endsWith('%')) return fixed + (st['box-sizing'] === 'content-box' ? extra : 0);
    if (e.tagName === 'CANVAS') return +e.getAttribute('width') || 300;
    const kids = this.kids(e).filter((k) => k.tagName === '#TEXT' || !this.hidden(k, styleOf([...ch, nodeOf(k)], this.vw, this.vh)));
    const container = /flex|grid/.test(st.display || '') && kids.some((k) => k.tagName !== '#TEXT');
    if (!container && !kids.some((k) => this.isBox(k, k.tagName === '#TEXT' ? {} : styleOf([...ch, nodeOf(k)], this.vw, this.vh)))) {
      return Math.max(this.len(st['min-width']) || 0, this.textWidth(this.text(e), f) + extra);
    }
    const ws = kids.map((k) => this.natural(k, ch, f));
    const row = /flex/.test(st.display || '') && !/column/.test(st['flex-direction'] || '');
    const gap = this.gaps(st).col;
    const inner = row ? ws.reduce((a, b) => a + b, 0) + gap * Math.max(0, ws.length - 1) : Math.max(0, ...ws);
    return Math.max(this.len(st['min-width']) || 0, inner + extra);
  }

  gaps(st) {
    const [row, col = row] = splitTop(st.gap || '0');
    return { row: this.len(st['row-gap'] || row) || 0, col: this.len(st['column-gap'] || col) || 0 };
  }

  // lay e out in `avail` px of width; returns its border-box { w, h } and its margins
  measure(e, chain = [], avail = this.vw, inh = { size: REM, weight: 400, lh: 1.5 }) {
    if (e.tagName === '#TEXT') {
      const n = this.lines(e.textContent, avail, inh);
      return { w: Math.min(avail, this.textWidth(e.textContent, inh)), h: n * inh.lh * inh.size, mar: [0, 0, 0, 0] };
    }
    const ch = [...chain, nodeOf(e)];
    const st = styleOf(ch, this.vw, this.vh);
    if (this.hidden(e, st)) return { w: 0, h: 0, mar: [0, 0, 0, 0], gone: true };
    const f = this.font(e, st, inh);
    const { pad, brd, mar } = this.box(e, st, avail);
    const ex = pad[1] + pad[3] + brd[1] + brd[3];
    const ey = pad[0] + pad[2] + brd[0] + brd[2];
    let w = avail - mar[1] - mar[3];
    const fixedW = this.len(st.width, avail);
    if (fixedW != null) w = fixedW;
    const maxW = this.len(st['max-width'], avail);
    if (maxW != null) w = Math.min(w, maxW);
    const minH = this.len(st['min-height'], this.vh) || 0;
    const cls = nodeOf(e).cls;
    const pic = cls.find((c) => this.pictures[c]);
    if (pic) return { w, h: this.pictures[pic](w - ex) + ey, mar };
    if (e.tagName === 'CANVAS') return { ...this.replaced(e, st, avail), mar };
    const inner = Math.max(0, w - ex);
    const kids = this.kids(e);
    const boxes = kids.filter((k) => k.tagName === '#TEXT' || !this.hidden(k, styleOf([...ch, nodeOf(k)], this.vw, this.vh)));
    let h;
    const container = /flex|grid/.test(st.display || '') && boxes.some((k) => k.tagName !== '#TEXT');
    if (!container && !boxes.some((k) => this.isBox(k, k.tagName === '#TEXT' ? {} : styleOf([...ch, nodeOf(k)], this.vw, this.vh)))) {
      h = this.lines(this.text(e), inner, f) * f.lh * f.size;
      if (!this.text(e)) h = 0;
    } else if (/grid/.test(st.display || '')) {
      h = this.grid(boxes, ch, st, inner, f);
    } else if (/flex/.test(st.display || '') && !/column/.test(st['flex-direction'] || '')) {
      h = this.flexRow(boxes, ch, st, inner, f);
    } else {
      const gap = /flex/.test(st.display || '') ? this.gaps(st).row : 0;
      h = this.stack(boxes, ch, inner, f, gap);
    }
    // a shrink-to-fit box (a button, an inline flex) is as wide as its content
    if (ATOMIC.has(e.tagName) || /inline/.test(st.display || '')) w = Math.min(w, this.natural(e, chain, inh));
    const maxH = this.len(st['max-height'], this.vh);
    let out = Math.max(minH, h + ey);
    if (maxH != null) out = Math.min(out, maxH);
    return { w, h: out, mar };
  }

  replaced(e, st, avail) {
    const iw = +e.getAttribute('width') || 300, ih = +e.getAttribute('height') || 150;
    let w = this.len(st.width, avail) ?? iw;
    const mw = this.len(st['max-width'], avail);
    if (mw != null) w = Math.min(w, mw);
    w = Math.min(w, avail);
    let h = (w * ih) / iw;
    const mh = this.len(st['max-height'], this.vh);
    if (mh != null && h > mh) { h = mh; w = (h * iw) / ih; }
    return { w, h };
  }

  stack(kids, ch, inner, f, gap) {
    let h = 0, n = 0;
    for (const k of kids) {
      const m = this.measure(k, ch, inner, f);
      if (m.gone) continue;
      h += m.h + m.mar[0] + m.mar[2] + (n ? gap : 0);
      n++;
    }
    return h;
  }

  flexRow(kids, ch, st, inner, f) {
    const { row, col } = this.gaps(st);
    const wrap = /wrap/.test(st['flex-wrap'] || '');
    const items = [];
    for (const k of kids) {
      const kst = k.tagName === '#TEXT' ? {} : styleOf([...ch, nodeOf(k)], this.vw, this.vh);
      if (k.tagName !== '#TEXT' && this.hidden(k, kst)) continue;
      const flex = (kst.flex || '').split(/\s+/);
      const grow = kst.flex === 'none' ? 0 : parseFloat(flex[0]) || 0;
      const basisV = kst['flex-basis'] || (flex[2] && flex[2] !== 'auto' ? flex[2] : null);
      let basis = basisV ? this.len(basisV, inner) : null;
      if (basis == null) basis = this.natural(k, ch, f);
      items.push({ k, grow, basis: Math.min(inner, basis) });
    }
    const lines = [];
    let cur = [], used = 0;
    for (const it of items) {
      const need = cur.length ? used + col + it.basis : it.basis;
      if (wrap && cur.length && need > inner + 0.5) { lines.push(cur); cur = []; used = 0; }
      used = cur.length ? used + col + it.basis : it.basis;
      cur.push(it);
    }
    if (cur.length) lines.push(cur);
    let h = 0;
    lines.forEach((line, i) => {
      const sum = line.reduce((a, it) => a + it.basis, 0) + col * (line.length - 1);
      const free = inner - sum;
      const g = line.reduce((a, it) => a + it.grow, 0);
      let lh = 0;
      for (const it of line) {
        let w = it.basis;
        if (free > 0 && g > 0) w += (free * it.grow) / g;
        if (free < 0 && !wrap) w = Math.max(0, it.basis + (free * it.basis) / (sum || 1));
        lh = Math.max(lh, this.measure(it.k, ch, w, f).h);
      }
      h += lh + (i ? row : 0);
    });
    return h;
  }

  tracks(st, inner, col, kids, ch, f) {
    const spec = st['grid-template-columns'];
    if (!spec) return [inner];
    const toks = [];
    for (const t of splitTop(spec)) {
      const rep = /^repeat\((auto-fill|auto-fit|\d+),\s*(.+)\)$/.exec(t);
      if (!rep) { toks.push(t); continue; }
      if (/^\d+$/.test(rep[1])) { for (let i = 0; i < +rep[1]; i++) toks.push(rep[2]); continue; }
      const mm = /^minmax\(([^,]+),\s*(.+)\)$/.exec(rep[2]);
      const lo = this.len(mm ? mm[1] : rep[2]), hi = mm ? this.len(mm[2]) : lo;
      // as browsers do: the number of tracks comes from the maximum size
      // when it is definite, else from the minimum
      const n = Math.max(1, Math.floor((inner + col) / ((hi ?? lo) + col)));
      const w = hi == null ? (inner - col * (n - 1)) / n : Math.min(hi, (inner - col * (n - 1)) / n);
      return Array(n).fill(w);
    }
    const out = toks.map(() => 0), fr = toks.map(() => 0), min = toks.map(() => 0);
    toks.forEach((t, i) => {
      const mm = /^minmax\(([^,]+),\s*(.+)\)$/.exec(t);
      const hi = mm ? mm[2].trim() : t, lo = mm ? mm[1].trim() : t;
      if (/fr$/.test(hi)) { fr[i] = parseFloat(hi); min[i] = this.len(lo) || 0; } else if (hi === 'auto' || hi === 'max-content') {
        out[i] = Math.max(0, ...kids.filter((_, k) => k % toks.length === i).map((k) => this.natural(k, ch, f)));
      } else { out[i] = this.len(hi) ?? 0; min[i] = this.len(lo) ?? out[i]; }
    });
    const gaps = col * (toks.length - 1);
    let free = inner - gaps - out.reduce((a, b) => a + b, 0);
    if (free < 0) {
      // fixed tracks give back down to their minimums
      toks.forEach((_, i) => { if (!fr[i] && free < 0) { const give = Math.min(out[i] - min[i], -free); out[i] -= give; free += give; } });
    }
    const totalFr = fr.reduce((a, b) => a + b, 0);
    toks.forEach((_, i) => { if (fr[i]) out[i] = Math.max(min[i], (Math.max(0, free) * fr[i]) / totalFr); });
    return out;
  }

  grid(kids, ch, st, inner, f) {
    const { row, col } = this.gaps(st);
    const live = kids.filter((k) => k.tagName === '#TEXT' || !this.hidden(k, styleOf([...ch, nodeOf(k)], this.vw, this.vh)));
    const cols = this.tracks(st, inner, col, live, ch, f);
    let h = 0;
    for (let i = 0; i < live.length; i += cols.length) {
      let rh = 0;
      live.slice(i, i + cols.length).forEach((k, j) => {
        const m = this.measure(k, ch, cols[j], f);
        rh = Math.max(rh, m.h + m.mar[0] + m.mar[2]);
      });
      h += rh + (i ? row : 0);
    }
    return h;
  }
}

// main's chain: the page grid, then main
export const MAIN_CHAIN = [{ tag: 'html', cls: [] }, { tag: 'body', cls: [] }, { tag: 'div', cls: ['app'] }, { tag: 'main', cls: [] }];

// The header for a step and the dock, as app.js draws them.
export function header({ lap, counter, why, tourOn = false, band = null }) {
  return el('header', { class: 'top' }, [
    el('span', { class: 'brand', text: 'FRAME//PLAY' }),
    el('span', { class: 'lap', text: lap }),
    el('nav', { class: 'road' }, [
      el('button', { type: 'button', class: 'btn icon-btn' }, [el('span', { text: '←' })]),
      el('span', { class: 'counter', text: counter }),
      el('button', { type: 'button', class: 'btn icon-btn' }, [el('span', { text: '→' })]),
      el('span', { class: 'why', text: why }),
      el('button', { type: 'button', class: 'btn quiet tour-btn', text: tourOn ? 'End the tour' : 'Take the tour' }),
    ]),
    band ? el('p', { class: 'band', text: band }) : null,
  ]);
}
export function dock(mode) {
  return el('footer', { class: 'dock' }, [
    el('button', { type: 'button', class: 'btn' }, [el('span', { text: '⚙' }), el('span', { text: 'Settings' })]),
    el('button', { type: 'button', class: 'btn', text: 'Sound: on' }),
    el('span', { class: `mode-chip ${mode}`, text: mode.toUpperCase() }),
    el('span', { class: 'mark', text: 'FRAME//PLAY' }),
  ]);
}

// The space main gives a screen: the window less the header, the dock and
// main's own padding. Returns { space, width, layout }.
export function mainSpace(vw, vh, head, mode, opts) {
  const L = new Layout(vw, vh, opts);
  const app = [MAIN_CHAIN[0], MAIN_CHAIN[1], MAIN_CHAIN[2]];
  const top = L.measure(head, app, vw).h;
  const bottom = L.measure(dock(mode), app, vw).h;
  const pad = L.len('var(--pad)');
  return { space: vh - top - bottom - 2 * pad, width: vw - 2 * pad, layout: L, header: top, dock: bottom };
}

export function screenHeight(L, section, width) {
  return L.measure(section, MAIN_CHAIN, width).h;
}
