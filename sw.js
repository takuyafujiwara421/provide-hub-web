/* provide hub ─ Service Worker
   画面の「ガワ」だけを先に出すためのキャッシュ。データは必ずネットワークから取る
   （古い実績や古いタスクを見せるのが一番まずいため）。 */
var CACHE = 'provide-hub-202609041449';   // ★画面を変えたら必ず上げる（古いガワが残るため）
// ガワは index.html だけ先読みする。css/js は ?v= 付きで来るのでここに固定名を書かない
var SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // API（script.google.com）は絶対にキャッシュしない
  if (url.hostname.indexOf('google.com') >= 0) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.ok && url.origin === location.origin) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () { return caches.match(e.request).then(function (r) { return r || caches.match('./index.html'); }); })
  );
});
