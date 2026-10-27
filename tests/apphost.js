// Boots the real app.js in Node on tests/fakedom.js, with the play screen
// and the reveal (src/game.js) swapped for tests/stub_game.js through a
// module hook. The page's rooms are served from disk; api/health answers
// for the mode asked for (MOCK: no server answers). Each boot is a fresh
// instance of app.js on a fresh page; the road may be saved beforehand.
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { installFakeDocument } from './fakedom.js';
import { el } from '../src/ui.js';
import { FREE_PLAY } from '../src/road.js';

const STUB = new URL('./stub_game.js', import.meta.url).href;
const HOOKS = `export async function resolve(spec, ctx, next) {
  if (spec === './src/game.js' && ctx.parentURL && /\\/app\\.js(\\?|$)/.test(ctx.parentURL)) return { url: ${JSON.stringify(STUB)}, shortCircuit: true };
  return next(spec, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);

const realSetInterval = globalThis.setInterval;
let boots = 0;

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

// The page as index.html lays it out.
function page(doc) {
  doc.body.append(
    el('div', { class: 'app', id: 'app' }, [
      el('header', { class: 'top', id: 'top' }, [el('span', { class: 'brand', text: 'FRAME//PLAY' }), el('span', { class: 'lap', id: 'lap' }), el('nav', { class: 'road', id: 'road' })]),
      el('main', { id: 'main', tabindex: '-1' }),
      el('div', { class: 'tour-strip', id: 'tour-strip' }),
      el('aside', { class: 'drawer', id: 'drawer', hidden: true }),
      el('footer', { class: 'dock', id: 'dock' }),
    ]),
    el('p', { class: 'sr-only', id: 'live' }),
    el('dialog', { class: 'card', id: 'card' }),
  );
}

// A picked photo file: its bytes (and so its sha256) from a seed.
export function photoFile(seed) {
  const bytes = new Uint8Array(400).fill(seed);
  return { type: 'image/jpeg', size: bytes.length, name: `photo${seed}.jpg`, arrayBuffer: async () => bytes.buffer.slice(0), sha256: createHash('sha256').update(bytes).digest('hex') };
}

// the page's canvases hold these pixels (Node has no decoder): what a
// browser would hold after decoding and shrinking the chosen photo
export function paintCanvases(app, pixels) {
  const make = app.doc.createElement;
  app.doc.createElement = (tag) => {
    const e = make(tag);
    if (tag === 'canvas') {
      const ctx = { getImageData: () => ({ width: pixels.width, height: pixels.height, data: pixels.data }) };
      e.getContext = () => new Proxy(ctx, { get: (t, k) => (k in t ? t[k] : () => undefined), set: () => true });
    }
    return e;
  };
  globalThis.createImageBitmap = async () => ({ width: pixels.width, height: pixels.height, close() {} });
}

export async function until(app, f, what, ms = 30000) {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}: ${app.counter()} · ${app.main().slice(0, 300)}`);
    await app.settle(2);
  }
}

export const nameOf = (e) => (e.children.length ? e.children.map(nameOf).join('') : e.textContent || '').trim();
export const textOf =(e) => (e.children.length ? e.children.map(textOf).join(' ') : e.textContent || '').replace(/\s+/g, ' ').trim();

