// sw.js – Service Worker: App startet auch ohne Internet (z. B. an der Bahn ohne WLAN).
//
// Strategie:
// • Eigene Dateien (HTML/JS/CSS/Bilder): zuerst Netz, bei Fehler aus dem Cache.
//   So ist online immer die neueste Version aktiv, offline die zuletzt geladene.
// • Bibliotheken von CDNs (Firebase, Chart.js, Schrift): aus dem Cache, im Hintergrund aktualisieren.
// • Firestore-/Login-Anfragen werden NICHT angefasst (die Daten puffert Firestore selbst).

const CACHE = 'grp-v2';

const APP_SHELL = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'firebase.js', 'storage.js', 'helpers.js', 'elo.js', 'sync.js',
  'app.js', 'ranking.js', 'race.js', 'history.js', 'records.js',
  'statistics.js', 'wheel.js', 'slot.js',
  'assets/logo.png', 'assets/icons/icon-192.png', 'assets/icons/apple-touch-icon.png'
];

const CDN_HOSTS = ['www.gstatic.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Eigene Dateien: Netz zuerst, Cache als Fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true })
          .then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
    );
    return;
  }

  // CDN-Bibliotheken: Cache zuerst, im Hintergrund aktualisieren
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(CACHE).then(cache => cache.match(req).then(hit => {
        const net = fetch(req)
          .then(res => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; })
          .catch(() => hit);
        return hit || net;
      }))
    );
  }
  // alles andere (Firestore, Auth) unverändert ans Netz
});
