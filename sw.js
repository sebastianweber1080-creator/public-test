// Offline-Shell: statische Dateien cachen, API-Aufrufe immer live.
const CACHE = 'spritpreise-v4';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icons/icon.svg',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/leaflet/images/marker-icon.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // Preise & Geocoding nie cachen
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// Klick auf Preisalarm-Benachrichtigung: App in den Vordergrund holen
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list.find(w => w.url.startsWith(self.registration.scope));
    return c ? c.focus() : self.clients.openWindow('./');
  }));
});
