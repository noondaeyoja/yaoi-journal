const CACHE_NAME = 'yaoi-journal-v7';
const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './seed_data.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the cross-reference proxy calls (always want fresh data),
// cache-first for the app shell itself so it works offline.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if (url.includes('script.google.com') || url.includes('anime-planet') || url.includes('mangago')) {
    // Don't intercept live proxy/cross-reference calls.
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return resp;
      }).catch(() => cached);
    })
  );
});
