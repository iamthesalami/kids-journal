/*
 * sw.js — Service worker for offline app-shell caching.
 *
 * Bump CACHE_NAME whenever any cached file changes so the browser fetches
 * fresh copies instead of serving stale ones from an old cache.
 */
const CACHE_NAME = 'kids-journal-v9';

const SHELL_FILES = [
  './',
  './index.html',
  './css/styles.css',
  './js/db.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for the app shell, with the network response cached opportunistically
// for anything else same-origin (e.g. if new files are added later). All entry/photo
// data lives in IndexedDB, not behind network requests, so this is the only caching
// this app needs to work fully offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
