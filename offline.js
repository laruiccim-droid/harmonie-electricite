// ============================================================
//  OFFLINE MANAGER — Harmonie Électricité
//  IndexedDB locale + file d'attente sync
// ============================================================

const HE_DB_NAME = 'harmonie-offline';
const HE_DB_VERSION = 2;
let heDB = null;

// ── Ouvrir/créer la base IndexedDB ───────────────────────
function heOpenDB() {
  return new Promise(function(resolve, reject) {
    if (heDB) { resolve(heDB); return; }
    const req = indexedDB.open(HE_DB_NAME, HE_DB_VERSION);

    req.onupgradeneeded = function(e) {
      const db = e.target.result;
      // Clients
      if (!db.objectStoreNames.contains('clients')) {
        const cs = db.createObjectStore('clients', { keyPath: 'id' });
        cs.createIndex('name', 'payload.name', { unique: false });
      }
      // Catalogue
      if (!db.objectStoreNames.contains('catalogue')) {
        const cat = db.createObjectStore('catalogue', { keyPath: 'id' });
        cat.createIndex('ref', 'payload.ref', { unique: false });
      }
      // Bons/Devis
      if (!db.objectStoreNames.contains('devis')) {
        const dv = db.createObjectStore('devis', { keyPath: 'id' });
        dv.createIndex('eventId', 'payload.eventId', { unique: false });
        dv.createIndex('client', 'payload.client', { unique: false });
      }
      // Agenda (events GCal)
      if (!db.objectStoreNames.contains('agenda')) {
        const ag = db.createObjectStore('agenda', { keyPath: 'id' });
        ag.createIndex('start', 'start.dateTime', { unique: false });
      }
      // File d'attente sync
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
      }
      // Métadonnées (dernière sync, etc.)
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = function(e) { heDB = e.target.result; resolve(heDB); };
    req.onerror   = function(e) { reject(e.target.error); };
  });
}

// ── Helpers CRUD génériques ───────────────────────────────
async function heDBGet(store, key) {
  const db = await heOpenDB();
  return new Promise(function(resolve, reject) {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = function() { resolve(req.result); };
    req.onerror   = function() { reject(req.error); };
  });
}

async function heDBGetAll(store) {
  const db = await heOpenDB();
  return new Promise(function(resolve, reject) {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = function() { resolve(req.result || []); };
    req.onerror   = function() { reject(req.error); };
  });
}

async function heDBPut(store, data) {
  const db = await heOpenDB();
  return new Promise(function(resolve, reject) {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(data);
    req.onsuccess = function() { resolve(req.result); };
    req.onerror   = function() { reject(req.error); };
  });
}

async function heDBPutMany(store, items) {
  const db = await heOpenDB();
  return new Promise(function(resolve, reject) {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    items.forEach(function(item) { os.put(item); });
    tx.oncomplete = function() { resolve(); };
    tx.onerror    = function() { reject(tx.error); };
  });
}

async function heDBDelete(store, key) {
  const db = await heOpenDB();
  return new Promise(function(resolve, reject) {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = function() { resolve(); };
    req.onerror   = function() { reject(req.error); };
  });
}

async function heDBMeta(key, value) {
  if (value === undefined) {
    const r = await heDBGet('meta', key);
    return r ? r.value : null;
  }
  return heDBPut('meta', { key, value });
}

// ── File d'attente offline ────────────────────────────────
async function heQueueAction(action) {
  // action = { type, store, data, method, url, body }
  const db = await heOpenDB();
  return new Promise(function(resolve, reject) {
    const tx = db.transaction('syncQueue', 'readwrite');
    const req = tx.objectStore('syncQueue').add({
      ...action,
      createdAt: Date.now(),
      status: 'pending'
    });
    req.onsuccess = function() { resolve(req.result); };
    req.onerror   = function() { reject(req.error); };
  });
}

async function heGetQueue() {
  return heDBGetAll('syncQueue');
}

async function heClearQueued(id) {
  return heDBDelete('syncQueue', id);
}

