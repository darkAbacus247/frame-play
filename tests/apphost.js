// Boots the real app.js in Node on tests/fakedom.js, with the play screen
// and the reveal (src/game.js) swapped for tests/stub_game.js through a
// module hook. The page's rooms are served from disk; api/health answers
// for the mode asked for (MOCK: no server answers). Each boot is a fresh
// instance of app.js on a fresh page; the road may be saved beforehand.
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './fakedom.js';
import { el } from '../src/ui.js';

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

export const textOf = (e) => (e.children.length ? e.children.map(textOf).join(' ') : e.textContent || '').replace(/\s+/g, ' ').trim();

// mode: 'mock' | 'rehearsal' | 'live'; road: saved before the boot, or null
export async function bootApp({ mode = 'mock', road = null } = {}) {
  const doc = installFakeDocument();
  doc.body.append(el('div', { id: 'tips' }));
  page(doc);
  const storage = memoryStorage();
  if (road) storage.setItem('frameplay.road', JSON.stringify(road));
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
        if (mode === 'mock') throw new Error('no server');
        const h = { mode, reason: '', label: mode };
        if (mode === 'rehearsal') h.rehearsal = { stand_in_base: 'http://127.0.0.1:8192/v1', room: 'desk' };
        return { ok: true, json: async () => h };
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
    step: () => { const m = /^Step (\d+)/.exec(app.counter()); return m ? +m[1] : app.counter() === 'Free play' ? 13 : null; },
    why: () => textOf($('road').querySelector('.why')),
    main: () => textOf($('main')),
    h1: () => { const h = $('main').querySelector('h1'); return h ? textOf(h) : null; },
    mainPrimary: () => $('main').querySelector('[data-primary]'),
    cardPrimary: () => $('card').querySelector('[data-primary]'),
    cardOpen: () => $('card').open,
    back: () => $('road').querySelectorAll('button')[0].click(),
    forward: () => $('road').querySelectorAll('button')[1].click(),
    button: (text) => $('main').querySelectorAll('button').find((b) => textOf(b) === text || b.getAttribute('aria-label') === text) || null,
    popstate: (state) => { for (const f of listeners.get('popstate') || []) f({ state }); },
    savedRoad: () => JSON.parse(storage.getItem('frameplay.road')),
  };
  await app.settle();
  return app;
}
