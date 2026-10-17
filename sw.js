const CACHE = 'sb-ipad-v2';
const ASSETS = [
  './', './index.html', './app.css', './app.js', './manifest.webmanifest',
  './icon-180.png', './icon-512.png',
  './assets/fonts/THICCCBOI-Light.woff2', './assets/fonts/THICCCBOI-Regular.woff2', './assets/fonts/THICCCBOI-Bold.woff2',
  './assets/brush/toolbar-brush-tools-0.png', './assets/brush/toolbar-brush-tools-1.png',
  './assets/brush/toolbar-brush-tools-2.png', './assets/brush/toolbar-brush-tools-3.png',
  './assets/brush/toolbar-brush-tools-4.png', './assets/brush/toolbar-brush-tools-5.png',
  './assets/brush/toolbar-brush-tools-6.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
