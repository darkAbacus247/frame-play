// FRAME//PLAY service worker: keeps the page's own static files, so the
// installed app opens with its shell. It caches nothing else: never
// api/... (the server's answers, LIVE's reads), never a photo (our kitchen's
// included), never another site, never anything but a plain GET. Each file
// is fetched fresh first and the kept copy is used only when the server
// cannot answer; LIVE still needs the local server running.
const CACHE = 'frameplay-static-v1';
const SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'favicon.svg', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const STATIC = [
  /^\/(index\.html|app\.js|styles\.css|favicon\.svg|manifest\.webmanifest)?$/,
  /^\/icons\/icon-(192|512)\.png$/,
  /^\/src\/[a-z_]+\.js$/,
  /^\/rooms\/[a-z0-9_-]+\.json$/,
];

// a request this worker may keep: a GET for one of the page's own static
// files, on this origin, under this worker's scope
function cacheable(request, scopeUrl) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  const scope = new URL(scopeUrl);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return false;
  if (url.search) return false;
  const path = '/' + url.pathname.slice(scope.pathname.length);
  if (path.startsWith('/api/')) return false;
  return STATIC.some((re) => re.test(path));
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (!cacheable(e.request, self.registration.scope)) return; // the network, untouched
  e.respondWith(fetch(e.request).then((res) => {
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || Response.error())));
});