// ── Sync au retour du réseau ──────────────────────────────
async function heSyncAll() {
  if (!navigator.onLine) return;

  const queue = await heGetQueue();
  let synced = 0;

  if (queue.length) {
    const SUPA = 'https://bqzebkobyfktemnwfwbt.supabase.co';
    const KEY  = 'sb_publishable_vh62KxFcG1NuLcnya6WpMg_oFRtY-2v';

    for (const action of queue) {
      try {
        if (action.store === 'devis') {
          const r = await fetch(SUPA + '/rest/v1/devis', {
            method: 'POST',
            headers: {
              'apikey': KEY, 'Authorization': 'Bearer ' + KEY,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates,return=minimal'
            },
            body: JSON.stringify({ id: action.data.id, payload: action.data })
          });
          if (r.ok || r.status === 201) {
            await heClearQueued(action.id);
            synced++;

            // Mettre à jour Google Calendar si eventId présent
            if (action.data.eventId) {
              await heSyncBonToGcal(action.data);
            }
          }
        }
      } catch(err) {
        console.warn('[Offline] Sync failed for action', action.id, err);
      }
    }
  }

  if (synced) {
    console.log('[Offline] Synced', synced, 'actions');
    heShowSyncToast(synced);
    // Invalider cache agenda pour forcer rechargement
    await heDBMeta('agenda_synced', 0);
    window._bonExistantLoaded = false;
  }

  // Sync file d'attente GCal (descriptions RDV créés hors ligne)
  await heSyncGcalQueue();

  // Rafraîchir depuis le serveur
  await heSyncFromServer();

  // Recharger l'agenda si visible
  setTimeout(function() {
    if (typeof loadAgenda === 'function' && document.getElementById('tab-agenda')?.classList.contains('active')) {
      loadAgenda();
    }
    // Recharger docs si visible
    if (typeof renderDocsList === 'function' && document.getElementById('tab-docs')?.classList.contains('active')) {
      renderDocsList();
    }
  }, 500);
}

// ── Télécharger et cacher les données depuis le serveur ──
async function heSyncFromServer() {
  if (!navigator.onLine) return;

  const SUPA = 'https://bqzebkobyfktemnwfwbt.supabase.co';
  const KEY  = 'sb_publishable_vh62KxFcG1NuLcnya6WpMg_oFRtY-2v';
  const headers = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY };

  try {
    // Clients
    const cr = await fetch(SUPA + '/rest/v1/clients?select=id,payload&order=id', { headers });
    if (cr.ok) {
      const clients = await cr.json();
      if (clients.length) {
        await heDBPutMany('clients', clients);
        await heDBMeta('clients_synced', Date.now());
        console.log('[Offline] Clients cached:', clients.length);
      }
    }
  } catch(e) { console.warn('[Offline] Clients sync failed'); }

  try {
    // Catalogue (1373 refs)
    const lastSync = await heDBMeta('catalogue_synced');
    const catAge = lastSync ? Date.now() - lastSync : Infinity;
    if (catAge > 24 * 3600 * 1000) { // Re-sync catalogue toutes les 24h
      const catr = await fetch(SUPA + '/rest/v1/catalogue?select=id,payload&order=id', { headers });
      if (catr.ok) {
        const cat = await catr.json();
        if (cat.length) {
          await heDBPutMany('catalogue', cat);
          await heDBMeta('catalogue_synced', Date.now());
          console.log('[Offline] Catalogue cached:', cat.length);
        }
      }
    }
  } catch(e) { console.warn('[Offline] Catalogue sync failed'); }

  try {
    // Bons/Devis récents (30 derniers jours)
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const dr = await fetch(SUPA + '/rest/v1/devis?select=id,payload&order=id.desc&limit=200', { headers });
    if (dr.ok) {
      const docs = await dr.json();
      if (docs.length) {
        await heDBPutMany('devis', docs);
        await heDBMeta('devis_synced', Date.now());
        console.log('[Offline] Docs cached:', docs.length);
      }
    }
  } catch(e) { console.warn('[Offline] Devis sync failed'); }

  // Agenda — pré-cacher 3 semaines (semaine courante + 2 suivantes)
  try {
    const accessToken = localStorage.getItem('gcal_access_token');
    const refreshToken = localStorage.getItem('gcal_refresh_token');
    const agendaSynced = await heDBMeta('agenda_synced');
    const agendaAge = agendaSynced ? Date.now() - agendaSynced : Infinity;

    if ((accessToken || refreshToken) && agendaAge > 30 * 60 * 1000) { // Re-sync toutes les 30min
      const NETLIFY = 'https://gcal-harmonie.harmonie-electricite.workers.dev';
      const now = new Date();
      // Lundi de la semaine courante
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      monday.setHours(0,0,0,0);
      const tMin = monday.toISOString();
      const tMax = new Date(monday.getTime() + 21 * 86400000).toISOString(); // +3 semaines

      const token = accessToken || '';
      const ar = await fetch(NETLIFY + '/events?timeMin=' + encodeURIComponent(tMin)
        + '&timeMax=' + encodeURIComponent(tMax) + '&singleEvents=true&orderBy=startTime', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (ar.ok) {
        const agData = await ar.json();
        const agEvents = agData.items || [];
        if (agEvents.length) {
          await heDBPutMany('agenda', agEvents);
          await heDBMeta('agenda_synced', Date.now());
          console.log('[Offline] Agenda cached:', agEvents.length, 'events (3 weeks)');
        }
      }
    }
  } catch(e) { console.warn('[Offline] Agenda sync failed'); }

  await heDBMeta('last_sync', Date.now());
}

