// A tiny stand-in for the page, enough for ui.js: elements, attributes,
// events, focus and a modal dialog. Not a browser; only what the tests use.
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
    this.hidden = false;
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
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  append(...kids) {
    for (const c of kids) {
      const n = typeof c === 'string' ? Object.assign(new FakeElement(this.ownerDocument, '#text'), { textContent: c }) : c;
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
  closest() { return null; }
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
    if (sel === 'button') return this.all().filter((e) => e.tagName === 'BUTTON');
    if (sel === 'dialog[open]') return this.all().filter((e) => e.tagName === 'DIALOG' && e.open);
    if (sel === '[data-primary]') return this.all().filter((e) => e.attrs.has('data-primary'));
    return [];
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
  doc.body = new FakeElement(doc, 'body');
  return doc;
}

export function installFakeDocument() {
  const doc = fakeDocument();
  globalThis.document = doc;
  return doc;
}
