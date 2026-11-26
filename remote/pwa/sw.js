const CACHE_NAME = 'maga-remote-shell-v7';
const SHELL_PATHS = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest'];
const SHELL_SET = new Set(SHELL_PATHS);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_PATHS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Hard invariant: never intercept or cache /api/* or /ws (always Network-Only)
  if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
    return;
  }

  const isNavigation = req.mode === 'navigate';
  const cachePath = url.pathname === '/' ? '/' : url.pathname;
  if (!isNavigation && !SHELL_SET.has(cachePath)) {
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const fetchOpts =
          typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? { signal: AbortSignal.timeout(4000) }
            : undefined;
        const networkRes = await fetch(req, fetchOpts);
        if (networkRes && networkRes.ok && SHELL_SET.has(cachePath)) {
          const cache = await caches.open(CACHE_NAME);
          // Store under clean path without query params or hash
          await cache.put(cachePath, networkRes.clone());
        }
        return networkRes;
      } catch (err) {
        const cache = await caches.open(CACHE_NAME);
        const cached =
          (await cache.match(cachePath)) ||
          (isNavigation ? await cache.match('/index.html') : null);
        if (cached) return cached;
        throw err;
      }
    })()
  );
});
