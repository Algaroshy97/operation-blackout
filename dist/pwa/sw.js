/* Operation Blackout PWA Service Worker (ob-pwa-c3a8216bba70) */
const CACHE_NAME = 'ob-pwa-c3a8216bba70';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];
const SCOPE = self.registration.scope;
const INDEX = new URL('./index.html', SCOPE).href;
const PRECACHED = new Set(PRECACHE_URLS.map((path) => new URL(path, SCOPE).href));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      for (const url of PRECACHED) {
        const req = new Request(url, { cache: 'reload' });
        const res = await fetch(req);
        if (!res.ok) throw new Error('Precache failed for ' + url + ' (' + res.status + ')');
        await cache.put(req, res);
      }
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('ob-pwa-') && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    if (url.href !== SCOPE && url.href !== INDEX) return;
    // App-shell first: the shell is written only by a successful install, so a
    // half-published release (failed precache) can never replace the working copy,
    // online or offline. A good release rotates CACHE_NAME, so it takes over on
    // install instead of after the next network hit.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = (await cache.match(INDEX)) || (await cache.match(SCOPE));
      if (cached) return cached;
      try {
        const net = await fetch(req);
        if (net && net.ok) return net;
      } catch (_) {}
      return Response.error();
    })());
    return;
  }
  url.search = '';
  if (!PRECACHED.has(url.href)) return; // Leave unrelated requests alone.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(url.href)) || fetch(req);
  })());
});
