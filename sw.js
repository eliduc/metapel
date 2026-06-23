/*
 * Service worker: приложение открывается и без интернета.
 * Стратегия: сеть в приоритете (чтобы обновления доходили сразу),
 * при недоступности сети — копия из кэша.
 */
// Среду определяем по собственному пути worker'а: sw.js в /stage/ обслуживает
// staging. Семейство имён кэшей у сред РАЗНОЕ, иначе на общем origin
// eliduc.github.io они удаляли бы кэши друг друга при активации.
var STAGE = self.location.pathname.indexOf('/stage/') !== -1;
var CACHE_FAMILY = STAGE ? 'metapel-stage-shell-' : 'metapel-shell-';
// Раздел «Табели» (этап 2/3) обкатывается только на stage: на проде версия
// заморожена (v23), на stage — новее (v25). Тяжёлые pdf.js/pdf-lib/EmailJS в
// SHELL не кладём — они грузятся лениво и кэшируются обычным fetch-обработчиком.
var CACHE = CACHE_FAMILY + (STAGE ? 'v27' : 'v23');
var SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/env.js',
  'js/calc.js',
  'js/storage.js',
  'js/sync.js',
  'js/timesheet-sign.js',
  'js/app.js',
  'manifest.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        // удаляем только СТАРЫЕ кэши СВОЕЙ среды; кэш другой среды (stage/prod)
        // на общем origin не трогаем — иначе среды затирали бы друг друга
        if (k !== CACHE && k.indexOf(CACHE_FAMILY) === 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // GitHub API и пр. — мимо кэша
  e.respondWith(
    fetch(e.request).then(function (resp) {
      if (resp && resp.ok) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return resp;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
        return hit || caches.match('index.html');
      });
    })
  );
});
