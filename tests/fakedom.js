// A tiny stand-in for the page, enough for ui.js and for booting app.js
// (tests/apphost.js): elements, attributes, simple selectors, events, focus,
// a modal dialog and canvases that draw nothing. Not a browser; only what
// the tests use.
// Escape on a modal dialog follows Chrome: keydown runs first (capture, then
// bubble) and, unless its default is prevented, the dialog gets 'cancel'.
// Refusing 'cancel' works only once until the next click (user activation);
// after that 'cancel' cannot be refused and the dialog closes, firing 'close'.
class FakeClassList {
  constructor(e) { this.e = e; }
  get set() { return new Set(this.e.className.split(/\s+/).filter(Boolean)); }
  contains(c) { return this.set.has(c); }
  add(c) { const s = this.set; s.add(c); this.e.className = [...s].join(' '); }
  remove(c) { const s = this.set; s.delete(c); this.e.className = [...s].join(' '); }
  toggle(c, on) { if (on ?? !this.contains(c)) this.add(c); else this.remove(c); }
}

class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.style = {};
    this.open = false;
    this.classList = new FakeClassList(this);
  }
  get id() { return this.attrs.get('id') || ''; }
  set id(v) { this.attrs.set('id', v); }
  get isConnected() {
    let e = this;
    while (e.parentNode) e = e.parentNode;
    return e === this.ownerDocument.body;
  }
  get disabled() { return this.attrs.has('disabled'); }
  // reflected, as in a browser: the hidden attribute is the hidden property
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  set disabled(v) { if (v) this.attrs.set('disabled', ''); else this.attrs.delete('disabled'); }
  // a canvas: drawing does nothing; there are no pixels to read
  getContext() {
    return new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => undefined), set: (t, k, v) => { t[k] = v; return true; } });
  }
  toBlob(cb) { cb(null); }
  matches(sel) { return selectorList(sel).some((s) => matchesSelector(this, s)); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  // as a browser does: anything that is not an element (null and undefined
  // too) becomes a text node of its String(), so a stray null shows as 'null'
  append(...kids) {
    for (const c of kids) {
      const n = c instanceof FakeElement ? c : Object.assign(new FakeElement(this.ownerDocument, '#text'), { textContent: String(c) });
      if (n.parentNode) n.remove();
      n.parentNode = this;
      this.children.push(n);
    }
  }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.children = p.children.filter((x) => x !== this);
    this.parentNode = null;
  }
  replaceChildren(...kids) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...kids);
  }
  contains(o) {
    for (let e = o; e; e = e.parentNode) if (e === this) return true;
    return false;
  }
  closest(sel) {
    for (let e = this; e && e.tagName; e = e.parentNode) if (e.matches && e.matches(sel)) return e;
    return null;
  }
  addEventListener(type, fn, opts) {
    addListener(this.listeners, type, fn, opts);
  }
  dispatch(type, ev = {}) {
    const e = makeEvent(type, this, ev);
    for (const { fn } of this.listeners.get(type) || []) fn(e);
    return e;
  }
  click() {
    if (this.disabled) return;
    this.ownerDocument.activated = true;
    this.dispatch('click');
  }
  focus() { this.ownerDocument.activeElement = this; }
  all() {
    const out = [];
    const walk = (e) => { for (const c of e.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const list = selectorList(sel);
    return this.all().filter((e) => e.tagName !== '#TEXT' && list.some((s) => matchesSelector(e, s)));
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  // dialog
  showModal() {
    if (this.open) throw new Error('InvalidStateError: the dialog is already open');
    this.returnFocus = this.ownerDocument.activeElement;
    this.open = true;
    this.ownerDocument.modal = this;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    if (this.ownerDocument.modal === this) this.ownerDocument.modal = null;
    this.ownerDocument.activeElement = this.returnFocus || null;
    this.dispatch('close');
  }
  // Chrome's close request (Escape, or the back gesture)
  requestClose() {
    const doc = this.ownerDocument;
    const cancelable = !this.refusedOnce || doc.activated;
    doc.activated = false;
    const e = this.dispatch('cancel', { cancelable });
    if (cancelable && e.defaultPrevented) { this.refusedOnce = true; return; }
    this.close();
  }
}

// Selectors, as far as the page uses them: tags, #id, .class, [attr],
// [attr="value"] and :not(...), joined by descendant spaces and commas. A
// dialog's [open] is its open state.
function selectorList(sel) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of sel) {
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out.map((s) => {
    const parts = [];
    let d = 0, p = '';
    for (const c of s) {
      if (c === '(' || c === '[') d++;
      if (c === ')' || c === ']') d--;
      if (/\s/.test(c) && !d) { if (p) parts.push(p); p = ''; } else p += c;
    }
    if (p) parts.push(p);
    return parts;
  });
}

function matchesCompound(e, c) {
  if (!e || !e.attrs) return false;
  const re = /^([a-zA-Z*][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:not\((.+?)\)(?=$|[#.[:])/g;
  let m, used = 0;
  while ((m = re.exec(c))) {
    if (m.index !== used) return false;
    used = re.lastIndex;
    if (m[1] && m[1] !== '*' && e.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && e.id !== m[2]) return false;
    if (m[3] && !e.classList.contains(m[3])) return false;
    if (m[4]) {
      const has = m[4] === 'open' && e.tagName === 'DIALOG' ? e.open : e.attrs.has(m[4]);
      if (!has || (m[5] !== undefined && e.attrs.get(m[4]) !== m[5])) return false;
    }
    if (m[6] && matchesCompound(e, m[6])) return false;
  }
  return used === c.length;
}

function matchesSelector(e, parts) {
  if (!matchesCompound(e, parts[parts.length - 1])) return false;
  let k = parts.length - 2;
  for (let a = e.parentNode; a && k >= 0; a = a.parentNode) if (matchesCompound(a, parts[k])) k--;
  return k < 0;
}

function addListener(map, type, fn, opts) {
  if (!map.has(type)) map.set(type, []);
  map.get(type).push({ fn, capture: opts === true || !!(opts && opts.capture) });
}

function makeEvent(type, target, ev = {}) {
  return {
    type, target, cancelable: true, defaultPrevented: false, stopped: false,
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    ...ev,
  };
}

export function fakeDocument() {
  const doc = {
    activeElement: null,
    modal: null,
    listeners: new Map(),
    createElement(tag) { return new FakeElement(doc, tag); },
    getElementById(id) { return doc.body.all().find((e) => e.id === id) || null; },
    querySelector(sel) { return doc.body.querySelector(sel); },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
    addEventListener(type, fn, opts) {
      addListener(doc.listeners, type, fn, opts);
    },
    // a key press on the focused element: capture from the document down,
    // bubble back up, then the browser's default action
    pressKey(key) {
      const target = doc.activeElement || doc.body;
      const path = [];
      for (let n = target; n; n = n.parentNode) path.unshift(n);
      const e = makeEvent('keydown', target, { key });
      const run = (map, capture) => {
        for (const l of map.get('keydown') || []) if (l.capture === capture && !e.stopped) l.fn(e);
      };
      run(doc.listeners, true);
      for (const n of path) run(n.listeners, true);
      for (const n of [...path].reverse()) run(n.listeners, false);
      run(doc.listeners, false);
      if (!e.defaultPrevented && key === 'Escape' && doc.modal) doc.modal.requestClose();
      return e;
    },
  };
  // the root element only carries classes here; the body is the tree's root
  doc.documentElement = new FakeElement(doc, 'html');
  doc.body = new FakeElement(doc, 'body');
  return doc;
}

export function installFakeDocument() {
  const doc = fakeDocument();
  globalThis.document = doc;
  return doc;
}
