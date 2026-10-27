// A4: the page is an installable app: its manifest, its icons (drawn from
// the favicon's artwork), a service worker that keeps only the page's own
// static files (never api/..., never a photo, never another site, never a
// non-GET), and Install in Settings only while the browser offers it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bootApp, nameOf } from './apphost.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url));

test('the manifest: name, short name, start URL, standalone, the page’s colours and icons', () => {
  const m = JSON.parse(read('manifest.webmanifest').toString('utf8'));
  assert.equal(m.name, 'FRAME//PLAY');
  assert.ok(m.short_name && m.short_name.length <= 12);
  assert.equal(m.start_url, './');
  assert.equal(m.display, 'standalone');
  const css = read('styles.css').toString('utf8');
  assert.match(css, new RegExp(`--bg: ${m.background_color};`), 'background: the page’s own');
  assert.match(css, new RegExp(`--panel: ${m.theme_color};`), 'theme: the page’s bars');
  const index = read('index.html').toString('utf8');
  assert.match(index, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(index, new RegExp(`<meta name="theme-color" content="${m.theme_color}">`));
  const pngs = m.icons.filter((i) => i.type === 'image/png');
  assert.deepEqual(pngs.map((i) => i.sizes), ['192x192', '512x512']);
  for (const i of pngs) {
    const b = read(i.src);
    assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG');
    const n = +i.sizes.split('x')[0];
    assert.equal(b.readUInt32BE(16), n);
    assert.equal(b.readUInt32BE(20), n);
  }
  assert.ok(m.icons.some((i) => i.src === 'favicon.svg'));
});

// sw.js run as a worker runs it, with a fake self, caches and fetch
function worker() {
  const listeners = {};
  const fetched = [];
  const self = {
    registration: { scope: 'http://127.0.0.1:8000/' },
    addEventListener: (t, f) => { listeners[t] = f; },
    skipWaiting: () => {}, clients: { claim: () => {} },
  };
  const caches = { open: async () => ({ addAll: async () => {}, put: async () => {} }), keys: async () => [], match: async () => undefined, delete: async () => true };
  vm.runInNewContext(read('sw.js').toString('utf8'), { self, caches, URL, Response: { error: () => null }, fetch: async (r) => { fetched.push(r); return { ok: true, type: 'basic', clone() { return this; } }; } });
  const handles = (url, method = 'GET') => {
    let responded = false;
    listeners.fetch({ request: { url, method }, respondWith: () => { responded = true; } });
    return responded;
  };
  return { handles, listeners };
}

test('the service worker keeps the page’s own static files only', () => {
  const { handles, listeners } = worker();
  assert.ok(listeners.install && listeners.activate && listeners.fetch);
  const base = 'http://127.0.0.1:8000';
  for (const p of ['/', '/index.html', '/app.js', '/styles.css', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/src/game.js', '/rooms/desk.json']) {
    assert.ok(handles(base + p), `${p} is kept`);
  }
  for (const p of ['/api/health', '/api/room', '/api/replay/kitchen', '/api/anything.js', '/rooms/kitchen.jpg', '/photo.jpg', '/sw.js', '/server/server.py', '/app.js?key=x', '/src/../server/config.py']) {
    assert.ok(!handles(base + p), `${p} is never touched`);
  }
  assert.ok(!handles('https://example.org/app.js'), 'never another site');
  assert.ok(!handles(base + '/app.js', 'POST'), 'never anything but a GET');
  assert.ok(!handles(base + '/api/room', 'POST'));
  assert.ok(!handles('blob:http://127.0.0.1:8000/1234'), 'never a picture in memory');
});

test('the shell the worker keeps on install holds no api route, photo or key', () => {
  const src = read('sw.js').toString('utf8');
  const shell = JSON.parse(/const SHELL = (\[[^\]]*\]);/.exec(src)[1].replace(/'/g, '"'));
  assert.ok(shell.includes('index.html') && shell.includes('app.js'));
  for (const f of shell) assert.doesNotMatch(f, /api|\.jpe?g$|key/i, f);
  assert.doesNotMatch(src, /localStorage|indexedDB|Authorization|api_key/i);
});

test('Install appears in Settings only while the browser offers installation', async () => {
  const app = await bootApp({ mode: 'mock' });
  const openSettings = () => app.$('dock').querySelectorAll('button').find((b) => /Settings/.test(nameOf(b))).click();
  openSettings();
  await app.settle(2);
  const install = () => app.$('drawer').querySelectorAll('button').find((b) => nameOf(b) === 'Install') || null;
  assert.equal(install(), null, 'no offer, no Install');
  let prompted = 0, prevented = 0;
  app.fire('beforeinstallprompt', { preventDefault: () => { prevented++; }, prompt: () => { prompted++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  await app.settle(2);
  assert.equal(prevented, 1, 'the browser’s own bar is held for the page’s button');
  assert.ok(install(), 'offered: Install in Settings');
  install().click();
  await app.settle(3);
  assert.equal(prompted, 1);
  assert.equal(install(), null, 'used once, gone');
  app.fire('beforeinstallprompt', { preventDefault() {}, prompt() {}, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  await app.settle(2);
  assert.ok(install());
  app.fire('appinstalled');
  await app.settle(2);
  assert.equal(install(), null, 'installed: no more offer');
});

test('the page registers the worker only over http(s), and I’m done closes an installed app’s window', () => {
  const app = read('app.js').toString('utf8');
  assert.match(app, /nav\.serviceWorker\.register\('sw\.js'\)/);
  assert.match(app, /\/\^https\?:\$\/\.test/);
  assert.match(app, /globalThis\.close\(\)/);
});