// ── Sync file d'attente Google Calendar ──────────────────
async function heSyncGcalQueue() {
  const queue = JSON.parse(localStorage.getItem('he_gcal_queue') || '[]');
  if (!queue.length) return;

  const GCAL = 'https://gcal-harmonie.harmonie-electricite.workers.dev';
  let token = localStorage.getItem('gcal_access_token');
  const refresh = localStorage.getItem('gcal_refresh_token');

  // Rafraîchir le token
  if ((!token || token === 'null') && refresh) {
    try {
      const r = await fetch(GCAL + '/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh })
      });
      const d = await r.json();
      if (d.access_token) {
        token = d.access_token;
        localStorage.setItem('gcal_access_token', token);
      }
    } catch(e) { return; }
  }

  if (!token) return;

  const remaining = [];
  for (const item of queue) {
    if (item.type !== 'gcal_update') continue;
    try {
      const doc = item.doc;
      const isBon = doc.type === 'bon';
      const appUrl = 'https://laruiccim-droid.github.io/harmonie-electricite/bon.html?doc='
        + encodeURIComponent(doc.id) + '&mode=detail';
      const lignesText = (doc.lignes||[]).map(function(l){
        return l.qty + ' ' + (l.unite||'U') + ' × ' + l.nom;
      }).join('\n');
      const description = [
        (isBon ? '✅ BON D\'INTERVENTION' : '📄 DEVIS') + ' N°' + (doc.numero||''),
        '━━━━━━━━━━━━━━━━━━━━━━',
        '👤 Client : ' + (doc.client||''),
        doc.heureDebut ? '⏱ ' + doc.heureDebut + ' → ' + (doc.heureFin||'') + (doc.duree?' ('+doc.duree+')':'') : '',
        doc.motif ? '🔧 Motif : ' + doc.motif : '',
        '',
        lignesText ? '📦 Fournitures :\n' + lignesText : '',
        '',
        '💶 Total TTC : ' + (doc.totalTTC||0).toFixed(2) + ' €',
        '',
        '📄 PDF (lien direct) :',
        appUrl
      ].filter(function(l){ return l !== ''; }).join('\n');

      const r = await fetch(GCAL + '/events/' + item.eventId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ description: description, colorId: isBon ? '10' : '3' })
      });

      if (!r.ok) remaining.push(item); // réessayer plus tard
      else console.log('[Offline] GCal description mise à jour:', item.eventId);

    } catch(e) {
      remaining.push(item);
    }
  }

  localStorage.setItem('he_gcal_queue', JSON.stringify(remaining));
  if (remaining.length < queue.length) {
    console.log('[Offline] GCal queue:', queue.length - remaining.length, 'mis à jour');
  }
}

// ── Mettre à jour Google Calendar après sync offline ─────
async function heSyncBonToGcal(doc) {
  try {
    const refreshToken = localStorage.getItem('gcal_refresh_token');
    if (!refreshToken) return;

    const NETLIFY = 'https://gcal-harmonie.harmonie-electricite.workers.dev';

    // Rafraîchir le token
    const tokenRes = await fetch(NETLIFY + '/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    if (!tokenRes.ok) return;
    const { access_token } = await tokenRes.json();

    // Colorier le RDV en vert (bon validé)
    const colorId = doc.type === 'bon' ? '10' : '3';
    const desc = '[Bon:' + doc.numero + '] [Client:' + (doc.client||'') + ']'
      + (doc.totalTTC ? ' [TTC:' + doc.totalTTC.toFixed(2) + '€]' : '');

    await fetch(NETLIFY + '/events/' + encodeURIComponent(doc.eventId), {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ colorId, description: desc })
    });

    console.log('[Offline] GCal updated for event', doc.eventId);
  } catch(e) {
    console.warn('[Offline] GCal sync failed:', e);
  }
}

