// ============================================================
//  SERVICE WORKER — Harmonie Électricité v5
//  Offline-first complet
// ============================================================
const CACHE_NAME = 'harmonie-v7';
const BASE = self.registration.scope;

const PRECACHE = [
  BASE + 'index.html',
  BASE + 'bon.html',
  BASE + 'maintenance.html',
  BASE + 'offline.js',
  BASE + 'sw.js',
  // jsPDF depuis CDN — précaché pour PDF offline
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // Précacher les fichiers critiques — ignorer les erreurs individuelles
      return Promise.allSettled(
        PRECACHE.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn('[SW] Précache échoué pour:', url, err.message);
          });
        })
      );
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
  const method = e.request.method;

  // ── APIs Supabase / Google / Cloudflare Workers ──────────
  // Network-only avec fallback offline gracieux
  const isApi = url.hostname.includes('supabase.co') ||
                url.hostname.includes('googleapis.com') ||
                url.hostname.includes('workers.dev') ||
                url.hostname.includes('netlify');

  if (isApi) {
    e.respondWith(
      fetch(e.request).catch(function() {
        if (method !== 'GET') {
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

  // ── CDN (jsPDF, etc.) ────────────────────────────────────
  // Cache-first : important pour PDF offline
  if (url.hostname.includes('cdnjs.cloudflare.com')) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        if (cached) return cached;
        return fetch(e.request).then(function(response) {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(function(c) { c.put(e.request, clone); });
          }
          return response;
        }).catch(function() {
          return new Response('/* CDN indisponible hors ligne */', {
            status: 503, headers: { 'Content-Type': 'application/javascript' }
          });
        });
      })
    );
    return;
  }

  // ── Fichiers locaux (HTML, JS, CSS, images) ──────────────
  // Cache-first avec mise à jour en arrière-plan (stale-while-revalidate)
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      const networkFetch = fetch(e.request).then(function(response) {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(e.request, clone); });
        }
        return response;
      }).catch(function() {
        return cached || new Response('Hors ligne', { status: 503 });
      });
      // Retourner le cache immédiatement si disponible, réseau en arrière-plan
      return cached || networkFetch;
    })
  );
});

// Background sync
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
