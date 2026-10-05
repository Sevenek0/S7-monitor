// Service worker S7 Monitor: cache aplikacji (offline), Web Push, kliknięcia powiadomień.
const VERSION = 's7-v1';
const ASSETS = [
  '/', '/index.html', '/manifest.webmanifest', '/css/app.css',
  '/js/app.js', '/js/api.js', '/js/store.js', '/js/util.js', '/js/charts.js', '/js/dashboard.js',
  '/js/detail.js', '/js/settings.js', '/js/push.js', '/js/modal.js', '/js/desktop-bridge.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/badge-72.png', '/icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // API zawsze z sieci
  // Stale-while-revalidate: szybko z cache, w tle aktualizacja.
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const key = url.pathname === '/' ? '/index.html' : url.pathname;
    const cached = await cache.match(key);
    const network = fetch(e.request).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data?.json() || {}; } catch { data = { title: 'S7 Monitor', body: e.data?.text() }; }
  const title = data.title || 'S7 Monitor';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    requireInteraction: data.kind === 'down',
    data: { url: data.url || '/#/', monitorId: data.monitorId },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/#/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === location.origin) {
        await c.focus();
        c.postMessage({ type: 'open', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
