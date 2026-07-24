const CACHE_NAME = 'yaoi-journal-v18';
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

// These are the files that actually change when the app gets updated. They
// need network-first so a new deploy shows up the moment you reload, instead
// of the old cached copy sticking around until some unrelated cache-eviction
// event happens to clear it.
const NETWORK_FIRST_FILES = ['./', './index.html', './styles.css', './app.js', './manifest.json'];

function isNetworkFirst(url) {
  return NETWORK_FIRST_FILES.some((f) => url.endsWith(f.replace('./', '')) || url.endsWith('/'));
}

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

// Network-first for the cross-reference proxy calls (always want fresh data)
// and for the core app shell (index.html/app.js/styles.css/manifest.json) so
// a new deploy is visible on the very next reload. Cache-first for
// everything else (icons, seed data) so those still work offline.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if (url.includes('script.google.com') || url.includes('anime-planet') || url.includes('mangago')) {
    // Don't intercept live proxy/cross-reference calls.
    return;
  }
  if (isNetworkFirst(url)) {
    event.respondWith(
      fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(event.request))
    );
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