// ── Toast de sync ─────────────────────────────────────────
function heShowSyncToast(count) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#22c55e;color:#000;padding:10px 20px;border-radius:20px;font-size:13px;font-weight:700;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
  t.textContent = '☁️ ' + count + ' action(s) synchronisée(s) !';
  document.body.appendChild(t);
  setTimeout(function() { t.remove(); }, 4000);
}

// ── Indicateur online/offline ─────────────────────────────
function heInitOfflineIndicator() {
  const bar = document.createElement('div');
  bar.id = 'he-offline-bar';
  bar.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;background:#ef4444;color:#fff;text-align:center;padding:6px;font-size:12px;font-weight:700;z-index:10000;';
  bar.textContent = '📵 Mode hors ligne — les données sont sauvegardées localement';
  document.body.prepend(bar);

  function updateStatus() {
    bar.style.display = navigator.onLine ? 'none' : 'block';
    if (navigator.onLine) {
      heSyncAll();
    }
  }

  window.addEventListener('online',  updateStatus);
  window.addEventListener('offline', updateStatus);
  updateStatus();
}

// ── Wrappers pour remplacer les appels Supabase ──────────
// Ces fonctions interceptent les appels réseau et tombent en local si offline

async function heSupaFetch(path, options) {
  const SUPA = 'https://bqzebkobyfktemnwfwbt.supabase.co';
  const KEY  = 'sb_publishable_vh62KxFcG1NuLcnya6WpMg_oFRtY-2v';
  const defaultHeaders = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  if (!navigator.onLine) {
    // Mode offline — lire depuis IndexedDB
    if (path.includes('/clients')) {
      const clients = await heDBGetAll('clients');
      return { ok: true, json: async () => clients };
    }
    if (path.includes('/catalogue')) {
      const cat = await heDBGetAll('catalogue');
      return { ok: true, json: async () => cat };
    }
    if (path.includes('/devis')) {
      const docs = await heDBGetAll('devis');
      return { ok: true, json: async () => docs };
    }
    return { ok: false, json: async () => ({}) };
  }

  return fetch(SUPA + path, { ...options, headers: { ...defaultHeaders, ...(options && options.headers) } });
}

// Sauvegarder un bon localement + queue sync si offline
async function heSaveBon(doc) {
  // Toujours sauvegarder en local
  await heDBPut('devis', { id: doc.id, payload: doc });

  if (!navigator.onLine) {
    // Mettre en file d'attente pour sync ultérieure
    await heQueueAction({ store: 'devis', data: doc, method: 'POST' });
    const pending = await heGetQueue();
    return { offline: true, queued: true, pendingCount: pending.length };
  }

  // Online — envoyer à Supabase directement
  const SUPA = 'https://bqzebkobyfktemnwfwbt.supabase.co';
  const KEY  = 'sb_publishable_vh62KxFcG1NuLcnya6WpMg_oFRtY-2v';
  try {
    const r = await fetch(SUPA + '/rest/v1/devis', {
      method: 'POST',
      headers: {
        'apikey': KEY, 'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ id: doc.id, payload: doc })
    });
    return { ok: r.ok };
  } catch(e) {
    // Réseau coupé pendant l'envoi → mettre en queue
    await heQueueAction({ store: 'devis', data: doc, method: 'POST' });
    return { offline: true, queued: true };
  }
}

// ── Init ──────────────────────────────────────────────────
async function heOfflineInit() {
  await heOpenDB();
  heInitOfflineIndicator();

  // Écouter les messages du Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'SW_SYNC_READY') {
        heSyncAll();
      }
    });
  }

  // Sync initiale si online
  if (navigator.onLine) {
    setTimeout(heSyncAll, 2000); // Attendre que l'app soit chargée
  }

  console.log('[Offline] Manager initialisé');
}

// Exporter les fonctions globalement
window.HE = {
  openDB: heOpenDB,
  get: heDBGet,
  getAll: heDBGetAll,
  put: heDBPut,
  putMany: heDBPutMany,
  delete: heDBDelete,
  meta: heDBMeta,
  queue: heQueueAction,
  getQueue: heGetQueue,
  clearQueued: heClearQueued,
  syncAll: heSyncAll,
  syncFromServer: heSyncFromServer,
  supaFetch: heSupaFetch,
  saveBon: heSaveBon,
  init: heOfflineInit
};
