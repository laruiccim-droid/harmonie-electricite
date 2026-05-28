// ============================================================
//  SERVICE WORKER — Harmonie Électricité v4
//  Compatible GitHub Pages (/harmonie-electricite/) et Netlify (/)
// ============================================================
const CACHE_NAME = 'harmonie-v4';

// Détecter le scope (GitHub Pages vs Netlify)
const BASE = self.registration.scope;
const IS_GITHUB = BASE.includes('github.io');

const PRECACHE = IS_GITHUB ? [
  BASE + 'index.html',
  BASE + 'offline.js',
  BASE + 'sw.js'
] : [
  '/index.html',
  '/bon.html',
  '/offline.js'
];

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(PRECACHE).catch(function(err) {
        console.warn('[SW] Precache partial fail:', err);
      });
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  const url = new URL(e.request.url);

  // APIs externes → network only, pas de cache
  const isExternal = url.hostname.includes('netlify') ||
                     url.hostname.includes('supabase') ||
                     url.hostname.includes('googleapis') ||
                     url.hostname.includes('google.com') ||
                     url.hostname.includes('cdnjs');

  if (isExternal) {
    e.respondWith(
      fetch(e.request).catch(function() {
        if (e.request.method !== 'GET') {
          return new Response(JSON.stringify({ offline: true, queued: true }), {
            status: 202, headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ offline: true, items: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Fichiers locaux → cache first, réseau en fond
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      const networkFetch = fetch(e.request).then(function(response) {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      }).catch(function() {
        return cached || new Response('Hors ligne', { status: 503 });
      });
      return cached || networkFetch;
    })
  );
});

self.addEventListener('sync', function(e) {
  if (e.tag === 'he-sync') {
    e.waitUntil(
      self.clients.matchAll().then(function(clients) {
        clients.forEach(function(c) {
          c.postMessage({ type: 'SW_SYNC_READY' });
        });
      })
    );
  }
});

self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
