// A tiny stand-in for the page, enough for ui.js: elements, attributes,
// events, focus and a modal dialog. Not a browser; only what the tests use.
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
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, ev = {}) {
    const e = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...ev };
    for (const fn of this.listeners.get(type) || []) fn(e);
    return e;
  }
  click() { if (!this.disabled) this.dispatch('click'); }
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
  showModal() { this.open = true; this.ownerDocument.modal = this; }
  close() { this.open = false; if (this.ownerDocument.modal === this) this.ownerDocument.modal = null; }
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
    addEventListener(type, fn) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, []);
      doc.listeners.get(type).push(fn);
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
