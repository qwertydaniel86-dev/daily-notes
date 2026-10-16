/* Daily Notes – offline cache. Network-first for everything (so new publishes show up immediately),
   falling back to the last cached copy when offline. Only static files + the ENCRYPTED notes.enc.json are cached. */
const CACHE = 'dn-shell-v7';
const SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'crypto.js', 'habits.js', 'edits-core.js', 'features.js', 'sync.js', 'app.js', 'manifest.webmanifest', 'notes.enc.json'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const keyUrl = url.origin + url.pathname; // ignore cache-busting query (?t=…)
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(keyUrl, copy)); }
    return res;
  }).catch(() => caches.match(keyUrl).then((r) => r || caches.match(req, { ignoreSearch: true })).then((r) => r || Response.error())));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => (cs.length ? cs[0].focus() : self.clients.openWindow('./'))));
});