// mode: 'mock' | 'rehearsal' | 'live'; road: saved before the boot, or null;
// room: the room the stand-in was started for (REHEARSAL); answer(body): the
// reply api/room gives for a POST, or null for no server answer there. With
// an answer, the page's canvases encode (an empty JPEG) and decode again, so
// a send runs end to end.
// prefs: other saved preferences, by name (as src/store.js keeps them).
// server: in MOCK, a server answers (health says mock) rather than none.
// replay(): the reply api/replay/kitchen gives (the server's replay of our
// kitchen photo), or null when the server has no replay (an older one).
export async function bootApp({ mode = 'mock', road = null, room = 'desk', answer = null, prefs = {}, server = mode !== 'mock', replay = null } = {}) {
  const doc = installFakeDocument();
  if (answer) {
    const make = doc.createElement;
    doc.createElement = (tag) => {
      const e = make(tag);
      if (tag === 'canvas') e.toBlob = (cb, type = 'image/png') => cb(new Blob([new Uint8Array(64)], { type }));
      return e;
    };
    globalThis.createImageBitmap = async () => ({ width: 1024, height: 768, close() {} });
  }
  doc.body.append(el('div', { id: 'tips' }));
  page(doc);
  const storage = memoryStorage();
  if (road) storage.setItem('frameplay.road', JSON.stringify(road));
  for (const [k, v] of Object.entries(prefs)) storage.setItem(`frameplay.${k}`, JSON.stringify(v));
  const listeners = new Map();
  const history = [];
  const requests = [];
  Object.assign(globalThis, {
    localStorage: storage,
    innerWidth: 839,
    innerHeight: 945,
    requestAnimationFrame: (f) => setTimeout(() => f(performance.now()), 0),
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    getComputedStyle: () => ({ paddingTop: '0', paddingBottom: '0', rowGap: '0', columnGap: '0', getPropertyValue: () => '' }),
    history: {
      pushState: (s, t, u) => history.push(['push', u]),
      replaceState: (s, t, u) => history.push(['replace', u]),
    },
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    // the tour's timer must not keep the test process alive
    setInterval: (f, ms) => { const t = realSetInterval(f, ms); if (t.unref) t.unref(); return t; },
    fetch: async (url, opts = {}) => {
      requests.push([opts.method || 'GET', String(url)]);
      if (url === 'api/health') {
        if (!server) throw new Error('no server');
        const h = { mode, reason: '', label: mode };
        if (mode === 'rehearsal') h.rehearsal = { stand_in_base: 'http://127.0.0.1:8192/v1', room };
        if (replay) h.replay = { kitchen: { route: 'api/replay/kitchen', photo: 'rooms/kitchen.jpg', recorded: '2026-10-27' } };
        return { ok: true, json: async () => h };
      }
      if (url === 'api/replay/kitchen' && replay) {
        const reply = replay();
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => reply };
      }
      if (url === 'rooms/kitchen.jpg') {
        const bytes = readFileSync(new URL('../rooms/kitchen.jpg', import.meta.url));
        return { ok: true, blob: async () => new Blob([bytes], { type: 'image/jpeg' }) };
      }
      if (url === 'api/room' && answer) {
        const reply = answer(opts.body);
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => reply };
      }
      const m = /^rooms\/([a-z]+)\.json$/.exec(url);
      if (m) {
        const text = readFileSync(new URL(`../rooms/${m[1]}.json`, import.meta.url), 'utf8');
        return { ok: true, json: async () => JSON.parse(text) };
      }
      throw new Error(`no such address in this test: ${url}`);
    },
  });
  boots++;
  await import(`../app.js?boot=${boots}`);
  const $ = (id) => doc.getElementById(id);
  const app = {
    doc, $, history, requests, storage,
    settle: async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); },
    counter: () => textOf($('road').querySelector('.counter')),
    step: () => { const m = /^Step (\d+)/.exec(app.counter()); return m ? +m[1] : app.counter() === 'Free play' ? FREE_PLAY : null; },
    why: () => textOf($('road').querySelector('.why')),
    main: () => textOf($('main')),
    h1: () => { const h = $('main').querySelector('h1'); return h ? textOf(h) : null; },
    mainPrimary: () => $('main').querySelector('[data-primary]'),
    cardPrimary: () => $('card').querySelector('[data-primary]'),
    cardOpen: () => $('card').open,
    back: () => $('road').querySelectorAll('button')[0].click(),
    forward: () => $('road').querySelectorAll('button')[1].click(),
    // by its accessible name: aria-label, or its text as one run
    button: (name) => $('main').querySelectorAll('button').find((b) => (b.getAttribute('aria-label') || nameOf(b)) === name) || null,
    popstate: (state) => { for (const f of listeners.get('popstate') || []) f({ state }); },
    savedRoad: () => JSON.parse(storage.getItem('frameplay.road')),
    posts: () => requests.filter(([m]) => m === 'POST').length,
    // a picked file, as the screen's file input hands it on
    choose: (file) => { const input = $('main').querySelector('input'); input.files = [file]; input.dispatch('change'); },
    levels: () => JSON.parse(storage.getItem('frameplay.levels') || '[]'),
  };
  await app.settle();
  return app;
}
